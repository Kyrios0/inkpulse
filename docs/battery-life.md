# Battery-life estimates

**Planning estimates for future sleep-capable firmware, not measurements.** Current firmware stays awake on
Wi-Fi, so AFK holds save panel refreshes, not radio or CPU power.

```text
average current = sleep current + wake charge × wakes per day / 24 h
battery days    = usable capacity / average current / 24 h
```

Anchors: a nominal 2000 mAh battery; a vendor claim of about 90 days at six-hour intervals; one user's
report of three days at 20-minute intervals. With a published 14 µA sleep current, these imply
5.47–9.25 mAh per wake (one changed page downloaded and redrawn). None is a controlled measurement.
Sources: [product guide](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/),
[E Series comparison](https://wiki.seeedstudio.com/reterminal_e10xx_main_page/),
[low-power cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino_peripherals_2/),
[manual](https://manuals.plus/ae/1005010024295436),
[field report](https://forum.seeedstudio.com/t/reterminal-e1001-really-great-but/295567).

## Fixed intervals

| Interval | Wakes/day | Estimated mAh/day | Estimated days |
| --- | ---: | ---: | ---: |
| 5 minutes | 288 | 1,576–2,666 | 0.8–1.3 |
| 15 minutes | 96 | 526–889 | 2.3–3.8 |
| 20 minutes | 72 | 394–667 | 3.0–5.1 |
| 30 minutes | 48 | 263–445 | 4.5–7.6 |
| 60 minutes | 24 | 132–222 | 9.0–15.2 |
| 4 hours | 6 | 33–56 | 36–60 |
| 6 hours | 4 | 22–37 | 54–90 |
| 24 hours | 1 | 5.8–9.6 | 209–344 |

Rows other than the anchors are extrapolations (the 24-hour row especially). Unchanged pages cost less;
holds, outages, and self-discharge are excluded.

## Market-aware schedules (not implemented)

Checks at the listed interval during 6.5 trading hours on weekdays, every six hours otherwise:

| Open-market interval | Average wakes/day | Estimated days |
| --- | ---: | ---: |
| 5 minutes | 58.9 | 3.7–6.2 |
| 30 minutes | 12.5 | 17–29 |
| 60 minutes | 7.9 | 27–46 |

## Measurement plan

1. On current firmware, measure idle power, download energy, and redraw energy separately; count redraws
   with the [NVS counters](../firmware/e1001/README.md#refresh-counters).
2. Implement sleep, then measure ≥100 cycles each of unchanged and changed-page wakes with a power profiler
   (battery percentage is nonlinear), keeping hardware, Wi-Fi, and firmware fixed.
3. Run 5-, 30-, and 60-minute schedules for ≥7 days each, then confirm the chosen one in a full battery run.
