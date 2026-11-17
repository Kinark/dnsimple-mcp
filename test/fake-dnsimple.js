#!/usr/bin/env node
// Stand-in for the dnsimple CLI: serves the recorded reference and echoes argv.
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const fail = (msg) => { process.stderr.write(`Error: ${msg}\n`); process.exit(1); };
if (argv[0] === 'ai') {
  process.stdout.write(readFileSync(new URL('./fixtures/ai-full-0.11.1.md', import.meta.url)));
} else if (argv.includes('--help')) {
  process.stdout.write(`help for ${argv.filter((a) => a !== '--help').join(' ')}\n`);
} else if (process.env.FAKE_UNAUTH) {
  fail("not authenticated. Run 'dnsimple auth login' to authenticate");
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ context: 'production', environment: 'production', account_id: 1 }));
} else if (argv[0] === 'auth' && argv[1] === 'list') {
  process.stdout.write(JSON.stringify({ contexts: [{ active: true, name: 'production' }] }));
} else {
  process.stdout.write(JSON.stringify({ argv, token: process.env.DNSIMPLE_TOKEN ?? null }));
}
