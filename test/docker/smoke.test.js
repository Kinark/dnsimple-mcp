// Builds the image and talks to it the way an MCP host does. Needs Docker;
// run with `npm run test:docker`. DNSIMPLE_MCP_IMAGE skips the build and tests
// that image instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const image = process.env.DNSIMPLE_MCP_IMAGE || 'dnsimple-mcp:smoke';
const volume = `dnsimple-mcp-smoke-${randomBytes(4).toString('hex')}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(() => {
  if (!process.env.DNSIMPLE_MCP_IMAGE) execFileSync('docker', ['build', '-t', image, root], { stdio: 'inherit' });
}, { timeout: 15 * 60_000 });
after(() => { try { docker('volume', 'rm', '-f', volume); } catch {} });

test('the image runs as a non-root user with the pinned CLI and /data as its home', () => {
  const out = docker('run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'sh', image, '-c',
    'id -u; dnsimple --version; echo "$HOME $DNSIMPLE_MCP_STATE_DIR"; touch /data/.writable && echo writable');
  const [uid, version, env, writable] = out.split('\n');
  assert.notEqual(uid, '0');
  assert.match(version, /^dnsimple version \d+\.\d+\.\d+$/);
  assert.equal(env, '/data /data/dnsimple-mcp');
  assert.equal(writable, 'writable');
});

test('docker run -i --stdio: initialize and tools/list answer at once, and sign-in is the two-step headless one', async () => {
  const transport = new StdioClientTransport({ command: 'docker', args: ['run', '-i', '--rm', '-v', `${volume}:/data`, image], stderr: 'pipe' });
  const client = new Client({ name: 'smoke', version: '0' });
  const started = Date.now();
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, 'dnsimple');
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.ok(Date.now() - started < 20_000, 'handshake does not wait on anything');
    assert.deepEqual(names, [
      'dnsimple_auth_complete', 'dnsimple_auth_login', 'dnsimple_auth_logout', 'dnsimple_auth_status', 'dnsimple_auth_switch',
      'dnsimple_guide', 'dnsimple_mutate', 'dnsimple_query',
    ]);
    const call = async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return { isError: !!res.isError, text: res.content[0].text };
    };

    const query = await call('dnsimple_query', { command: 'zones list' });
    assert.equal(query.isError, true);
    assert.match(query.text, /Not signed in to DNSimple\. Call dnsimple_auth_login/);

    // The real CLI under a pty, no browser: the link comes straight back.
    const login = JSON.parse((await call('dnsimple_auth_login')).text);
    assert.equal(login.status, 'action_required');
    const authorize = new URL(login.authorize_url);
    assert.match(authorize.href, /^https:\/\/dnsimple\.com\/oauth\/authorize\?/);
    const redirect = new URL(authorize.searchParams.get('redirect_uri'));
    assert.equal(redirect.hostname, '127.0.0.1');

    const forged = await call('dnsimple_auth_complete', { redirect_url: `${redirect.href}?code=x&state=forged` });
    assert.match(forged.text, /`state` in that address does not match/);
    assert.equal(JSON.parse((await call('dnsimple_auth_status')).text).login.state, 'pending');
  } finally { await client.close(); }
});

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('default (http) serves the OAuth-protected endpoint under the published address', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const name = `${volume}-http`;
  // Detached, stdin closed: HTTP mode must not need it.
  docker('run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8377`, '-v', `${volume}:/data`, '-e', `DNSIMPLE_MCP_PUBLIC_URL=${base}`, image, '--http');
  // The server logs to stderr.
  const logs = () => { const r = spawnSync('docker', ['logs', name], { encoding: 'utf8' }); return r.stdout + r.stderr; };
  try {
    let meta;
    for (let i = 0; i < 100 && !meta; i++) {
      try { meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json(); } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    assert.equal(meta?.issuer, base, logs());
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), new RegExp(`resource_metadata="${base}/`));
    // Bound to 0.0.0.0 in the image, so the sign-in page is behind the access key printed in the log.
    const key = /access key: (\S+)/.exec(logs());
    assert.ok(key, 'the access key is in the log');
    assert.equal(docker('exec', name, 'cat', '/data/dnsimple-mcp/access-key'), key[1]);
  } finally {
    try { docker('rm', '-f', name); } catch {}
  }
});

test('a signal stops the stdio container promptly', async () => {
  const child = spawn('docker', ['run', '-i', '--rm', image], { stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise((r) => setTimeout(r, 1500));
  const started = Date.now();
  child.stdin.end(); // the host went away
  await new Promise((resolve) => child.on('exit', resolve));
  assert.ok(Date.now() - started < 8000);
});
