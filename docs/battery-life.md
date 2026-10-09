# E1001 battery-life estimates and measurement plan

The current InkPulse firmware stays awake with Wi-Fi enabled and checks every
60 seconds by default. It does not deep sleep. The tables below are historical
planning estimates for a future wake/work/sleep implementation, **not measured
battery life or predictions for the current firmware**. AFK holds reduce panel
refreshes, but do not put the radio or processor to sleep.

## Reference data collected during initial planning

| Item | Published value | How we use it |
| --- | ---: | --- |
| Battery capacity | 2000 mAh | Nominal capacity, not guaranteed usable capacity |
| Vendor battery claim | Up to about 3 months | Initial guide/manual reference; a reproduced E1001 manual specifies a 6-hour interval |
| Deep-sleep support | Yes; example reports about 14 µA | Confirms the wake/work/sleep design; does not establish whole-device consumption |
| E1001 panel refresh | 2–5 seconds | Active time that should be captured by our measurements |
| Field report | About 3 days at a 20-minute interval | One SenseCraft user report; useful as a pessimistic anchor, not a controlled test |

Sources: [E1001 product guide](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1001/),
[E Series comparison](https://wiki.seeedstudio.com/reterminal_e10xx_main_page/), and
[Seeed low-power cookbook](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino_peripherals_2/).
The interval anchors come from an
[E1001 manual reproduction](https://manuals.plus/ae/1005010024295436) and a
[firsthand Seeed forum report](https://forum.seeedstudio.com/t/reterminal-e1001-really-great-but/295567).

## Estimated fixed-interval results

The estimates use two calibration curves:

- **Vendor-calibrated:** 2000 mAh lasts 90 days at a 6-hour interval.
- **Field-calibrated:** 2000 mAh lasts 3 days at a 20-minute interval.

After allowing for the published 14 µA deep-sleep figure, these imply about
5.47–9.25 mAh per wake. The table assumes every wake downloads and redraws one
changed page. An unchanged manifest should consume less.

| Check interval | Wakes/day | Added polling delay, up to | Estimated mAh/day | Estimated battery life | Evidence |
| ---: | ---: | ---: | ---: | ---: | --- |
| 5 minutes | 288 | 5 minutes | 1,576–2,666 | 0.8–1.3 days | Extrapolated |
| 15 minutes | 96 | 15 minutes | 526–889 | 2.3–3.8 days | Extrapolated |
| 20 minutes | 72 | 20 minutes | 394–667 | 3.0–5.1 days | Field-report lower anchor |
| 30 minutes | 48 | 30 minutes | 263–445 | 4.5–7.6 days | Extrapolated |
| 60 minutes | 24 | 1 hour | 132–222 | 9.0–15.2 days | Extrapolated |
| 4 hours | 6 | 4 hours | 33–56 | 36–60 days | Extrapolated |
| 6 hours | 4 | 6 hours | 22–37 | 54–90 days | Vendor upper anchor |
| 24 hours | 1 | 24 hours | 5.8–9.6 | 209–344 days | Long extrapolation; low confidence |

These extrapolations exclude source delays, AFK holds, outages, and battery
self-discharge. Five-minute chart bars are not a guarantee about quote metadata
freshness. The model cannot select a battery default without device measurements.

## Market-aware candidates

Stocks do not need the same cadence around the clock. These profiles assume
6.5 US market hours on five weekdays and a six-hour interval at all other
times. Holidays are omitted, so actual wake counts can be slightly lower.

| Schedule | Average wakes/day | Estimated battery life | Role |
| --- | ---: | ---: | --- |
| 5 minutes while open / 6 hours closed | 58.9 | 3.7–6.2 days | Freshness-first |
| 30 minutes while open / 6 hours closed | 12.5 | 17–29 days | Balanced candidate |
| 60 minutes while open / 6 hours closed | 7.9 | 27–46 days | Battery-first candidate |

The 30-minute/6-hour profile is one candidate to measure, not a current default.
The refresh button fetches the latest server pages, not a fresh upstream quote.
Market-aware cadence is planned work; the current manifest exposes one fixed
interval and the stock fetch timer runs regardless of market hours.

## Measurement method

First implement a sleep-capable firmware before testing these wake-based rows.
For current firmware, measure continuous idle power separately from image
downloads and redraw energy; use its NVS refresh counters to count panel updates.

Use the same device, firmware, Wi-Fi location, page set, and battery charge
procedure for every row. Test two workloads because an unchanged manifest
avoids image download and panel redraw:

1. **No-change:** wake, connect, fetch the manifest, find unchanged page
   versions, and return to deep sleep without downloading an image.
2. **Changed page:** wake, download one changed image, refresh the panel, and
   return to deep sleep.

Record battery voltage, reported percentage, wake reason, Wi-Fi connection
time, bytes downloaded, manifest result, panel-refresh duration, and total
awake time on every cycle. Measure charge with a power profiler or coulomb
counter when available; battery percentage alone is not sufficiently linear.

Run at least 100 cycles per workload for energy-per-cycle estimates. Then run
the 5-, 30-, and 60-minute candidates for at least seven days and extrapolate
only if daily consumption is stable. Finally, validate the selected cadence
with a long battery run before calling it the default.

The estimates above use this model; replace its inputs with measured quantities
when possible:

```text
average current = sleep current + (wake charge × wakes per day / 24 hours)
battery days = measured usable capacity / average current / 24 hours
```

Manual button refreshes are recorded separately so ordinary interaction does
not distort the scheduled-cadence comparison.
