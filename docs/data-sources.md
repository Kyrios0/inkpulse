# Collectors and data sources

## PC setup

Create ignored `.env.local` with `INKPULSE_AI_INGEST_URL` and
`INKPULSE_AI_INGEST_TOKEN`; the token must differ from the display token.
See [.env.example](../.env.example) for settings.

```sh
npm run build
npm run collect:ai
```

The watch loop waits 60 seconds after each attempt. Windows sign-in setup and
restart commands are in [deployment](deployment.md). Bluetooth and input/lock
detection require native Windows; Codex collection also supports WSL/Linux.

`collect:codex` aliases the combined watch loop; `collect:codex:once` sends one
combined report. Legacy `INKPULSE_CODEX_INGEST_*` variables remain accepted.
An ingest URL ending in `/api/v1/metrics` maps to the existing `/codex` route;
old single-provider uploads remain compatible.

Only normalized summaries leave the PC—not credentials, account IDs, device
names/addresses, conversations, or logs.
Display times use UTC until an AI report supplies the PC timezone; cached reports
retain it while the PC is offline. AI capacity bars show remaining allowance.

## Sources and diagnostics

Run these after building; they inspect data without uploading to InkPulse.

| Source | Diagnostic command | Behavior |
| --- | --- | --- |
| Codex | `npm run collect:codex:once -- --dry-run` | Local CLI sign-in; percentages, durations, reset times |
| Claude Desktop | `npm run collect:claude:check` | Latest local history sample; no reset times |
| Batteries | `npm run collect:battery:check` | Windows Hands-Free HF/AG properties; no AI queries |

Codex executable discovery follows Windows app updates. Readings older than
180 seconds show `Last reading`; `Live` means recent collection, not user activity.

Claude reads internal `plan-usage-history.json` v2 fields `t`, `u.fh`, and `u.sd`.
Observed sampling is roughly 15 minutes; faster polling cannot improve that.
The stale default is 30 minutes; original sample timestamps never advance on
reread. Reset lines remain blank. Windows desktop/Store paths auto-discover;
`INKPULSE_CLAUDE_USAGE_FILE` overrides them. macOS/Linux paths exist but are not
live-verified. Multiple histories/organizations or invalid schemas are rejected;
the server keeps its previous snapshot. No status-line integration is required.

## Battery setup and display

Copy [battery.example.json](../config/battery.example.json) to ignored
`config/battery.local.json`, using exact paired Bluetooth names for optional
`phone`, `watch`, and `headphones` slots. Omit it to disable collection;
`INKPULSE_BATTERY_CONFIG_FILE` overrides the path.

The adapter checks connection state and reads System-class HF/AG properties,
not potentially stale Bluetooth-class BLE records. Device support varies.
Phone Link Calls may help connect a phone, but its UI/databases are not read.

Windows values may be rounded/cached. Observation time means a PC cache read,
not a new peripheral measurement; charging is not inferred.

- Numbers round to 10%; positive values below 10% show `<10%`.
- Current raw values ≤20% invert the tile.
- Disconnected, collector-offline, or >3-minute-old observations show gray
  values with fixed `Last reading <timestamp>` labels.
- At 48 hours, show a dash and `Disconnected`; missing readings show a dash immediately.
- Battery changes never release AFK holds. Date/freshness transitions can change pixels.

## Stocks

Set 1–12 `INKPULSE_STOCK_SYMBOLS`; there is no default watchlist. Yahoo's unofficial,
keyless chart source returns five-minute trend bars, polled every 900 seconds.
Quote metadata may change between bars. Failures preserve cached quotes;
`STALE` appears after prolonged failures, not a lone transient error.
Closed-market timestamps can stay unchanged despite successful fetching.
No fallback or authenticated provider exists; this is not a trading-grade feed.
