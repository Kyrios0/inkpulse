# InkPulse

A low-power e-ink dashboard for device batteries, AI usage, and US stocks, crafted with GPT.

A PC collector sends local summaries to an always-on server, which fetches stocks
and renders 800 × 480 grayscale pages. The E1001 downloads changed images over
Wi-Fi. Stocks keep updating while the PC is off; AI and battery readings retain
their last known values with freshness labels.

## Pages

- **Overview:** phone, watch, and headphone batteries above AI capacity.
- **Stocks:** your configured watchlist, daily changes, and price trends.
- **AI usage:** Codex and Claude capacity, with reset times when available.

Left/right buttons switch cached pages; Refresh checks the server. Current
firmware stays awake and is intended for plugged-in use. Unchanged images do not
redraw; AFK holds further reduce panel refreshes.

## Try locally

Requires Node.js 22+ (CI uses 24). Mock previews need no credentials or hardware.

```sh
npm install
npm test
npm run render:mock
```

Previews are written to the ignored `output/mock/` directory using fictional data.
Tests cover rendering, API authorization, caches, collectors, and refresh policy.

## Configure and run

Use [.env.example](.env.example) as a reference; keep real settings in ignored
local files, never in source code.

1. **Server:** create `.env.local`, choose 1–12 `INKPULSE_STOCK_SYMBOLS`, and set
   distinct display and AI-ingest tokens. There is no default watchlist.
2. **PC:** configure the ingest URL/token; optionally copy
   [battery.example.json](config/battery.example.json) to `config/battery.local.json`.
   Bluetooth batteries and input/lock detection require native Windows.
3. **E1001:** configure Wi-Fi, HTTPS origin, and display token following the
   [firmware guide](firmware/e1001/README.md).

After building, run each component on its intended host:

```sh
# Local server (npm start instead uses the existing process environment)
node --env-file=.env.local dist/apps/server/src/index.js
# PC collector (loads .env.local automatically)
npm run collect:ai
```

For a VPS, follow [deployment](docs/deployment.md): unprivileged SSH account,
PM2, loopback listener, and TLS reverse proxy. Deploying the server does not
restart the PC collector or flash the device.

## Data and refresh limits

- Device checks default to 60 seconds; stock fetches to 900 seconds.
- Codex uses local CLI sign-in; Claude reads Desktop's local usage cache, whose
  updates may lag polling. Only normalized summaries leave the PC.
- Battery values may be rounded/cached by Windows; disconnected readings remain
  visible with timestamps for up to 48 hours. Charging is not inferred.
- Yahoo quotes use an unofficial keyless source, not a trading-grade feed.
- Deep sleep, market-aware scheduling, authenticated stock providers, and server
  metrics remain future work. Battery-life tables are estimates, not measurements.

## Documentation

- [Collectors and data sources](docs/data-sources.md) — setup, privacy, freshness, diagnostics
- [Architecture](docs/architecture.md) — components, caches, security boundaries
- [Deployment](docs/deployment.md) — VPS setup, collector restart, opt-in monitoring
- [Display protocol](docs/display-protocol.md) — API, image versions, AFK holds
- [E1001 firmware](firmware/e1001/README.md) — build, flash, buttons, refresh counters
- [Battery-life estimates](docs/battery-life.md) — assumptions and measurement plan

CI tests Windows/Linux and builds firmware. Production monitoring is opt-in;
configure its repository URL and read-only secret as described in deployment.
