# Architecture

```text
Stock provider -> stock cache --+
                               +-> renderer -> manifest/PNGs -> E1001
PC collector -> AI/battery caches+
             -> presence tracker -> redraw policy
```

## Responsibilities

| Component | Role |
| --- | --- |
| PC collector | Read local usage/batteries; upload normalized summaries and coarse presence |
| Server | Fetch stocks independently of the PC, persist caches, render all three pages |
| E1001 | Validate/cache images, navigate locally, redraw changed selected pages subject to holds |

The server defaults to loopback behind a TLS reverse proxy and runs under an
unprivileged user's PM2. Layout changes require server deployment, not flashing.
The firmware stays awake; deep sleep is not implemented.

## Data and failures

- Provider adapters isolate external formats. Codex uses local App Server
  `account/rateLimits/read`; Claude and batteries use local caches/properties.
- Windows presence uses `GetLastInputInfo` and `WTSQuerySessionInformation`.
  Only `present`/`away`/`transition` leaves the interactive sign-in session.
- Persistent caches retain last good readings after collection failures.
  Source observation times and server receipt times remain distinct.
- Stock partial failures retain failed symbols' previous values. No automatic
  provider fallback exists; assess upstream availability and terms per deployment.
- Rendering publishes complete page sets. Device failures preserve cached pages
  and the last displayed image; retries occur on the next check or button press.

See [data sources](data-sources.md) for freshness and [display protocol](display-protocol.md)
for AFK behavior. Stock polling defaults to 15 minutes to limit traffic:
N symbols generate about 4N requests/hour plus startup. Device checks default
to 60 seconds; the Refresh button does not force an upstream stock fetch.

## Security

Assume a compromised VPS can read its stored summaries and application tokens.
Keep account credentials, cookies, private device names, and conversation data on
the PC. Use separate revocable tokens for writes and display reads.

Set both tokens before public exposure: missing display credentials allow public
reads; missing ingest credentials disable writes. The API validates payloads;
configure rate limits, TLS, and firewall rules outside the app. Run without sudo.

## Source layout

- `apps/pc-agent/`: collectors and presence helper
- `apps/server/`: API, caches, scheduling, rendering
- `packages/contracts/`: schemas and validation
- `firmware/e1001/`: device client, buttons, panel counters

Setup: [deployment](deployment.md), [firmware](../firmware/e1001/README.md).
