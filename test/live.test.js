// Against the real dnsimple CLI. Read-only: nothing here changes the account.
// Skipped when the CLI is not installed; account tests skip when not signed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from './helpers.js';

const real = (...args) => execFileSync('dnsimple', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
let installed = true, signedIn = true;
try { real('--version'); } catch { installed = false; }
try { real('auth', 'status', '--json'); } catch { signedIn = false; }

const portOpen = (port) => new Promise((resolve) => {
  const sock = tcpConnect(port, '127.0.0.1');
  sock.on('connect', () => { sock.destroy(); resolve(true); });
  sock.on('error', () => resolve(false));
});

test('live: catalog comes from the installed CLI', { skip: !installed }, async () => {
  const s = await connect();
  try {
    const { tools } = await s.client.listTools();
    assert.match(tools.find((t) => t.name === 'dnsimple_query').description, /- zones list: List zones/);
    assert.match((await s.call('dnsimple_guide', { command: 'zones records create' })).text, /--ttl int/);
  } finally { await s.close(); }
});

test('live: read-only queries on the signed-in account', { skip: !installed || !signedIn }, async () => {
  const s = await connect();
  try {
    const status = (await s.call('dnsimple_auth_status')).json;
    assert.equal(status.authenticated, true);
    assert.ok(status.contexts.some((c) => c.active));

    const who = await s.call('dnsimple_query', { command: 'whoami' });
    assert.equal(who.isError, false, who.text);
    assert.equal(who.json.account_id, status.account_id);

    const zones = await s.call('dnsimple_query', { command: 'zones list', flags: { 'per-page': 1 } });
    assert.equal(zones.isError, false, zones.text);
    assert.equal(zones.json.pagination.per_page, 1);
    assert.ok(Array.isArray(zones.json.data));

    if (zones.json.data.length) {
      const zone = zones.json.data[0].name;
      const records = await s.call('dnsimple_query', { command: 'records list', args: [zone], flags: { type: 'NS' } });
      assert.equal(records.isError, false, records.text);
      assert.ok(records.json.data.every((r) => r.type === 'NS'));
    }

    const missing = await s.call('dnsimple_query', { command: 'zones get', args: ['no-such-zone.invalid'] });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not found/);
  } finally { await s.close(); }
});

test('live: OAuth login starts, returns a PKCE authorize URL, and is torn down with the server',
  { skip: !installed || process.platform === 'win32' }, async () => {
    // A throwaway HOME: the CLI sees no credentials and stores nothing in the real one.
    const home = mkdtempSync(join(tmpdir(), 'dnsimple-mcp-home-'));
    const s = await connect({ env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DNSIMPLE_MCP_NO_BROWSER: '1' } });
    let port;
    try {
      const q = await s.call('dnsimple_query', { command: 'zones list' });
      assert.equal(q.isError, true);
      assert.match(q.text, /not authenticated[\s\S]*dnsimple_auth_login/);

      const login = await s.call('dnsimple_auth_login', { wait_seconds: 0 });
      assert.equal(login.isError, false, login.text);
      assert.equal(login.json.status, 'pending');
      const url = new URL(login.json.authorize_url);
      assert.equal(url.origin + url.pathname, 'https://dnsimple.com/oauth/authorize');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(url.searchParams.get('code_challenge'));
      assert.ok(url.searchParams.get('state'));
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      assert.equal(redirect.hostname, '127.0.0.1');
      port = Number(redirect.port);
      assert.equal(await portOpen(port), true, 'CLI is listening for the OAuth callback');

      // A second call joins the login in progress instead of starting another.
      const again = await s.call('dnsimple_auth_login', { wait_seconds: 0 });
      assert.equal(again.json.authorize_url, login.json.authorize_url);

      const status = (await s.call('dnsimple_auth_status')).json;
      assert.equal(status.authenticated, false);
      assert.equal(status.login.state, 'pending');
    } finally {
      await s.close();
      // The callback listener must not outlive the server.
      for (let i = 0; i < 30 && await portOpen(port); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(await portOpen(port), false, 'login process was cleaned up');
      rmSync(home, { recursive: true, force: true });
    }
  });
