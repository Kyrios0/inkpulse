# InkPulse

A low-power e-ink dashboard for US stock updates, Codex usage, and other
personal real-time data.

## Architecture

```text
US stock source ---------------------------+
                                            |
PC Codex collector ---> deployment host ---> rendered page set ---> E1001
   (PC online only)        cache/API             800 x 480           Wi-Fi pull
```

The deployment host is the always-on center of the system. It collects and
caches stock data, receives summarized Codex usage from the PC, and renders
display pages. The E1001 periodically pulls a small manifest and only downloads
pages whose versions changed.

Rendering lives on the VPS rather than the PC, so stock pages continue to
update while the PC is offline. Codex data remains at its last known value and
is visibly marked stale.

## Version 1 pages

1. **Overview** — selected stocks, Codex usage, and update status.
2. **Stocks** — the complete watchlist with price and daily movement.
3. **Codex** — usage windows, reset times, and collector freshness.

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

The deployment host receives only summarized Codex metrics. It must not contain
Codex credentials, brokerage credentials, or general access to the PC.

## Interfaces

- `GET /api/v1/display/manifest` — page versions and image metadata
- `GET /api/v1/display/pages/:pageId.png` — rendered four-level grayscale page
- `GET /health` — process health for deployment checks
- `PUT /api/v1/metrics/codex` — PC collector upload using a separate write token

The display protocol is specified in [docs/display-protocol.md](docs/display-protocol.md).
The component design and failure behavior are described in
[docs/architecture.md](docs/architecture.md).
The E1001 refresh-cadence experiment is tracked in
[docs/battery-life.md](docs/battery-life.md).
Deployment and rollback are documented in [docs/deployment.md](docs/deployment.md).

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

## Stock data

The initial keyless adapter requests five-minute US quote charts from Yahoo and
stores the last successful normalized snapshot on disk. Symbols and refresh
frequency are environment settings. Provider failures preserve cached quotes
and visibly mark the Stocks page stale; the display is informational and not a
trading data source.

## Codex usage

The PC collector asks the locally installed Codex CLI for the signed-in
account's rate-limit windows, normalizes them, and uploads only percentages,
window durations, and reset times. It does not read or upload credential files,
account identifiers, raw logs, or conversation data.

Create an ignored `.env.local` on the PC with `INKPULSE_CODEX_INGEST_URL` and
`INKPULSE_CODEX_INGEST_TOKEN`, then run:

```sh
npm run collect:codex
```

Use `npm run collect:codex -- --dry-run` to verify the local Codex read without
contacting the server.

The command is one-shot and works on Windows, WSL, and Linux. Schedule it every
five minutes on a PC that is normally on; the server marks the value offline
after 15 minutes without a successful upload while retaining the last reading.

## Delivery stages

1. Build a mock-data server and render all three pages at 800 x 480.
2. Add the PC Codex collector and freshness handling. **Complete.**
3. Add a replaceable US-stock provider adapter and server-side cache. **Complete.**
4. Deploy under an unprivileged account. **Runtime, PM2, loopback service, and
   persistent caches complete; TLS ingress and runtime tokens pending.**
5. Implement and test E1001 firmware when the hardware arrives.
6. Add optional VPS health metrics after the core display flow is stable.
