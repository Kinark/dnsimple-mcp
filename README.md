# dnsimple-mcp

An [MCP](https://modelcontextprotocol.io) server for [DNSimple](https://dnsimple.com) that wraps the official [`dnsimple` CLI](https://github.com/dnsimple/cli) and signs in with **OAuth in your browser**. There is no API token to create, paste into a config file, or hand to a model.

- **OAuth on the connection.** Run it as an HTTP server and your MCP client asks you to authenticate when it connects, like any remote MCP: a sign-in page opens, you approve on dnsimple.com, done.
- **OAuth, not tokens.** The sign-in is the CLI's own authorization-code + PKCE flow. The credential goes straight into the CLI's store; the server never reads it, `--token` is refused, and `DNSIMPLE_TOKEN` is stripped from the CLI's environment.
- **Tracks your CLI.** The command catalog is read from the installed CLI at startup (`dnsimple ai --full`), so new CLI commands show up without a new release of this server.
- **Reads and writes are separate tools**, so a client can auto-approve reads and still ask before anything changes.

## Requirements

- Node.js 20+
- The `dnsimple` CLI on your `PATH` (`brew install dnsimple/tap/dnsimple`, or see the [CLI repo](https://github.com/dnsimple/cli))
- macOS or Linux for the browser login (it needs the `script` utility for a pseudo-terminal). Elsewhere, run `dnsimple auth login` once in a terminal; everything else works.

## Install

### HTTP: the connection asks for OAuth (recommended)

Start the server (it listens on `127.0.0.1` only):

```sh
npx -y --allow-git=all github:Kinark/dnsimple-mcp --http        # http://127.0.0.1:8377/mcp
```

Add it to your client as an HTTP server. Claude Code:

```sh
claude mcp add --transport http dnsimple http://127.0.0.1:8377/mcp
```

The client shows the server as needing authentication (in Claude Code: `/mcp`, pick `dnsimple`, Authenticate). Your browser opens a page served by this server:

- **Not signed in to DNSimple on this computer:** "Sign in with DNSimple" opens DNSimple's consent page in a new tab. Approve there and the first tab returns to your client by itself.
- **Already signed in with the CLI:** the page shows the account and asks you to continue, or to sign in to a different one.

How it works: the MCP endpoint is an OAuth 2.1 protected resource and the server is its own authorization server (protected-resource and authorization-server metadata, dynamic client registration, PKCE, refresh tokens), as the MCP authorization spec describes. DNSimple has no dynamic client registration, so the server delegates the actual sign-in to `dnsimple auth login`. The tokens your client receives are opaque handles to this server; the DNSimple credential stays in the CLI's store. Signing out with `dnsimple_auth_logout` or `dnsimple auth logout` ends the connection's session and the client asks for OAuth again.

### stdio: sign in through a tool

Claude Code:

```sh
claude mcp add dnsimple -- npx -y --allow-git=all github:Kinark/dnsimple-mcp
```

Any other MCP client:

```json
{
  "mcpServers": {
    "dnsimple": {
      "command": "npx",
      "args": ["-y", "--allow-git=all", "github:Kinark/dnsimple-mcp"]
    }
  }
}
```

A stdio connection has no OAuth step in MCP, so here the assistant signs in with the `dnsimple_auth_login` tool, which opens the same DNSimple consent page. If you are already signed in with the CLI, it works immediately.

`--allow-git=all` is needed on npm 12+, which refuses packages from git by default. Or run either mode from a clone:

```sh
git clone https://github.com/Kinark/dnsimple-mcp && cd dnsimple-mcp && npm install
node bin/dnsimple-mcp.js --http
```

## Tools

| Tool | What it does |
| --- | --- |
| `dnsimple_query` | Runs a read-only command (`zones list`, `zones records list`, `registrar check`, …) and returns its JSON. |
| `dnsimple_mutate` | Runs a command that creates, changes or deletes something. Marked destructive. |
| `dnsimple_guide` | The CLI reference, or the full help of one command. |
| `dnsimple_auth_status` | Who is signed in, which environment, stored contexts, login in progress. |
| `dnsimple_auth_login` | stdio only: OAuth sign-in in the browser (`sandbox: true` for the sandbox environment). |
| `dnsimple_auth_switch` | Makes another stored context active. |
| `dnsimple_auth_logout` | Removes a stored context. |

`dnsimple_query` and `dnsimple_mutate` take the same input:

```json
{
  "command": "zones records create",
  "args": ["example.com"],
  "flags": { "type": "A", "name": "www", "content": "1.2.3.4", "ttl": 3600 },
  "account": 1234
}
```

The request is checked against the catalog before the CLI runs: unknown commands, wrong argument counts, unknown flags and missing required flags come back as errors that say what is valid. `--json` is always applied, and `--yes` is added to commands that would otherwise prompt.

### Things to know

- **`dnsimple_mutate` does not prompt.** Your MCP client's approval of the tool call is the confirmation. Registrar and certificate commands (`registrar register`, `registrar renew`, `certificates letsencrypt purchase`, …) can charge your account. Keep that tool on "ask every time".
- **Signing in changes the active CLI context** for every `dnsimple` user on the machine, as `dnsimple auth login` does. To keep the server on one context regardless, pin it.
- The browser must open on the machine running the server: the OAuth callback goes to `127.0.0.1`.
- **The HTTP server is for this machine only.** It binds to `127.0.0.1`, rejects other `Host` and `Origin` headers, and its tokens mean "may use this computer's dnsimple CLI". Any local program you let through the sign-in page gets that access; don't put it behind a tunnel or reverse proxy.

## Configuration

| Option | Effect |
| --- | --- |
| `--context <name>` or `DNSIMPLE_MCP_CONTEXT` | Pin every call to one stored CLI context (safe alongside other agents; disables switching). |
| `--http`, `--port <n>` or `DNSIMPLE_MCP_PORT` | Serve over HTTP with OAuth on the connection (default port 8377). |
| `--sandbox` | With `--http`: sign in to the DNSimple sandbox environment. |
| `DNSIMPLE_MCP_STATE_DIR` | Where the HTTP server keeps client registrations and hashed tokens (default `~/.local/state/dnsimple-mcp`). |
| `DNSIMPLE_BIN` | Path to the `dnsimple` binary. |
| `DNSIMPLE_MCP_NO_BROWSER=1` | stdio: don't launch a browser on login; only return the authorize URL. |

To play safely, use the sandbox: run `--http --sandbox --context sandbox`, or over stdio ask for a sandbox login (creates a `sandbox` context) and run the server with `--context sandbox`.

## Development

```sh
npm install
npm test
```

The suite has four layers: catalog parsing against a recorded CLI reference, end-to-end MCP calls over stdio against a fake CLI (asserting the exact argv), the HTTP server's whole OAuth flow (discovery, registration, sign-in through the fake CLI's login, PKCE, refresh, logout) including an SDK client that authenticates by itself, and live tests against the installed CLI. The live tests are read-only, skip themselves when the CLI is missing or signed out, and exercise the OAuth login in a throwaway `HOME` without opening a browser.

## License

MIT
