# InkPulse

A low-power e-ink dashboard for device batteries, AI usage, and US stocks.

## Architecture

```text
US stock source ---------------------------+
                                            |
PC collector ---------> deployment host ---> rendered page set ---> E1001
   (PC online only)        cache/API             800 x 480           Wi-Fi pull
```

The deployment host is the always-on center of the system. It collects and
caches stock data, receives AI usage and battery summaries from the PC, and
renders display pages. The E1001 periodically pulls a small manifest and only downloads
pages whose versions changed.

Rendering lives on the VPS rather than the PC, so stock pages continue to
update while the PC is offline. AI and battery data retain their last known
values with visible stale labels.

## Pages

1. **Overview** — phone, watch, and headphone batteries above AI capacity.
2. **Stocks** — the complete watchlist with price and daily movement.
3. **AI usage** — Codex and Claude capacity, reset times when available, and
   independent freshness labels. The wire ID stays `codex` for compatibility.

The E1001's left and right buttons switch between cached pages. The refresh
button checks the server for updated versions. The current firmware stays awake. Page
switching does not require another network request when the cached image is
current.

## Deployment boundary

- Application account: unprivileged, key-only SSH, and no sudo
- Application directory: supplied by deployment configuration
- Process manager: PM2 owned by the application account
- Application listener: loopback only
- Public entry point: system Nginx reverse proxy

Machine-specific values are stored in `config/deploy.local.json`, which is
gitignored. Copy [config/deploy.example.json](config/deploy.example.json) to
create it for a new deployment target.

Runtime credentials are provided through environment variables. Their names
are documented in [.env.example](.env.example); real `.env` files are ignored
and must never be committed.

The deployment host receives only summarized usage, battery, and coarse presence
data. It must not contain Codex credentials, brokerage credentials, or general
access to the PC.

## Interfaces

- `GET /api/v1/display/manifest` — page versions and image metadata
- `GET /api/v1/display/pages/:pageId.png` — rendered four-level grayscale page
- `GET /health` — process health for deployment checks
- `PUT /api/v1/metrics/codex` — combined AI usage, battery, and presence upload; the path remains for ingress compatibility

The display protocol is specified in [docs/display-protocol.md](docs/display-protocol.md).
The component design and failure behavior are described in
[docs/architecture.md](docs/architecture.md).
The E1001 refresh-cadence experiment is tracked in
[docs/battery-life.md](docs/battery-life.md).
Deployment and rollback are documented in [docs/deployment.md](docs/deployment.md).

## Continuous verification

GitHub Actions runs the build and tests on Linux and Windows for pushes to `main`
and pull requests, plus a firmware build. An opt-in five-minute production monitor verifies HTTPS, the
public health endpoint, authentication boundaries, manifest freshness, all
three PNG pages, ETags, and cache revalidation.

The monitor is skipped until repository variable `INKPULSE_PUBLIC_BASE_URL` is set.
To enable it, configure that URL and the
read-only Actions secret `INKPULSE_MONITOR_DEVICE_TOKEN`. It never receives the
AI ingest token or any account credentials. Run the same probe locally with:

```sh
INKPULSE_PUBLIC_BASE_URL=https://display.example.com \
INKPULSE_MONITOR_DEVICE_TOKEN=... npm run monitor:production
```

## Local development

```sh
npm install
npm test
npm run render:mock
```

`npm test` builds the TypeScript project and verifies image dimensions,
four-level grayscale output, display authorization, manifest ordering, and HTTP
cache revalidation. `npm run render:mock` writes preview images to
`output/mock/`; generated output is gitignored.

To run the live server, copy `.env.example` to `.env.local`, set
`INKPULSE_STOCK_SYMBOLS` to your own 1-12 symbols, and configure its tokens. Then
run `node --env-file=.env.local dist/apps/server/src/index.js`. There is no
production watchlist fallback; `npm start` expects configuration already in the
process environment. Mock rendering needs no local configuration.

Build the E1001 firmware without flashing hardware:

```sh
npm run firmware:build
```

See [`firmware/e1001/README.md`](firmware/e1001/README.md) for the ignored Wi-Fi
and display-token configuration, flashing, and runtime behavior.

The display uses a shared monochrome grid with large readings, thin dividers,
and page indicators. Filled capacity segments mean **remaining** allowance.
Displayed times follow the PC's timezone once the collector publishes a reading;
the timezone is retained while the PC is offline. Before the first reading, times
use UTC. Mock previews use fictional DEMOA–DEMOE quotes independent of deployment
configuration; they are labeled as sample data. Watchlists above six symbols
use compact stock rows. The overview shows three battery slots above a pair of
AI capacity panels; the dedicated Stocks page keeps the full watchlist.

## Device batteries

On Windows, copy `config/battery.example.json` to the ignored
`config/battery.local.json` and enter each device's exact paired Bluetooth name.
The optional slots are `phone`, `watch`, and `headphones`; their names and addresses
remain local. `INKPULSE_BATTERY_CONFIG_FILE` overrides the path. Omit the file to
disable battery collection. This source is not available from WSL/Linux.

After building, `npm run collect:battery:check` reads batteries without uploading
or querying AI usage. The existing `collect:ai` process includes readings in its
one-minute upload. Supported devices expose battery levels through Windows's
System-class Hands-Free HF/AG battery properties; availability varies by device.
The reader checks connection state first; a Bluetooth-class BLE record can hold
an obsolete value. Phone Link's Calls setup may be needed to establish the phone's
Bluetooth connection, but its UI and databases are not used by the collector.

Percentages are Windows-reported, potentially rounded or cached—not guaranteed
one-minute physical measurements. Only slots, percentages, connection state, and
observation timestamps leave the PC. Charging state is not inferred. Missing or
expired readings display a dash; disconnections preserve the last reading. Battery changes
respect the existing AFK hold and do not trigger the AI release exception.
Polling alone does not change pixels; freshness transitions and date changes can.
Battery layout updates require no firmware change.

Battery numbers round to the nearest 10% with a thin ten-step accent; positive
values below 10% show `<10%`. Raw values remain cached: current readings at 20%
or below invert the tile. Disconnection, an offline collector, or observations older than three
minutes show a gray `Last reading <timestamp>`; after 48 hours they show a dash
and `Disconnected`. These ages measure
PC observations of Windows's cache, not physical device samples. Fixed labels
avoid clock-driven redraws; AI bars are unchanged.

## Stock data

The keyless adapter requests US quote charts from Yahoo's unofficial endpoint
with five-minute trend bars, polling every 900 seconds by default. Set your own
`INKPULSE_STOCK_SYMBOLS` (1-12 symbols); there is no default watchlist.
Successful snapshots are cached on disk. Failures retain prior quotes; `STALE`
appears after prolonged failures, not one transient error. Closed-market quote
timestamps can remain unchanged even while fetching works. This is informational,
not a trading data source; an authenticated provider remains future work.

## Claude Desktop usage

The PC collector reads Claude Desktop's local `plan-usage-history.json` (observed
version 2: `t` is the sample time, `u.fh` and `u.sd` are used percentages).
It sends only the newest sample's percentages and original timestamp.
Reset times are absent in this source, so their display lines remain blank.
No Claude credentials, account IDs, conversation data, or history leave the PC.

After building, run `npm run collect:claude:check` to inspect normalized data
without uploading. Windows desktop and Store paths are discovered automatically;
set `INKPULSE_CLAUDE_USAGE_FILE` on the PC to override the path. macOS and Linux
conventional paths are also supported, but only Windows has been live-verified.
Multiple histories or organizations are rejected to avoid mixing accounts.

The shared `collect:ai` process publishes both providers in one request with
`INKPULSE_AI_INGEST_TOKEN` to `INKPULSE_AI_INGEST_URL`.
The token must differ from the read-only display token. The existing
`collect:codex` command and Windows task remain compatible and now publish both
providers too. Existing `INKPULSE_CODEX_INGEST_*` settings remain accepted
temporarily during migration. A URL ending in `/api/v1/metrics` uses the
existing `/codex` ingress route; old single-provider Codex uploads still work.

Desktop samples were observed about 15 minutes apart, so one-minute collector
polling cannot provide one-minute Claude freshness. The default stale threshold
is 30 minutes; rereading old data never advances its timestamp. Closing Desktop
leaves the last sample visible. This is an internal cache format, not a supported
Anthropic API; schema changes fail validation and preserve the last good server
snapshot. The CLI status-line integration is not required.

## Codex usage

The PC collector asks the locally installed Codex CLI for the signed-in
account's rate-limit windows, normalizes them, and uploads only percentages,
window durations, and reset times. It does not read or upload credential files,
account identifiers, raw logs, or conversation data.

Create an ignored `.env.local` on the PC with `INKPULSE_AI_INGEST_URL` and
`INKPULSE_AI_INGEST_TOKEN`, build once, then run the one-minute collector:

```sh
npm run build
npm run collect:ai
```

Use `npm run collect:codex:once -- --dry-run` to verify the local Codex read
without contacting the server. On Windows,
`scripts/install-windows-collector-task.ps1` installs the watch process as a
current-user task launched at sign-in; it does not require administrator access.
On native Windows the collector discovers the newest installed Codex executable,
so a normal Codex application update does not require editing the task.

The Codex collector supports Windows, WSL, and Linux; Bluetooth batteries and
input/lock detection require native Windows. The watch loop waits 60 seconds
after each collection attempt by default. Codex readings older than 180 seconds
are labeled `Last reading`; `Live` means recently collected, not user activity.

## Refresh policy and future work

- Device manifest checks: 60 seconds by default; polling does not redraw the panel.
- Stock fetches: 900 seconds; Claude freshness depends on Desktop's local cache.
- While AFK, changed pages normally wait up to one hour; AI changes briefly
  release the hold, battery changes do not. Buttons override it for five minutes.
- The firmware uses full four-gray refreshes and stays awake. Deep sleep,
  measured battery-life profiles, and market-aware scheduling remain future work.
- Authenticated stock providers and optional server metrics are future extensions.

See [display protocol](docs/display-protocol.md) for exact hold behavior and
[battery estimates](docs/battery-life.md) for the limits of the power model.
