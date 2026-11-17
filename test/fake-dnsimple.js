#!/usr/bin/env node
// Stand-in for the dnsimple CLI: serves the recorded reference and echoes argv.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const fail = (msg) => { process.stderr.write(`Error: ${msg}\n`); process.exit(1); };
if (argv[0] === 'ai') {
  process.stdout.write(readFileSync(new URL('./fixtures/ai-full-0.11.1.md', import.meta.url)));
} else if (argv.includes('--help')) {
  process.stdout.write(`help for ${argv.filter((a) => a !== '--help').join(' ')}\n`);
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
