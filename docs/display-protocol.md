# E1001 display protocol

## Image profile

InkPulse v1 renders one image per page with these properties:

- Width: 800 pixels
- Height: 480 pixels
- Format: PNG
- Palette: four grayscale values (black, dark gray, light gray, white)
- Orientation: landscape

The server performs layout, font rendering, graph drawing, and grayscale
quantization. Firmware only decodes the image into the panel buffer.

## Manifest

The device requests `GET /api/v1/display/manifest` with its read-only bearer
token. A version 1 response has this shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-21T12:00:00Z",
  "refreshAfterSeconds": 300,
  "defaultPage": "overview",
  "presence": "present",
  "holdRedraws": false,
  "awayRedrawSeconds": 3600,
  "pages": [
    {
      "id": "overview",
      "title": "Overview",
      "version": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "imageUrl": "/api/v1/display/pages/overview.png?v=sha256%3A0000000000000000000000000000000000000000000000000000000000000000",
      "width": 800,
      "height": 480,
      "format": "png",
      "updatedAt": "2026-09-21T12:00:00Z"
    }
  ]
}
```

`version` changes only when that page's pixels change. The device compares it
with its cached version and skips unchanged downloads. Page image responses
also provide an `ETag` and support `If-None-Match`.

Because every changed version costs a physical panel refresh, pages avoid
pixels that change without new information:

- the header shows the date, not a clock;
- the stock footer shows the newest market quote time, not the fetch time, so
  a closed market renders identical pages;
- AI status reads `Live` or `Last reading <time>`, never a relative age;
- AI percentages are whole numbers, so every 1 % change still appears;
- `STALE` appears only after stock refreshes have failed for two refresh
  intervals, not after one transient symbol failure.

### Presence and redraw hold

`presence`, `holdRedraws`, and `awayRedrawSeconds` are additive schema-1
fields; firmware that does not know them ignores them.

- `presence` is `present`, `away`, or `unknown` (tracking disabled with
  `INKPULSE_PRESENCE_HOLD=off`).
- `holdRedraws` asks the device not to redraw the panel for new page versions.
  It is `true` while `presence` is `away`, except for a short window
  (`INKPULSE_AI_RELEASE_SECONDS`, default 180) after the displayed AI usage
  values change, so work that continues while the user is away still appears.
- `awayRedrawSeconds` (`INKPULSE_AWAY_REDRAW_SECONDS`, default 3600) lets a
  held device still show a changed page once that many seconds have passed
  since its last panel refresh, so an unattended display stays roughly current
  (for example stock moves during US market hours). `0` keeps the panel fully
  held until someone returns.

The PC classifies input locally. `away` means idle for at least
`INKPULSE_AWAY_AFTER_IDLE_SECONDS` (default 600) or locked; `present` means
input within `INKPULSE_PRESENT_WITHIN_SECONDS` (default 120); `transition`
keeps the previous state. Configure these thresholds on the PC. The gap is
hysteresis: short breaks do not flap the state. The server also marks the PC
away after `INKPULSE_COLLECTOR_OFFLINE_SECONDS` without a post (default 180,
never longer than the Codex stale threshold). A collector with no activity
signal is treated as present while it posts; after a server restart presence
starts as `away` until the first collector post.

Only the coarse state crosses the PC/VPS boundary as an optional `activity`
object in the write-token AI usage batch (`{"presence":"present"}`); a batch
may carry activity with no usage reports. Exact idle seconds and lock state
never leave the PC. The server retains the coarse state only in memory and
the display manifest exposes only the derived fields.

`refreshAfterSeconds` controls device checks, not the server's stock-provider
schedule. Keeping these settings independent allows a battery-powered display
to wake less often without making the server cache equally stale.

## Button behavior

- **Left:** display the previous cached page, wrapping at the beginning.
- **Right:** display the next cached page, wrapping at the end.
- **Refresh:** wake, fetch the manifest, download changed pages, and redraw the
  selected page if necessary.

Any button press also counts as someone present at the device for five
minutes; during that time the device ignores `holdRedraws`.

Navigation is local. It must continue working when Wi-Fi or the VPS is down.
The selected page is persisted so a scheduled wake does not unexpectedly
return the user to the overview.

## Refresh behavior

1. Wake and connect to the configured Wi-Fi network.
2. Request the manifest with a short timeout.
3. Validate the schema, page dimensions, format, and allowed URL origin.
4. Download changed images to temporary files or buffers.
5. Validate each complete image before replacing its cached predecessor.
6. Display the selected page if its version changed, unless `holdRedraws` is
   true, no button was pressed in the last five minutes, a page is already on
   screen, and the last panel refresh is more recent than
   `awayRedrawSeconds`. Held pages stay cached; the newest selected page is
   drawn once when the hold ends.
7. Wait until the next scheduled refresh or button press. A later battery-mode
   firmware can deep sleep between checks.

On any failure, the device keeps its current image and cached page set.

The prepared E1001 implementation stores versioned PNG files in LittleFS and
commits new metadata only after every changed page has passed its PNG signature
and 800 x 480 dimension checks. It uses full four-gray panel refreshes; unchanged
versions do not refresh the physical display. After a reboot it redraws only
if the panel does not already show the selected page's cached version, which
it records in NVS after every refresh.
The downloaded file's SHA-256 digest must match the manifest version before it
can enter the cache. This also handles a page that changes between the manifest
and image requests.

## Authentication

The display token grants read-only access to display endpoints. It is separate
from the PC collector's write credential. The firmware sends it in the
`Authorization: Bearer` header; it is never placed in an image URL or query
string where it could appear in access logs.

HTTPS certificate validation uses the ISRG Root X1 and X2 trust anchors. The
firmware rejects redirects and accepts only relative image URLs matching the
display-page route for the declared page ID.
