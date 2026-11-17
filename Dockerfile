# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

# The dnsimple CLI this image wraps. Bump the version here; the release's own
# checksum file is verified at build time.
ARG DNSIMPLE_CLI_VERSION=0.11.1
ARG TARGETARCH

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tini; \
    release="https://github.com/dnsimple/cli/releases/download/v${DNSIMPLE_CLI_VERSION}"; \
    archive="dnsimple_${DNSIMPLE_CLI_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    cd /tmp; \
    curl -fsSLO "${release}/${archive}"; \
    curl -fsSLO "${release}/checksums.txt"; \
    grep " ${archive}\$" checksums.txt | sha256sum -c -; \
    tar -xzf "${archive}" -C /usr/local/bin dnsimple; \
    rm -f "${archive}" checksums.txt; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    dnsimple --version; \
    # the CLI's browser login needs a pty; `script` (bsdutils) provides it
    script --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY LICENSE README.md ./

# Everything that has to survive a restart lives in /data: HOME, so the CLI's
# credential store (~/.config/dnsimple) lands there, and this server's state.
ENV NODE_ENV=production \
    HOME=/data \
    DNSIMPLE_MCP_STATE_DIR=/data/dnsimple-mcp \
    DNSIMPLE_MCP_TRANSPORT=stdio \
    DNSIMPLE_MCP_HEADLESS=1 \
    DNSIMPLE_MCP_HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8377

# HTTP by default, so the MCP connection itself asks for OAuth; `--stdio`
# switches to stdio. tini reaps the login's child processes and forwards signals.
ENTRYPOINT ["tini", "--", "node", "/app/bin/dnsimple-mcp.js"]
