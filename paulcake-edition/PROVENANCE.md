# Paulcake Edition provenance and changes

## Upstream

- Project: `ChromeDevTools/chrome-devtools-mcp`
- Licence: Apache License 2.0
- Initial Paulcake runtime base: `chrome-devtools-mcp` 1.7.0
- Upstream 1.7.0 tag: `chrome-devtools-mcp-v1.7.0`
- Upstream 1.7.0 release commit: `774d78f5eef5e610407a0c92fa6ec5ed74b027e8`
- Upstream repository: https://github.com/ChromeDevTools/chrome-devtools-mcp

The upstream project source, licence and copyright notices remain intact in this fork.

## Paulcake-specific layer

The files in this directory are the Paulcake Edition hosting/lifecycle layer. They do not replace the upstream Chrome DevTools MCP implementation; the Dockerfile installs the official upstream npm package.

Paulcake Edition adds:

1. a persistent HTTP-to-stdio MCP gateway;
2. external-tool-activity tracking;
3. configurable idle page parking;
4. configurable internal-child recycling;
5. performance trace and screencast activity leases;
6. stale-lease expiry;
7. lifecycle-only `/statusz` and `/healthz` endpoints;
8. a DNS-aware browser egress proxy that rejects protected network ranges;
9. a hardened loopback-only Docker Compose example.

## Origin of the lifecycle change

The lifecycle layer was developed after a long-lived self-hosted Chrome DevTools MCP deployment retained an abandoned dynamic page and consumed substantial CPU after the client had stopped making MCP calls.

The upstream discussion is public at:

https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2599

The Chrome DevTools MCP maintainer described the current attached-page behaviour as expected and suggested that environment-specific cleanup is best handled by a sidecar/gateway tuned to the deployment. Paulcake Edition follows that model.

## Public release hygiene

The public release was derived from the already-tested lifecycle implementation, then genericised before publication:

- private routing tokens were never included;
- private hostnames and organisation-specific configuration were not included;
- the gateway client identity was changed to `paulcake-persistent-browser-gateway`;
- the built-in idle park default was aligned to 20 minutes;
- Docker Compose was changed to a generic local build and loopback port example;
- Paulcake-specific source files carry Apache-2.0 SPDX headers.

## Pre-publication acceptance

The generic release candidate was built and run in a separate Docker container before committing to GitHub. It verified:

- upstream server version 1.7.0;
- 43 tools after an internal idle recycle;
- stale-page parking;
- internal-child recycling with the outer container still running;
- private/LAN navigation blocked with HTTP 403 network evidence;
- zero container restarts;
- `OOMKilled=false`;
- the production service remained unchanged during testing.

These tests validate this initial public implementation. They do not imply compatibility with future upstream releases without retesting.
