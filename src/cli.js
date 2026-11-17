import { execFile } from 'node:child_process';
import { isReadOnly, normalizeCommand, parseCatalog, usage } from './catalog.js';

// Flags the server sets itself. `token` is refused on purpose: credentials
// come only from the CLI's OAuth contexts and never pass through the model.
const RESERVED_FLAGS = new Map([
  ['token', 'API tokens are not accepted; authenticate with dnsimple_auth_login (OAuth).'],
  ['context', 'The authentication context is fixed by the server configuration.'],
  ['sandbox', 'The environment is defined by the authentication context.'],
  ['account', 'Use the `account` parameter instead.'],
  ['json', 'Output is always JSON.'],
  ['format', 'Output is always JSON.'],
  ['yes', 'Confirmation is handled by the server.'],
  ['debug', 'Not supported.'],
  ['no-color', 'Not supported.'],
  ['help', 'Use dnsimple_guide instead.'],
]);

export class UsageError extends Error {}

export class CliError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.code = code;
    this.stderr = stderr;
  }
}

/** The child never sees an API token from the environment: OAuth contexts only. */
export function childEnv(base = process.env) {
  const env = { ...base };
  delete env.DNSIMPLE_TOKEN;
  return env;
}

export function createCli({ bin = process.env.DNSIMPLE_BIN || 'dnsimple', context, env = childEnv() } = {}) {
  let catalogPromise;

  function exec(args, { timeout = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { env, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        if (error.code === 'ENOENT') {
          return reject(new CliError(
            `The dnsimple CLI was not found (looked for "${bin}"). Install it (https://github.com/dnsimple/cli) or set DNSIMPLE_BIN.`,
            { code: 'ENOENT' },
          ));
        }
        if (error.code === 'EACCES') {
          return reject(new CliError(
            `The dnsimple CLI at "${bin}" is not executable. Fix its permissions or set DNSIMPLE_BIN.`,
            { code: 'ENOENT' },
          ));
        }
        const text = (stderr || stdout || error.message).trim().replace(/^Error: /, '');
        reject(new CliError(error.killed ? `Timed out after ${timeout / 1000}s: ${text}` : text, { code: error.code, stderr }));
      });
    });
  }

  const contextArgs = () => (context ? ['--context', context] : []);

  /** Parsed command catalog; an empty one means "CLI changed format, don't validate". */
  function catalog() {
    catalogPromise ??= exec(['ai', '--full'], { timeout: 20_000 })
      .then(({ stdout }) => parseCatalog(stdout))
      .catch((error) => {
        catalogPromise = undefined; // retry next time (e.g. CLI installed later)
        throw error;
      });
    return catalogPromise;
  }

  /** Validate a request against the catalog and build the argv. */
  async function buildArgs({ command, args = [], flags = {}, account }) {
    const { commands, aliases } = await catalog();
    const path = normalizeCommand(command, aliases);
    if (!path) throw new UsageError('`command` is required, e.g. "zones records list".');
    if (path.split(' ').some((w) => w.startsWith('-'))) {
      throw new UsageError('`command` is the command path only; pass options in `flags` and positionals in `args`.');
    }
    const first = path.split(' ')[0];
    if (first === 'auth') throw new UsageError('Use the dnsimple_auth_* tools for authentication.');

    const known = commands.size > 0;
    const spec = commands.get(path);
    if (known && !spec) {
      const near = [...commands.keys()].filter((c) => c.startsWith(first + ' ') || c === first);
      throw new UsageError(
        `Unknown command "${path}".` +
        (near.length ? ` Commands under "${first}": ${near.join(', ')}.` : ' Call dnsimple_guide for the command list.'),
      );
    }

    if (spec) {
      const min = spec.positionals.filter((p) => p.required).length;
      const max = spec.positionals.length;
      if (args.length < min || args.length > max) {
        throw new UsageError(`"${path}" takes ${min === max ? min : `${min}-${max}`} positional argument(s): ${usage(spec)}. Received ${args.length}.`);
      }
    }

    const flagArgs = [];
    const seen = new Set();
    for (const [rawKey, value] of Object.entries(flags)) {
      const key = rawKey.replace(/^--/, '').replaceAll('_', '-');
      if (RESERVED_FLAGS.has(key)) throw new UsageError(`Flag --${key} cannot be set. ${RESERVED_FLAGS.get(key)}`);
      if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new UsageError(`Invalid flag name "${rawKey}".`);
      if (spec && !spec.flags.has(key)) {
        const valid = [...spec.flags.keys()].filter((f) => !RESERVED_FLAGS.has(f)).map((f) => `--${f}`);
        throw new UsageError(`"${path}" has no flag --${key}. ${valid.length ? `Valid flags: ${valid.join(', ')}.` : 'It takes no flags.'}`);
      }
      seen.add(key);
      if (value === null || value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) {
        // `--flag=value` is unambiguous for every cobra flag type, booleans included.
        flagArgs.push(v === true ? `--${key}` : `--${key}=${v}`);
      }
    }
    if (spec) {
      const missing = [...spec.flags].filter(([name, f]) => f.required && !seen.has(name)).map(([name]) => `--${name}`);
      if (missing.length) throw new UsageError(`"${path}" requires ${missing.join(', ')}.`);
    }

    const argv = [...path.split(' '), ...flagArgs, '--json', '--no-color', ...contextArgs()];
    // The MCP client's own approval of the tool call is the confirmation.
    if (spec?.flags.has('yes')) argv.push('--yes');
    if (account !== undefined && account !== null && account !== '') argv.push('--account', String(account));
    // `--` keeps a positional that starts with a dash from being read as a flag.
    argv.push('--', ...args.map(String));
    return { argv, path, spec, readOnly: spec ? spec.readOnly : isReadOnly(path) };
  }

  /** Run a command; returns parsed JSON when the CLI printed JSON, raw text otherwise. */
  async function run(argv) {
    const { stdout } = await exec(argv);
    const text = stdout.trim();
    if (!text) return { ok: true };
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Rejects with the "not found" explanation when the binary cannot be run at all. */
  const ensure = () => exec(['--version'], { timeout: 20_000 }).then(() => {}, (error) => {
    if (error.code === 'ENOENT') throw error;
  });

  return { bin, env, context, exec, ensure, catalog, buildArgs, run, contextArgs };
}
