# E1001 firmware

```sh
npm run firmware:build    # from the repository root
npm run firmware:upload   # flash over a data-capable USB cable
npm run firmware:monitor  # serial log at 115200 baud
```

Before the first build, install [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html),
copy `include/secrets.example.h` to ignored `include/secrets.h`, and set the 2.4 GHz Wi-Fi SSID/password,
the HTTPS origin, and the server's read-only display token. Without secrets the firmware still builds (CI)
and shows a configuration message. If the device isn't detected, press the green Refresh button and retry.

PlatformIO client for the reTerminal E1001 (ESP32-S3, UC8179, 800 × 480, four grays). It stays awake on
Wi-Fi; deep sleep is future work. Pages are Overview and Stocks. Deploy the two-page server before
flashing; old three-page caches migrate and a retired page selection falls back to Overview.

## Boot and runtime

First boot clears to white, shows four gray bands, then downloads Overview, so several slow refreshes
are expected. Later boots redraw only if NVS says the panel shows a different version.

| Button | Pin | Action |
| --- | --- | --- |
| Refresh / KEY0 | GPIO3 | Check the server now |
| Left / KEY1 | GPIO4 | Previous cached page |
| Right / KEY2 | GPIO5 | Next cached page |

The manifest is polled every 60 s without touching the panel. Changed pages download to LittleFS and only
the selected page redraws. While away, redraws are held (at most one per hour); any button overrides the
hold for five minutes. Navigation works offline, and failures keep the last image and cache. Full rules:
[display protocol](../../docs/display-protocol.md).

## Refresh counters

NVS namespace `inkpulse` keeps lifetime counts `rdFull`, `rdPart`, and `boots`; every refresh logs a reason:

```text
[stats] boot #12, lifetime panel refreshes: full=431 partial=0
[panel] full refresh #432 reason=version page=overview (3120 ms, 1 this boot)
```

Reasons: `boot`, `first-boot-clear`, `diagnostic`, `status`, `version`, `presence-return`, `away-interval`,
`button`. Divide the `rdFull` increase by elapsed days for the refresh rate. `rdPart` stays 0: the driver's
partial update is 1-bit only and would destroy the grayscale rendering.

## Security

Wi-Fi credentials and the display token are compiled into flash; assume they can be extracted, and rotate
them if the device is lost. The bundled ISRG roots are public trust anchors, not secrets.

References: [Seeed Arduino cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino/),
[E1001 getting started](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/),
[Seeed firmware examples](https://github.com/Seeed-Projects/OSHW-reTerminal-Series-E-D).
