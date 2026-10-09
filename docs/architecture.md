# Architecture

```text
Stock provider -> stock cache --+
                               +-> renderer -> manifest/PNGs -> E1001
PC collector -> AI/battery caches+
             -> presence tracker -> redraw policy
```

| Component | Role |
| --- | --- |
| PC collector | Read local AI usage and batteries; upload normalized summaries and coarse presence |
| Server | Fetch stocks independently of the PC, persist caches, render Overview and Stocks |
| E1001 | Validate and cache images, navigate locally, redraw the selected page subject to holds |

The server listens on loopback behind a TLS reverse proxy, under an unprivileged user's PM2. Layout
changes need a server deploy, not a flash. The firmware stays awake; deep sleep is not implemented.

## Data and failures

- Adapters isolate external formats: Codex via the local App Server (`account/rateLimits/read`); Claude
  and batteries via local caches and device properties.
- Presence uses Windows `GetLastInputInfo` and `WTSQuerySessionInformation`, which only work in the
  signed-in session; only `present`/`away`/`transition` leaves the PC.
- Caches keep the last good reading through collection failures, with source time and receipt time kept apart.
- Failed stock symbols keep their previous values; there is no provider fallback.
- The server publishes only complete page sets; the device keeps its cache and image on any failure.

Stocks refresh every 15 minutes (about 4 requests per symbol per hour); devices check every 60 s.
Freshness rules: [data sources](data-sources.md). AFK behavior: [display protocol](display-protocol.md).

## Security

Assume a compromised VPS can read its stored summaries and tokens. Account credentials, cookies, device
names, and conversations stay on the PC. Writes and display reads use separate revocable tokens; production
refuses to start without a display token, and without an ingest token uploads are disabled. The API
validates every payload; rate limits, TLS, and firewall rules live outside the app, which runs without sudo.

## Source layout

- `apps/pc-agent/`: collectors and presence helper
- `apps/server/`: API, caches, scheduling, rendering
- `packages/contracts/`: shared schemas and validation
- `firmware/e1001/`: device client, buttons, refresh counters
