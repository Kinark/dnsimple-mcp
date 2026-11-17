import { randomUUID } from 'node:crypto';
import { LoginError, callbackOf } from './login.js';

// Sign-in prompted by the MCP client itself (elicitation, MCP 2025-11-25), so a
// stdio server, Docker included, needs no tool call and no second process:
// the client opens the DNSimple link, and when the browser is on another
// machine than the CLI it asks for the address the browser ended on.

const PASTE_ATTEMPTS = 3;

/** What the connected client can prompt for: { url, form } booleans. */
export function elicitation(server) {
  const caps = server.server.getClientCapabilities()?.elicitation;
  if (!caps) return { url: false, form: false };
  // An empty object predates modes and means form (spec 2025-11-25).
  const empty = Object.keys(caps).length === 0;
  return { url: !!caps.url, form: !!caps.form || empty };
}

/** True when the client can carry a whole sign-in for this server. */
export function canPrompt(server, headless) {
  const { url, form } = elicitation(server);
  // Headless, the address has to come back: that needs a form.
  return headless ? form : url || form;
}

export function createClientSignIn({ server, cli, login, headless }) {
  let inFlight = null;

  /** Sign in through the client's prompts. Shared by concurrent callers. */
  function signIn(options, extra) {
    inFlight ??= run(options, extra).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function run({ sandbox, name } = {}, extra = {}) {
    const caps = elicitation(server);
    await cli.ensure();
    // With URL mode the client opens the link where the user is; otherwise a
    // local CLI opens it, and a headless one cannot.
    const s = login.start({ sandbox, name, noBrowser: caps.url || headless, headless });
    await login.waitForUrl(s);
    if (s.state === 'succeeded') return s;
    if (!s.url) {
      login.cancel();
      throw new LoginError(s.state === 'pending'
        ? 'The dnsimple CLI did not print a sign-in address. Is it installed and up to date?'
        : `Sign-in could not start: ${s.error || s.state}`);
    }

    const site = s.sandbox ? 'sandbox.dnsimple.com' : 'dnsimple.com';
    const opts = () => ({
      relatedRequestId: extra.requestId,
      signal: extra.signal,
      timeout: Math.max(1000, s.expiresAt - Date.now()),
    });
    const declined = () => {
      login.cancel();
      return new LoginError('Sign-in to DNSimple was cancelled by the user.', { restart: true });
    };

    let done = null;
    if (caps.url) {
      const id = randomUUID();
      const res = await server.server.elicitInput({
        mode: 'url',
        elicitationId: id,
        url: s.url,
        message: `Sign in to DNSimple: approve access on ${site}.` +
          (headless ? ' Afterwards your browser shows a page that cannot be reached; copy its address for the next step.' : ''),
      }, opts());
      if (res.action !== 'accept') throw declined();
      done = server.server.createElicitationCompletionNotifier(id, { relatedRequestId: extra.requestId });
    }

    if (headless) {
      const cb = callbackOf(s.url);
      const lands = cb ? `http://${cb.hostname}:${cb.port}${cb.path}?code=…` : 'http://127.0.0.1:…/callback?code=…';
      let problem = '';
      for (let i = 0; i < PASTE_ATTEMPTS && s.state === 'pending'; i++) {
        const res = await server.server.elicitInput({
          mode: 'form',
          message: (problem ? `${problem}\n\n` : '') +
            (caps.url ? '' : `Open this link and approve access on ${site}:\n${s.url}\n\n`) +
            `After approving, your browser lands on ${lands} and says the page cannot be reached. ` +
            'That is expected: DNSimple runs somewhere else. Paste that whole address here.',
          requestedSchema: {
            type: 'object',
            properties: { address: { type: 'string', title: 'Address from your browser', description: lands } },
            required: ['address'],
          },
        }, opts());
        if (s.state !== 'pending') break; // finished on its own meanwhile
        if (res.action !== 'accept') throw declined();
        try {
          await login.complete(res.content?.address);
        } catch (error) {
          if (!(error instanceof LoginError) || error.restart) throw error;
          problem = error.message;
        }
      }
    } else {
      await login.waitForCompletion(s, Math.max(0, s.expiresAt - Date.now()));
    }

    if (s.state === 'pending') {
      login.cancel();
      throw new LoginError('Sign-in to DNSimple was not completed.', { restart: true });
    }
    if (s.state !== 'succeeded') throw new LoginError(`Sign-in to DNSimple failed: ${s.error || s.state}`, { restart: true });
    await done?.().catch(() => {});
    return s;
  }

  return { signIn, canPrompt: () => canPrompt(server, headless) };
}
