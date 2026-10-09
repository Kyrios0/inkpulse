# Collectors and data sources

```sh
npm run build
npm run collect:ai                       # watch loop: upload, then wait 60 s
npm run collect:codex:once -- --dry-run  # print Codex usage; no upload
npm run collect:claude:check             # print Claude Desktop usage; no upload
npm run collect:battery:check            # print Bluetooth batteries; no upload
```

## PC setup

Create ignored `.env.local` with `INKPULSE_AI_INGEST_URL` and `INKPULSE_AI_INGEST_TOKEN` (distinct from
the display token); see [.env.example](../.env.example). For the Windows sign-in task, see
[deployment](deployment.md#collector). Batteries and AFK detection need native Windows; Codex also works on WSL/Linux.

Only normalized summaries leave the PC: no credentials, account IDs, device names or addresses, conversations,
or logs. Pages show UTC until an AI report supplies the PC timezone.

Compatibility: `collect:codex` and `collect:codex:once` are aliases; legacy `INKPULSE_CODEX_INGEST_*`
variables still work; an ingest URL ending in `/api/v1/metrics` maps to the `/codex` route.

## Sources

| Source | Reads | Notes |
| --- | --- | --- |
| Codex | Local App Server via the CLI sign-in | Percentages, window lengths, reset times |
| Claude Desktop | `plan-usage-history.json` v2 (`t`, `u.fh`, `u.sd`) | Newest sample only; no reset times |
| Batteries | Windows Hands-Free HF/AG device properties | Connected devices only |

Codex readings older than 180 s show `Last reading <time>`; `Live` means recent collection, not activity.

Claude Desktop samples about every 15 minutes, so faster polling can't help; its stale threshold is
30 minutes. Windows paths are auto-discovered; `INKPULSE_CLAUDE_USAGE_FILE` overrides them (macOS/Linux
paths are unverified). Multiple histories, multiple organizations, or an unknown schema are rejected,
and the server keeps its previous snapshot.

## Batteries

Copy [battery.example.json](../config/battery.example.json) to ignored `config/battery.local.json` with the
exact paired Bluetooth names for any of `phone`, `watch`, `headphones`; omit the file to disable.
`INKPULSE_BATTERY_CONFIG_FILE` overrides the path. Support varies by device; Phone Link Calls can help keep
a phone connected.

Values come from Windows' cache and may be rounded; charging is not detected. On the page:

- Numbers round to 10%; values between 0 and 10 show `<10%`; ≤20% inverts the tile.
- Disconnected, collector-offline, or over-3-minute-old readings turn gray with `Last reading <time>`.
- After 48 hours the tile shows a dash and `Disconnected`.
- Battery changes never release an AFK hold.

## Stocks

Set 1–12 `INKPULSE_STOCK_SYMBOLS` (no default). Yahoo's unofficial chart API gives five-minute bars,
fetched every 900 s. Failed symbols keep their cached quote; `STALE` appears only after failures last
two refresh intervals. There is no fallback or authenticated provider.
