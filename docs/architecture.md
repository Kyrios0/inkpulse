# InkPulse architecture

## Goals

- Present useful information at a glance on a low-power E1001 display.
- Keep US stock data updating when the user's PC is off.
- Accept that AI usage updates only while the PC collector is running.
- Keep firmware simple and make layout changes deployable from the server.
- Limit the impact of a compromised VPS.

## Components

### PC collector

The collector reads Codex and Claude Desktop usage locally and uploads only
normalized summaries. It never uploads session credentials, cookies, API keys,
conversation data, or raw logs. One write-only AI credential authorizes a
combined upload and cannot read display pages.

Each report records both when its provider produced the measurement and when the
VPS received it. The renderer can therefore label old data as stale instead of
presenting it as current.

The implementation launches the installed Codex CLI's local App Server over
stdio and calls `account/rateLimits/read`. It uses the existing local sign-in;
the collector never parses Codex credential storage. This interface is kept
behind one adapter because the App Server contract follows the installed Codex
version. A collection run is intentionally one-shot so Windows Task Scheduler,
cron, or a future desktop startup task can invoke the same command.

### InkPulse service on the deployment host

The service runs as an unprivileged application user and has four
responsibilities:

1. Fetch and cache US stock quotes through a replaceable provider adapter.
2. Receive and store the latest normalized Codex and Claude summaries.
3. Render the overview, stocks, and AI usage pages.
4. Serve a versioned display manifest and immutable page images.

The application binds to a loopback address. Nginx provides the externally
reachable TLS endpoint. PM2 state belongs to the application user and is
separate from other users' PM2 processes.

### E1001 firmware

The prepared plugged-in firmware stays awake, checks the manifest on its
declared schedule, and downloads only changed pages. It stores the selected
page and versioned images in LittleFS. Left and right change the selected page;
refresh checks for new content. Deep sleep is deferred until measurements can
be made on the delivered hardware.

The panel keeps its last image without power. Network or service failure must
therefore leave the last valid page visible rather than clear the screen.

## Data flow

```text
                  +--------------------+
stock provider -->| stock adapter/cache|--+
                  +--------------------+  |
                                            v
PC collector ----> AI usage caches -----> renderer --> page cache
                                                   |       |
                                                   |       v
                                                   +--> manifest --> E1001
```

## Availability rules

- A failed stock fetch preserves the last successful quote and its timestamp.
- Missing or old AI usage data is rendered with a visible stale indicator.
- A rendering failure preserves the last complete page set.
- A page set becomes visible only after every image and its manifest are ready.
- The device retains cached pages and retries at the next manifest interval or
  on a Refresh press.

## Security boundaries

- Treat all data stored on the deployment host as potentially readable after
  compromise.
- Store no brokerage, Codex, or PC-login credentials on the VPS.
- Use independent credentials for PC writes and device reads.
- Make credentials revocable and keep them outside the repository.
- Rate-limit public endpoints and validate every payload at the API boundary.
- Run the application without sudo and write only below its service/data paths.

## Source layout

```text
apps/
  server/       HTTP API, caches, scheduling, and renderer
  pc-agent/     Local AI usage collector
firmware/
  e1001/        ESP32-S3 device client and button handling
packages/
  contracts/    Shared schemas and types
docs/
```

The stock provider is intentionally behind an adapter. A keyless source can be
used initially, but the rest of InkPulse must not depend on its response shape
or continued availability.

The first adapter uses Yahoo's unofficial chart endpoint with a conservative
five-minute default refresh. Responses are validated and normalized before an
atomic cache write. Partial refreshes retain the previous value for failed
symbols, and a total provider outage keeps the last complete snapshot.

As of September 2026, there is no equally suitable credential-free fallback
for intraday US quotes. Stooq is not reachable from the deployment host,
Nasdaq's supported market-data APIs require credentials, its public website
endpoint is undocumented, and Cboe prohibits automated extraction from its
delayed-quote pages. Open-source finance libraries wrap these upstream sources;
they do not supply independent market data. The adapter boundary remains so a
credentialed provider can be added later without changing the renderer.

## Refresh cadence

Five minutes is the initial server-side stock cadence because the provider is
requested at five-minute chart granularity. Polling more frequently usually
retrieves the same bar, creates avoidable load on an unofficial endpoint, and
raises rate-limit risk. With the default six-symbol watchlist, a five-minute
cadence produces at most 72 quote requests per hour.

This is a configurable product choice rather than a hardware constraint. The
device manifest cadence is configured separately. Initial estimates favor a
future market-aware schedule rather than one fixed interval: check more often
while US markets are open and every six hours while they are closed. The server
can continue maintaining a five-minute cache, and the refresh button can
request an immediate check. The estimates, assumptions, candidate profiles,
and future measurements are maintained in [battery-life.md](battery-life.md).
