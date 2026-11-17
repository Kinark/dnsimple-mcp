// HTTP mode published under another name: behind a proxy, on a headless host.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp } from '../src/http.js';
import { callbackOf } from '../src/login.js';
import { FAKE } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'dnsimple-mcp-remote-'));
const cliState = join(dir, 'cli-credential');
process.env.FAKE_STATE = cliState;
process.env.FAKE_LISTEN = '1';

const PUBLIC = 'https://dns-mcp.example.com';
const PROXY_CALLBACK = 'https://some-proxy.example/oauth/callback';
const KEY = 'correct-horse-battery-staple';

const app = await createHttpApp({
  bin: FAKE, port: 0, stateFile: join(dir, 'state', 'http.json'),
  publicUrl: `${PUBLIC}/`, allowedHosts: ['proxy.internal', 'other.internal:8443'], headless: true, accessKey: KEY,
});
const listenBase = await app.listen();
const port = app.server.address().port;
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

/** A request as the proxy would forward it: any Host header, straight to the bound port. */
function call(path, { host = 'dns-mcp.example.com', method = 'GET', headers = {}, json, form, target = port } = {}) {
  const body = json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: target, path, method,
      headers: { Host: host, ...(body && { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
const rid = (html) => /name="rid" value="([^"]+)"/.exec(html)?.[1];
const mcpBody = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const mcpHeaders = { Accept: 'application/json, text/event-stream' };

test('every advertised URL is the public one, whatever name the request arrived under', async () => {
  assert.equal(listenBase, PUBLIC);
  for (const host of ['dns-mcp.example.com', `127.0.0.1:${port}`, 'proxy.internal']) {
    const challenge = await call('/mcp', { host, method: 'POST', json: mcpBody, headers: mcpHeaders });
    assert.equal(challenge.status, 401, host);
    assert.equal(/resource_metadata="([^"]+)"/.exec(challenge.headers['www-authenticate'])[1], `${PUBLIC}/.well-known/oauth-protected-resource/mcp`);

    const resource = (await call('/.well-known/oauth-protected-resource/mcp', { host })).json;
    assert.equal(resource.resource, `${PUBLIC}/mcp`);
    assert.deepEqual(resource.authorization_servers, [PUBLIC]);

    const as = (await call('/.well-known/oauth-authorization-server', { host })).json;
    assert.equal(as.issuer, PUBLIC);
    assert.equal(as.authorization_endpoint, `${PUBLIC}/authorize`);
    assert.equal(as.token_endpoint, `${PUBLIC}/token`);
    assert.equal(as.registration_endpoint, `${PUBLIC}/register`);
    assert.equal(as.revocation_endpoint, `${PUBLIC}/revoke`);
    assert.ok(!JSON.stringify([resource, as]).includes('127.0.0.1'));
  }
});

test('Host: the public host and listed hosts are answered, anything else is refused', async () => {
  const ok = ['dns-mcp.example.com', 'dns-mcp.example.com:443', 'DNS-MCP.example.com', 'proxy.internal', 'proxy.internal:9000', 'other.internal:8443', `127.0.0.1:${port}`, `localhost:${port}`];
  for (const host of ok) assert.equal((await call('/.well-known/oauth-authorization-server', { host })).status, 200, host);
  const refused = ['evil.example', 'dns-mcp.example.com:8443', 'other.internal', 'other.internal:1', 'dns-mcp.example.com.evil.example', `127.0.0.1:${port + 1}`];
  for (const host of refused) {
    const res = await call('/.well-known/oauth-authorization-server', { host });
    assert.equal(res.status, 403, host);
    assert.match(res.json.error_description, /--public-url|--allowed-hosts/);
  }
});

test('Origin on /mcp: public origin, listed hosts and none at all pass; a foreign one does not', async () => {
  const mcp = (origin) => call('/mcp', { method: 'POST', json: mcpBody, headers: { ...mcpHeaders, ...(origin && { Origin: origin }) } });
  for (const origin of [undefined, PUBLIC, 'https://proxy.internal', 'http://other.internal:8443', 'http://localhost:6274']) {
    const res = await mcp(origin);
    assert.equal(res.status, 401, String(origin)); // past the Origin check, stopped only by the missing token
    if (origin) assert.equal(res.headers['access-control-allow-origin'], origin);
  }
  for (const origin of ['https://evil.example', 'https://other.internal', 'https://dns-mcp.example.com.evil.example']) {
    assert.equal((await mcp(origin)).status, 403, origin);
  }
  // The sign-in pages only take posts from the server's own origin.
  assert.equal((await call('/authorize/approve', { method: 'POST', form: { rid: 'x' }, headers: { Origin: 'https://proxy.internal' } })).status, 403);
  assert.notEqual((await call('/authorize/approve', { method: 'POST', form: { rid: 'x' }, headers: { Origin: PUBLIC } })).status, 403);
});

let client;

test('a remote https redirect_uri registers; plain http off loopback does not', async () => {
  const reg = (redirect_uris) => call('/register', { method: 'POST', json: { client_name: 'Remote Proxy', redirect_uris } });
  const ok = await reg([PROXY_CALLBACK]);
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json.redirect_uris, [PROXY_CALLBACK]);
  client = ok.json;
  assert.equal((await reg(['http://some-proxy.example/oauth/callback'])).status, 400);
  assert.equal((await reg([PROXY_CALLBACK, 'http://10.0.0.5/cb'])).status, 400);
  assert.equal((await reg(['http://127.0.0.1:7777/cb'])).status, 201);
});

const authorizePath = (challenge) => `/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: PROXY_CALLBACK, state: 'st', code_challenge: challenge, code_challenge_method: 'S256' })}`;

test('the sign-in page is locked behind the access key when the server is reachable remotely', async () => {
  assert.equal(app.accessKey, KEY);
  const page = await call(authorizePath(pkce().challenge));
  assert.equal(page.status, 200);
  assert.match(page.text, /Access key/);
  assert.doesNotMatch(page.text, /Sign in with DNSimple|Finish sign-in/);
  const id = rid(page.text);

  assert.equal((await call(`/authorize/dnsimple?rid=${id}`)).status, 400);
  assert.equal((await call('/authorize/approve', { method: 'POST', form: { rid: id } })).status, 403);
  assert.deepEqual((await call(`/authorize/poll?rid=${id}`)).json, { status: 'expired' });
  assert.equal((await call('/authorize/complete', { method: 'POST', json: { rid: id, redirect_url: 'http://127.0.0.1:1/callback?code=a&state=b' } })).json.status, 'error');

  const wrong = await call('/authorize/unlock', { method: 'POST', form: { rid: id, key: 'not-the-key' } });
  assert.equal(wrong.status, 403);
  assert.match(wrong.text, /not the access key/);
  const right = await call('/authorize/unlock', { method: 'POST', form: { rid: id, key: KEY } });
  assert.equal(right.status, 200);
  assert.match(right.text, /Sign in with DNSimple[\s\S]*Finish sign-in/);
});

test('headless sign-in over HTTP: the pasted address finishes it and the proxy gets its code', async () => {
  const { verifier, challenge } = pkce();
  const id = rid((await call(authorizePath(challenge))).text);
  const page = await call('/authorize/unlock', { method: 'POST', form: { rid: id, key: KEY } });
  assert.match(page.text, /Bring the address back/);
  assert.match(page.text, /name="redirect_url"/);
  const finish = (redirect_url) => call('/authorize/complete', { method: 'POST', json: { rid: id, redirect_url }, headers: { Origin: PUBLIC } });

  assert.match((await finish('http://127.0.0.1:1/callback?code=a&state=b')).json.error, /Do step 1 first/);

  const go = await call(`/authorize/dnsimple?rid=${id}`);
  assert.equal(go.status, 302);
  const cb = callbackOf(go.headers.location);
  const good = `http://127.0.0.1:${cb.port}/callback?code=good-code&state=${cb.state}`;

  for (const [bad, pattern] of [
    [good.replace('127.0.0.1', 'dns-mcp.example.com'), /does not point at this sign-in/],
    [good.replace(`:${cb.port}`, `:${Number(cb.port) + 1}`), /different sign-in attempt/],
    [good.replace(cb.state, 'forged'), /`state` in that address does not match/],
  ]) {
    const r = await finish(bad);
    assert.equal(r.json.status, 'error', bad);
    assert.match(r.json.error, pattern);
  }
  assert.equal(existsSync(`${cliState}.hits`), false);
  assert.deepEqual((await call(`/authorize/poll?rid=${id}`)).json, { status: 'pending' });

  const done = await finish(good);
  assert.equal(done.json.status, 'done', done.text);
  assert.equal(readFileSync(cliState, 'utf8'), 'auth login');
  const back = new URL(done.json.redirect);
  assert.equal(back.origin + back.pathname, PROXY_CALLBACK);
  assert.equal(back.searchParams.get('state'), 'st');
  // The page's poll, racing the form, is told the same thing.
  assert.deepEqual((await call(`/authorize/poll?rid=${id}`)).json, { status: 'done', redirect: done.json.redirect });

  const token = await call('/token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: client.client_id, code: back.searchParams.get('code'), code_verifier: verifier, redirect_uri: PROXY_CALLBACK } });
  assert.equal(token.status, 200);
  const list = await call('/mcp', { method: 'POST', json: mcpBody, headers: { ...mcpHeaders, Authorization: `Bearer ${token.json.access_token}` } });
  assert.equal(list.status, 200);
  assert.match(list.text, /dnsimple_query/);
  assert.doesNotMatch(list.text, /dnsimple_auth_complete/, 'over HTTP the connection is the sign-in');

  // Signed in now: the page offers the stored account, still behind the key.
  const next = rid((await call(authorizePath(pkce().challenge))).text);
  const signedIn = await call('/authorize/unlock', { method: 'POST', form: { rid: next, key: KEY } });
  assert.match(signedIn.text, /This server is signed in to DNSimple as account <strong>1<\/strong>/);
  assert.match(signedIn.text, /<summary>Use a different account<\/summary>/);
  assert.equal((await call('/authorize/approve', { method: 'POST', form: { rid: next } })).status, 303);
});

test('a public URL with a path, a generated key, and too many wrong keys', async () => {
  const stateFile = join(dir, 'prefixed', 'http.json');
  const prefixed = await createHttpApp({ bin: FAKE, port: 0, stateFile, publicUrl: 'https://example.com/dnsimple', headless: true });
  assert.equal(await prefixed.listen(), 'https://example.com/dnsimple');
  const target = prefixed.server.address().port;
  const at = (path, options) => call(path, { host: 'example.com', target, ...options });
  try {
    assert.match(prefixed.accessKey, /^[\w-]{32}$/);
    assert.equal(readFileSync(prefixed.accessKeyFile, 'utf8').trim(), prefixed.accessKey);

    // The proxy may forward the path as is or strip it.
    for (const path of ['/dnsimple/.well-known/openid-configuration', '/.well-known/oauth-authorization-server']) {
      const as = (await at(path)).json;
      assert.equal(as.issuer, 'https://example.com/dnsimple');
      assert.equal(as.token_endpoint, 'https://example.com/dnsimple/token');
    }
    assert.equal((await at('/dnsimple/mcp', { method: 'POST', json: mcpBody, headers: mcpHeaders })).status, 401);

    const reg = (await at('/dnsimple/register', { method: 'POST', json: { redirect_uris: [PROXY_CALLBACK] } })).json;
    const page = await at(`/dnsimple/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: PROXY_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
    assert.match(page.text, /action="\/dnsimple\/authorize\/unlock"/);
    const id = rid(page.text);
    for (let i = 0; i < 10; i++) assert.equal((await at('/authorize/unlock', { method: 'POST', form: { rid: id, key: `guess-${i}` } })).status, 403);
    assert.equal((await at('/authorize/unlock', { method: 'POST', form: { rid: id, key: prefixed.accessKey } })).status, 429, 'guessing is throttled');
  } finally { await prefixed.close(); }
});

test('loopback-only servers ask for no key; bad configuration is refused at startup', async () => {
  const local = await createHttpApp({ bin: FAKE, port: 0, stateFile: join(dir, 'local', 'http.json'), headless: false });
  assert.equal(local.accessKey, null);
  assert.equal(local.relay, false);
  const bound = await createHttpApp({ bin: FAKE, port: 0, host: '0.0.0.0', stateFile: join(dir, 'bound', 'http.json'), headless: false });
  assert.ok(bound.accessKey);
  assert.equal(bound.relay, true);

  await assert.rejects(createHttpApp({ bin: FAKE, publicUrl: 'ftp://example.com' }), /public URL must be an http\(s\) URL/);
  await assert.rejects(createHttpApp({ bin: FAKE, publicUrl: 'https://example.com/?x=1' }), /public URL/);
  await assert.rejects(createHttpApp({ bin: FAKE, allowedHosts: ['https://example.com'] }), /Invalid entry in the allowed hosts/);
  await assert.rejects(createHttpApp({ bin: FAKE, host: '0.0.0.0', accessKey: 'short' }), /at least 16 characters/);
});
