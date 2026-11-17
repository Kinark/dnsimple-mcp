import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalizeCommand, usage } from './catalog.js';
import { CliError, UsageError, createCli } from './cli.js';
import { createLoginManager } from './login.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const INSTRUCTIONS = `DNSimple (domains, DNS zones and records, certificates, registrar) through the official dnsimple CLI.

Authentication is OAuth in the user's browser: if a call reports "not authenticated", call dnsimple_auth_login and ask the user to approve the request in the browser window that opens. API tokens are never used or accepted.

Read with dnsimple_query, change things with dnsimple_mutate. Both take a CLI command path ("zones records list"), positional \`args\` and a \`flags\` object. dnsimple_guide prints the full reference or the help of one command.

Before any dnsimple_mutate call that deletes data or costs money (registering, transferring, renewing or restoring a domain, buying a certificate, enabling paid services), show the user exactly what will happen, including the price from "registrar prices", and wait for explicit confirmation.`;

const commandInput = {
  command: z.string().describe('CLI command path without the "dnsimple" prefix, e.g. "zones records list".'),
  args: z.array(z.union([z.string(), z.number()])).optional()
    .describe('Positional arguments in order, e.g. ["example.com", 12345].'),
  flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
    .describe('Command flags by name without dashes, e.g. {"type": "A", "all": true}. An array repeats the flag.'),
  account: z.union([z.string(), z.number()]).optional()
    .describe('Account ID to operate on, when the identity can access more than one.'),
};

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

function failure(error) {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof CliError && /not authenticated|authentication failed|401|unauthorized/i.test(message)) {
    message += '\n\nCall dnsimple_auth_login to sign in with OAuth, then retry.';
  }
  return { ...text(message), isError: true };
}

const guard = (fn) => async (input) => {
  try { return await fn(input); } catch (error) {
    if (error instanceof UsageError || error instanceof CliError) return failure(error);
    return failure(error);
  }
};

function index(commands, readOnly) {
  return [...commands.values()]
    .filter((c) => c.readOnly === readOnly)
    .map((c) => `- ${usage(c)}: ${c.summary}`)
    .join('\n');
}

export async function createServer({ bin, context } = {}) {
  const cli = createCli({ bin, context });
  const login = createLoginManager(cli);

  // A missing or unparseable CLI must not stop the server from starting: the
  // tools then report the real problem when called.
  let commands = new Map();
  try { ({ commands } = await cli.catalog()); } catch {}

  const server = new McpServer({ name: 'dnsimple', version: pkg.version }, { instructions: INSTRUCTIONS });

  async function authState() {
    const state = { authenticated: false };
    try {
      Object.assign(state, await cli.run(['auth', 'status', '--json', ...cli.contextArgs()]), { authenticated: true });
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      state.detail = error.message;
    }
    try { state.contexts = (await cli.run(['auth', 'list', '--json'])).contexts ?? []; } catch {}
    if (cli.context) state.pinned_context = cli.context;
    const s = login.current();
    if (s) state.login = { state: s.state, ...(s.state === 'pending' && { authorize_url: s.url }), ...(s.error && { error: s.error }) };
    return state;
  }

  server.registerTool('dnsimple_guide', {
    title: 'DNSimple CLI reference',
    description: 'Without arguments: the DNSimple CLI reference (workflows and every command). With `command`: the detailed help of that command, including all flags.',
    inputSchema: { command: z.string().optional().describe('Command path, e.g. "registrar register".') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guard(async ({ command }) => {
    if (!command) {
      const { stdout } = await cli.exec(['ai']);
      return text(
        '> Running through the DNSimple MCP: run commands with dnsimple_query (reads) and dnsimple_mutate (changes); ' +
        'authenticate with dnsimple_auth_login instead of `dnsimple auth login`. --json and --yes are applied automatically.\n\n' + stdout,
      );
    }
    const { aliases } = await cli.catalog();
    const path = normalizeCommand(command, aliases);
    if (!path || path.split(' ').some((w) => w.startsWith('-'))) throw new UsageError('`command` must be a command path, e.g. "zones records create".');
    const { stdout } = await cli.exec([...path.split(' '), '--help']);
    return text(stdout);
  }));

  const runCommand = (expectReadOnly) => guard(async (input) => {
    const { argv, path, readOnly } = await cli.buildArgs(input);
    if (readOnly !== expectReadOnly) {
      throw new UsageError(readOnly
        ? `"${path}" only reads data; call it with dnsimple_query.`
        : `"${path}" changes data; call it with dnsimple_mutate.`);
    }
    return text(await cli.run(argv));
  });

  server.registerTool('dnsimple_query', {
    title: 'Read from DNSimple',
    description:
      'Run a read-only DNSimple CLI command and return its JSON output. List commands return the first page (30 items) plus a `pagination` object; pass {"all": true} in `flags` to fetch everything.\n\n' +
      (commands.size ? `Commands:\n${index(commands, true)}\n\nFlags per command: dnsimple_guide.` : 'Call dnsimple_guide for the command list.'),
    inputSchema: commandInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, runCommand(true));

  server.registerTool('dnsimple_mutate', {
    title: 'Change DNSimple resources',
    description:
      'Run a DNSimple CLI command that creates, changes or deletes something. Destructive commands run without a further prompt, and registrar and certificate commands can charge the account: get the user\'s explicit confirmation first (show the price from "registrar prices" for purchases).\n\n' +
      (commands.size ? `Commands:\n${index(commands, false)}\n\nFlags per command: dnsimple_guide.` : 'Call dnsimple_guide for the command list.'),
    inputSchema: commandInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, runCommand(false));

  server.registerTool('dnsimple_auth_status', {
    title: 'DNSimple authentication status',
    description: 'Show whether the CLI is authenticated, which account and environment (production or sandbox) is active, the stored contexts, and the state of a login in progress.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guard(async () => text(await authState())));

  server.registerTool('dnsimple_auth_login', {
    title: 'Sign in to DNSimple (OAuth)',
    description:
      'Sign in to DNSimple with OAuth: opens the DNSimple authorization page in the user\'s browser and completes once they approve. No token is typed, shown or stored by this server. ' +
      'Returns the authorize URL (give it to the user in case the browser did not open; it must be opened on this machine) and waits up to `wait_seconds` for approval. ' +
      'If it is still pending, call dnsimple_auth_status later. The new context becomes the active one.',
    inputSchema: {
      sandbox: z.boolean().optional().describe('Sign in to the DNSimple sandbox environment instead of production.'),
      name: z.string().regex(/^[\w.-]+$/).optional().describe('Name for the stored context (default: "production" or "sandbox").'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe('How long to wait for the user to approve (default 45).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ sandbox, name, wait_seconds = 45 }) => {
    const session = login.start({ sandbox, name });
    await login.waitForUrl(session);
    await login.waitForCompletion(session, wait_seconds * 1000);

    if (session.state === 'succeeded') {
      return text({ status: 'authenticated', ...(await authState()), login: undefined });
    }
    if (session.state === 'pending') {
      return text({
        status: 'pending',
        authorize_url: session.url,
        message: session.url
          ? 'Waiting for the user to approve in the browser. If no window opened, they can open authorize_url on this machine. Call dnsimple_auth_status to check, or call dnsimple_auth_login again to keep waiting.'
          : 'The login was started but no authorize URL was captured. Ask the user to check their browser, then call dnsimple_auth_status.',
      });
    }
    return failure(new Error(`Login ${session.state}: ${session.error}`));
  }));

  server.registerTool('dnsimple_auth_switch', {
    title: 'Switch DNSimple context',
    description: 'Make another stored authentication context active (see dnsimple_auth_status for the list). Affects every dnsimple CLI user on this machine; only do it when the user asks.',
    inputSchema: { context: z.string().describe('Context name or account ID.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ context: target }) => {
    if (cli.context) throw new UsageError(`This server is pinned to the "${cli.context}" context and cannot switch.`);
    if (target.startsWith('-')) throw new UsageError('Invalid context name.');
    await cli.exec(['auth', 'switch', '--', target]);
    return text(await authState());
  }));

  server.registerTool('dnsimple_auth_logout', {
    title: 'Sign out of DNSimple',
    description: 'Remove a stored authentication context from this machine (defaults to the active one). Only do it when the user asks.',
    inputSchema: { name: z.string().regex(/^[\w.-]+$/).optional().describe('Context to remove.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ name }) => {
    login.cancel();
    const target = name || cli.context;
    await cli.exec(['auth', 'logout', ...(target ? ['--name', target] : [])]);
    return text(await authState());
  }));

  return { server, close: () => login.cancel() };
}
