// End-to-end over stdio against a fake CLI: what argv does each call produce?
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { connect, FAKE } from './helpers.js';

let s;
before(async () => { s = await connect({ env: { DNSIMPLE_BIN: FAKE, DNSIMPLE_TOKEN: 'leaked-token' } }); });
after(() => s.close());

test('exposes the tool set with safety annotations', async () => {
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'dnsimple_auth_login', 'dnsimple_auth_logout', 'dnsimple_auth_status', 'dnsimple_auth_switch',
    'dnsimple_guide', 'dnsimple_mutate', 'dnsimple_query',
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.dnsimple_query.annotations.readOnlyHint, true);
  assert.equal(by.dnsimple_mutate.annotations.destructiveHint, true);
  assert.match(by.dnsimple_query.description, /- zones records list <zone>: List zone records/);
  assert.doesNotMatch(by.dnsimple_query.description, /zones records delete/);
  assert.match(by.dnsimple_mutate.description, /- registrar register <domain>: Register a domain/);
});

test('query builds argv: flags, --json, -- before positionals', async () => {
  const r = await s.call('dnsimple_query', {
    command: 'zones records list', args: ['example.com'], flags: { type: 'A', all: true, per_page: 5 }, account: 42,
  });
  assert.equal(r.isError, false);
  assert.deepEqual(r.json.argv, [
    'zones', 'records', 'list', '--type=A', '--all', '--per-page=5', '--json', '--no-color', '--account', '42', '--', 'example.com',
  ]);
});

test('an API token in the environment never reaches the CLI', async () => {
  const r = await s.call('dnsimple_query', { command: 'whoami' });
  assert.equal(r.json.token, null);
});

test('aliases and a "dnsimple" prefix are accepted', async () => {
  const r = await s.call('dnsimple_query', { command: 'dnsimple records get', args: ['example.com', 7] });
  assert.deepEqual(r.json.argv.slice(0, 3), ['zones', 'records', 'get']);
  assert.deepEqual(r.json.argv.slice(-3), ['--', 'example.com', '7']);
});

test('mutate adds --yes only where the command has it; false and repeated flags', async () => {
  const del = await s.call('dnsimple_mutate', { command: 'zones records delete', args: ['example.com', 7] });
  assert.ok(del.json.argv.includes('--yes'));
  const reg = await s.call('dnsimple_mutate', {
    command: 'registrar register', args: ['example.com'],
    flags: { 'registrant-id': 1, 'auto-renew': false, 'extended-attribute': ['a=1', 'b=2'] },
  });
  assert.ok(!reg.json.argv.includes('--yes'));
  assert.deepEqual(reg.json.argv.slice(2, 6), ['--registrant-id=1', '--auto-renew=false', '--extended-attribute=a=1', '--extended-attribute=b=2']);
});

test('a positional that looks like a flag stays a positional', async () => {
  const r = await s.call('dnsimple_query', { command: 'zones get', args: ['--token=x'] });
  assert.deepEqual(r.json.argv.slice(-2), ['--', '--token=x']);
});

test('read/write tools refuse each other\'s commands', async () => {
  const a = await s.call('dnsimple_query', { command: 'zones records delete', args: ['example.com', 7] });
  assert.equal(a.isError, true);
  assert.match(a.text, /changes data; call it with dnsimple_mutate/);
  const b = await s.call('dnsimple_mutate', { command: 'zones list' });
  assert.equal(b.isError, true);
  assert.match(b.text, /dnsimple_query/);
});

test('validation errors explain the fix', async () => {
  const cases = [
    [{ command: 'zones explode' }, /Unknown command "zones explode"\. Commands under "zones": .*zones list/],
    [{ command: 'zones get' }, /takes 1 positional argument\(s\): zones get <zone>\. Received 0/],
    [{ command: 'zones list', flags: { bogus: 1 } }, /has no flag --bogus\. Valid flags: --name-like, --sort, --all/],
    [{ command: 'zones list', flags: { token: 'abc' } }, /API tokens are not accepted/],
    [{ command: 'zones list', flags: { context: 'other' } }, /--context cannot be set/],
    [{ command: 'zones list --token abc' }, /command path only/],
    [{ command: 'auth logout' }, /dnsimple_auth_\* tools/],
  ];
  for (const [input, pattern] of cases) {
    const r = await s.call('dnsimple_query', input);
    assert.equal(r.isError, true, JSON.stringify(input));
    assert.match(r.text, pattern);
  }
  const m = await s.call('dnsimple_mutate', { command: 'zones records create', args: ['example.com'], flags: { type: 'A' } });
  assert.match(m.text, /requires --content/);
});

test('guide: reference and per-command help', async () => {
  assert.match((await s.call('dnsimple_guide')).text, /dnsimple_auth_login[\s\S]*# DNSimple CLI/);
  assert.equal((await s.call('dnsimple_guide', { command: 'records create' })).text, 'help for zones records create\n');
});

test('auth status reports identity and contexts', async () => {
  const r = await s.call('dnsimple_auth_status');
  assert.equal(r.json.authenticated, true);
  assert.equal(r.json.account_id, 1);
  assert.equal(r.json.contexts[0].name, 'production');
});

test('unauthenticated errors point at the OAuth login', async () => {
  const u = await connect({ env: { DNSIMPLE_BIN: FAKE, FAKE_UNAUTH: '1' } });
  try {
    const r = await u.call('dnsimple_query', { command: 'zones list' });
    assert.equal(r.isError, true);
    assert.match(r.text, /^not authenticated[\s\S]*Call dnsimple_auth_login/);
    assert.equal((await u.call('dnsimple_auth_status')).json.authenticated, false);
  } finally { await u.close(); }
});

test('--context pins every call and blocks switching', async () => {
  const p = await connect({ env: { DNSIMPLE_BIN: FAKE }, args: ['--context', 'work'] });
  try {
    const r = await p.call('dnsimple_query', { command: 'zones list' });
    assert.deepEqual(r.json.argv, ['zones', 'list', '--json', '--no-color', '--context', 'work', '--']);
    assert.match((await p.call('dnsimple_auth_switch', { context: 'other' })).text, /pinned to the "work" context/);
  } finally { await p.close(); }
});

test('a missing CLI is reported, not fatal', async () => {
  const m = await connect({ env: { DNSIMPLE_BIN: '/nonexistent/dnsimple' } });
  try {
    const r = await m.call('dnsimple_query', { command: 'zones list' });
    assert.equal(r.isError, true);
    assert.match(r.text, /dnsimple CLI was not found/);
  } finally { await m.close(); }
});
