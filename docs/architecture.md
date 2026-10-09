# InkPulse architecture

## Goals

- Present useful information at a glance on a low-power E1001 display.
- Keep US stock data updating when the user's PC is off.
- Accept that AI usage updates only while the PC collector is running.
- Keep firmware simple and make layout changes deployable from the server.
- Limit the impact of a compromised VPS.

## Components

### PC collector

The collector reads Codex and Claude Desktop usage and optional Windows Bluetooth
batteries locally and uploads only
normalized summaries. It never uploads session credentials, cookies, API keys,
conversation data, or raw logs. One write-only AI credential authorizes a
combined upload and cannot read display pages. Battery device names/addresses stay
in ignored PC configuration; only three fixed slots and their summarized readings
are uploaded. The battery adapter reads connected System-class Hands-Free records,
not stale BLE records or Phone Link's UI. Observation time means the PC read Windows's
cache, not necessarily a new peripheral measurement. Missing readings preserve the
last good cache; battery updates never release the AFK redraw hold.

Each report records both when its provider produced the measurement and when the
VPS received it. On Windows a hidden helper reads input idle time and lock state
through `GetLastInputInfo` and `WTSQuerySessionInformation`. The PC classifies
those values into `present`, `away`, or `transition`; exact idle time and lock
state never leave the PC. The helper needs the signed-in interactive session,
so the collector is a logon-triggered task rather than a service. The renderer
can label old data as stale instead of presenting it as current.

The implementation launches the installed Codex CLI's local App Server over
stdio and calls `account/rateLimits/read`. It uses the existing local sign-in;
the collector never parses Codex credential storage. This interface is kept
behind one adapter because the App Server contract follows the installed Codex
version. `collect:ai` runs a persistent watch loop; the Windows sign-in task
launches that loop. `collect:codex:once` runs one combined collection attempt.
Both include Claude and optional batteries despite the legacy command name.

### InkPulse service on the deployment host

The service runs as an unprivileged application user and has four
responsibilities:

1. Fetch and cache US stock quotes through a replaceable provider adapter.
2. Receive and store the latest normalized AI usage and battery summaries.
3. Render the overview, stocks, and AI usage pages.
4. Serve a versioned display manifest and the latest images with ETags.

The application binds to a loopback address. Nginx provides the externally
reachable TLS endpoint. PM2 state belongs to the application user and is
separate from other users' PM2 processes.

### E1001 firmware

The plugged-in firmware stays awake, checks the manifest on its
declared schedule, and downloads only changed pages. Polling consumes power but
does not refresh the panel; it redraws only when the selected page's
pixels change and the server does not ask it to hold (see
[display-protocol.md](display-protocol.md#presence-and-redraw-hold)). It stores the selected
page and versioned images in LittleFS. Left and right change the selected page;
refresh checks for new content. Deep sleep is not implemented; device-specific
energy measurements are still needed before designing a battery mode.

The panel keeps its last image without power. Network or service failure must
therefore leave the last valid page visible rather than clear the screen.

## Data flow

```text
                  +--------------------+
stock provider -->| stock adapter/cache|--+
                  +--------------------+  |
                                            v
PC collector ----> AI/battery caches ----> renderer --> page cache
                                                   |       |
                                                   |       v
                                                   +--> manifest --> E1001
PC collector activity --> presence tracker ----------------^
                          (present/away, holdRedraws)
```

## Availability rules

- A failed stock fetch preserves the last successful quote and its timestamp.
- Missing or old AI usage data is rendered with a visible stale indicator.
- Missing or expired batteries show a dash; disconnected devices and offline collectors
  retain gray last readings with fixed timestamps until their PC observations
  are 48 hours old, then show a dash labeled `Disconnected`.
  Battery display rounds to 10% steps; raw readings determine low-battery alerts.
  Stocks remain on the dedicated page, not the overview.
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
- Payload validation is implemented in the API; configure public rate limits
  in the reverse proxy (the application does not supply a rate limiter).
- Set both tokens before exposing the service: absent display credentials allow
  unauthenticated reads, while absent ingest credentials disable writes.
- Run the application without sudo and write only below its service/data paths.

## Source layout

```text
apps/
  server/       HTTP API, caches, scheduling, and renderer
  pc-agent/     Local AI usage, battery, and presence collector
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
fifteen-minute default refresh. Responses are validated and normalized before an
atomic cache write. Partial refreshes retain the previous value for failed
symbols, and a total provider outage keeps the last complete snapshot.

No automatic fallback provider is implemented. Upstream access, availability,
and usage terms must be evaluated for each deployment. The adapter boundary
allows a credentialed provider later without changing the renderer.

## Refresh cadence

Fifteen minutes is the default server-side stock cadence. The watchlist is for
glancing and limiting upstream requests. The provider returns five-minute trend
bars; this does not guarantee that quote metadata changes only every five
minutes. With N configured symbols, steady-state polling makes about 4N
requests per hour, plus a startup fetch. There is no default watchlist.

This is a configurable product choice rather than a hardware constraint. The
device manifest cadence defaults to 60 seconds, independently of stock fetching.
Only selected-page changes can redraw the panel, subject to presence holds.
The refresh button checks the current server pages; it does not force a new
upstream stock fetch. Market-aware scheduling is not implemented. Power-model
assumptions and proposed experiments are in [battery-life.md](battery-life.md).
