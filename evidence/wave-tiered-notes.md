# Tiered pricing: one rule, one implementation

**Card:** t_a7564faf — the follow-up Wave O filed as finding 6.

## The bug

`processRawData` fills every reading's `costTiered` with **tier 1 only**:

```ts
const costTiered = d.usage_kwh * (rates.tiered.tier1 / 100);
```

That is the honest per-reading rate (a reading has no tier of its own — the
tier-2 threshold is a volume allowance for a *month*), but the tier-2 rule
lived only in `aggregateChartData`'s monthly buckets. Every consumer that
summed the per-reading field instead of going through the buckets therefore
under-priced Tiered for any window over the threshold:

- `planCostFor` — the shared helper behind the True Bill card's variable figure,
- `reconcileBillingPeriods`'s `commodityEstimate` (a false "our rate assumptions
  are off" on the commodity cross-check),
- `calculateAlwaysOnFloor`, `projectMonthBill`, `shiftVerification`'s weekly
  windows, `hourCostProfile` (the ¢/kWh histogram), `evScenario`'s Tiered rates,
- and `planTimeline.tieredCommodity`, which carried its **own copy** of the
  month-bucket rule instead of the shared one.

Wave O hit it in the wild: pricing Tiered with `planCostFor` put Mark's
2026-07-22 period $8 **below** what TOU actually cost, the opposite conclusion
to Wave P's independent model of the same period.

## The decision

Option (a): **the month-scoped threshold now lives in one place —
`tieredCostFor(rows)` in `energy.ts` — and `planCostFor` is the single entry
point for pricing a window.**

- `monthBuckets` groups a window's rows by calendar month (the reading's own
  `dayStr`, so the dataset's clock decides), prorates that month's threshold by
  the days the rows actually cover (`days / 30.4`), charges tier 1 up to it and
  tier 2 on the excess. `aggregateChartData`'s monthly branch now *calls* that
  helper rather than re-implementing it.
- `tieredRateCentsFor(rows)` hands hour-level consumers a blended ¢/kWh for the
  window (total ÷ the window's kWh), so pricing any single reading or hour at it
  sums back to `tieredCostFor(rows)` exactly.
- `processRawData`'s `costTiered` column is **unchanged and stays tier 1** — it
  is what the CSV export publishes, and the comment at the assignment now says
  so and points at the window rule. Nothing may SUM it to price a window.
- `calculateFullDataTotals`' comment was rewritten from "the per-plan sums reuse
  the monthly buckets…" into a statement about **every** plan sum in the app.

## Every caller, checked

| Consumer | Was | Now |
|---|---|---|
| `planCostOf` → `planCostFor` | per-reading sum | `tieredCostFor` for Tiered; TOU/ULO still per-reading |
| `TrueBillEstimate` (variable + vs-actual) | via `planCostFor` | inherits the fix, unchanged code |
| `reconcileBillingPeriods` | via `planCostOf` | inherits the fix, unchanged code |
| `calculateAlwaysOnFloor` | summed `r.costTiered` | `planCostFor(rows, plan)` |
| `projectMonthBill` (MTD + 7-day average) | summed `costOf(r, plan)` | `planCostFor(mtdRows/recentRows, plan)` |
| `shiftVerification.windowStats` | summed per-day `cost` | keeps the day's rows, prices the window |
| `hourCostProfile` (`moneyViz`) | summed `r.costTiered` | window's `tieredRateCentsFor` |
| `evScenario` (stay / overnight / worst case) | `rates.tiered.tier1` | the window's blended rate — Tiered has no time dimension, so "moving hours cannot change Tiered" stays exactly true while the figure is the rate actually paid |
| `planTimeline.tieredCommodity` | **duplicate** month-bucket rule | deleted; calls `planCostFor` |
| `planOverlay` (`moneyViz`) | already on the buckets | left alone; its comment now points at the shared rule |
| `useDashboard.ts` | — | no Tiered pricing anywhere in the file (checked) |

## Tests

**Added**

- `energy.test.ts` — a 10-day, 1,000 kWh July window crosses the summer
  threshold: `planCostFor(rows, 'Tiered') === 137.66` to the cent
  (`600 × 10/30.4 = 197.37 kWh @ 12¢ + 802.63 kWh @ 14.2¢`), tier-1 would be
  120.00; identical to `calculateComparison(aggregateChartData(rows,'monthly'))`
  to 9 dp **and** to the hourly zoom of the same window; a window under its
  prorated threshold stays at tier 1; TOU/ULO untouched; `tieredRateCentsFor`
  sums back to the same total and returns null on an empty window.
- `usageSummary.test.ts` — `reconcileBillingPeriods(..., 'Tiered')` over the
  2026-07-22 period (2,900 kWh, 10 July + 19 August days) returns **399.21**,
  not 2,900 × 12¢ = 348.00.
- `WaveL.test.tsx` — `TrueBillEstimate` in Tiered mode: the card's own variable
  figure equals `planCostFor` for the same rows *and* the tier-2 arithmetic, and
  the vs-actual "Your estimate" equals `calculateTrueBill(variableCost:
  planCostFor(rows,'Tiered'), …)` to the cent.

**Assertions that pinned the old (tier-1-only) numbers — corrected, not bent
around:**

- `billProjection.test.ts`: MTD `28.80 → 197.37×0.12 + 42.63×0.142 = 29.74`;
  `avgDailyCost 2.88 → 2.97`; `projectedCost 89.28 → 92.19`; caption
  `$2.88/day → $2.97/day`.
- `BillProjectionBanner.test.tsx`: the rendered banner `$89.28 → $92.19`, MTD
  `$28.80 → $29.74`.
- `evScenario.test.ts`: `prices.Tiered.rateCents` `toBe(12.0) → toBeCloseTo(12.0, 6)`
  — the blended window rate round-trips through a division, so assert the value,
  not the bits.

## Gates

```
npm run lint        clean
npm run typecheck   clean
npx vitest run      48 files, 832/832 passed
npm run build       clean (public/sw.js VERSION restored to oeo-v1-local after prebuild)
```

## Browser evidence — Mark's real 24-period export

`evidence/wave-tiered-verification.json` — **20/20**, run against a local
`next start` on `127.0.0.1:3100` with
`doc_3d4f339925bf_oakvillehydro_Electricity_60_Minute_30-04-2024_06-10-2026.xml`
(never committed). Screenshots: `wave-tiered-{plan-cards,true-bill,vs-actual,hour-histogram,chart}-desktop.png`
and `wave-tiered-mobile.png`.

Whole dataset — 17,539 readings, 38,739 kWh, 731 days, 24 billing periods
parsed in the browser, 21 GETs and no POST (the client-only invariant):

- plan cards: **Tiered $4,521.58 · TOU $4,282.01** — the CSV's own
  `costTiered` column sums to **$4,127.61**, so tier 2 adds **+$393.97** and
  Tiered now models **above** TOU. Tier-1-only pricing inverted that (Wave O's
  "$8 below TOU").
- True Bill card's variable figure: **$4,521.58 — identical to the plan card**.
- ¢/kWh histogram window average **11.7¢** = 4,521.58 ÷ 38,739 × 100.

Newest billing period (Jul 22 – Aug 20, 2026), Tiered selected:

- vs-actual row: **Your estimate $541.38 · Oakville billed $499.57**.
- **THE FIX**: that estimate is recomputed here from first principles — the
  spec's month-scoped threshold rule, rates read from the app's own
  `/api/rates`, and the row set rebuilt from the bill's own reads — and lands
  on **$541.38 exactly** (tiered variable $362.08, 1 mo, 2,641.59 kWh over 696
  readings).
- The tier-1-only equivalent for the same row set is **$490.43** — tier 2 is
  worth **+$50.95** on this one period.
- No horizontal page overflow at 390 × 844.

Rerun:

```
TIERED_XML=/path/to/export.xml TIERED_EXPECT_PERIODS=24 TZ=America/Toronto \
NODE_PATH=$PWD/webapp/node_modules node evidence/wave-tiered-verify.cjs
```

(`TIERED_BASE_URL` points it at a different stack; `TIERED_SUFFIX` namespaces
the JSON.)

## Two things the evidence run itself turned up — script bugs, not product bugs

Worth recording because the first run failed 17/19 and both failures were in
the *checker*:

1. **UTC days.** The CSV's `datetime` is a UTC ISO string; slicing it to ten
   characters puts every reading after 20:00 local in the next day, so a
   29-day window looked like 30. The window inputs were correct all along —
   696 rows = 29 × 24 exactly. Fixed with a `localDay()` helper.
2. **The vs-actual row is pinned to the bill's read window, not the calendar
   window.** `billWindow(summary)` returns the previous → current read
   timestamps (01:01 local on Jul 22 through 01:01 local on Aug 20 here), so
   the row prices two readings the on-screen calendar window does not include
   and drops two it does. Recomputing from the calendar window's CSV came out
   $0.48 high — the app was right, the checker's basis was wrong. The script now
   rebuilds the bill's own read span (including `BILL_WINDOW_TOLERANCE` and the
   coarse-stamp fallback) and prices exactly those rows.

Neither is a change to app behaviour; both are corrections to
`evidence/wave-tiered-verify.cjs`, and the second is the reason the row's basis
is now documented in the script's header.
