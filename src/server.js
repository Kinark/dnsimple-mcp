import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalizeCommand, usage } from './catalog.js';
import { CliError, UsageError, createCli } from './cli.js';
import { LoginError, callbackOf, createLoginManager, isHeadless } from './login.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const INSTRUCTIONS = `DNSimple (domains, DNS zones and records, certificates, registrar) through the official dnsimple CLI.

__AUTH__

Read with dnsimple_query, change things with dnsimple_mutate. Both take a CLI command path ("zones records list"), positional \`args\` and a \`flags\` object. dnsimple_guide prints the full reference or the help of one command.

Before any dnsimple_mutate call that deletes data or costs money (registering, transferring, renewing or restoring a domain, buying a certificate, enabling paid services), show the user exactly what will happen, including the price from "registrar prices", and wait for explicit confirmation.`;

const AUTH_STDIO = 'Authentication is OAuth in the user\'s browser: if a call reports "not authenticated", call dnsimple_auth_login and ask the user to approve the request in the browser window that opens. API tokens are never used or accepted.';
const AUTH_HEADLESS = 'Authentication is OAuth, and this server runs where no browser can be opened, so signing in takes two steps. If a call reports "not signed in": (1) call dnsimple_auth_login and give the user the authorize_url it returns; they open it in a browser on any computer and approve. (2) Their browser then lands on an address starting with http://127.0.0.1 that fails to load, which is expected; ask them to copy that whole address from the address bar, and pass it to dnsimple_auth_complete as redirect_url. API tokens are never used or accepted.';
const AUTH_HTTP = 'Authentication is OAuth on the MCP connection itself: the user signs in with DNSimple in their browser when the client connects. If a call reports "not authenticated", the DNSimple session ended; ask the user to re-authenticate this MCP server in their client. API tokens are never used or accepted.';

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

export const isAuthError = (message) => /not authenticated|authentication failed|401|unauthorized/i.test(message);

function index(commands, readOnly) {
  return [...commands.values()]
    .filter((c) => c.readOnly === readOnly)
    .map((c) => `- ${usage(c)}: ${c.summary}`)
    .join('\n');
}

/**
 * `http` is set when the server is reached over HTTP, where sign-in happens in
 * the connection's OAuth flow: { onAuthLost(), onLogout() }. `cli` and `login`
 * can be shared between the per-request servers of that mode.
 */
export async function createServer({
  bin, context, cli = createCli({ bin, context }), login = createLoginManager(cli), http, headless = isHeadless(),
} = {}) {
  function failure(error) {
    let message = error instanceof Error ? error.message : String(error);
    if (error instanceof LoginError && error.restart && !http) {
      message += '\n\nCall dnsimple_auth_login to start a new sign-in and get a fresh authorize_url.';
    } else if (error instanceof CliError && isAuthError(message)) {
      http?.onAuthLost?.();
      message += http
        ? '\n\nThe DNSimple session ended. Ask the user to re-authenticate this MCP server in their client, then retry.'
        : '\n\nNot signed in to DNSimple. Call dnsimple_auth_login to sign in with OAuth, then retry.';
    }
    return { ...text(message), isError: true };
  }

  const guard = (fn) => async (input) => {
    try { return await fn(input); } catch (error) { return failure(error); }
  };

  // A missing or unparseable CLI must not stop the server from starting: the
  // tools then report the real problem when called.
  let commands = new Map();
  try { ({ commands } = await cli.catalog()); } catch {}

  const server = new McpServer({ name: 'dnsimple', version: pkg.version }, { instructions: INSTRUCTIONS.replace('__AUTH__', http ? AUTH_HTTP : headless ? AUTH_HEADLESS : AUTH_STDIO) });

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
    if (s) {
      state.login = {
        state: s.state,
        ...(s.state === 'pending' && { authorize_url: s.url, expires_in_seconds: secondsLeft(s) }),
        ...(s.state === 'pending' && !http && { finish_with: 'dnsimple_auth_complete { redirect_url }' }),
        ...(s.error && { error: s.error }),
      };
    }
    return state;
  }

  const secondsLeft = (s) => Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));

  /** What a headless login hands back: the link, and the two steps in plain words. */
  function relayInstructions(s) {
    const cb = callbackOf(s.url);
    const lands = cb ? `http://${cb.hostname}:${cb.port}${cb.path}?code=…&state=…` : 'http://127.0.0.1:<port>/callback?code=…&state=…';
    const minutes = Math.max(1, Math.round(secondsLeft(s) / 60));
    return {
      status: 'action_required',
      authorize_url: s.url,
      expires_in_seconds: secondsLeft(s),
      steps: [
        `Step 1: Give the user authorize_url exactly as it is and ask them to open it in a browser (any computer works) and approve the request on ${s.sandbox ? 'sandbox.dnsimple.com' : 'dnsimple.com'}.`,
        `Step 2: After approving, their browser goes to an address like ${lands} and shows a "can't connect" or "site can't be reached" error. That is expected, because this server runs on a different machine than their browser. Ask them to copy the whole address from the address bar and send it to you. Then call dnsimple_auth_complete with that address as redirect_url.`,
      ],
      message: `Not signed in yet. This sign-in link is valid for about ${minutes} minute(s); calling dnsimple_auth_login again while it is pending returns the same link.`,
    };
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
        (http ? 'authentication is handled by the MCP connection. ' : 'authenticate with dnsimple_auth_login instead of `dnsimple auth login`. ') +
        '--json and --yes are applied automatically.\n\n' + stdout,
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

  // Over HTTP the connection's OAuth flow is the login.
  if (!http) server.registerTool('dnsimple_auth_login', {
    title: 'Sign in to DNSimple (OAuth)',
    description:
      (headless
        ? 'Sign in to DNSimple with OAuth, step 1 of 2. This server runs where no browser can be opened, so this returns an authorize_url right away instead of opening one. ' +
          'Give that URL to the user to open in a browser on any computer and approve. Their browser then lands on an address starting with http://127.0.0.1 that fails to load (expected). ' +
          'Step 2: ask the user to copy that whole address and pass it to dnsimple_auth_complete as redirect_url. '
        : 'Sign in to DNSimple with OAuth: opens the DNSimple authorization page in the user\'s browser and completes once they approve. ' +
          'Returns the authorize URL (give it to the user in case the browser did not open; it must be opened on this machine) and waits up to `wait_seconds` for approval. ' +
          'If it is still pending, call dnsimple_auth_status later. ' +
          'If the user\'s browser is on a different machine than this server, give them the authorize URL, have them copy the http://127.0.0.1 address their browser ends on, and pass it to dnsimple_auth_complete. ') +
      'No token is typed, shown or stored by this server. The new context becomes the active one.',
    inputSchema: {
      sandbox: z.boolean().optional().describe('Sign in to the DNSimple sandbox environment instead of production.'),
      name: z.string().regex(/^[\w.-]+$/).optional().describe('Name for the stored context (default: "production" or "sandbox").'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe(headless ? 'Ignored here: the link is returned immediately.' : 'How long to wait for the user to approve (default 45).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ sandbox, name, wait_seconds = 45 }) => {
    await cli.ensure();
    const session = login.start({ sandbox, name, noBrowser: headless, headless });
    await login.waitForUrl(session);
    if (headless && session.state === 'pending') {
      if (session.url) return text(relayInstructions(session));
      login.cancel();
      return failure(new Error('The dnsimple CLI did not print a sign-in address. Is it installed and up to date? Call dnsimple_auth_login to try again.'));
    }
    await login.waitForCompletion(session, wait_seconds * 1000);

    if (session.state === 'succeeded') {
      return text({ status: 'authenticated', ...(await authState()), login: undefined });
    }
    if (session.state === 'pending') {
      return text({
        status: 'pending',
        authorize_url: session.url,
        message: session.url
          ? 'Waiting for the user to approve in the browser. If no window opened, they can open authorize_url on this machine. Call dnsimple_auth_status to check, or call dnsimple_auth_login again to keep waiting. If their browser is on another machine, it ends on an http://127.0.0.1 address that fails to load: pass that whole address to dnsimple_auth_complete.'
          : 'The login was started but no authorize URL was captured. Ask the user to check their browser, then call dnsimple_auth_status.',
      });
    }
    return failure(new Error(`Login ${session.state}: ${session.error}`));
  }));

  if (!http) server.registerTool('dnsimple_auth_complete', {
    title: 'Finish signing in to DNSimple',
    description:
      'Sign in to DNSimple with OAuth, step 2 of 2: finish the sign-in started by dnsimple_auth_login when the user\'s browser is on a different machine than this server. ' +
      'After the user approves on dnsimple.com, their browser lands on an address like http://127.0.0.1:<port>/callback?code=…&state=… and shows a connection error, which is expected. ' +
      'Pass that whole address, exactly as copied from the address bar, as redirect_url. It is handed to the dnsimple CLI on this server, which completes the sign-in and stores the credential itself. ' +
      'The address only works for the sign-in in progress and only once.',
    inputSchema: {
      redirect_url: z.string().describe('The full address the browser ended on after approving, e.g. "http://127.0.0.1:51996/callback?code=abc&state=xyz".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(async ({ redirect_url }) => {
    await login.complete(redirect_url);
    return text({ status: 'authenticated', ...(await authState()), login: undefined });
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
    description: 'Remove a stored authentication context from this machine (defaults to the active one). Only do it when the user asks.' +
      (http ? ' The MCP connection is signed out too and asks for OAuth again.' : ''),
    inputSchema: { name: z.string().regex(/^[\w.-]+$/).optional().describe('Context to remove.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ name }) => {
    login.cancel();
    const target = name || cli.context;
    await cli.exec(['auth', 'logout', ...(target ? ['--name', target] : [])]);
    http?.onLogout?.();
    return text(await authState());
  }));

  return { server, cli, login, close: () => login.cancel() };
}
