import { createServer as createHttpServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCli } from './cli.js';
import { createLoginManager } from './login.js';
import { createServer, isAuthError } from './server.js';

// The MCP endpoint is an OAuth 2.1 protected resource and this process is its
// authorization server (MCP authorization spec: RFC 9728 + RFC 8414 + RFC 7591
// + PKCE). DNSimple offers no dynamic client registration, so the sign-in
// itself is delegated to `dnsimple auth login`: /authorize shows a page that
// sends the user to the CLI's DNSimple consent screen and returns to the MCP
// client once the CLI has stored the credential. The tokens issued here are
// opaque handles to "this machine's dnsimple CLI"; the DNSimple token never
// leaves the CLI's credential store.

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 60;
const REQUEST_TTL = 15 * 60;
const AUTH_CACHE_MS = 60_000;
const MAX_CLIENTS = 200;
const MAX_BODY = 4 * 1024 * 1024;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const now = () => Math.floor(Date.now() / 1000);
const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest('base64url');
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

const isLoopbackUrl = (url) => url.protocol === 'http:' && LOOPBACK.has(url.host.replace(/:\d+$/, ''));

/** Loopback http, https, or a private-use scheme (cursor://, vscode://…). */
function validRedirect(value) {
  const url = typeof value === 'string' && parseUrl(value);
  if (!url || url.hash) return false;
  if (url.protocol === 'http:') return isLoopbackUrl(url);
  return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(url.protocol);
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  const a = parseUrl(registered);
  const b = parseUrl(requested);
  if (!a || !b || !isLoopbackUrl(a) || !isLoopbackUrl(b)) return false;
  a.port = ''; b.port = '';
  return a.href === b.href;
}

export function defaultStateFile(env = process.env) {
  const dir = env.DNSIMPLE_MCP_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dnsimple-mcp');
  return join(dir, 'http.json');
}

/** Registered clients and hashed tokens, so a restart does not force a new sign-in. */
function createStore(file) {
  let data = { clients: {}, tokens: {} };
  try { data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch {}

  function save() {
    for (const [hash, t] of Object.entries(data.tokens)) if (t.exp <= now()) delete data.tokens[hash];
    const ids = Object.keys(data.clients);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CLIENTS))) delete data.clients[id];
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {} // an unwritable state dir only costs persistence
  }

  return {
    client: (id) => (typeof id === 'string' && Object.hasOwn(data.clients, id) ? data.clients[id] : null),
    addClient(client) { data.clients[client.client_id] = client; save(); },
    issue(clientId) {
      const access = random();
      const refresh = random();
      data.tokens[sha256(access)] = { kind: 'access', client_id: clientId, exp: now() + ACCESS_TTL };
      data.tokens[sha256(refresh)] = { kind: 'refresh', client_id: clientId, exp: now() + REFRESH_TTL };
      save();
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh };
    },
    find(token, kind) {
      const hash = sha256(String(token));
      const t = Object.hasOwn(data.tokens, hash) ? data.tokens[hash] : null;
      return t && t.kind === kind && t.exp > now() ? t : null;
    },
    revoke(token) { delete data.tokens[sha256(String(token))]; save(); },
    revokeAll() { data.tokens = {}; save(); },
  };
}

function page({ title, body, script = '' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--mut:#6e6e73;--bg:#f5f5f7;--card:#fff;--line:#d2d2d7;--acc:#1a5fb4;--err:#b3261e}
@media(prefers-color-scheme:dark){:root{--fg:#f5f5f7;--mut:#a1a1a6;--bg:#1c1c1e;--card:#2c2c2e;--line:#48484a;--acc:#64a8ff;--err:#ff6b60}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;padding:24px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px}
h1{font-size:22px;line-height:1.25;margin:0 0 12px}p{margin:0 0 16px}.mut{color:var(--mut);font-size:14px}
.btn{display:block;width:100%;padding:12px 16px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;margin:0 0 10px}
.btn.primary{background:var(--acc);border-color:var(--acc);color:#fff}@media(prefers-color-scheme:dark){.btn.primary{color:#0b1a2e}}
.btn:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
#status{min-height:21px;margin:16px 0 0}#status.err{color:var(--err)}code{font-size:13px}
</style></head><body><main>${body}</main>${script}</body></html>`;
}

export async function createHttpApp({
  bin, context, sandbox = false, port = 8377, host = '127.0.0.1', stateFile = defaultStateFile(),
} = {}) {
  const cli = createCli({ bin, context });
  const login = createLoginManager(cli);
  const store = createStore(stateFile);
  const requests = new Map(); // authorization requests waiting on the user
  const codes = new Map();
  let boundPort = port;

  let authCache = null;
  /** Identity of the CLI's (pinned or active) context, or null when signed out. */
  async function cliIdentity({ fresh = false } = {}) {
    if (!fresh && authCache && Date.now() - authCache.at < AUTH_CACHE_MS) return authCache.identity;
    let identity = null;
    try {
      identity = await cli.run(['auth', 'status', '--json', ...cli.contextArgs()]);
    } catch (error) {
      // Anything but "signed out" (CLI missing, network) is the tools' job to report.
      if (!isAuthError(error.message)) identity = authCache?.identity ?? {};
    }
    authCache = { at: Date.now(), identity };
    return identity;
  }

  const mcpOptions = {
    cli,
    login,
    http: {
      onAuthLost() { authCache = null; },
      onLogout() { authCache = null; store.revokeAll(); },
    },
  };

  function send(res, status, body, headers = {}) {
    const isText = typeof body === 'string';
    res.writeHead(status, {
      'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json',
      'Cache-Control': 'no-store',
      ...(isText && { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'", 'X-Frame-Options': 'DENY' }),
      ...headers,
    });
    res.end(isText ? body : JSON.stringify(body));
  }

  const oauthError = (res, status, error, description, headers) =>
    send(res, status, { error, error_description: description }, headers);

  const errorPage = (res, status, message) =>
    send(res, status, page({ title: 'DNSimple MCP', body: `<h1>Can’t connect to DNSimple</h1><p>${esc(message)}</p><p class="mut">Close this tab and start the connection again from your MCP client.</p>` }));

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function readParams(req) {
    const raw = await readBody(req);
    if ((req.headers['content-type'] || '').includes('application/json')) {
      const json = JSON.parse(raw || '{}');
      return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  function prune() {
    for (const [id, r] of requests) if (r.exp <= now()) requests.delete(id);
    for (const [code, c] of codes) if (c.exp <= now()) codes.delete(code);
  }

  const takeRequest = (rid) => { prune(); return (typeof rid === 'string' && requests.get(rid)) || null; };

  function clientRedirect(request, params) {
    const url = new URL(request.redirect_uri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (request.state !== undefined) url.searchParams.set('state', request.state);
    return url.href;
  }

  /** The user is signed in and agreed: hand the client its authorization code. */
  function complete(rid, request) {
    requests.delete(rid);
    const code = random();
    codes.set(code, {
      client_id: request.client_id,
      redirect_uri: request.redirect_uri,
      code_challenge: request.code_challenge,
      exp: now() + CODE_TTL,
    });
    return clientRedirect(request, { code });
  }

  // --- OAuth endpoints ---

  const metadata = (base) => ({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  });

  async function register(req, res) {
    let body;
    try { body = await readParams(req); } catch { return oauthError(res, 400, 'invalid_client_metadata', 'Body must be JSON.'); }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirect)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be loopback http, https or private-use scheme URIs.');
    }
    const client = {
      client_id: random(16),
      client_id_issued_at: now(),
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : 'MCP client',
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    store.addClient(client);
    send(res, 201, client);
  }

  async function authorize(url, res) {
    const q = Object.fromEntries(url.searchParams);
    const client = store.client(q.client_id);
    if (!client) return errorPage(res, 400, 'This MCP client is not registered with the server. Reconnect it so it registers again.');
    const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !validRedirect(redirectUri) || !client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) {
      return errorPage(res, 400, 'The redirect address sent by the MCP client does not match its registration.');
    }
    const request = { client_id: client.client_id, redirect_uri: redirectUri, state: q.state, code_challenge: q.code_challenge, exp: now() + REQUEST_TTL, session: null };
    const reject = (error, description) => {
      res.writeHead(302, { Location: clientRedirect(request, { error, error_description: description }), 'Cache-Control': 'no-store' });
      res.end();
    };
    if (q.response_type !== 'code') return reject('unsupported_response_type', 'Only response_type=code is supported.');
    if (!q.code_challenge || (q.code_challenge_method ?? 'plain') !== 'S256') return reject('invalid_request', 'PKCE with code_challenge_method=S256 is required.');

    prune();
    const rid = random();
    requests.set(rid, request);
    const identity = await cliIdentity({ fresh: true });
    const environment = sandbox ? 'DNSimple Sandbox' : 'DNSimple';
    const who = identity && identity.account_id !== undefined
      ? `account <strong>${esc(identity.account_id)}</strong>${identity.context ? ` (context <code>${esc(identity.context)}</code>)` : ''}`
      : 'the account stored in the dnsimple CLI';
    const signIn = `<a class="btn${identity ? '' : ' primary'}" id="signin" target="_blank" rel="noopener" href="/authorize/dnsimple?rid=${rid}">${identity ? 'Use a different account' : `Sign in with ${environment}`}</a>`;
    const body = `
<h1>Connect ${esc(client.client_name)} to ${environment}</h1>
<p>${identity
    ? `This computer is signed in to ${environment} as ${who}. ${esc(client.client_name)} will be able to read and change everything in that account.`
    : `${esc(client.client_name)} will be able to read and change everything in the account you sign in to. The sign-in opens in a new tab and is handled by the dnsimple CLI on this computer.`}</p>
${identity ? `<form method="post" action="/authorize/approve"><input type="hidden" name="rid" value="${rid}"><button class="btn primary" type="submit">Continue</button></form>` : ''}
${signIn}
<form method="post" action="/authorize/deny"><input type="hidden" name="rid" value="${rid}"><button class="btn" type="submit">Cancel</button></form>
<p id="status" class="mut" role="status" aria-live="polite"></p>`;
    const script = `<script>
(() => {
  const status = document.getElementById('status');
  let timer = null;
  const say = (text, err) => { status.textContent = text; status.className = err ? 'err' : 'mut'; };
  async function poll() {
    try {
      const r = await (await fetch('/authorize/poll?rid=${rid}', { cache: 'no-store' })).json();
      if (r.status === 'done') { say('Signed in. Returning to your MCP client…'); location.replace(r.redirect); return; }
      if (r.status === 'failed') { say(r.error || 'The sign-in did not complete. Try again.', true); timer = null; return; }
      if (r.status === 'expired') { say('This request expired. Start the connection again from your MCP client.', true); timer = null; return; }
    } catch {}
    timer = setTimeout(poll, 1000);
  }
  document.getElementById('signin').addEventListener('click', () => {
    say('Waiting for you to approve in the DNSimple tab…');
    if (!timer) timer = setTimeout(poll, 1500);
  });
})();
</script>`;
    send(res, 200, page({ title: `Connect to ${environment}`, body, script }));
  }

  /** Start `dnsimple auth login` and send this tab to the consent page it produced. */
  async function startDnsimple(url, res) {
    const request = takeRequest(url.searchParams.get('rid'));
    if (!request) return errorPage(res, 400, 'This request expired.');
    let session;
    try {
      session = login.start({ sandbox, noBrowser: true });
      request.session = session;
      await login.waitForUrl(session);
    } catch (error) {
      return errorPage(res, 500, error.message);
    }
    if (!session.url) {
      return errorPage(res, 502, session.error || 'The dnsimple CLI did not produce a sign-in address. Is the CLI installed and up to date?');
    }
    res.writeHead(302, { Location: session.url, 'Cache-Control': 'no-store' });
    res.end();
  }

  function poll(url, res) {
    const rid = url.searchParams.get('rid');
    const request = takeRequest(rid);
    if (!request) return send(res, 200, { status: 'expired' });
    const s = request.session;
    if (!s) return send(res, 200, { status: 'idle' });
    if (s.state === 'pending') return send(res, 200, { status: 'pending' });
    if (s.state !== 'succeeded') {
      request.session = null;
      return send(res, 200, { status: 'failed', error: `The sign-in did not complete: ${s.error || s.state}` });
    }
    authCache = null;
    send(res, 200, { status: 'done', redirect: complete(rid, request) });
  }

  async function decide(req, res, approve) {
    let rid;
    try { ({ rid } = await readParams(req)); } catch { return errorPage(res, 400, 'Bad request.'); }
    const request = takeRequest(rid);
    if (!request) return errorPage(res, 400, 'This request expired.');
    let location;
    if (!approve) {
      requests.delete(rid);
      location = clientRedirect(request, { error: 'access_denied', error_description: 'The user cancelled.' });
    } else if (await cliIdentity({ fresh: true })) {
      location = complete(rid, request);
    } else {
      return errorPage(res, 409, 'The dnsimple CLI is no longer signed in.');
    }
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  async function token(req, res) {
    let p;
    try { p = await readParams(req); } catch { return oauthError(res, 400, 'invalid_request', 'Unreadable body.'); }
    const client = store.client(p.client_id);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client_id.');

    if (p.grant_type === 'authorization_code') {
      prune();
      const grant = typeof p.code === 'string' ? codes.get(p.code) : null;
      if (grant) codes.delete(p.code); // single use, whatever happens next
      const verifier = typeof p.code_verifier === 'string' ? p.code_verifier : '';
      if (!grant || grant.client_id !== client.client_id
        || (p.redirect_uri !== undefined && p.redirect_uri !== grant.redirect_uri)
        || sha256(verifier) !== grant.code_challenge) {
        return oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid, expired or does not match.');
      }
      return send(res, 200, store.issue(client.client_id));
    }

    if (p.grant_type === 'refresh_token') {
      const t = store.find(p.refresh_token ?? '', 'refresh');
      if (!t || t.client_id !== client.client_id) return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired.');
      // A refresh is only good while the CLI still holds a DNSimple credential.
      if (!(await cliIdentity({ fresh: true }))) {
        store.revoke(p.refresh_token);
        return oauthError(res, 400, 'invalid_grant', 'The DNSimple session ended. Sign in again.');
      }
      store.revoke(p.refresh_token);
      return send(res, 200, store.issue(client.client_id));
    }

    oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  async function revoke(req, res) {
    try { const p = await readParams(req); if (typeof p.token === 'string') store.revoke(p.token); } catch {}
    send(res, 200, {});
  }

  // --- MCP endpoint ---

  async function mcp(req, res, base) {
    const challenge = (extra = '') => ({
      'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"${extra}`,
    });
    const bearer = /^Bearer +(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!bearer) return oauthError(res, 401, 'invalid_token', 'Sign in with DNSimple to use this server.', challenge());
    if (!store.find(bearer, 'access') || !(await cliIdentity())) {
      return oauthError(res, 401, 'invalid_token', 'The access token is invalid or expired.', challenge(', error="invalid_token"'));
    }
    if (req.method !== 'POST') {
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (error) {
      return send(res, error.status || 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    // Stateless: every request gets its own server over the shared CLI wrapper.
    const { server } = await createServer(mcpOptions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // --- routing ---

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

  async function handle(req, res) {
    // DNS-rebinding guard: only answer to names that mean "this machine".
    const hostHeader = req.headers.host || '';
    const name = hostHeader.replace(/:\d+$/, '');
    if (!LOOPBACK.has(name) || (hostHeader.match(/:(\d+)$/)?.[1] ?? '80') !== String(boundPort)) {
      return send(res, 403, { error: 'forbidden', error_description: 'Unexpected Host header.' });
    }
    const base = `http://${hostHeader}`;
    const url = new URL(req.url, base);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = req.headers.origin;
    const route = `${req.method} ${path}`;

    // Discovery, registration and the token endpoint carry no ambient
    // credentials, so any origin may call them (browser-based MCP clients do).
    const open = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/register', '/token', '/revoke'];
    if (open.includes(path)) {
      for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    } else if (origin && origin !== 'null') {
      // Everything else acts for the user: same-origin pages and loopback web clients only.
      const o = parseUrl(origin);
      const sameOrigin = origin === base;
      if (path === '/mcp' ? !(o && isLoopbackUrl(o)) : !sameOrigin) {
        return send(res, 403, { error: 'forbidden', error_description: 'Unexpected Origin.' });
      }
      if (path === '/mcp') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', CORS['Access-Control-Allow-Headers']);
        res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      }
    }

    switch (route) {
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'DNSimple MCP' });
      case 'GET /.well-known/oauth-authorization-server':
        return send(res, 200, metadata(base));
      case 'POST /register': return register(req, res);
      case 'GET /authorize': return authorize(url, res);
      case 'GET /authorize/dnsimple': return startDnsimple(url, res);
      case 'GET /authorize/poll': return poll(url, res);
      case 'POST /authorize/approve': return decide(req, res, true);
      case 'POST /authorize/deny': return decide(req, res, false);
      case 'POST /token': return token(req, res);
      case 'POST /revoke': return revoke(req, res);
      case 'GET /':
        return send(res, 200, page({ title: 'DNSimple MCP', body: `<h1>DNSimple MCP</h1><p>This is an MCP server. Add <code>${esc(base)}/mcp</code> to your MCP client; it will ask you to sign in with DNSimple.</p>` }));
      default:
        if (path === '/mcp') return mcp(req, res, base);
        return send(res, 404, { error: 'not_found' });
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      send(res, error.status || 500, { error: 'server_error', error_description: error.message });
    });
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        boundPort = server.address().port;
        resolve(`http://${host}:${boundPort}`);
      });
    }),
    close() {
      login.cancel();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
