# Chrome DevTools MCP: Paulcake Edition

**Persistent, self-hosted Chrome DevTools MCP with idle lifecycle management, stale-page cleanup, child-process recycling and long-running trace protection.**

Paulcake Edition is an unofficial community extension of [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp), designed for people who run Chrome DevTools MCP as a **persistent remote MCP server** rather than a short-lived local process.

It keeps the upstream Chrome DevTools MCP tool behaviour intact and adds an environment-aware gateway around it.

> **Not an official Google or Chrome product.** Chrome DevTools MCP is developed by the Chrome DevTools team. Paulcake Edition is an independent community project and is not affiliated with or endorsed by Google.

## Why Paulcake Edition exists

Chrome DevTools MCP intentionally stays attached to browser pages until those pages are closed or the server stops. That is sensible for interactive debugging, but it creates a lifecycle problem for long-running self-hosted deployments: an AI client can disappear while a dynamic page keeps timers, polling, rendering and other browser work alive indefinitely.

This edition was created after a stale SPA page in a persistent deployment continued using roughly **28-30% CPU for hours on a four-core host** after the agent had finished. Closing/parking the abandoned browser state reduced idle CPU to effectively zero.

The behaviour and proposed lifecycle approach were discussed upstream in [ChromeDevTools/chrome-devtools-mcp#2599](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2599). The maintainer's current preference is to keep environment-specific cleanup in a sidecar or gateway tuned to each deployment rather than impose one lifecycle policy on every MCP client. Paulcake Edition follows that direction.

## What it adds

- **Persistent MCP gateway**: fresh external MCP sessions share one long-lived Chrome DevTools MCP child and browser state.
- **Idle park**: after a configurable idle period, extra pages are closed and the retained page is navigated to `about:blank`.
- **Idle recycle**: after a longer idle period, only the internal Chrome DevTools MCP child is recreated. The public gateway/container stays alive.
- **Activity leases**: manual performance traces and screencasts prevent idle maintenance while legitimate long-running work is active.
- **Lease fail-safe**: abandoned long-running leases eventually expire so they cannot make the browser immortal forever.
- **Health and lifecycle status**: `/healthz` and privacy-safe `/statusz` endpoints expose readiness/lifecycle state without browser content.
- **DNS-aware egress guard**: the included forward/CONNECT proxy rejects private, loopback, link-local and other protected network ranges before Chrome can connect.
- **Hardened Docker example**: non-root runtime, dropped capabilities, `no-new-privileges`, PID/CPU/RAM limits and loopback-only host publishing.

## Upstream base

The first public Paulcake Edition is built around **Chrome DevTools MCP 1.7.0**, released by the upstream project on 10 August 2026.

The Dockerfile deliberately installs the upstream package from npm rather than maintaining a private copy of Google's runtime:

```dockerfile
ARG CHROME_DEVTOOLS_MCP_VERSION=1.7.0
RUN npm install -g "chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}"
```

That keeps the Paulcake-specific work concentrated in the hosting/lifecycle layer and makes upstream updates easier to review and adopt.

## Quick start

The public implementation lives in [`paulcake-edition/`](./paulcake-edition/).

```bash
git clone https://github.com/paulcakeface/chrome-devtools-mcp.git
cd chrome-devtools-mcp/paulcake-edition
docker compose up -d --build
curl http://127.0.0.1:8814/healthz
```

The MCP endpoint is then available locally at:

```text
http://127.0.0.1:8814/mcp
```

### Important remote-hosting warning

**Do not expose port 8814 or the container's port 8000 directly to the public internet.**

For remote use, put the loopback-only service behind your own authenticated TLS reverse proxy, access gateway or equivalent security boundary. The included egress proxy protects the browser from reaching private network destinations; it is **not** authentication for incoming MCP clients.

## Lifecycle defaults

| Setting | Default | Purpose |
| --- | ---: | --- |
| `BROWSER_IDLE_PARK_MS` | `1200000` (20 min) | Close stale extra pages and park the retained page at `about:blank` |
| `BROWSER_IDLE_RECYCLE_MS` | `3600000` (60 min) | Recreate the internal Chrome DevTools MCP child after longer inactivity |
| `BROWSER_IDLE_CHECK_MS` | `10000` (10 sec) | Lifecycle check interval |
| `BROWSER_ACTIVITY_LEASE_MAX_MS` | `7200000` (2 hr) | Fail-safe expiry for abandoned trace/screencast leases |

The gateway currently recognises these long-running operations as activity leases:

- `performance_start_trace` with `autoStop=false` until `performance_stop_trace`
- `screencast_start` until `screencast_stop`

## Architecture

```text
AI / MCP client
      |
      v
Authenticated reverse proxy (recommended for remote use)
      |
      v
Paulcake persistent HTTP gateway
      |
      +--> lifecycle manager: park / recycle / leases
      |
      +--> one persistent chrome-devtools-mcp stdio child
                  |
                  v
             Headless Chrome
                  |
                  v
          DNS-aware egress proxy
                  |
                  v
             Public Internet
```

The public HTTP gateway can accept fresh client `initialize` calls without repeatedly reinitialising the internal child. JSON-RPC request IDs are remapped internally and real tool activity resets the idle lifecycle.

## Security defaults

The example deployment intentionally uses conservative defaults:

- isolated Chrome context
- network-header redaction
- usage statistics disabled
- update checks disabled in the container
- DNS-aware private-network egress denial
- explicit private/LAN blocked URL patterns as defence in depth
- loopback-only host port
- non-root Node process
- all Linux capabilities dropped
- `no-new-privileges`
- 2 GiB memory/memory-swap limit
- 2 CPU limit
- PID limit 512
- 512 MiB `/dev/shm`

Chrome currently uses `--no-sandbox` inside the restricted container, so **container isolation and the network boundary remain important security controls**.

## Tested acceptance evidence

Before the public files were committed, the generic Paulcake release candidate was built and exercised separately from the production deployment.

It passed:

- Chrome DevTools MCP **1.7.0** initialisation
- **43 tools** available after an internal idle recycle
- automatic stale-page parking to `about:blank`
- internal child recycle without restarting the Docker container
- private/LAN navigation attempts blocked with authoritative **HTTP 403** network evidence
- zero Docker restarts
- `OOMKilled=false`
- production deployment remained untouched during release testing

Earlier isolated lifecycle testing also observed working-set reduction from roughly **327 MiB to 139 MiB** after an internal recycle and idle CPU around **0.02%**. These are environment-specific observations, not performance guarantees.

## Status endpoint

`GET /statusz` returns lifecycle-only state similar to:

```json
{
  "ready": true,
  "parked": true,
  "recycled_since_activity": true,
  "active_external_calls": 0,
  "idle_ms": 12345,
  "activity_leases": [],
  "maintenance_active": false,
  "child_pid": 142
}
```

It deliberately does not expose page URLs, page content, network requests or browser data.

## Who should use this?

Paulcake Edition is aimed at people who:

- self-host Chrome DevTools MCP
- run an MCP server continuously
- expose it through a persistent authenticated gateway
- use ChatGPT, Claude, coding agents or other MCP clients that may reconnect between tool calls
- run Chrome DevTools MCP in Docker or on a home/server environment
- want abandoned browser sessions cleaned up automatically
- have seen stale Chrome pages keep consuming CPU or memory after an agent leaves

If you only use Chrome DevTools MCP as a short-lived local process, the upstream project is probably all you need.

## Relationship with upstream

Please use the upstream project for upstream Chrome DevTools MCP bugs, features and documentation:

- [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Upstream releases](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases)

Issues specific to the Paulcake lifecycle/gateway layer can be raised on this fork.

The goal is to stay respectful of upstream behaviour and keep Paulcake-specific changes outside Google's core tool implementation wherever practical.

## Licence and trademarks

The upstream Chrome DevTools MCP source is licensed under the **Apache License 2.0**. This fork retains the upstream licence and copyright notices.

Paulcake-specific files are also released under **Apache-2.0** and are marked accordingly.

Chrome, Chrome DevTools, Google and related marks belong to their respective owners. The name **Paulcake Edition** identifies this independent community modification; it does not imply Google sponsorship or endorsement.

---

### Search / discovery summary

**Chrome DevTools MCP Paulcake Edition** is a persistent self-hosted Chrome DevTools MCP gateway/sidecar for long-running MCP servers, with idle browser cleanup, `about:blank` parking, Chrome DevTools MCP child recycling, performance-trace and screencast activity leases, Docker hardening and private-network egress protection.
