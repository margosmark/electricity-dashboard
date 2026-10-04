# Interval hygiene — webapp always-on floor + Streamlit chart labels

Card t_7833d76f · PR #14 · 2026-10-04

Same root cause as `evidence/streamlit-vampire-15min.png` (PR #12): `usage_kwh`
is energy **per reading interval**, and every `P05 × 24 h/day` figure assumed an
hourly feed, so a 15-minute Green Button / ESPI export read exactly 4× low. All
bundled fixtures are hourly, so nothing could catch it.

## What the numbers say

**Webapp (vitest, `npm run test` — 511 passed, was 503)**

| assertion | result |
| --- | --- |
| 15-min vs hourly feed → `calculateVampire().watts` / `.cost` | bit-identical |
| 15-min vs hourly feed → `calculateAlwaysOnFloor().watts` / `.kwhPerDay` | bit-identical |
| ... `annualCost` / `label` / `billShare` / `verdict` | equal (`toBeCloseTo` ≤ 1e-6) |
| 15-min `calculateVampire().cost` vs pre-fix `P05 × 24 × 30 × rate` | exactly **4×** |
| pre-fix 15-min cost vs hourly cost | pre-fix was **÷4** (the bug) |
| heatmap cell `avg`, both cadences | equal; 15-min cell holds 4× the readings |

`inferIntervalHours()`: 3600 s → 1.0 h, 1800 s → 0.5 h, 900 s → 0.25 h;
unfazed by a 7-hour outage gap, a duplicated timestamp or reversed row order;
returns 1.0 on 0/1 rows and on all-identical stamps.

**Mutation check** — with the two `/ inferIntervalHours(...)` divisions and the
heatmap's `/ cell.days` reverted to the pre-fix expressions, exactly those **4
cadence tests fail** (111 others still pass). The suite now catches the bug.

**Gates:** `npm run lint` ✓ · `npm run typecheck` ✓ · `npm run test` 511/511 ✓ ·
`npm run build` ✓ · `pytest tests/` 33/33 ✓ · CI run 37209376193 **3/3 green**
(Frontend, E2E Smoke, Python).

## Streamlit — AppTest, pre-fix vs post-fix

Two synthetic Green Button exports of the *same* household (120 hourly readings
vs the same hours as 480 quarter-hour readings), each run through the real
`app.py` via `streamlit.testing.v1.AppTest`, with the whole date range selected
as "away" so the vacation metric renders:

| | `origin/main` app | PR #14 |
| --- | --- | --- |
| hourly feed — Avg Vacation Hourly Usage | 0.717 kWh | 0.717 kWh |
| 15-minute feed — same metric | **0.179 kWh (4× low)** | **0.717 kWh** |
| hourly feed — Daily Routine chart (24 bars) | — | identical, worst abs diff **0.000e+00** |
| 15-minute feed — Daily Routine chart | per-reading mean | = main × 4 (worst abs diff 1.1e-16) |

11/11 A/B assertions pass, including "the 15-minute feed names its reading
interval in the vampire help text" (that help string comes from PR #12).

Reproduce: `verify_labels.py` / `verify_prepost.py` in the session scratch
(they generate the feeds, run `AppTest`, and decode the rendered Plotly `spec`).

## Sweep result (card step 2)

Beyond the four locations the card named:

- Appliance-signature header comment ("readings are treated as one per hour —
  the same assumption `calculateVampire` makes") → stale; the code sums into
  per-clock-hour buckets, which *is* kW on any cadence. Comment corrected.
- `hourlyCurve` doc "(= kW for an hourly feed)" → misleading for the same
  reason. Doc corrected.
- `detectAnomalies` baselines, `calculateWfhShare`, `calculateFullDataTotals`,
  `aggregateChartData`, `touShift.ts`, `billProjection.ts`, `trend.ts`: all
  **sums** over rows — already cadence-independent, nothing to do.
- **`buildHeatmapData`** was the one real chart-maths hit: `avg = sum/count`
  (a per-reading mean) rendered as "X kWh average" on a weekday-hour cell → now
  `sum / distinct days`.
- **Outside `energy.ts`, not fixed here** → follow-up card **t_58afdb97**:
  `evScenario.ts::detectEvCandidate` computes `meanKw = sum/count` over
  *readings*, so the overnight kW, `EV_MIN_KW` gating and "kWh a night" are 4×
  low on a 15-minute feed.
