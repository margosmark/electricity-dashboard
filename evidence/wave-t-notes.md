# Wave T — the weather next to the meter

**What shipped** — all three slices:

| # | Slice | Where |
|---|---|---|
| 1 | Usage binned by that hour's outdoor temperature — mean kWh/h, ¢/kWh, and each bin's share of the window's kWh | `lib/tempBands.ts` → `components/TempBandCard.tsx`, on USAGE |
| 2 | Anomaly context: the day's temperature and a verdict ("25 °C — that's AC" / "no weather signal — worth checking the appliance" / "no data") | `lib/energy.ts#anomalyWeatherContext`, computed inside `detectAnomalies`, rendered by `components/UsagePanel.tsx` |
| 3 | Delivery and regulatory split into fixed + volume-driven, or the honest refusal | `lib/energy.ts#chargeDecomposition` → `components/ActualBillPanel.tsx`, on PLANS inside "Your actual bill" |

Plus the plumbing both depend on: `lib/openMeteo.ts` (client-side CDN fetch,
localStorage cache, chunked to the data's own dates) and
`hooks/useHourlyTemps.ts` (one fetch for the dashboard).

## The numbers a reviewer should check

From `wave-t-verification.json` — **41/41** on the **deployed** stack
(`http://dashboard.example.internal:3939`, deploy `58202db`, recorded as `deployedCommit`)
against Mark's real 2-year export (sha256 `e292de50a560f56e…`, 6,424,909
bytes — never committed; pass `WAVE_T_XML` yourself to re-run). Every figure is
asserted against `wave-t-audit.py`, a **second parser** (Python ElementTree)
that reads the raw XML independently of the app's fast-xml-parser pipeline and
does its **own live Open-Meteo fetch**:

- **17,539/17,539 hourly readings matched, zero gaps** — the whole metered
  span, 2024-10-06 → 2026-10-06;
- **the curve**, mean kWh/h per bin (app DOM vs audit, all seven exact):

  | bin | hours | mean kWh/h | ¢/kWh | share of kWh |
  |---|---:|---:|---:|---:|
  | < −10 °C | 783 | **1.34** | 11.4 | 2.8 % |
  | −10 to 5 | 5,942 | **1.33** | 11.1 | 20.4 % |
  | 5 to 12 | 3,154 | **1.63** | 10.6 | 13.3 % |
  | 12 to 18 | 2,811 | **2.46** | 10.4 | 17.8 % |
  | 18 to 24 | 3,388 | **3.34** | 11.0 | 29.2 % |
  | 24 to 30 | 1,322 | **4.34** | 12.0 | 14.8 % |
  | over 30 | 139 | **4.98** | 12.2 | 1.8 % |

  The card's own sentence checks out against it: *"-10 to 5 °C averages 1.33
  kWh/h; at 24 to 30 °C it is 4.34 — 3.3× as much. 15% of this window's energy
  was used in those hours."* The cold half is **flat** (1.33 vs 1.34 across a
  20-degree span) and the hot half **triples**: the AC signature, drawn from
  the meter rather than asserted;
- **all five anomaly verdicts** match the audit's own thresholds, newest first:
  2026-09-25 / 09-24 / 09-19 → *no weather signal*, 2026-09-16 → *25 °C —
  that's AC*, 2026-09-13 → *29 °C — that's AC*;
- **both charge lines**, status/amount/periods/worst-miss/residual-share match
  an independent OLS: delivery `$102.34`, worst miss `$6.56` = **6.41 %**,
  regulatory `$14.76`, worst miss `$1.13` = **7.68 %** — both over the 5 % bar;
- **the network invariant, read off Playwright's real request log**: the only
  cross-origin host is `archive-api.open-meteo.com` (4 chunked requests,
  `hourly=temperature_2m&timezone=UTC`), and every `start_date`/`end_date`
  sits inside the data's own span (2024-10-06 … 2026-10-06). No route, no
  proxy, no server-side call — a grep of the diff finds no `app/api` change
  and no `rewrites()` entry.

Screenshots from the deployed stack: `wave-t-desktop-usage.png` (1440),
`wave-t-desktop-temp-band.png` (the card itself), `wave-t-desktop-plans.png`
(the decomposition inside "Your actual bill"), `wave-t-mobile-usage.png` (390).

## Why the temperature is keyed on absolute hours

Open-Meteo returns each value under a **wall-clock label in the timezone you
ask for**. Two ways of pairing a reading with its temperature are correct:
ask for `timezone=UTC` and index by the reading's UTC hour, or ask for the
meter's zone and index by its local hour — both sides then describe the same
absolute instant. The shipped code does the former, which is also
timezone-proof: the numbers do not change if you open the file in another
country, and they do not break on the two DST days a year (a skipped hour, a
repeated one). `openMeteo.test.ts` pins both DST edges and a chunked reassembly.

**The task brief's reference figures come from the third combination**, which
is not correct: matching a reading's **UTC** hour against Open-Meteo's
**local-labelled** series shifts every pairing by Toronto's offset (4 h in
summer, 5 h in winter), so afternoon usage gets scored against evening
temperatures and the hot bins come out cooler than they are.
`evidence/wave-t-published-repro.py` reproduces the brief's five numbers
**exactly** that way — 1.33, 1.66, 3.5, 3.7, 3.9 (Oakville's coordinates,
which is the other half of the difference) — which pins the cause rather than
asserting it:

```
$ python3 evidence/wave-t-published-repro.py <export.xml>
band        hours mean kWh/h   (the published method)
< -10         728      1.357
-10 to 5     5905      1.332   ← "1.33 near -10"
5 to 12      3206      1.657   ← "1.66 at 5-12"
12 to 18     2961      2.617
18 to 24     3268      3.457   ← "3.5"  ┐ "3.5-3.7
24 to 30     1290      3.734   ← "3.7"  ┘  at 18-30"
over 30       181      3.916   ← "3.9+"
```

The shipped curve is the same story and a **stronger** one: 3.34 and 4.34 at
18–30 °C, 4.98 over 30 °C. Switching the coordinates from Toronto to Oakville
moves no bin by more than 0.05 kWh/h (both runs are in the JSON's `audit.bands`
versus this table), so the location is not what separates the two.

## Gates run locally before the push

| Gate | Result |
|---|---|
| `npm run lint` | clean (0 errors, 0 warnings) |
| `npm run typecheck` | clean |
| `npm run test` (vitest) | **1123 passed, 4 skipped**, 66 files — on `58202db`'s parent, i.e. on top of #46 |
| `npm run build` | `next build` OK (11 routes, proxy middleware) |
| `node evidence/wave-t-verify.cjs` (local :3107) | 41/41 |
| `node evidence/wave-t-verify.cjs` (deployed `58202db`) | **41/41** |
| CI | skipped by convention — Actions billing dead since 2026-10-07; gates run locally |
| deploy | `~/bin/deploy-energy-dashboard.sh` → `DEPLOY_OK at 58202db` |

New tests: `lib/openMeteo.test.ts` (23 — the shared clock, both DST edges,
chunking, cache hit/miss/stale, and four failure modes), `lib/tempBands.test.ts`
(14 — bin edges at every boundary, cadence independence, unmatched-hour
honesty), `components/WaveT.test.tsx` (11), plus anomaly-context cases in
`lib/energy.test.ts` and decomposition cases in `lib/usageSummary.test.ts`.

## Honest limitations — they change what the panels mean

- **2 of 17,539 hours have no temperature, and stay unmatched.** Both are at
  06:00Z on an Ontario fall-back day (2024-11-03, 2025-11-02): Open-Meteo's
  hourly series omits the repeated hour on those days. They are left out of the
  bin averages (the card prints "all 17,539 hours matched" only when that is
  true, and otherwise says how many it could not explain) rather than filled
  from a neighbouring hour. 0.01 % of the data, and the card is built to admit
  it.
- **Both charge lines FAIL the 5 % bar on this file, and the card says so.**
  Delivery fits `$36.51 + $0.0255/kWh` across 24 periods but misses by up to
  `$6.56` — 6.41 % of the newest period's `$102.34`. The bill it misses is
  **Aug 26, 2024**, priced under the previous rate year (the same kWh in
  May 2025 costs $9 less), so the line is real and large but not one straight
  line of usage. The card names that bill, prints the rejected fit, and quotes
  the blended `3.87¢/kWh` that survives. Regulatory is rejected the same way
  (7.68 %, worst miss on the Jun 2026 bill).
  **A candidate follow-up, deliberately not done here:** fitting only the
  periods since the last rate change (Nov 1, 2024) brings delivery to 4.4 % —
  under the bar, and a real "$36 fixed + $0.0253/kWh" answer. That is a
  different claim (it silently drops the oldest bills) and deserves its own
  card, its own test and its own sentence, not a tolerance quietly loosened.
- **One tolerance bar, deliberately shared.** `fitCharge` used to reject any
  fit that missed by more than $0.50 — a bar that meant something different on
  every bill size. It is now `CHARGE_FIT_MAX_RESIDUAL_SHARE` (5 %) of the line
  being explained, and every consumer (`deliverySplit`, `deriveExtraCharges`,
  `chargeDecomposition`) reads the same function, so the per-line note and the
  headline card cannot disagree. A test asserts exactly that on both a fitting
  and a non-fitting fixture.
- **A negative intercept is an answer, not a failure.** A line that would need
  a negative fixed part to fit has no fixed part; the fit is forced through
  zero and the headline says "none of it is fixed — you would pay $0.00 at 0
  kWh", instead of refusing to answer. Regulatory charges land here when their
  seasonal wobble is small enough.
- **The verdict thresholds are choices, and they are pinned.** `24 °C` (the
  bin where draw leaves the cold baseline and roughly doubles) and `0 °C`
  (freezing) are exported constants with tests on both edges; they were chosen,
  not discovered. On this export the anomaly cards the user actually sees are
  the five newest spikes, which are September days — three mild, two hot. The
  "that's heat" branch is covered by a unit test, not by the deployed DOM,
  because this file has no winter spike day in its newest five.
- **The verdict names no appliance.** "That's AC" means the day was hot
  enough for cooling to be the obvious explanation — not that a device was
  measured. The mild case says the weather is not the explanation and points
  at the appliance list, which is all the data can support from a single
  UsagePoint.
- **The ¢/kWh column is priced by the plan on screen**, so it moves when the
  user switches TOU/Tiered/ULO — the kWh and hour counts do not. The check
  asserts hours, kWh, mean and share exactly; ¢/kWh is asserted as present and
  positive, because it comes from the same rate engine Wave S already audited
  to the cent.
- **The card is a chart, and every number on it is also text** — the DOM
  attributes (`data-hours`, `data-mean-kwh`, `data-cents`, `data-share`) are
  what the browser check reads, so a drawing bug cannot hide behind a plausible
  picture.
- **Cached weather is never re-fetched for the same span**, and a LONGER export
  invalidates it (tested). A cached entry stores the location it was fetched
  for, so changing `OPEN_METEO` cannot silently serve another city's weather.
- Cosmetic: at 1440 px the "over 30" bar is a sliver (139 hours, 1.8 % of the
  window) and its value label sits close to its neighbour's; the share strip
  scales to the largest bin, so the two smallest strips are 1–2 px tall with
  the percentage printed beneath them rather than inside.

## Re-running

```bash
# the deployed stack (what wave-t-verification.json is from):
WAVE_T_XML=/path/to/2-year-export.xml TZ=America/Toronto \
  WAVE_T_DEPLOY=58202db node evidence/wave-t-verify.cjs

# the second parser alone (fetches Open-Meteo live):
python3 evidence/wave-t-audit.py /path/to/2-year-export.xml 2024-01-01 2027-12-31

# the published-figures reproduction, for the four-hour-shift argument:
python3 evidence/wave-t-published-repro.py /path/to/2-year-export.xml
```
