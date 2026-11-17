# DNSimple CLI — AI Context

You are interacting with the DNSimple CLI (`dnsimple`), a command-line tool for managing domains, DNS records, certificates, and other DNSimple services via the DNSimple API v2.

## Authentication

The CLI requires a DNSimple API token. The user must authenticate before you can use the CLI.

You can check whether the CLI is already authenticated by running `dnsimple auth status`. If the CLI is not authenticated, ask the user to run `dnsimple auth login` themselves. Do NOT pass tokens via `--token` or environment variables — never handle API tokens directly. To login against the sandbox environment, pass the `--sandbox` flag to the command.

The CLI supports multiple stored authentication *contexts*. Use `dnsimple auth list` to see them; the active one is marked with `*`. To run a single command against a different stored context without changing the active one, pass `--context <name>` — this is the safe option for parallel agents because it does not mutate shared on-disk state.

Don't switch authentication context during a session, unless otherwise specified by the user. The sandbox environment is safer for testing and as a playground. If the user is logged in to a production account, ask for confirmation before executing destructive actions, or actions that could result in a charge like registering a domain or purchasing a product.

## Global Flags

These flags work with any command:

- `-a, --account`: Account ID to operate on
- `--context`: Authentication context to use for this invocation (overrides the active context)
- `--debug`: Enable debug logging
- `--format`: Custom output format (Go template over the resource; use {{.Field}} for single items or {{range .}}{{.Field}}{{end}} for lists)
- `--json`: Output as JSON
- `--no-color`: Disable colored output
- `--sandbox`: Use sandbox environment
- `--token`: API token (overrides DNSIMPLE_TOKEN env var)

## Output Formats

- **Table** (default): Human-readable tabular output
- **JSON**: Machine-readable output with `--json`
- **Custom**: Go template formatting with `--format <template>`

When scripting or parsing output programmatically, always use `--json`.

## Pagination

List commands are paginated and return only the first page by default (30 items).
The `--json` response includes a `pagination` object (`current_page`, `per_page`,
`total_pages`, `total_entries`) — inspect it to decide whether more results exist. In
the default table output, a `Showing X of Y ...` hint is written to stderr when more
pages are available. To retrieve everything in one call, pass `--all` (where supported);
otherwise page through with `--page <n>` and `--per-page <n>`.

## Common Workflows

### List all DNS records for a zone

```shell
dnsimple zones records list example.com --all --json
```

### Create an A record

```shell
dnsimple zones records create example.com --type A --name www --content 1.2.3.4 --ttl 3600
```

### Update an existing record

```shell
dnsimple zones records update example.com 12345 --content 5.6.7.8
```

### Delete a record

```shell
dnsimple zones records delete example.com 12345
```

### Check domain availability

Use `dnsimple registrar check <domain>` for individual, low-volume checks, typically before a registration or transfer. Available on every plan, but rate-limited to discourage bulk use.

```shell
dnsimple registrar check example.com
```

For high-volume availability lookups (10+), use `dnsimple research status <domain>`. Designed for bulk research workflows. Requires dedicated paid access; the call will fail with an authorization error if the account is not entitled. Direct the user to <https://dnsimple.com/sales> to request access.

### Register or transfer a domain

Follow this process:

1. Check the domain status (see "Check domain availability" above). Register only if available; transfer only if already registered.
2. Look up pricing with `dnsimple registrar prices <domain>`.
3. Present the registration or transfer price to the user and wait for explicit confirmation before proceeding.
4. Unless the user specified otherwise, use their most recently updated contact as the registrant and leave auto-renewal enabled (the default). For transfers, ask the user for the auth (EPP) code from the losing registrar.

Register:

```shell
dnsimple registrar prices example.com
dnsimple contacts list --json
dnsimple registrar register example.com --registrant-id 1234
```

Transfer:

```shell
dnsimple registrar prices example.com
dnsimple contacts list --json
dnsimple registrar transfer example.com --registrant-id 1234 --auth-code <code>
```

### Manage Let's Encrypt certificates

```shell
dnsimple certificates letsencrypt purchase example.com
dnsimple certificates letsencrypt issue example.com 98765
```

### Apply a one-click service

```shell
dnsimple services list --json
dnsimple services apply example.com github-pages
```

## Commands

All commands below are invoked as `dnsimple <command>`.
Full command flag tables are included for commands that define local flags.

### accounts

Manage accounts

- `list`: List accounts

### analytics

DNS analytics

- `query`: Query DNS analytics
  Flags:
  - `--start-date`: Start date (ISO8601)
  - `--end-date`: End date (ISO8601)
  - `--groupings`: Group by (comma-separated). Supported: zone_name, date
  - `--sort`: Sort order
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### auth

Manage authentication contexts

- `list`: List authentication contexts
- `login`: Authenticate with DNSimple
  Flags:
  - `--with-token`: Authenticate with an API token instead of the browser
  - `--name`: Name for the new context (auto-derived if omitted)
- `logout`: Remove a stored authentication context
  Flags:
  - `--name`: Name of the context to remove (defaults to active)
- `status`: Show current authentication status
- `switch [<name-or-account-id>]`: Switch the active authentication context

### billing

Billing and charges

- `charges`: List billing charges
  Flags:
  - `--start-date`: Start date (YYYY-MM-DD)
  - `--end-date`: End date (YYYY-MM-DD)
  - `--sort`: Sort order

### certificates

Manage SSL/TLS certificates

Aliases: certs

- `download <domain> <certificate-id>`: Download certificate bundle
- `get <domain> <certificate-id>`: Get certificate details
- `list <domain>`: List certificates for a domain
  Flags:
  - `--sort`: Sort order
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page
- `private-key <domain> <certificate-id>`: Get certificate private key

### certificates letsencrypt

Manage Let's Encrypt certificates

- `issue <domain> <certificate-id>`: Issue a pending Let's Encrypt certificate
- `issue-renewal <domain> <certificate-id> <renewal-id>`: Issue a pending Let's Encrypt certificate renewal
- `purchase <domain>`: Purchase a Let's Encrypt certificate
  Flags:
  - `--name`: Certificate name (subdomain)
  - `--auto-renew`: Enable auto-renewal
  - `--alternate-names`: Subject Alternative Names
  - `--signature-algorithm`: Signature algorithm
- `renew <domain> <certificate-id>`: Purchase a Let's Encrypt certificate renewal
  Flags:
  - `--auto-renew`: Enable auto-renewal
  - `--signature-algorithm`: Signature algorithm

### contacts

Manage contacts

- `create`: Create a contact
  Flags:
  - `--label`: Contact label
  - `--first-name`: First name **(required)**
  - `--last-name`: Last name **(required)**
  - `--email`: Email address **(required)**
  - `--phone`: Phone number **(required)**
  - `--organization`: Organization name
  - `--job-title`: Job title
  - `--address1`: Address line 1 **(required)**
  - `--address2`: Address line 2
  - `--city`: City **(required)**
  - `--state-province`: State or province **(required)**
  - `--postal-code`: Postal code **(required)**
  - `--country`: Country code (e.g., US, IT) **(required)**
  - `--fax`: Fax number
- `delete <contact-id>`: Delete a contact
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <contact-id>`: Get contact details
- `list`: List contacts
  Flags:
  - `--sort`: Sort order
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page
- `update <contact-id>`: Update a contact
  Flags:
  - `--label`: Contact label
  - `--first-name`: First name
  - `--last-name`: Last name
  - `--email`: Email address
  - `--phone`: Phone number
  - `--organization`: Organization name
  - `--job-title`: Job title
  - `--address1`: Address line 1
  - `--address2`: Address line 2
  - `--city`: City
  - `--state-province`: State or province
  - `--postal-code`: Postal code
  - `--country`: Country code (e.g., US, IT)
  - `--fax`: Fax number

### domains

Manage domains

- `create <name>`: Add a domain to the account
- `delete <domain>`: Delete a domain from the account
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
  - `--confirm-registered-domain`: Acknowledge deletion of a registered domain, which downgrades it to hosted and loses registration metadata
- `get <domain>`: Get domain details
- `list`: List domains
  Flags:
  - `--name-like`: Filter domains by name (partial match)
  - `--sort`: Sort order (e.g., name:asc, expiration:desc)
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### domains dnssec

Manage DNSSEC for a domain

- `disable <domain>`: Disable DNSSEC
- `enable <domain>`: Enable DNSSEC
- `status <domain>`: Get DNSSEC status

### domains ds-records

Manage delegation signer (DS) records

- `create <domain>`: Create a DS record
  Flags:
  - `--algorithm`: DNSSEC algorithm **(required)**
  - `--digest`: Digest value
  - `--digest-type`: Digest type
  - `--keytag`: Key tag
  - `--public-key`: Public key
- `delete <domain> <ds-record-id>`: Delete a DS record
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <domain> <ds-record-id>`: Get DS record details
- `list <domain>`: List DS records
  Flags:
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### domains email-forwards

Manage email forwards

- `create <domain>`: Create an email forward
  Flags:
  - `--from`: Alias name (e.g., info) **(required)**
  - `--to`: Destination email address **(required)**
- `delete <domain> <forward-id>`: Delete an email forward
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <domain> <forward-id>`: Get email forward details
- `list <domain>`: List email forwards
  Flags:
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### domains pushes

Manage domain pushes

- `accept <push-id>`: Accept a domain push
  Flags:
  - `--contact-id`: Contact ID for the domain **(required)**
- `initiate <domain>`: Push a domain to another account
  Flags:
  - `--email`: Email of the target account **(required)**
- `list`: List pending domain pushes
  Flags:
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page
- `reject <push-id>`: Reject a domain push

### records (alias for `zones records`)

### registrar

Domain registration operations

- `check <domain>`: Check domain availability
- `prices <domain>`: Get domain prices
- `register <domain>`: Register a domain
  Flags:
  - `--registrant-id`: Contact ID to use as registrant **(required)**
  - `--auto-renew`: Enable auto-renewal (default: true)
  - `--whois-privacy`: Enable WHOIS privacy
  - `--trustee`: Enable trustee service (extra cost may apply)
  - `--premium-price`: Confirm premium price
  - `--extended-attribute`: Extended attributes (key=value)
- `renew <domain>`: Renew a domain
  Flags:
  - `--period`: Number of years to renew (default: 1)
  - `--premium-price`: Confirm premium price
- `restore <domain>`: Restore an expired domain
  Flags:
  - `--premium-price`: Confirm premium price
- `transfer <domain>`: Transfer a domain in
  Flags:
  - `--registrant-id`: Contact ID to use as registrant **(required)**
  - `--auth-code`: Authorization code from current registrar
  - `--auto-renew`: Enable auto-renewal (default: true)
  - `--whois-privacy`: Enable WHOIS privacy
  - `--trustee`: Enable trustee service (extra cost may apply)
  - `--premium-price`: Confirm premium price
  - `--extended-attribute`: Extended attributes (key=value)
- `transfer-out <domain>`: Authorize a domain transfer out

### registrar auto-renewal

Manage domain auto-renewal

- `disable <domain>`: Disable auto-renewal
- `enable <domain>`: Enable auto-renewal

### registrar delegation

Manage domain name server delegation

- `change <domain>`: Change name server delegation
  Flags:
  - `--name-servers`: Name servers (comma-separated) **(required)**
- `get <domain>`: Get current name servers

### registrar registrant-change

Manage registrant changes

- `create`: Create a registrant change
  Flags:
  - `--domain-id`: Domain ID **(required)**
  - `--contact-id`: Contact ID **(required)**
- `delete <change-id>`: Cancel a registrant change
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <change-id>`: Get registrant change details
- `list`: List registrant changes
  Flags:
  - `--state`: Filter by state
  - `--domain-id`: Filter by domain ID
  - `--contact-id`: Filter by contact ID
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### registrar transfer-lock

Manage domain transfer lock

- `disable <domain>`: Disable transfer lock
- `enable <domain>`: Enable transfer lock
- `status <domain>`: Get transfer lock status

### registrar whois-privacy

Manage WHOIS privacy

- `disable <domain>`: Disable WHOIS privacy
- `enable <domain>`: Enable WHOIS privacy

### research

Domain research operations

- `status <domain>`: Bulk domain availability research

### services

Manage one-click services

- `applied <domain>`: List services applied to a domain
  Flags:
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page
- `apply <domain> <service>`: Apply a service to a domain
  Flags:
  - `--settings`: Service settings (key=value)
- `get <service>`: Get service details
- `list`: List available one-click services
  Flags:
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page
- `unapply <domain> <service>`: Remove a service from a domain
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting

### templates

Manage DNS templates

- `apply <template> <domain>`: Apply a template to a domain
- `create`: Create a template
  Flags:
  - `--name`: Template name **(required)**
  - `--sid`: Template short ID **(required)**
  - `--description`: Template description
- `delete <template>`: Delete a template
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <template>`: Get template details
- `list`: List templates
  Flags:
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page
- `update <template>`: Update a template
  Flags:
  - `--name`: Template name
  - `--sid`: Template short ID
  - `--description`: Template description

### templates records

Manage template records

- `create <template>`: Create a template record
  Flags:
  - `--type`: Record type **(required)**
  - `--name`: Record name
  - `--content`: Record content **(required)**
  - `--ttl`: Time to live
  - `--priority`: Record priority
- `delete <template> <record-id>`: Delete a template record
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <template> <record-id>`: Get template record details
- `list <template>`: List template records
  Flags:
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### tlds

List and inspect TLDs

- `extended-attributes <tld>`: Get extended attributes for a TLD
- `get <tld>`: Get TLD details
- `list`: List supported TLDs
  Flags:
  - `--sort`: Sort order
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### vanity-servers

Manage vanity name servers

- `disable <domain>`: Disable vanity name servers
- `enable <domain>`: Enable vanity name servers

### webhooks

Manage webhooks

- `create`: Create a webhook
  Flags:
  - `--url`: Webhook URL **(required)**
- `delete <webhook-id>`: Delete a webhook
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <webhook-id>`: Get webhook details
- `list`: List webhooks

### whoami

Show the currently authenticated identity

### zones

Manage DNS zones

- `activate <zone>`: Activate DNS for a zone
- `check-distribution <zone>`: Check zone distribution status
- `deactivate <zone>`: Deactivate DNS for a zone
- `file <zone>`: Download zone file
- `get <zone>`: Get zone details
- `list`: List zones
  Flags:
  - `--name-like`: Filter zones by name (partial match)
  - `--sort`: Sort order
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page

### zones records

Manage zone records

- `check-distribution <zone> <record-id>`: Check record distribution status
- `create <zone>`: Create a zone record
  Flags:
  - `--type`: Record type (A, AAAA, CNAME, MX, TXT, etc.) **(required)**
  - `--name`: Record name (subdomain or empty for apex)
  - `--content`: Record content **(required)**
  - `--ttl`: Time to live in seconds
  - `--priority`: Record priority (for MX, SRV)
  - `--regions`: Regions for regional records
- `delete <zone> <record-id>`: Delete a zone record
  Flags:
  - `-y, --yes`: Confirm the destructive operation without prompting
- `get <zone> <record-id>`: Get zone record details
- `list <zone>`: List zone records
  Flags:
  - `--name`: Filter by exact name
  - `--name-like`: Filter by name (partial match)
  - `--type`: Filter by record type (A, AAAA, CNAME, MX, TXT, etc.)
  - `--sort`: Sort order
  - `--all`: Fetch all pages
  - `--page`: Page number
  - `--per-page`: Number of items per page
- `update <zone> <record-id>`: Update a zone record
  Flags:
  - `--name`: Record name
  - `--content`: Record content
  - `--ttl`: Time to live in seconds
  - `--priority`: Record priority
  - `--regions`: Regions for regional records

## Tips

- Use `--all` on list commands to fetch every page of results automatically.
- Use `--json` when you need to parse output or chain commands.
- Use `--yes` on destructive commands in scripts and CI to skip confirmation prompts.
- The `zones` and `zones records` commands are the primary way to manage DNS. The top-level `records` command is a shortcut alias.
- Domain names (e.g. example.com) are used as zone identifiers — you don't need zone IDs.
- Record IDs are numeric. Use `zones records list` with `--json` to find them.
