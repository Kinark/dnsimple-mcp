#!/usr/bin/env node
// Stand-in for the dnsimple CLI: serves the recorded reference and echoes argv.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const argv = process.argv.slice(2);
const fail = (msg) => { process.stderr.write(`Error: ${msg}\n`); process.exit(1); };
if (argv[0] === 'ai') {
  process.stdout.write(readFileSync(new URL('./fixtures/ai-full-0.11.1.md', import.meta.url)));
} else if (argv.includes('--help')) {
  process.stdout.write(`help for ${argv.filter((a) => a !== '--help').join(' ')}\n`);
} else if (argv[0] === 'auth' && argv[1] === 'login' && process.env.FAKE_LISTEN) {
  // Like the real CLI: listen on a loopback port for the OAuth callback, print
  // the authorize URL, and abort the login on a callback with the wrong state.
  const file = process.env.FAKE_STATE;
  const state = randomBytes(12).toString('base64url');
  const server = createServer((req, res) => {
    appendFileSync(`${file}.hits`, `${req.url}\n`);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const reason = url.searchParams.get('state') !== state ? 'state mismatch on callback'
      : url.searchParams.get('code') !== 'good-code' ? 'invalid_grant' : null;
    res.writeHead(reason ? 400 : 200, { 'Content-Type': 'text/html' });
    res.end(reason ? 'login failed' : 'signed in', () => {
      if (reason) fail(`browser login failed: oauth: ${reason}`);
      writeFileSync(file, argv.join(' '));
      process.exit(0);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const redirect = encodeURIComponent(`http://127.0.0.1:${server.address().port}/callback`);
    const url = `https://dnsimple.test/oauth/authorize?client_id=fake&redirect_uri=${redirect}&response_type=code&state=${state}`;
    try { execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]); } catch { process.stderr.write(`${url}\n`); }
  });
} else if (argv[0] === 'auth' && argv[1] === 'login') {
  // Like the real CLI: hand the authorize URL to the browser opener, then wait
  // for the approval (a FAKE_STATE.approve file) and store the credential.
  const state = process.env.FAKE_STATE;
  execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', ['https://dnsimple.test/oauth/authorize?client_id=fake&state=s']);
  const deadline = Date.now() + 10_000;
  while (!existsSync(`${state}.approve`)) {
    if (Date.now() > deadline) fail('login timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  writeFileSync(state, argv.join(' '));
} else if (argv[0] === 'auth' && argv[1] === 'logout') {
  if (process.env.FAKE_STATE) writeFileSync(process.env.FAKE_STATE + '.out', '');
} else if (process.env.FAKE_UNAUTH || (process.env.FAKE_STATE && (!existsSync(process.env.FAKE_STATE) || existsSync(process.env.FAKE_STATE + '.out')))) {
  fail("not authenticated. Run 'dnsimple auth login' to authenticate");
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ context: 'production', environment: 'production', account_id: 1 }));
} else if (argv[0] === 'auth' && argv[1] === 'list') {
  process.stdout.write(JSON.stringify({ contexts: [{ active: true, name: 'production' }] }));
} else {
  process.stdout.write(JSON.stringify({ argv, token: process.env.DNSIMPLE_TOKEN ?? null }));
}
