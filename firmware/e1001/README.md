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

If the sleeping device is not detected, press its green Refresh button once and
retry the upload. A normal first boot performs a white panel clear, shows four
gray diagnostic bands, connects to Wi-Fi, downloads all pages, and replaces the
diagnostic with Overview. That initial sequence includes multiple slow full
refreshes by design; later boots draw the cached page without a white clear.

The physical buttons are mapped from Seeed's board definition:

- Refresh / KEY0 / GPIO3: check the server now;
- Left / KEY1 / GPIO4: show the previous cached page;
- Right / KEY2 / GPIO5: show the next cached page.

## Runtime behavior

- The manifest controls the polling interval; production currently requests a
  check every 60 seconds.
- Images are downloaded only when their SHA-256 version changes.
- A full page set is committed only after every changed PNG has downloaded and
  passed its signature, 800 x 480 dimension, and manifest SHA-256 checks.
- Versioned PNGs and page metadata live in LittleFS. Navigation works with no
  Wi-Fi, and failures leave the last displayed frame and cache intact.
- HTTPS is verified against the bundled ISRG Root X1/X2 trust anchors. Redirects
  and image URLs outside the expected display route are rejected.
- This plugged-in first release stays awake with Wi-Fi enabled. Deep sleep and
  battery-aware scheduling remain a later hardware-measurement task.

The Wi-Fi password and display token are compiled into device flash. The token
is deliberately read-only and cannot publish PC metrics, but a person with
physical access and flash-extraction capability should still be treated as able
to recover both values. Rotate them if the device is lost.

Hardware references:

- [Seeed Arduino cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino/)
- [Seeed E1001 getting started guide](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/)
- [Seeed E-series firmware examples](https://github.com/Seeed-Projects/OSHW-reTerminal-Series-E-D)
