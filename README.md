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

## Version 1 pages

1. **Overview** — phone, watch, and headphone batteries above AI capacity.
2. **Stocks** — the complete watchlist with price and daily movement.
3. **AI usage** — Codex and Claude capacity, reset times when available, and
   independent measurement ages. The wire ID stays `codex` for compatibility.

The E1001's left and right buttons switch between cached pages. The refresh
button wakes the device and checks the server for updated versions. Page
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

GitHub Actions runs the build and tests on Linux and Windows for every push and
pull request. A separate five-minute production monitor verifies HTTPS, the
public health endpoint, authentication boundaries, manifest freshness, all
three PNG pages, ETags, and cache revalidation.

The monitor requires repository variable `INKPULSE_PUBLIC_BASE_URL` and the
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
npm start
```

`npm test` builds the TypeScript project and verifies image dimensions,
four-level grayscale output, display authorization, manifest ordering, and HTTP
cache revalidation. `npm run render:mock` writes preview images to
`output/mock/`; generated output is gitignored.

The E1001 firmware can also be compiled before the hardware arrives:

```sh
npm run firmware:build
```

See [`firmware/e1001/README.md`](firmware/e1001/README.md) for the ignored Wi-Fi
and display-token configuration and the single-upload arrival test.

The display uses a shared monochrome grid with large readings, thin dividers,
and page indicators. Filled capacity segments mean **remaining** allowance.
Displayed times follow the PC's timezone once the collector publishes a reading;
the timezone is retained while the PC is offline. Before the first reading, times
use UTC. Mock previews use illustrative JNJ, JPM, META, PG,
and XLP quotes; they are labeled as sample data. Watchlists above six symbols
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
one-minute upload. Pixel 9 Pro, Pixel Watch 3, and Bose QC Ultra 2 HP have been
verified through Windows's System-class Hands-Free HF/AG battery properties.
The reader checks connection state first; a Bluetooth-class BLE record can hold
an obsolete value. Phone Link's Calls setup may be needed to establish the phone's
Bluetooth connection, but its UI and databases are not used by the collector.

Percentages are Windows-reported, potentially rounded or cached—not guaranteed
one-minute physical measurements. Only slots, percentages, connection state, and
observation timestamps leave the PC. Charging state is not inferred. Missing or
expired readings display a dash; disconnections preserve the last reading. Battery changes
respect the existing AFK hold and do not trigger the AI release exception.
Unchanged readings produce identical pixels, and no firmware change is needed.

Battery numbers round to the nearest 10% with a thin ten-step accent; positive
values below 10% show `<10%`. Raw values remain cached: current readings at 20%
or below invert the tile. Disconnection, an offline collector, or observations older than three
minutes show a gray `Last reading <timestamp>`; after 48 hours they show a dash
and `Disconnected`. These ages measure
PC observations of Windows's cache, not physical device samples. Fixed labels
avoid clock-driven redraws; AI bars are unchanged.

## Stock data

The initial keyless adapter requests five-minute US quote charts from Yahoo and
stores the last successful normalized snapshot on disk. Symbols and refresh
frequency are environment settings. Provider failures preserve cached quotes
and visibly mark the Stocks page stale; the display is informational and not a
trading data source.

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

The same collector works on Windows, WSL, and Linux. It publishes once per
minute while running. The server marks the value offline after three missed
updates while retaining the last reading.

## Delivery stages

1. Build a mock-data server and render all three pages at 800 x 480.
2. Add the PC Codex collector and freshness handling. **Complete.**
3. Add a replaceable US-stock provider adapter and server-side cache. **Complete.**
4. Deploy under an unprivileged account with TLS ingress. **Complete.**
5. Prepare E1001 firmware. **Complete; physical panel validation pending delivery.**
6. Add cross-platform CI and external production monitoring. **Complete.**
