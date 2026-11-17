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
// A headless login waits on a person relaying an address by hand; keep the
// loopback listener (and the pasted code's window) short.
const HEADLESS_TIMEOUT_MS = 5 * 60_000;
const REPLAY_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const AUTHORIZE_URL = /https:\/\/[^\s"']+\/oauth\/authorize\?[^\s"']+/;

/** A problem the user can fix; `restart` means the pending login is gone. */
export class LoginError extends Error {
  constructor(message, { restart = false } = {}) {
    super(message);
    this.restart = restart;
  }
}

/**
 * True when no browser can be opened next to this process: forced with
 * DNSIMPLE_MCP_HEADLESS=1 (0 forces it off), inside a container, or on Linux
 * without a display server.
 */
export function isHeadless(env = process.env) {
  const flag = env.DNSIMPLE_MCP_HEADLESS;
  if (flag !== undefined && flag !== '') return !/^(0|false|no|off)$/i.test(flag);
  if (env.container || existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  return process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** The CLI's loopback listener, read off the authorize URL it produced. */
export function callbackOf(authorizeUrl) {
  try {
    const authorize = new URL(authorizeUrl);
    const redirect = new URL(authorize.searchParams.get('redirect_uri'));
    const state = authorize.searchParams.get('state');
    if (redirect.protocol !== 'http:' || !LOOPBACK_HOSTS.has(redirect.hostname) || !redirect.port || !state) return null;
    return { hostname: redirect.hostname, port: redirect.port, path: redirect.pathname, state };
  } catch {
    return null;
  }
}

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

export function createLoginManager(cli, { ttlMs = Number(process.env.DNSIMPLE_MCP_LOGIN_TTL) * 1000 || undefined } = {}) {
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

  /**
   * `noBrowser` leaves opening the authorize URL to the caller. `headless`
   * says the browser is on another machine, so the login is finished with
   * complete() and expires sooner.
   */
  function start({ sandbox = false, name, noBrowser = false, headless = false } = {}) {
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

    const lifetime = ttlMs ?? (headless ? HEADLESS_TIMEOUT_MS : LOGIN_TIMEOUT_MS);
    const s = {
      state: 'pending', child, dir, urlFile, url: null, output: '', error: null, sandbox, headless,
      startedAt: Date.now(), expiresAt: Date.now() + lifetime, expired: false, replaying: null,
    };
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
        // The CLI's own "Error: …" line; what follows it is a hint to use an API token.
        const lines = s.output.replace(/[\x00-\x08\x0b-\x1f]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
        const text = lines.findLast((l) => l.startsWith('Error: '))?.slice(7) || lines.at(-1) || '';
        if (s.expired) return finish('cancelled', `The sign-in was not completed within ${Math.round(lifetime / 60_000) || 1} minute(s) and expired.`);
        finish(signal ? 'cancelled' : 'failed', signal ? `Login ended (${signal}).` : text || `Login exited with code ${code}.`);
      });
    });

    s.timer = setTimeout(() => { s.expired = true; kill(s); }, lifetime);
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

  /**
   * Finish a login whose browser ran on another machine. `redirectUrl` is the
   * address that browser ended on: the CLI's loopback callback, unreachable
   * from there. It is replayed to the CLI's listener here, so the CLI does its
   * own code exchange and stores the credential itself.
   */
  async function complete(redirectUrl, expected = session) {
    const s = session;
    if (!s || s !== expected) throw new LoginError('No sign-in is in progress.', { restart: true });
    if (s.state === 'succeeded') return s;
    if (s.state !== 'pending') {
      throw new LoginError(s.expired ? s.error : `That sign-in already ended: ${s.error || s.state}`, { restart: true });
    }
    const cb = readUrl(s) && callbackOf(s.url);
    if (!cb) throw new LoginError('The dnsimple CLI did not announce a loopback callback, so this sign-in cannot be finished by pasting an address.');
    const expectedPrefix = `http://${cb.hostname}:${cb.port}${cb.path}`;

    let url;
    try { url = new URL(String(redirectUrl ?? '').trim()); } catch {
      throw new LoginError(`That is not a complete address. Copy the whole address from the browser's address bar after approving; it starts with ${expectedPrefix}?`);
    }
    // Checked here, before the CLI sees anything: the CLI aborts the whole
    // login on a callback it does not like.
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new LoginError(`That address does not point at this sign-in. After approving on dnsimple.com the browser ends on an address starting with ${expectedPrefix}? — copy that one.`);
    }
    if (url.port !== cb.port || url.pathname !== cb.path) {
      throw new LoginError(`That address belongs to a different sign-in attempt (expected one starting with ${expectedPrefix}?). Open the current sign-in link again and copy the address you land on.`);
    }
    if (url.searchParams.get('state') !== cb.state) {
      throw new LoginError('The `state` in that address does not match the sign-in in progress. It is probably from an earlier attempt: open the current sign-in link again and copy the address you land on.');
    }
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
      throw new LoginError('That address has no authorization `code`. Copy the whole address, including everything after the "?".');
    }

    s.replaying ??= fetch(`${expectedPrefix}${url.search}`, { redirect: 'manual', signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS) })
      .then((res) => res.arrayBuffer())
      .catch(() => {}); // the CLI may exit before the response is complete
    await s.replaying;
    await waitForCompletion(s, REPLAY_TIMEOUT_MS);

    if (s.state === 'succeeded') return s;
    if (s.state === 'pending') {
      s.replaying = null;
      throw new LoginError('The dnsimple CLI received the address but has not finished signing in yet. Check the status in a moment.');
    }
    throw new LoginError(`DNSimple did not accept the sign-in: ${s.error || s.state}`, { restart: true });
  }

  return {
    start,
    waitForUrl,
    waitForCompletion,
    complete,
    current: () => session,
    cancel: () => kill(session),
  };
}
