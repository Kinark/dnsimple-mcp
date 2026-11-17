// Sign-in when the server has no browser next to it: the user approves on
// another machine and brings the loopback address back by hand.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callbackOf, isHeadless } from '../src/login.js';
import { connect, FAKE } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/dnsimple-mcp.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'dnsimple-mcp-headless-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const headless = (name, extra = {}) => {
  const state = join(dir, name);
  return { state, env: { DNSIMPLE_BIN: FAKE, DNSIMPLE_MCP_HEADLESS: '1', FAKE_LISTEN: '1', FAKE_STATE: state, ...extra } };
};

/** The address the user's browser would end on after approving. */
function landing(authorizeUrl, { code = 'good-code' } = {}) {
  const cb = callbackOf(authorizeUrl);
  return { cb, url: `http://127.0.0.1:${cb.port}${cb.path}?code=${code}&state=${cb.state}` };
}

test('headless is detected from the environment', () => {
  assert.equal(isHeadless({ DNSIMPLE_MCP_HEADLESS: '1' }), true);
  assert.equal(isHeadless({ DNSIMPLE_MCP_HEADLESS: '0', container: 'docker' }), false);
  assert.equal(isHeadless({ container: 'docker', DISPLAY: ':0' }), true);
  if (!existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) {
    assert.equal(isHeadless({ DISPLAY: ':0' }), false);
    assert.equal(isHeadless({}), process.platform === 'linux');
  }
});

test('two-step sign-in: the link comes back at once, the pasted address finishes it', async () => {
  const { state, env } = headless('ok');
  const s = await connect({ env });
  try {
    assert.match(s.client.getInstructions(), /two steps[\s\S]*dnsimple_auth_login[\s\S]*dnsimple_auth_complete/);
    const { tools } = await s.client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.match(by.dnsimple_auth_login.description, /step 1 of 2[\s\S]*dnsimple_auth_complete/);
    assert.match(by.dnsimple_auth_complete.description, /step 2 of 2[\s\S]*redirect_url/);

    const signedOut = await s.call('dnsimple_query', { command: 'zones list' });
    assert.equal(signedOut.isError, true);
    assert.match(signedOut.text, /Not signed in to DNSimple\. Call dnsimple_auth_login/);

    const early = await s.call('dnsimple_auth_complete', { redirect_url: 'http://127.0.0.1:1/callback?code=x&state=y' });
    assert.equal(early.isError, true);
    assert.match(early.text, /No sign-in is in progress[\s\S]*Call dnsimple_auth_login/);

    const started = Date.now();
    const login = await s.call('dnsimple_auth_login', { wait_seconds: 300 });
    assert.ok(Date.now() - started < 10_000, 'does not wait for an approval that cannot arrive');
    assert.equal(login.isError, false);
    assert.equal(login.json.status, 'action_required');
    assert.match(login.json.authorize_url, /^https:\/\/dnsimple\.test\/oauth\/authorize\?/);
    assert.equal(login.json.steps.length, 2);
    assert.match(login.json.steps[0], /^Step 1: Give the user authorize_url/);
    assert.match(login.json.steps[1], /^Step 2: [\s\S]*http:\/\/127\.0\.0\.1:\d+\/callback[\s\S]*dnsimple_auth_complete/);
    assert.ok(login.json.expires_in_seconds > 200 && login.json.expires_in_seconds <= 300);

    const again = await s.call('dnsimple_auth_login');
    assert.equal(again.json.authorize_url, login.json.authorize_url, 'a pending sign-in keeps its link');

    const { cb, url } = landing(login.json.authorize_url);
    const refused = [
      [`http://evil.example:${cb.port}/callback?code=good-code&state=${cb.state}`, /does not point at this sign-in/],
      [`https://127.0.0.1:${cb.port}/callback?code=good-code&state=${cb.state}`, /does not point at this sign-in/],
      [`http://127.0.0.1:${Number(cb.port) + 1}/callback?code=good-code&state=${cb.state}`, /different sign-in attempt/],
      [`http://127.0.0.1:${cb.port}/other?code=good-code&state=${cb.state}`, /different sign-in attempt/],
      [`http://127.0.0.1:${cb.port}/callback?code=good-code&state=someone-else`, /`state` in that address does not match/],
      [`http://127.0.0.1:${cb.port}/callback?code=good-code`, /`state` in that address does not match/],
      [`http://127.0.0.1:${cb.port}/callback?state=${cb.state}`, /no authorization `code`/],
      ['127.0.0.1 callback', /not a complete address/],
    ];
    for (const [redirect_url, pattern] of refused) {
      const r = await s.call('dnsimple_auth_complete', { redirect_url });
      assert.equal(r.isError, true, redirect_url);
      assert.match(r.text, pattern, redirect_url);
    }
    assert.equal(existsSync(`${state}.hits`), false, 'a refused address never reaches the CLI');
    const status = await s.call('dnsimple_auth_status');
    assert.equal(status.json.authenticated, false);
    assert.equal(status.json.login.state, 'pending');
    assert.equal(status.json.login.authorize_url, login.json.authorize_url);

    // Pasted from the address bar, with the stray whitespace that comes with it.
    const done = await s.call('dnsimple_auth_complete', { redirect_url: `  ${url}\n` });
    assert.equal(done.isError, false, done.text);
    assert.equal(done.json.status, 'authenticated');
    assert.equal(done.json.account_id, 1);
    assert.equal(readFileSync(state, 'utf8'), 'auth login', 'the CLI stored its own credential');
    assert.equal(readFileSync(`${state}.hits`, 'utf8'), `/callback?code=good-code&state=${cb.state}\n`);

    assert.equal((await s.call('dnsimple_query', { command: 'zones list' })).isError, false);
  } finally { await s.close(); }
});

test('an expired sign-in is refused and a new one gets a new link', async () => {
  const { state, env } = headless('expired', { DNSIMPLE_MCP_LOGIN_TTL: '1' });
  const s = await connect({ env });
  try {
    const login = await s.call('dnsimple_auth_login');
    const { url } = landing(login.json.authorize_url);
    await new Promise((r) => setTimeout(r, 1500));

    const late = await s.call('dnsimple_auth_complete', { redirect_url: url });
    assert.equal(late.isError, true);
    assert.match(late.text, /expired[\s\S]*Call dnsimple_auth_login to start a new sign-in/);
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(`${state}.hits`), false);

    const next = await s.call('dnsimple_auth_login');
    assert.equal(next.json.status, 'action_required');
    assert.notEqual(next.json.authorize_url, login.json.authorize_url);
  } finally { await s.close(); }
});

test('a code DNSimple rejects is reported and the sign-in can be restarted', async () => {
  const { state, env } = headless('rejected');
  const s = await connect({ env });
  try {
    const login = await s.call('dnsimple_auth_login');
    const r = await s.call('dnsimple_auth_complete', { redirect_url: landing(login.json.authorize_url, { code: 'stale' }).url });
    assert.equal(r.isError, true);
    assert.match(r.text, /DNSimple did not accept the sign-in: [\s\S]*invalid_grant[\s\S]*Call dnsimple_auth_login/);
    assert.equal(existsSync(state), false);
    assert.equal((await s.call('dnsimple_auth_login')).json.status, 'action_required');
  } finally { await s.close(); }
});

test('a browser on another machine also works when the server is not headless', async () => {
  const { env } = headless('mixed', { DNSIMPLE_MCP_HEADLESS: '0', DNSIMPLE_MCP_NO_BROWSER: '1' });
  const s = await connect({ env });
  try {
    const login = await s.call('dnsimple_auth_login', { wait_seconds: 0 });
    assert.equal(login.json.status, 'pending');
    assert.match(login.json.message, /dnsimple_auth_complete/);
    const done = await s.call('dnsimple_auth_complete', { redirect_url: landing(login.json.authorize_url).url });
    assert.equal(done.json.status, 'authenticated');
  } finally { await s.close(); }
});

/** Raw process, no SDK: what a host sees on the pipes. */
function run(args, env, stdin = 'pipe') {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: [stdin, 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const until = async (test, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!test(out)) {
      if (Date.now() > deadline) throw new Error(`timed out; stdout=${out.stdout} stderr=${out.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { child, out, until };
}

test('stdio answers initialize and tools/list at once without a CLI, and keeps stdout for the protocol', async () => {
  const { child, out, until } = run([], { DNSIMPLE_BIN: '/nonexistent/dnsimple', DNSIMPLE_MCP_HEADLESS: '1' });
  try {
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    const started = Date.now();
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'dnsimple_auth_login', arguments: {} } });
    await until((o) => o.stdout.split('\n').filter(Boolean).length >= 3);
    assert.ok(Date.now() - started < 5000);

    const messages = out.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)); // every stdout line is JSON-RPC
    const by = Object.fromEntries(messages.map((m) => [m.id, m]));
    assert.equal(by[1].result.serverInfo.name, 'dnsimple');
    assert.equal(by[2].result.tools.length, 8);
    assert.equal(by[3].result.isError, true);
    assert.match(by[3].result.content[0].text, /dnsimple CLI was not found/);
    await until((o) => /dnsimple-mcp: The dnsimple CLI was not found \(looked for "\/nonexistent\/dnsimple"\)/.test(o.stderr));
  } finally { child.kill(); }
});

test('--http runs with stdin closed and reports a missing CLI on stderr', async () => {
  const { child, out, until } = run(['--http', '--port', '0'], { DNSIMPLE_BIN: '/nonexistent/dnsimple', DNSIMPLE_MCP_STATE_DIR: join(dir, 'http-state') }, 'ignore');
  try {
    await until((o) => /listening on (http:\/\/127\.0\.0\.1:\d+)\/mcp/.test(o.stderr) && /CLI was not found/.test(o.stderr));
    const base = /listening on (http:\/\/127\.0\.0\.1:\d+)\/mcp/.exec(out.stderr)[1];
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 200);
    assert.equal(child.exitCode, null);
    assert.equal(out.stdout, '');
  } finally { child.kill(); }
});
