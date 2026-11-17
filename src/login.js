import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

// `dnsimple auth login` runs the OAuth authorization-code + PKCE flow itself:
// it opens the browser and listens on a loopback port for the callback. It
// only does so when stdin is a terminal, so it is run under a pty (`script`).
// The token it obtains goes straight into the CLI's credential store; this
// process never reads it.

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const AUTHORIZE_URL = /https:\/\/[^\s"']+\/oauth\/authorize\?[^\s"']+/;

function which(name, pathVar) {
  for (const dir of (pathVar || '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const shQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/**
 * Browser-opener shims put first on PATH: they record the authorize URL so it
 * can be handed back to the MCP client, then call the real opener.
 */
function makeShims(dir, env) {
  for (const name of ['open', 'xdg-open']) {
    const real = which(name, env.PATH);
    const script = [
      '#!/bin/sh',
      'printf \'%s\\n\' "$1" > "$DNSIMPLE_MCP_URL_FILE"',
      '[ -n "$DNSIMPLE_MCP_NO_BROWSER" ] && exit 0',
      real ? `exec ${shQuote(real)} "$@"` : 'exit 1',
      '',
    ].join('\n');
    const file = join(dir, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
}

function ptyCommand(bin, args) {
  if (process.platform === 'win32') return null;
  if (!which('script', process.env.PATH)) return null;
  // util-linux `script` takes the command via -c; the BSD/macOS one takes argv.
  let utilLinux = process.platform === 'linux';
  if (utilLinux) {
    try { utilLinux = /util-linux/.test(execFileSync('script', ['--version'], { encoding: 'utf8' })); } catch { utilLinux = false; }
  }
  return utilLinux
    ? ['script', ['-qec', [bin, ...args].map(shQuote).join(' '), '/dev/null']]
    : ['script', ['-q', '/dev/null', bin, ...args]];
}

export function createLoginManager(cli) {
  let session = null;

  function cleanup(s) {
    clearTimeout(s.timer);
    try { rmSync(s.dir, { recursive: true, force: true }); } catch {}
  }

  function kill(s) {
    if (!s || s.state !== 'pending') return;
    // `script` and the CLI share a process group; signal both.
    try { process.kill(-s.child.pid, 'SIGTERM'); } catch { try { s.child.kill('SIGTERM'); } catch {} }
  }

  function start({ sandbox = false, name, noBrowser = false } = {}) {
    if (session?.state === 'pending') return session;

    const args = ['auth', 'login'];
    if (sandbox) args.push('--sandbox');
    const contextName = name || cli.context;
    if (contextName) args.push('--name', contextName);

    const pty = ptyCommand(cli.bin, args);
    if (!pty) {
      throw new Error(
        'Browser login needs a pseudo-terminal (`script`), which is not available on this system. ' +
        `Run \`dnsimple ${args.join(' ')}\` in a terminal instead, then retry.`,
      );
    }

    const dir = mkdtempSync(join(tmpdir(), 'dnsimple-mcp-'));
    const urlFile = join(dir, 'authorize-url');
    makeShims(dir, cli.env);

    const child = spawn(pty[0], pty[1], {
      env: {
        ...cli.env,
        PATH: `${dir}${delimiter}${cli.env.PATH || ''}`,
        DNSIMPLE_MCP_URL_FILE: urlFile,
        // The caller sends the browser to the URL itself.
        ...(noBrowser && { DNSIMPLE_MCP_NO_BROWSER: '1' }),
      },
      // stdin must be /dev/null: macOS `script` aborts (tcgetattr) on a pipe.
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const s = { state: 'pending', child, dir, urlFile, url: null, output: '', error: null, sandbox, startedAt: Date.now() };
    session = s;

    const onData = (chunk) => {
      s.output = (s.output + chunk.toString()).slice(-8192);
      // Printed by the CLI itself when it cannot launch a browser.
      s.url ??= s.output.match(AUTHORIZE_URL)?.[0] ?? null;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    s.done = new Promise((resolve) => {
      const finish = (state, error) => {
        if (s.state !== 'pending') return;
        readUrl(s);
        s.state = state;
        s.error = error ?? null;
        cleanup(s);
        resolve(s);
      };
      child.on('error', (e) => finish('failed', e.message));
      child.on('exit', (code, signal) => {
        if (code === 0) return finish('succeeded');
        const text = s.output.replace(/[\x00-\x08\x0b-\x1f]/g, '').trim().split('\n').at(-1) || '';
        finish(signal ? 'cancelled' : 'failed', signal ? `Login ended (${signal}).` : text || `Login exited with code ${code}.`);
      });
    });

    s.timer = setTimeout(() => kill(s), LOGIN_TIMEOUT_MS);
    s.timer.unref();
    return s;
  }

  function readUrl(s) {
    if (!s.url && existsSync(s.urlFile)) s.url = readFileSync(s.urlFile, 'utf8').trim() || null;
    return s.url;
  }

  /** Resolve once the authorize URL is known or the login process has ended. */
  async function waitForUrl(s, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (s.state === 'pending' && !readUrl(s) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return s.url;
  }

  /** Wait up to `ms` for the user to approve in the browser. */
  function waitForCompletion(s, ms) {
    let t;
    const timeout = new Promise((r) => { t = setTimeout(r, ms); });
    return Promise.race([s.done, timeout]).finally(() => clearTimeout(t)).then(() => s);
  }

  return {
    start,
    waitForUrl,
    waitForCompletion,
    current: () => session,
    cancel: () => kill(session),
  };
}
