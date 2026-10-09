# InkPulse firmware for reTerminal E1001

This PlatformIO project is the device half of InkPulse. It targets the Seeed
reTerminal E1001 (ESP32-S3, UC8179, 800 x 480) and uses the panel's native
four-level grayscale mode.

## Configure and build

Install [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html),
then create the ignored device configuration:

```sh
cd firmware/e1001
cp include/secrets.example.h include/secrets.h
```

Set these four values in `include/secrets.h`:

- a 2.4 GHz Wi-Fi SSID and password;
- the HTTPS InkPulse origin (a trailing slash is accepted);
- the read-only `INKPULSE_DEVICE_TOKEN` used by the server.

Build without hardware:

```sh
pio run
```

The default empty configuration intentionally compiles in CI but never makes a
network request. It displays a configuration message on real hardware.

## First device test

Connect the E1001 with a data-capable USB cable, then run from the repository
root:

```sh
npm run firmware:upload
npm run firmware:monitor
```

If the device is not detected, press its green Refresh button once and
retry the upload. A normal first boot performs a white panel clear, shows four
gray diagnostic bands, connects to Wi-Fi, downloads all pages, and replaces the
diagnostic with Overview. That initial sequence includes multiple slow full
refreshes by design; later boots skip the clear and only redraw the cached page
if its version is not already recorded as displayed in NVS.

The physical buttons are mapped from Seeed's board definition:

- Refresh / KEY0 / GPIO3: check the server now;
- Left / KEY1 / GPIO4: show the previous cached page;
- Right / KEY2 / GPIO5: show the next cached page.

## Runtime behavior

- The manifest controls the polling interval; the server defaults to a
  check every 60 seconds. Polling does not touch the panel.
- Images are downloaded only when their SHA-256 version changes, and the panel
  is refreshed only when the selected page's version changes.
- While the manifest says `holdRedraws: true` (nobody at the PC), new pages are
  downloaded and cached but not drawn, except that a changed page is still
  shown once per `awayRedrawSeconds` (server default: one hour) since the last
  panel refresh. The newest selected page is drawn once when the hold ends.
  Any button press overrides the hold for five minutes.
- After a reboot the cached page is redrawn only if NVS shows the panel is not
  already displaying that exact version.
- A full page set is committed only after every changed PNG has downloaded and
  passed its signature, 800 x 480 dimension, and manifest SHA-256 checks.
- Versioned PNGs and page metadata live in LittleFS. Navigation works with no
  Wi-Fi, and failures leave the last displayed frame and cache intact.
- HTTPS is verified against the bundled ISRG Root X1/X2 trust anchors. Redirects
  and image URLs outside the expected display route are rejected.
- This plugged-in firmware stays awake with Wi-Fi enabled. Deep sleep and
  battery-aware scheduling remain a later hardware-measurement task.

## Panel refresh accounting

Every physical refresh goes through one function that logs its reason and
increments a lifetime counter in NVS (namespace `inkpulse`, keys `rdFull` and
`rdPart`; `boots` counts restarts). Boot prints the lifetime totals:

```text
[stats] boot #12, lifetime panel refreshes: full=431 partial=0
[panel] full refresh #432 reason=version page=overview (3120 ms, 1 this boot)
[display] away: holding redraws; pages stay cached
[panel] full refresh #433 reason=away-interval page=overview (3118 ms, 2 this boot)
[display] hold released (37 held polls this boot)
[panel] full refresh #434 reason=presence-return page=overview (3115 ms, 3 this boot)
```

Reasons: `boot`, `first-boot-clear`, `diagnostic`, `status`, `version`,
`presence-return`, `away-interval`, and `button`. Divide the change in `rdFull` by elapsed days
to measure the real refresh rate.

This firmware uses full four-gray refreshes only. The UC8179 supports windowed
partial refresh, but Seeed_GFX implements it for 1-bit mode only
(`EPaper::updataPartial` reads a 1-bpp buffer), and every changed region on
InkPulse pages contain anti-aliased gray pixels that a 1-bit update would
destroy. `rdPart` is reserved so a future partial-refresh path can be measured
without changing the counter layout.

The Wi-Fi password and display token are compiled into device flash. The token
is deliberately read-only and cannot publish PC metrics, but a person with
physical access and flash-extraction capability should still be treated as able
to recover both values. Rotate them if the device is lost.

Hardware references:

- [Seeed Arduino cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino/)
- [Seeed E1001 getting started guide](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/)
- [Seeed E-series firmware examples](https://github.com/Seeed-Projects/OSHW-reTerminal-Series-E-D)
