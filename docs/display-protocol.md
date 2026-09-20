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
  "pages": [
    {
      "id": "overview",
      "title": "Overview",
      "version": "sha256:example",
      "imageUrl": "/api/v1/display/pages/overview.png?v=example",
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

`refreshAfterSeconds` controls device checks, not the server's stock-provider
schedule. Keeping these settings independent allows a battery-powered display
to wake less often without making the server cache equally stale.

## Button behavior

- **Left:** display the previous cached page, wrapping at the beginning.
- **Right:** display the next cached page, wrapping at the end.
- **Refresh:** wake, fetch the manifest, download changed pages, and redraw the
  selected page if necessary.

Navigation is local. It must continue working when Wi-Fi or the VPS is down.
The selected page is persisted so a scheduled wake does not unexpectedly
return the user to the overview.

## Refresh behavior

1. Wake and connect to the configured Wi-Fi network.
2. Request the manifest with a short timeout.
3. Validate the schema, page dimensions, format, and allowed URL origin.
4. Download changed images to temporary files or buffers.
5. Validate each complete image before replacing its cached predecessor.
6. Display the selected page if its version changed.
7. Sleep until the next scheduled refresh or button wake.

On any failure, the device keeps its current image and cached page set.

## Authentication

The display token grants read-only access to display endpoints. It is separate
from the PC collector's write credential. The firmware sends it in the
`Authorization: Bearer` header; it is never placed in an image URL or query
string where it could appear in access logs.
