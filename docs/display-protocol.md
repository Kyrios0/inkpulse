# E1001 display protocol

```sh
curl -H "Authorization: Bearer $INKPULSE_DEVICE_TOKEN" https://display.example.com/api/v1/display/manifest
```

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Public service health |
| `GET /api/v1/display/manifest` | Page versions and redraw policy |
| `GET /api/v1/display/pages/:pageId.png` | Latest rendered image (`overview`, `stocks`) |
| `PUT /api/v1/metrics/codex` | Combined collector upload (legacy route name) |

Display reads use a read-only bearer token, separate from the collector's write token; tokens never go in
URLs. Firmware pins TLS to ISRG Root X1/X2, rejects redirects, and only fetches the declared page's route.
Pages are 800 × 480 four-gray PNGs rendered by the server. The retired `codex.png` page returns 404.

## Manifest

Schema 1, showing one of the two pages:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-21T12:00:00Z",
  "refreshAfterSeconds": 60,
  "defaultPage": "overview",
  "presence": "present",
  "holdRedraws": false,
  "awayRedrawSeconds": 3600,
  "pages": [{
    "id": "overview",
    "title": "Overview",
    "version": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "imageUrl": "/api/v1/display/pages/overview.png?v=sha256%3A0000000000000000000000000000000000000000000000000000000000000000",
    "width": 800,
    "height": 480,
    "format": "png",
    "updatedAt": "2026-09-21T12:00:00Z"
  }]
}
```

`version` is the SHA-256 of the PNG bytes, so unchanged images are never downloaded again; images also
support `ETag`/`If-None-Match`. Only the latest set is served, so a stale version URL can return newer
bytes; the firmware rejects the digest mismatch and retries on the next check.

Pages avoid pixels that change without new data: headers show the date, stock footers show the quote
time, stale labels show a fixed time, AI percentages move in 1% steps, and batteries in 10% buckets.

## Presence and redraw hold

Older firmware ignores these schema-1 fields:

- `presence`: `present`, `away`, or `unknown`. `unknown` means tracking is off (`INKPULSE_PRESENCE_HOLD=off`
  or no ingest token) and never holds.
- `holdRedraws`: hold changed pages while away, except for 180 s after the displayed AI values change
  (`INKPULSE_AI_RELEASE_SECONDS`). Battery changes never release it.
- `awayRedrawSeconds`: while held, still show a changed page once this long after the last redraw
  (default 3600; `0` holds fully).

The PC classifies itself: locked or idle ≥600 s is `away`, input within 120 s is `present`, anything between
is `transition` and keeps the previous state (`INKPULSE_AWAY_AFTER_IDLE_SECONDS`,
`INKPULSE_PRESENT_WITHIN_SECONDS`). Only that word is uploaded; idle time and lock state stay on the PC.

The server starts `away` and keeps state in memory. A post without activity counts as present; no post for
180 s means away (`INKPULSE_COLLECTOR_OFFLINE_SECONDS`, capped at the Codex stale threshold). Any button
press overrides holds for five minutes.

## Device update cycle

1. Fetch and validate the manifest; download changed images.
2. Check each download's SHA-256 against its version; commit the LittleFS page set only when all pass.
   Cached pages are re-checked at boot, and the decoder rejects non-800 × 480 images.
3. Draw the selected page if it changed and no hold applies. A hold never hides the first page.
4. On any failure, keep the cache and the image on screen; retry next check.

Navigation works offline. NVS records the displayed page and version to skip redundant redraws after reboot.
Device polling (`refreshAfterSeconds`) is independent of stock fetching; Refresh never forces a stock fetch.
