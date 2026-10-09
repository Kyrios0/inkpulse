# E1001 firmware

PlatformIO client for reTerminal E1001: ESP32-S3, UC8179, 800 × 480 four-gray panel.
Current firmware stays awake with Wi-Fi enabled; deep sleep is future work.

## Configure, build, flash

Install [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html).
Copy `include/secrets.example.h` to ignored `include/secrets.h` in this directory.
Set the 2.4 GHz Wi-Fi SSID/password, HTTPS origin (trailing slash accepted), and
server's read-only display token. Empty CI configuration builds but makes no
network requests and shows a configuration message.

From the repository root:

```sh
npm run firmware:build
npm run firmware:upload
npm run firmware:monitor
```

Use a data-capable USB cable. If undetected, press green Refresh and retry.
First boot clears white, shows four gray diagnostic bands, then downloads Overview.
Multiple slow refreshes are expected initially. Later boots skip the clear and
redraw only if the selected cached version differs from NVS's recorded display.

## Buttons and runtime

| Button | Pin | Action |
| --- | --- | --- |
| Refresh / KEY0 | GPIO3 | Check server now |
| Left / KEY1 | GPIO4 | Previous cached page |
| Right / KEY2 | GPIO5 | Next cached page |

Manifest polling defaults to 60 seconds and does not touch the panel. Changed
pages download into LittleFS; only the selected page redraws. AFK holds normally
limit updates to one per hour; buttons override holds for five minutes.
Navigation works offline; failures preserve the last frame and cache.

The complete validation, TLS, versioning, and hold rules live in the
[display protocol](../../docs/display-protocol.md).

## Refresh counters

NVS namespace `inkpulse` stores `rdFull`, `rdPart`, and `boots`.
Every panel refresh logs its reason and increments its counter:

```text
[stats] boot #12, lifetime panel refreshes: full=431 partial=0
[panel] full refresh #432 reason=version page=overview (3120 ms, 1 this boot)
```

Reasons: `boot`, `first-boot-clear`, `diagnostic`, `status`, `version`,
`presence-return`, `away-interval`, `button`. Divide the `rdFull` increase by
elapsed days to measure refresh rate. `rdPart` is reserved: the current driver
partial-update path is 1-bit, incompatible with preserving our grayscale rendering.

## Security and references

Wi-Fi credentials and the read-only display token are compiled into flash.
Assume physical extraction is possible; rotate credentials if the device is lost.
Bundled ISRG roots are public trust anchors, not secrets.

- [Seeed Arduino cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino/)
- [E1001 getting started](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/)
- [Seeed firmware examples](https://github.com/Seeed-Projects/OSHW-reTerminal-Series-E-D)
