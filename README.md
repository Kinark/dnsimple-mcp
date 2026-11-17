# dnsimple-mcp

An [MCP](https://modelcontextprotocol.io) server for [DNSimple](https://dnsimple.com) that wraps the official [`dnsimple` CLI](https://github.com/dnsimple/cli) and signs in with **OAuth in your browser**. There is no API token to create, paste into a config file, or hand to a model.

- **OAuth, not tokens.** `dnsimple_auth_login` runs the CLI's own authorization-code + PKCE flow: your browser opens, you approve, done. The credential goes straight into the CLI's store; the server never reads it, `--token` is refused, and `DNSIMPLE_TOKEN` is stripped from the CLI's environment.
- **Tracks your CLI.** The command catalog is read from the installed CLI at startup (`dnsimple ai --full`), so new CLI commands show up without a new release of this server.
- **Reads and writes are separate tools**, so a client can auto-approve reads and still ask before anything changes.

## Requirements

- Node.js 20+
- The `dnsimple` CLI on your `PATH` (`brew install dnsimple/tap/dnsimple`, or see the [CLI repo](https://github.com/dnsimple/cli))
- macOS or Linux for the browser login (it needs the `script` utility for a pseudo-terminal). Elsewhere, run `dnsimple auth login` once in a terminal; everything else works.

## Install

Claude Code:

```sh
claude mcp add dnsimple -- npx -y --allow-git=all github:Kinark/dnsimple-mcp
```

Any other MCP client (stdio):

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

`--allow-git=all` is needed on npm 12+, which refuses packages from git by default. Or run it from a clone:

```sh
git clone https://github.com/Kinark/dnsimple-mcp && cd dnsimple-mcp && npm install
claude mcp add dnsimple -- node "$PWD/bin/dnsimple-mcp.js"
```

If you are already signed in with the CLI, it works immediately. Otherwise ask the assistant to sign in to DNSimple and approve the request in the browser.

## Tools

| Tool | What it does |
| --- | --- |
| `dnsimple_query` | Runs a read-only command (`zones list`, `zones records list`, `registrar check`, …) and returns its JSON. |
| `dnsimple_mutate` | Runs a command that creates, changes or deletes something. Marked destructive. |
| `dnsimple_guide` | The CLI reference, or the full help of one command. |
| `dnsimple_auth_status` | Who is signed in, which environment, stored contexts, login in progress. |
| `dnsimple_auth_login` | OAuth sign-in in the browser (`sandbox: true` for the sandbox environment). |
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

## Configuration

| Option | Effect |
| --- | --- |
| `--context <name>` or `DNSIMPLE_MCP_CONTEXT` | Pin every call to one stored CLI context (safe alongside other agents; disables switching). |
| `DNSIMPLE_BIN` | Path to the `dnsimple` binary. |
| `DNSIMPLE_MCP_NO_BROWSER=1` | Don't launch a browser on login; only return the authorize URL. |

To play safely, use the sandbox: ask for a sandbox login (creates a `sandbox` context), then run the server with `--context sandbox`.

## Development

```sh
npm install
npm test
```

The suite has three layers: catalog parsing against a recorded CLI reference, end-to-end MCP calls over stdio against a fake CLI (asserting the exact argv), and live tests against the installed CLI. The live tests are read-only, skip themselves when the CLI is missing or signed out, and exercise the OAuth login in a throwaway `HOME` without opening a browser.

## License

MIT
