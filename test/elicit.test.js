// Sign-in prompted by the MCP client (elicitation): no auth tool call needed.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { callbackOf } from '../src/login.js';
import { FAKE } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/dnsimple-mcp.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'dnsimple-mcp-elicit-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A client that answers elicitations with `answer(request, log)`. */
async function connect({ env, capabilities = { url: {}, form: {} }, answer }) {
  const client = new Client({ name: 'test', version: '0' }, { capabilities: capabilities ? { elicitation: capabilities } : {} });
  const prompts = [];
  if (capabilities) client.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(req.params);
    return answer(req.params, prompts);
  });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [BIN],
    env: { ...process.env, DNSIMPLE_BIN: FAKE, ...env }, stderr: 'pipe',
  });
  await client.connect(transport);
  const call = async (name, input = {}) => {
    const res = await client.callTool({ name, arguments: input });
    return { isError: !!res.isError, text: res.content[0].text };
  };
  return { client, prompts, call };
}

const landing = (authorizeUrl, code = 'good-code') => {
  const cb = callbackOf(authorizeUrl);
  return `http://127.0.0.1:${cb.port}${cb.path}?code=${code}&state=${cb.state}`;
};

test('headless (Docker): a signed-out call prompts the link, then the address, then succeeds', async () => {
  let link;
  const s = await connect({
    env: { DNSIMPLE_MCP_HEADLESS: '1', FAKE_LISTEN: '1', FAKE_STATE: join(dir, 'headless') },
    answer: (p, prompts) => {
      if (p.mode === 'url') { link = p.url; return { action: 'accept' }; }
      // First paste is wrong on purpose: the form comes back with the reason.
      return prompts.filter((x) => x.mode === 'form').length === 1
        ? { action: 'accept', content: { address: 'http://example.com/nope' } }
        : { action: 'accept', content: { address: landing(link) } };
    },
  });
  try {
    const res = await s.call('dnsimple_query', { command: 'zones list' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /"argv"/);
    assert.deepEqual(s.prompts.map((p) => p.mode), ['url', 'form', 'form']);
    assert.match(s.prompts[0].url, /^https:\/\/dnsimple\.test\/oauth\/authorize\?/);
    assert.match(s.prompts[1].message, /cannot be reached[\s\S]*Paste that whole address/);
    assert.match(s.prompts[2].message, /does not point at this sign-in/);

    const again = await s.call('dnsimple_query', { command: 'zones list' });
    assert.equal(again.isError, false);
    assert.equal(s.prompts.length, 3, 'signed in: no further prompts');
  } finally { await s.client.close(); }
});

test('headless, form-only client: the link is in the form message', async () => {
  const s = await connect({
    env: { DNSIMPLE_MCP_HEADLESS: '1', FAKE_LISTEN: '1', FAKE_STATE: join(dir, 'form') },
    capabilities: { form: {} },
    answer: (p) => ({ action: 'accept', content: { address: landing(p.message.match(/https:\/\/dnsimple\.test\S+/)[0]) } }),
  });
  try {
    const res = await s.call('dnsimple_query', { command: 'zones list' });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(s.prompts.map((p) => p.mode ?? 'form'), ['form']);
  } finally { await s.client.close(); }
});

test('local: the client opens the link and the CLI callback finishes on its own', async () => {
  const s = await connect({
    env: { DNSIMPLE_MCP_HEADLESS: '0', FAKE_LISTEN: '1', FAKE_STATE: join(dir, 'local') },
    answer: (p) => {
      // Stands in for the user's browser following the redirect.
      setTimeout(() => fetch(landing(p.url)).catch(() => {}), 100);
      return { action: 'accept' };
    },
  });
  try {
    const res = await s.call('dnsimple_mutate', { command: 'zones records create', args: ['example.com'], flags: { type: 'A', name: 'www', content: '1.2.3.4' } });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(s.prompts.map((p) => p.mode), ['url']);
  } finally { await s.client.close(); }
});

test('declining the prompt fails the call cleanly', async () => {
  const s = await connect({
    env: { DNSIMPLE_MCP_HEADLESS: '1', FAKE_LISTEN: '1', FAKE_STATE: join(dir, 'decline') },
    answer: () => ({ action: 'decline' }),
  });
  try {
    const res = await s.call('dnsimple_query', { command: 'zones list' });
    assert.equal(res.isError, true);
    assert.match(res.text, /cancelled by the user/);
  } finally { await s.client.close(); }
});

test('a client without elicitation keeps the tool-based sign-in', async () => {
  const s = await connect({
    env: { DNSIMPLE_MCP_HEADLESS: '1', FAKE_LISTEN: '1', FAKE_STATE: join(dir, 'none') },
    capabilities: null,
    answer: () => { throw new Error('not expected'); },
  });
  try {
    const res = await s.call('dnsimple_query', { command: 'zones list' });
    assert.equal(res.isError, true);
    assert.match(res.text, /Call dnsimple_auth_login/);
  } finally { await s.client.close(); }
});
