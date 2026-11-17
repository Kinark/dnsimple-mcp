import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/http.js';
import { FAKE } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'dnsimple-mcp-http-'));
const cliState = join(dir, 'cli-credential');
process.env.FAKE_STATE = cliState; // the fake CLI is signed out until this file exists
const stateFile = join(dir, 'http.json');

let app = await createHttpApp({ bin: FAKE, port: 0, stateFile, headless: false });
let base = await app.listen();
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const REDIRECT = 'http://127.0.0.1:59999/callback';
const b64 = (buf) => buf.toString('base64url');
const pkce = () => { const verifier = b64(randomBytes(32)); return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) }; };
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), redirect: 'manual' });
const json = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

async function registerClient(redirect_uris = [REDIRECT]) {
  const res = await fetch(`${base}/register`, json({ client_name: 'Test Client', redirect_uris }));
  return { res, client: await res.json() };
}

/** Open the authorize page like a browser would; returns the request id embedded in it. */
async function openAuthorize(client, { challenge, state = 'st', redirect = REDIRECT } = {}) {
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256' });
  const res = await fetch(url, { redirect: 'manual' });
  const html = await res.text();
  return { res, html, rid: /name="rid" value="([^"]+)"/.exec(html)?.[1] };
}

/** The whole sign-in as the user does it: open the page, sign in with DNSimple, land back on the client. */
async function signIn(client, { challenge }) {
  const { res, html, rid } = await openAuthorize(client, { challenge });
  assert.equal(res.status, 200);
  assert.match(html, /Sign in with DNSimple/);

  assert.deepEqual(await (await fetch(`${base}/authorize/poll?rid=${rid}`)).json(), { status: 'idle' });
  const go = await fetch(`${base}/authorize/dnsimple?rid=${rid}`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.match(go.headers.get('location'), /^https:\/\/dnsimple\.test\/oauth\/authorize\?/);
  assert.deepEqual(await (await fetch(`${base}/authorize/poll?rid=${rid}`)).json(), { status: 'pending' });

  writeFileSync(`${cliState}.approve`, ''); // the user approves on dnsimple.com
  let done;
  for (let i = 0; i < 100 && done?.status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    done = await (await fetch(`${base}/authorize/poll?rid=${rid}`)).json();
  }
  assert.equal(done.status, 'done');
  const back = new URL(done.redirect);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st');
  return back.searchParams.get('code');
}

const exchange = (client, code, verifier, extra = {}) =>
  fetch(`${base}/token`, form({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT, ...extra }));

const rpc = (token, body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers = {}) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token && { Authorization: `Bearer ${token}` }), ...headers }, body: JSON.stringify(body) });

let tokens; let client;

test('an unauthenticated connection is challenged and discovery leads to this server', async () => {
  const res = await rpc(null);
  assert.equal(res.status, 401);
  const metaUrl = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate'))[1];
  const resource = await (await fetch(metaUrl)).json();
  assert.equal(resource.resource, `${base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [base]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base);
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal((await rpc('made-up-token')).status, 401);
});

test('registration only accepts safe redirect URIs', async () => {
  for (const bad of [['http://evil.example/cb'], ['javascript:alert(1)'], [], ['http://127.0.0.1/cb#frag']]) {
    assert.equal((await registerClient(bad)).res.status, 400, JSON.stringify(bad));
  }
  assert.equal((await registerClient(['cursor://anysphere.cursor-mcp/oauth/callback'])).res.status, 201);
});

test('authorize rejects unknown clients, foreign redirects and missing PKCE', async () => {
  ({ client } = await registerClient());
  const { challenge } = pkce();
  assert.equal((await openAuthorize({ client_id: 'nope' }, { challenge })).res.status, 400);
  const foreign = await openAuthorize(client, { challenge, redirect: 'http://127.0.0.1:59999/other' });
  assert.equal(foreign.res.status, 400);
  assert.equal(foreign.res.headers.get('location'), null);
  const noPkce = await openAuthorize(client, { challenge: '' });
  assert.equal(noPkce.res.status, 302);
  assert.equal(new URL(noPkce.res.headers.get('location')).searchParams.get('error'), 'invalid_request');
  // RFC 8252: a loopback redirect may come back on another port
  assert.equal((await openAuthorize(client, { challenge, redirect: 'http://127.0.0.1:41000/callback' })).res.status, 200);
});

test('cancelling returns access_denied to the client', async () => {
  const { rid } = await openAuthorize(client, pkce());
  const res = await fetch(`${base}/authorize/deny`, form({ rid }));
  assert.equal(res.status, 303);
  const back = new URL(res.headers.get('location'));
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 'st');
});

test('signed out: approving without a DNSimple sign-in is refused', async () => {
  const { rid } = await openAuthorize(client, pkce());
  assert.equal((await fetch(`${base}/authorize/approve`, form({ rid }))).status, 409);
});

test('sign-in runs the CLI login and yields a single-use, PKCE-bound code', async () => {
  const a = pkce();
  const wrong = await signIn(client, a);
  assert.equal(readFileSync(cliState, 'utf8'), 'auth login');
  assert.equal((await exchange(client, wrong, 'not-the-verifier')).status, 400);
  assert.equal((await exchange(client, wrong, a.verifier)).status, 400, 'a failed exchange burns the code');

  // Now signed in: the page offers to continue with the stored account.
  const b = pkce();
  const { html, rid } = await openAuthorize(client, b);
  assert.match(html, /signed in to DNSimple as account <strong>1<\/strong>/);
  const res = await fetch(`${base}/authorize/approve`, form({ rid }));
  assert.equal(res.status, 303);
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  const other = (await registerClient()).client;
  assert.equal((await exchange(other, code, b.verifier)).status, 400, 'code is bound to its client');

  const c = pkce();
  const again = await openAuthorize(client, c);
  const code2 = new URL((await fetch(`${base}/authorize/approve`, form({ rid: again.rid }))).headers.get('location')).searchParams.get('code');
  const ok = await exchange(client, code2, c.verifier);
  assert.equal(ok.status, 200);
  tokens = await ok.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal((await exchange(client, code2, c.verifier)).status, 400, 'codes are single use');
  assert.equal((await fetch(`${base}/authorize/approve`, form({ rid: again.rid }))).status, 400, 'request ids are single use');
});

test('the token opens the MCP endpoint; the login tool is gone over HTTP', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(transport);
  assert.match(mcp.getInstructions(), /OAuth on the MCP connection itself/);
  const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['dnsimple_auth_logout', 'dnsimple_auth_status', 'dnsimple_auth_switch', 'dnsimple_guide', 'dnsimple_mutate', 'dnsimple_query']);
  const res = await mcp.callTool({ name: 'dnsimple_query', arguments: { command: 'zones list' } });
  assert.deepEqual(JSON.parse(res.content[0].text).argv.slice(0, 3), ['zones', 'list', '--json']);
  await mcp.close();
});

test('the endpoint refuses foreign Host and Origin headers, and tokens are stored hashed', async () => {
  const status = (headers, path = '/mcp') => new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}`, ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(await status({ Host: 'evil.example' }), 403);
  assert.equal(await status({ Host: `evil.example:${new URL(base).port}` }), 403);
  assert.equal(await status({ Origin: 'https://evil.example' }), 403);
  assert.equal(await status({ Origin: 'https://evil.example' }, '/authorize/approve'), 403);
  const saved = readFileSync(stateFile, 'utf8');
  assert.ok(!saved.includes(tokens.access_token) && !saved.includes(tokens.refresh_token));
});

test('refresh rotates, and registrations and tokens survive a restart', async () => {
  await app.close();
  app = await createHttpApp({ bin: FAKE, port: 0, stateFile, headless: false });
  base = await app.listen();
  assert.equal((await rpc(tokens.access_token)).status, 200);

  const refresh = (t) => fetch(`${base}/token`, form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: t }));
  const res = await refresh(tokens.refresh_token);
  assert.equal(res.status, 200);
  const next = await res.json();
  assert.equal((await refresh(tokens.refresh_token)).status, 400, 'a used refresh token is dead');
  assert.equal((await rpc(next.access_token)).status, 200);
  tokens = next;
});

test('an SDK client goes through the whole flow by itself', async () => {
  let authUrl; let saved; let info; let verifier;
  const provider = {
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() { return { client_name: 'SDK Client', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    clientInformation: () => info,
    saveClientInformation: (i) => { info = i; },
    tokens: () => saved,
    saveTokens: (t) => { saved = t; },
    redirectToAuthorization: (u) => { authUrl = u; },
    saveCodeVerifier: (v) => { verifier = v; },
    codeVerifier: () => verifier,
  };
  const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  await assert.rejects(new Client({ name: 'sdk', version: '0' }).connect(first), UnauthorizedError);
  assert.equal(authUrl.origin, base);

  const html = await (await fetch(authUrl)).text();
  const rid = /name="rid" value="([^"]+)"/.exec(html)[1];
  const back = new URL((await fetch(`${base}/authorize/approve`, form({ rid }))).headers.get('location'));
  await first.finishAuth(back.searchParams.get('code'));

  const mcp = new Client({ name: 'sdk', version: '0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  const res = await mcp.callTool({ name: 'dnsimple_auth_status', arguments: {} });
  assert.equal(JSON.parse(res.content[0].text).authenticated, true);
  await mcp.close();
});

test('logging out of DNSimple ends the connection\'s session', async () => {
  const out = await rpc(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dnsimple_auth_logout', arguments: {} } });
  assert.equal(out.status, 200);
  await out.text(); // the result is streamed: wait for the tool to finish
  assert.ok(existsSync(`${cliState}.out`));
  const res = await rpc(tokens.access_token);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata=/);
  const refresh = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }));
  assert.equal(refresh.status, 400);
});
