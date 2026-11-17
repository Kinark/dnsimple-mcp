# dnsimple-mcp

An [MCP](https://modelcontextprotocol.io) server for [DNSimple](https://dnsimple.com) that wraps the official [`dnsimple` CLI](https://github.com/dnsimple/cli) and signs in with **OAuth in your browser**. There is no API token to create, paste into a config file, or hand to a model.

- **OAuth on the connection.** Run it as an HTTP server and your MCP client asks you to authenticate when it connects, like any remote MCP: a sign-in page opens, you approve on dnsimple.com, done.
- **OAuth, not tokens.** The sign-in is the CLI's own authorization-code + PKCE flow. The credential goes straight into the CLI's store; the server never reads it, `--token` is refused, and `DNSIMPLE_TOKEN` is stripped from the CLI's environment.
- **Tracks your CLI.** The command catalog is read from the installed CLI at startup (`dnsimple ai --full`), so new CLI commands show up without a new release of this server.
- **Reads and writes are separate tools**, so a client can auto-approve reads and still ask before anything changes.
- **Runs anywhere.** On your own machine, or from a [Docker image](#docker) on a headless server, signing in from a browser on another computer.

## Requirements

- Node.js 20+
- The `dnsimple` CLI on your `PATH` (`brew install dnsimple/tap/dnsimple`, or see the [CLI repo](https://github.com/dnsimple/cli))
- Or none of the above: the [Docker image](#docker) contains both.
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

### stdio: the client prompts for sign-in

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

When a call needs DNSimple and you're signed out, your client asks you to sign in and opens the DNSimple consent page. Once you approve, the call goes ahead by itself. If you're already signed in with the CLI, it works immediately. Clients that can't show MCP prompts fall back to the `dnsimple_auth_login` tool.

`--allow-git=all` is needed on npm 12+, which refuses packages from git by default. Or run either mode from a clone:

```sh
git clone https://github.com/Kinark/dnsimple-mcp && cd dnsimple-mcp && npm install
node bin/dnsimple-mcp.js --http
```

## Docker

`ghcr.io/kinark/dnsimple-mcp` (linux/amd64 and linux/arm64) contains Node, a pinned `dnsimple` CLI and this server. Nothing else is needed on the host. It runs as a non-root user, and the `/data` volume holds everything that must survive a restart: the CLI's credential store and this server's state. Keep the volume and a restarted container is still signed in.

One config entry is all it takes: your MCP client starts the container itself.

```sh
claude mcp add dnsimple -- docker run -i --rm -v dnsimple-mcp:/data ghcr.io/kinark/dnsimple-mcp
```

```json
{
  "mcpServers": {
    "dnsimple": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "dnsimple-mcp:/data", "ghcr.io/kinark/dnsimple-mcp"]
    }
  }
}
```

The first call that needs DNSimple makes your client ask you to sign in (MCP elicitation, supported by current Claude Code). It opens the DNSimple consent page, and after you approve, your browser lands on a `http://127.0.0.1:…/callback` page that can't be reached, because the CLI that waits for it is inside the container. The client then asks for that address. Paste it in and the call goes ahead. You only do this once per volume. Clients that can't show these prompts fall back to the `dnsimple_auth_login` / `dnsimple_auth_complete` tools.

To run it as a long-lived HTTP server instead, where the connection's own OAuth flow signs in, add `--http` and publish the port:

```sh
docker run -d --name dnsimple-mcp --restart unless-stopped \
  -p 8377:8377 -v dnsimple-mcp:/data ghcr.io/kinark/dnsimple-mcp --http
docker logs dnsimple-mcp        # shows the access key the sign-in page asks for
claude mcp add --transport http dnsimple http://127.0.0.1:8377/mcp
```

In HTTP mode it answers on `http://127.0.0.1:8377/mcp` of the Docker host. To reach it under any other address (another port, a host name, a reverse proxy), say so with `--public-url`; see [Remote and headless hosts](#remote-and-headless-hosts).

If you bind-mount a host directory instead of a named volume, it must be writable by uid 1000. Use one container per volume: a sign-in is finished by the container that started it.

## Remote and headless hosts

### Signing in without a browser on the server

The CLI's OAuth callback goes to `127.0.0.1` on the machine the CLI runs on. When your browser is on another computer that callback cannot arrive, so the address is carried back by hand. The server uses this path when it runs in a container, on Linux without a display, or with `DNSIMPLE_MCP_HEADLESS=1`:

1. You get a DNSimple link: from the `dnsimple_auth_login` tool over stdio, or from the sign-in page over HTTP. Open it in any browser and approve.
2. Your browser then shows a "can't connect" error at an address like `http://127.0.0.1:51996/callback?code=…&state=…`. That is expected. Copy the whole address and give it back: to the assistant, which calls `dnsimple_auth_complete`, or into the box on the sign-in page.

The server checks that the address is a loopback one with the port and `state` of the sign-in in progress, then requests it from the CLI's listener on its own machine. The CLI exchanges the code and stores the credential itself, as in a local login. A pending sign-in expires after 5 minutes, and the code in the address is single-use and bound to that sign-in (PKCE), so it is worthless anywhere else.

### Serving HTTP mode to other machines

```sh
dnsimple-mcp --http --host 0.0.0.0 --public-url https://dns-mcp.example.com
```

- `--public-url` is the address clients use. All OAuth metadata (the protected resource, the issuer, and the authorize, token and registration endpoints) is built from it, never from the bind address, and its host is accepted in the `Host` header. A URL with a path (`https://example.com/dnsimple`) works whether or not the proxy strips the path.
- `--allowed-hosts` lists further `Host` values to answer to, for example the internal name a proxy forwards under. Every other name is refused, as are browser requests from other origins. Requests without an `Origin` header (server-to-server MCP clients) are accepted.
- An MCP client or proxy elsewhere can register a remote `https` redirect URI. Plain `http` is only accepted for loopback.
- **Access key.** Once the server can be reached from other machines (any bind address but loopback, a non-loopback public URL, or `--allowed-hosts`), the sign-in page asks for an access key before it shows anything, because otherwise anyone who can load that page could connect a client to the DNSimple account that is already signed in. The key is generated on first start, printed in the log and kept in the state directory; set `DNSIMPLE_MCP_ACCESS_KEY` (16+ characters) to choose it. A server on `127.0.0.1` never asks for one.
- Serve it over TLS. The server speaks plain HTTP and expects a reverse proxy or tunnel to terminate HTTPS; over plain HTTP the tokens and the access key cross the network readable.

## Tools

| Tool | What it does |
| --- | --- |
| `dnsimple_query` | Runs a read-only command (`zones list`, `zones records list`, `registrar check`, …) and returns its JSON. |
| `dnsimple_mutate` | Runs a command that creates, changes or deletes something. Marked destructive. |
| `dnsimple_guide` | The CLI reference, or the full help of one command. |
| `dnsimple_auth_status` | Who is signed in, which environment, stored contexts, login in progress. |
| `dnsimple_auth_login` | stdio only: OAuth sign-in in the browser (`sandbox: true` for the sandbox environment). On a headless host it returns the DNSimple link instead of opening it. |
| `dnsimple_auth_complete` | stdio only: finishes a sign-in whose browser was on another machine, from the `http://127.0.0.1…` address that browser ended on. |
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
- The OAuth callback goes to `127.0.0.1` on the machine running the server. With the browser on that machine the sign-in completes by itself; otherwise it takes the [two steps above](#signing-in-without-a-browser-on-the-server).
- **By default the HTTP server is for this machine only.** It binds to `127.0.0.1`, rejects other `Host` and `Origin` headers, and its tokens mean "may use this computer's dnsimple CLI". Any program you let through the sign-in page gets that access. Opening it to other machines is opt-in; see [Serving HTTP mode to other machines](#serving-http-mode-to-other-machines).
- If the `dnsimple` CLI is missing, the server still starts and answers; it says so on stderr and every tool call returns that as its error.

## Configuration

| Option | Effect |
| --- | --- |
| `--context <name>` or `DNSIMPLE_MCP_CONTEXT` | Pin every call to one stored CLI context (safe alongside other agents; disables switching). |
| `--http` / `--stdio` or `DNSIMPLE_MCP_TRANSPORT` | Transport (default stdio, in the Docker image too). |
| `--port <n>` or `DNSIMPLE_MCP_PORT` | Serve over HTTP with OAuth on the connection (default port 8377). |
| `--host <addr>` or `DNSIMPLE_MCP_HOST` | With `--http`: address to bind (default `127.0.0.1`; `0.0.0.0` in the Docker image). |
| `--public-url <url>` or `DNSIMPLE_MCP_PUBLIC_URL` | With `--http`: the base URL clients reach the server at. OAuth metadata is built from it. |
| `--allowed-hosts <h1,h2>` or `DNSIMPLE_MCP_ALLOWED_HOSTS` | With `--http`: further `Host` header values to answer to (`name` or `name:port`). |
| `DNSIMPLE_MCP_ACCESS_KEY` | With `--http`, when reachable from other machines: the key the sign-in page asks for (default: generated, printed at startup). |
| `--sandbox` | With `--http`: sign in to the DNSimple sandbox environment. |
| `DNSIMPLE_MCP_HEADLESS` | `1`: sign in by link and pasted address, for a server with no browser. `0`: never. Default: detected. |
| `DNSIMPLE_MCP_LOGIN_TTL` | Seconds a pending sign-in stays valid (default 300 headless, 600 otherwise). |
| `DNSIMPLE_MCP_STATE_DIR` | Where the HTTP server keeps client registrations, hashed tokens and its access key (default `~/.local/state/dnsimple-mcp`; `/data/dnsimple-mcp` in the image). |
| `DNSIMPLE_BIN` | Path to the `dnsimple` binary. |
| `DNSIMPLE_MCP_NO_BROWSER=1` | stdio: don't launch a browser on login; only return the authorize URL. |

To play safely, use the sandbox: run `--http --sandbox --context sandbox`, or over stdio ask for a sandbox login (creates a `sandbox` context) and run the server with `--context sandbox`.

## Development

```sh
npm install
npm test
npm run test:docker   # builds the image and drives it; needs Docker
```

`npm run test:docker` builds the image and talks to it as a host would: HTTP (the default) in a detached container, and `initialize`, `tools/list` and the headless sign-in link from the real CLI over `docker run -i --stdio`. A `v*` tag publishes the image for both architectures.

`npm test` has layers: catalog parsing against a recorded CLI reference, end-to-end MCP calls over stdio against a fake CLI (asserting the exact argv), the HTTP server's whole OAuth flow (discovery, registration, sign-in through the fake CLI's login, PKCE, refresh, logout) including an SDK client that authenticates by itself, the headless sign-in (the fake CLI listens on loopback as the real one does; a pasted address with the wrong host, port or state, or for an expired login, is refused before it reaches the CLI), HTTP mode behind a public URL and host allow-list, and live tests against the installed CLI. The live tests are read-only, skip themselves when the CLI is missing or signed out, and exercise the OAuth login in a throwaway `HOME` without opening a browser.

## License

MIT
