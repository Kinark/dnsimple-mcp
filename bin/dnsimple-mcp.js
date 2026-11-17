#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.js';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(`dnsimple-mcp — MCP server (stdio) for DNSimple, wrapping the dnsimple CLI with OAuth login.

Usage: dnsimple-mcp [--context <name>]

  --context <name>   Pin every call to one stored CLI context (also: DNSIMPLE_MCP_CONTEXT)

Environment:
  DNSIMPLE_BIN       Path to the dnsimple CLI (default: "dnsimple" on PATH)
`);
  process.exit(0);
}

const at = argv.indexOf('--context');
const context = (at !== -1 ? argv[at + 1] : undefined) || process.env.DNSIMPLE_MCP_CONTEXT || undefined;

const { server, close } = await createServer({ context });

const shutdown = () => { close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown); // client went away: don't leave a login listening

await server.connect(new StdioServerTransport());
