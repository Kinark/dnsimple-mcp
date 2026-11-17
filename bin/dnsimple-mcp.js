#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpApp } from '../src/http.js';
import { createServer } from '../src/server.js';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(`dnsimple-mcp — MCP server for DNSimple, wrapping the dnsimple CLI with OAuth login.

Usage:
  dnsimple-mcp --http [--port <n>] [--sandbox] [--context <name>]
      HTTP server on 127.0.0.1. The MCP connection itself asks for OAuth: the
      client opens a sign-in page that signs you in with DNSimple.
  dnsimple-mcp [--context <name>]
      stdio server. Sign-in happens through the dnsimple_auth_login tool.

  --http             Serve MCP over HTTP at http://127.0.0.1:<port>/mcp
  --port <n>         HTTP port (default 8377; also: DNSIMPLE_MCP_PORT)
  --sandbox          HTTP sign-in uses the DNSimple sandbox environment
  --context <name>   Pin every call to one stored CLI context (also: DNSIMPLE_MCP_CONTEXT)

Environment:
  DNSIMPLE_BIN            Path to the dnsimple CLI (default: "dnsimple" on PATH)
  DNSIMPLE_MCP_STATE_DIR  Where the HTTP server keeps its client registrations and
                          hashed tokens (default: ~/.local/state/dnsimple-mcp)
`);
  process.exit(0);
}

const option = (name) => { const at = argv.indexOf(name); return at !== -1 ? argv[at + 1] : undefined; };
const context = option('--context') || process.env.DNSIMPLE_MCP_CONTEXT || undefined;

if (argv.includes('--http')) {
  const port = Number(option('--port') ?? process.env.DNSIMPLE_MCP_PORT ?? 8377);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('dnsimple-mcp: --port must be a number between 0 and 65535.\n');
    process.exit(2);
  }
  const app = await createHttpApp({ context, port, sandbox: argv.includes('--sandbox') });
  let base;
  try { base = await app.listen(); } catch (error) {
    process.stderr.write(`dnsimple-mcp: cannot listen on port ${port}: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`dnsimple-mcp listening on ${base}/mcp\n  claude mcp add --transport http dnsimple ${base}/mcp\n`);
  const shutdown = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  const { server, close } = await createServer({ context });

  const shutdown = () => { close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown); // client went away: don't leave a login listening

  await server.connect(new StdioServerTransport());
}
