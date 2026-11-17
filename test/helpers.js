import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

export const FAKE = fileURLToPath(new URL('./fake-dnsimple.js', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/dnsimple-mcp.js', import.meta.url));

/** Start the real server over stdio and connect an MCP client to it. */
export async function connect({ env = {}, args = [] } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, ...args],
    // Tests choose the sign-in path themselves instead of inheriting the runner's (CI has no display).
    env: { ...process.env, DNSIMPLE_MCP_HEADLESS: '0', ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '0' });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  await client.connect(transport);
  const call = async (name, input = {}) => {
    const res = await client.callTool({ name, arguments: input });
    const text = res.content[0].text;
    let json; try { json = JSON.parse(text); } catch {}
    return { isError: !!res.isError, text, json };
  };
  return { client, call, stderr: () => stderr, close: () => client.close() };
}
