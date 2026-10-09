# Battery-life estimates

**These are planning estimates for future sleep-capable firmware, not measured
battery life or predictions for current InkPulse.** Current firmware stays awake
with Wi-Fi enabled. AFK holds save redraws, not continuous radio/processor power.

## Model and evidence

Historical anchors: nominal 2000 mAh battery; vendor/manual claim of about 90 days
at six-hour intervals; one SenseCraft user reported three days at 20-minute intervals.
Using a published example's 14 µA sleep current implies 5.47–9.25 mAh per wake.
Neither that sleep figure nor either anchor is a controlled whole-device
measurement of InkPulse. Reference panel refresh time: 2–5 seconds.

Sources: [product guide](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/),
[E Series comparison](https://wiki.seeedstudio.com/reterminal_e10xx_main_page/),
[low-power cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino_peripherals_2/),
[manual reproduction](https://manuals.plus/ae/1005010024295436),
[field report](https://forum.seeedstudio.com/t/reterminal-e1001-really-great-but/295567).

Assume each wake downloads and redraws one changed page, then sleeps:

```text
average current = sleep current + wake charge × wakes per day / 24 hours
battery days = usable capacity / average current / 24 hours
```

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

Except the calibration anchors, these are extrapolations; the 24-hour row has
particularly low confidence. Unchanged pages should cost less. Source delays,
holds, outages, and self-discharge are excluded. Polling adds up to one interval
of delay; five-minute chart bars do not guarantee five-minute quote freshness.

## Market-aware candidates

Assume 6.5 trading hours on five weekdays, six-hour checks otherwise; omit holidays.

| Open-market interval | Average wakes/day | Estimated days |
| --- | ---: | ---: |
| 5 minutes | 58.9 | 3.7–6.2 |
| 30 minutes | 12.5 | 17–29 |
| 60 minutes | 7.9 | 27–46 |

These schedules are not implemented. Current polling is fixed and stock fetching
continues outside market hours. Refresh fetches server pages, not upstream quotes.

## Measurement plan

1. For current firmware, measure continuous idle power, download energy, and
   redraw energy separately; count panel updates with [NVS counters](../firmware/e1001/README.md#refresh-counters).
2. Implement sleep before testing the wake-based model. Keep hardware, Wi-Fi,
   firmware, page set, and charging procedure fixed.
3. Measure ≥100 cycles each for unchanged manifests and changed-page redraws.
   Record voltage, wake reason, Wi-Fi/awake time, bytes, redraw duration, and charge.
   Prefer a power profiler/coulomb counter; battery percentages alone are nonlinear.
4. Run 5-, 30-, and 60-minute candidates for ≥7 days, then validate the chosen
   schedule in a long battery run. Count manual refreshes separately.
