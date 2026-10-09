# E1001 display protocol

## API and images

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Public service health |
| `GET /api/v1/display/manifest` | Page versions and redraw policy |
| `GET /api/v1/display/pages/:pageId.png` | Latest rendered image |
| `PUT /api/v1/metrics/codex` | Combined collector upload; legacy ingress name |

Display requests use a read-only `Authorization: Bearer` token, separate from the
collector's write token. Never put tokens in URLs. Firmware validates TLS with
ISRG Root X1/X2, rejects redirects, and accepts only relative image URLs matching
the declared page's route.

Pages are landscape 800 × 480 PNGs with four grayscale levels. The server renders;
firmware decodes. Wire IDs are `overview`, `stocks`, and `codex` (AI usage).

## Manifest

Schema 1 example, showing one of the three pages:

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

Versions hash PNG bytes; unchanged images skip downloads. Responses support
`ETag`/`If-None-Match`. Only the latest page set is served: an old version URL
may return new bytes, so firmware rejects digest mismatches and retries.

## Presence and redraw hold

These additive schema-1 fields are ignored by older firmware:

- `presence`: `present`, `away`, or `unknown` when tracking is disabled.
- `holdRedraws`: hold changed pages while away, except a 180-second window after
  displayed AI values change (`INKPULSE_AI_RELEASE_SECONDS`). Batteries do not release it.
- `awayRedrawSeconds`: permit a changed page after 3600 seconds since the last
  redraw by default; `0` disables this periodic exception.

PC defaults: locked or ≥600 seconds idle means away; input within 120 seconds
means present; intermediate `transition` preserves the prior state.
Set `INKPULSE_AWAY_AFTER_IDLE_SECONDS`/`INKPULSE_PRESENT_WITHIN_SECONDS` on the PC.

The server starts away, then marks a posting collector without activity data
present. No post for 180 seconds means away (`INKPULSE_COLLECTOR_OFFLINE_SECONDS`,
capped at the Codex stale threshold). `INKPULSE_PRESENCE_HOLD=off` disables tracking.
Only coarse `activity: {"presence":"present"}` crosses the network; exact idle/lock
details stay local. Server presence is memory-only; activity-only batches are valid.

Any button overrides holds for five minutes. Left/right navigate cached pages;
Refresh checks the server, not the upstream stock provider. Device polling
(`refreshAfterSeconds`) is independent of stock fetching.

## Cache and panel updates

1. Fetch/validate the manifest and download changed images.
2. Verify PNG signature, dimensions, and SHA-256; commit the LittleFS page set
   only after every changed page passes.
3. Draw the selected page if needed and permitted. Holds never hide the initial
   page; held updates remain cached until a button, interval exception, or release.
4. On failure, keep the existing cache and image; retry on the next check.

Navigation works offline. NVS records the displayed page/version to skip redundant
boot redraws. Current firmware stays awake and uses full four-gray refreshes only.

Headers show dates, stock footers quote times, and stale labels fixed timestamps,
not ticking clocks. AI percentages use 1% steps; batteries use 10% buckets
([source rules](data-sources.md)). Stock `STALE` follows prolonged fetch failures
(two refresh intervals since the last complete success). Date/freshness changes
can alter images even when numeric values do not.
