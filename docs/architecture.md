# InkPulse architecture

## Goals

- Present useful information at a glance on a low-power E1001 display.
- Keep US stock data updating when the user's PC is off.
- Accept that Codex usage updates only while the PC collector is running.
- Keep firmware simple and make layout changes deployable from the server.
- Limit the impact of a compromised VPS.

## Components

### PC collector

The collector reads Codex usage locally and uploads only a normalized summary.
It never uploads Codex session credentials, cookies, API keys, or raw logs. A
write-only credential authorizes this single operation.

The payload records both when Codex produced the measurement and when the VPS
received it. The renderer can therefore label old data as stale instead of
presenting it as current.

### InkPulse service on the deployment host

The service runs as an unprivileged application user and has four
responsibilities:

1. Fetch and cache US stock quotes through a replaceable provider adapter.
2. Receive and store the latest normalized Codex summary.
3. Render the overview, stocks, and Codex pages.
4. Serve a versioned display manifest and immutable page images.

The application binds to a loopback address. Nginx provides the externally
reachable TLS endpoint. PM2 state belongs to the application user and is
separate from other users' PM2 processes.

### E1001 firmware

The device wakes on schedule or button input, fetches the manifest, and
downloads only changed pages. It stores the current page index and cached
images locally. Left and right change the selected page; refresh checks for
new content.

The panel keeps its last image without power. Network or service failure must
therefore leave the last valid page visible rather than clear the screen.

## Data flow

```text
                  +--------------------+
stock provider -->| stock adapter/cache|--+
                  +--------------------+  |
                                            v
PC collector ----> Codex ingest/cache --> renderer --> page cache
                                                   |       |
                                                   |       v
                                                   +--> manifest --> E1001
```

## Availability rules

- A failed stock fetch preserves the last successful quote and its timestamp.
- Missing or old Codex data is rendered with a visible stale indicator.
- A rendering failure preserves the last complete page set.
- A page set becomes visible only after every image and its manifest are ready.
- The device retains cached pages and retries later with bounded backoff.

## Security boundaries

- Treat all data stored on the deployment host as potentially readable after
  compromise.
- Store no brokerage, Codex, or PC-login credentials on the VPS.
- Use independent credentials for PC writes and device reads.
- Make credentials revocable and keep them outside the repository.
- Rate-limit public endpoints and validate every payload at the API boundary.
- Run the application without sudo and write only below its service/data paths.

## Planned source layout

```text
apps/
  server/       HTTP API, caches, scheduling, and renderer
  pc-agent/     Local Codex usage collector
firmware/
  e1001/        ESP32-S3 device client and button handling
packages/
  contracts/    Shared schemas and types
docs/
```

The stock provider is intentionally behind an adapter. A keyless source can be
used initially, but the rest of InkPulse must not depend on its response shape
or continued availability.
