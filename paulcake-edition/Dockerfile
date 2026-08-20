FROM node:24-bookworm-slim

ARG CHROME_DEVTOOLS_MCP_VERSION=1.7.0

ENV DEBIAN_FRONTEND=noninteractive \
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 \
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
    CI=1 \
    HOME=/home/node

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
 && curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
 && rm -f /tmp/google-chrome.deb \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}" \
 && npm cache clean --force \
 && mkdir -p /home/node/.cache \
 && chown -R node:node /home/node

COPY --chown=node:node egress-proxy.js /usr/local/lib/browser-egress-proxy.js
COPY --chown=node:node persistent-gateway.js /usr/local/lib/browser-persistent-gateway.js
COPY --chown=node:node healthcheck.js /usr/local/lib/browser-healthcheck.js

USER node
EXPOSE 8000
CMD ["node", "/usr/local/lib/browser-persistent-gateway.js"]
