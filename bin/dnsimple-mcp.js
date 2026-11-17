#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpApp } from '../src/http.js';
import { createServer } from '../src/server.js';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(`dnsimple-mcp — MCP server for DNSimple, wrapping the dnsimple CLI with OAuth login.

Usage:
  dnsimple-mcp --http [--port <n>] [--host <addr>] [--public-url <url>]
               [--allowed-hosts <h1,h2>] [--sandbox] [--context <name>]
      HTTP server (127.0.0.1 by default). The MCP connection itself asks for
      OAuth: the client opens a sign-in page that signs you in with DNSimple.
  dnsimple-mcp --stdio [--context <name>]
      stdio server. Sign-in happens through the dnsimple_auth_login tool.
      Without --http or --stdio, DNSIMPLE_MCP_TRANSPORT decides (default stdio;
      the Docker image sets http).

  --http                   Serve MCP over HTTP at http://<host>:<port>/mcp
  --stdio                  Serve MCP over stdin/stdout
  --port <n>               HTTP port (default 8377; also: DNSIMPLE_MCP_PORT)
  --host <addr>            Address to bind (default 127.0.0.1; also: DNSIMPLE_MCP_HOST)
  --public-url <url>       Base URL clients reach the server at, e.g. https://dns-mcp.example.com.
                           All OAuth metadata is built from it (also: DNSIMPLE_MCP_PUBLIC_URL)
  --allowed-hosts <h1,h2>  Extra Host header values to answer to; loopback and the
                           public URL's host always are (also: DNSIMPLE_MCP_ALLOWED_HOSTS)
  --sandbox                HTTP sign-in uses the DNSimple sandbox environment
  --context <name>         Pin every call to one stored CLI context (also: DNSIMPLE_MCP_CONTEXT)

Environment:
  DNSIMPLE_MCP_TRANSPORT   http or stdio, used when neither flag is given (default stdio)
  DNSIMPLE_BIN             Path to the dnsimple CLI (default: "dnsimple" on PATH)
  DNSIMPLE_MCP_STATE_DIR   Where the HTTP server keeps its client registrations, hashed
                           tokens and access key (default: ~/.local/state/dnsimple-mcp)
  DNSIMPLE_MCP_HEADLESS    1: no browser can be opened next to the server, so sign-in hands
                           out a link and takes the resulting address back. 0: never.
                           Default: detected (container, or Linux without a display)
  DNSIMPLE_MCP_ACCESS_KEY  Key the sign-in page asks for when the HTTP server can be reached
                           from other machines (default: generated, printed at startup)
  DNSIMPLE_MCP_LOGIN_TTL   Seconds a pending sign-in stays valid (default 300 headless, 600 otherwise)
`);
  process.exit(0);
}

const option = (name) => {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at !== -1 ? argv[at + 1] : undefined;
};
const die = (message, code = 2) => { process.stderr.write(`dnsimple-mcp: ${message}\n`); process.exit(code); };
const context = option('--context') || process.env.DNSIMPLE_MCP_CONTEXT || undefined;

// Said once at startup; the tools repeat it as an error when called.
const reportCli = (cli) => cli.catalog().catch((error) => process.stderr.write(`dnsimple-mcp: ${error.message}\n`));

const transport = argv.includes('--http') ? 'http'
  : argv.includes('--stdio') ? 'stdio'
  : (process.env.DNSIMPLE_MCP_TRANSPORT || 'stdio').toLowerCase();
if (transport !== 'http' && transport !== 'stdio') die(`DNSIMPLE_MCP_TRANSPORT must be http or stdio, not "${transport}".`);

if (transport === 'http') {
  const port = Number(option('--port') ?? process.env.DNSIMPLE_MCP_PORT ?? 8377);
  if (!Number.isInteger(port) || port < 0 || port > 65535) die('--port must be a number between 0 and 65535.');
  const host = option('--host') || process.env.DNSIMPLE_MCP_HOST || '127.0.0.1';
  const publicUrl = option('--public-url') || process.env.DNSIMPLE_MCP_PUBLIC_URL || undefined;
  const allowedHosts = (option('--allowed-hosts') ?? process.env.DNSIMPLE_MCP_ALLOWED_HOSTS ?? '')
    .split(',').map((h) => h.trim()).filter(Boolean);

  let app;
  try {
    app = await createHttpApp({
      context, port, host, publicUrl, allowedHosts,
      sandbox: argv.includes('--sandbox'),
      accessKey: process.env.DNSIMPLE_MCP_ACCESS_KEY || undefined,
    });
  } catch (error) {
    die(error.message);
  }
  let base;
  try { base = await app.listen(); } catch (error) {
    die(`cannot listen on ${host}:${port}: ${error.message}`, 1);
  }
  // HTTP mode never reads stdin: it runs fine detached, with stdin closed.
  const lines = [
    `dnsimple-mcp listening on ${base}/mcp${publicUrl || host !== '127.0.0.1' ? ` (bound to ${host}:${app.server.address().port})` : ''}`,
    `  claude mcp add --transport http dnsimple ${base}/mcp`,
  ];
  if (app.accessKey !== null) {
    lines.push(app.accessKeyFile
      ? `  The sign-in page asks for this access key: ${app.accessKey}\n  (kept in ${app.accessKeyFile}; set DNSIMPLE_MCP_ACCESS_KEY to choose your own)`
      : '  The sign-in page asks for the access key set in DNSIMPLE_MCP_ACCESS_KEY.');
    if (!publicUrl) lines.push('  Reachable beyond this machine but no --public-url is set: only loopback and --allowed-hosts names are answered.');
    else if (/^http:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/.test(publicUrl)) lines.push('  The public URL is plain http: tokens and the access key cross the network unencrypted. Put TLS in front of it.');
  }
  process.stderr.write(`${lines.join('\n')}\n`);
  reportCli(app.cli);
  const shutdown = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  // A missing CLI or a signed-out account must not delay the handshake:
  // initialize and tools/list are answered regardless.
  const { server, cli, close } = await createServer({ context });

  const shutdown = () => { close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown); // client went away: don't leave a login listening

  await server.connect(new StdioServerTransport());
  reportCli(cli);
}
