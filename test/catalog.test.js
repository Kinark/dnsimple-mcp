import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCatalog, normalizeCommand, usage } from '../src/catalog.js';

const md = readFileSync(new URL('./fixtures/ai-full-0.11.1.md', import.meta.url), 'utf8');
const { commands, aliases } = parseCatalog(md);

test('parses every command of CLI 0.11.1', () => {
  assert.equal(commands.size, 93);
  for (const path of ['accounts list', 'whoami', 'zones records create', 'certificates letsencrypt purchase', 'registrar transfer-lock status']) {
    assert.ok(commands.has(path), path);
  }
});

test('auth commands are not exposed as generic commands', () => {
  assert.deepEqual([...commands.keys()].filter((c) => c.startsWith('auth')), []);
});

test('positionals and flags', () => {
  const create = commands.get('zones records create');
  assert.equal(usage(create), 'zones records create <zone>');
  assert.deepEqual([...create.flags.keys()], ['type', 'name', 'content', 'ttl', 'priority', 'regions']);
  assert.equal(create.flags.get('type').required, true);
  assert.equal(create.flags.get('ttl').required, false);
  assert.equal(create.flags.get('type').description, 'Record type (A, AAAA, CNAME, MX, TXT, etc.)');
  assert.ok(commands.get('zones records delete').flags.has('yes'));
  assert.equal(commands.get('certificates letsencrypt issue-renewal').positionals.length, 3);
});

test('aliases resolve to canonical paths', () => {
  assert.equal(aliases.records, 'zones records');
  assert.equal(aliases.certs, 'certificates');
  assert.equal(normalizeCommand('  dnsimple  records   list ', aliases), 'zones records list');
  assert.equal(normalizeCommand('certs get', aliases), 'certificates get');
});

test('read/write split: nothing that changes state is read-only', () => {
  const reads = [...commands.values()].filter((c) => c.readOnly).map((c) => c.path);
  assert.equal(reads.length, 44);
  const mutating = /\b(create|delete|update|enable|disable|apply|unapply|register|renew|restore|transfer|transfer-out|purchase|issue|issue-renewal|change|accept|reject|initiate|activate|deactivate)$/;
  assert.deepEqual(reads.filter((p) => mutating.test(p)), []);
  for (const c of commands.values()) {
    assert.ok(c.readOnly || mutating.test(c.path), `unclassified write: ${c.path}`);
  }
});

test('unknown format degrades to an empty catalog', () => {
  assert.equal(parseCatalog('nothing useful').commands.size, 0);
});
