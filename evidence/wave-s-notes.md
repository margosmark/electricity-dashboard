# Wave S — efficiency statistics: ¢/kWh, the verdict, and the half of it rates caused

**What shipped** — all six slices:

| # | Slice | Where |
|---|---|---|
| 1 | All-time kWh-weighted ¢/kWh (Σcost ÷ ΣkWh over every closed bill) | `lib/statistics.ts` → headline on the EFFICIENCY card + `efficiency-all-time-strip` |
| 2 | In-view average scoped to the window on screen (selection ∩ chart zoom) | `lib/statistics.ts#inViewCentsPerKwh` → `efficiency-in-view` in the EXISTING totals strip |
| 3 | Trend verdict from a linear fit, stable iff \|slope\| ≤ its own stderr | `lib/statistics.ts#linearFit` / `directionOf` → `efficiency-trend-chip` |
| 4 | Behaviour-vs-rate split: each period decomposes exactly, slope(observed) = slope(behaviour) + slope(rate) | `lib/statistics.ts#efficiencyPeriods` (counterfactual repricing at today's rate set) |
| 5 | 24-point mini-line + regression overlay + Nov 1 rate ticks + labelled season bands | `components/EfficiencyCard.tsx` (hand-drawn SVG, no recharts chunk) |
| 6 | One EFFICIENCY card on OVERVIEW; all-time/in-view restated inside the existing strip | `components/OverviewPanel.tsx`, `components/Dashboard.tsx` |

## The numbers a reviewer should check

From `wave-s-verification.json` — **40/40** on the **deployed** stack
(`http://dashboard.example.internal:3939`, deploy `8fdc1ec`, recorded as `deployedCommit`
in the JSON; identical 40/40 runs landed earlier that day on `0881614` and
`cc69444` as the stack moved under me) against Mark's
real 2-year export (sha256 `e292de50a560f56e…`, 6,424,909 bytes — never committed; pass
`WAVE_S_XML` yourself to re-run). Every figure is asserted against
`wave-s-audit.py`, a **second parser** (Python ElementTree) that reads the raw
XML independently of the app's fast-xml-parser pipeline:

- **the audit itself**: 24 bills, Σ$6,114.64 ÷ 37,611.1 kWh = **16.2575¢/kWh**
  all-time; metered span 2024-10-06 → 2026-10-06 (17,539 readings);
- **task spot checks all land**: Aug 2024 = **15.90¢** ($306.42 / 1,927.6 kWh),
  Jul 2025 = **13.93¢** ($432.07 / 3,101.0 kWh), Jan 2026 = **19.35¢**
  ($157.92 / 816.1 kWh) — read back from the DOM `data-cents`/`data-kwh`
  attributes the mini-line carries per point;
- **all 24 points** match the audit on month, ¢/kWh (±0.011) and kWh (±0.06);
  headline prints **16.3¢/kWh · 24 bills**; the totals strip restates the same
  `16.26` — one strip, no new one;
- **the verdict, split**: chip `IMPROVING −0.2¢/kWh per period (your last 12
  bills)` reads the **behaviour** fit (−0.157¢) — asserted as
  `data-slope == data-behavior-slope`; rates `+0.2¢/period` (+0.212¢); the two
  recombine to the net slope +0.055 within 0.01; **net `stable ±0.1¢`** matches
  an independent OLS run in Python over the same 12 bills (slope 0.0552,
  stderr 0.1326 → inside its own error bar);
- **the honesty sentence on screen**: *"Your usage mix improved (−0.2¢/kWh
  behavior-driven), but rates rose (+0.2¢/kWh) — net stable ±0.1¢."* — exactly
  the confusion the split exists to prevent: a raw verdict would have reported
  the +0.055 drift, or declared victory on the behaviour half alone;
- **rate-change ticks**: exactly `2024-11-01` and `2025-11-01` (the two shipped
  OEB sets inside the billed span), drawn as red dashed lines labelled
  *rates*, and **named in the footer text** ("Nov 1, 2024, Nov 1, 2025");
- **chart furniture**: 24 points, one regression polyline drawn over the
  12-bill window only (never extrapolated), 5 season bands, Winter/Summer
  labels present;
- **in-view is really scoped**: default window (2026-08-20..2026-10-06) = 1
  bill / 16.74¢; widened to the whole span = 23 bills / 16.28¢ vs audit
  16.2770¢; narrowed to 2025-01-01..2025-12-31 = **13 bills / 15.47¢** vs audit
  15.4665¢ — while all-time stays 16.26¢ / 24 bills the whole time;
- **interaction**: clicking the mini-line selects the MONEY tab
  (`aria-selected=true`); at 390 px the card renders, draws all 24 points and
  scrolls sideways by **0 px**.

Screenshots from the deployed stack: `wave-s-desktop-overview.png` (1440),
`wave-s-desktop-efficiency-card.png` (the card itself), `wave-s-mobile-overview.png` (390).

## Gates run locally before the push

| Gate | Result |
|---|---|
| `npm run lint` | clean (0 errors, 0 warnings) |
| `npm run typecheck` | clean |
| `npm run test` (vitest) | **1052/1052**, 61 files (62.5 s) on `8fdc1ec` (= base `cb92c11`'s 1003 Wave S tests + the waves that landed since) |
| `npm run build` | `next build` OK (11 routes, proxy middleware) |
| `node evidence/wave-s-verify.cjs` (deployed `8fdc1ec`) | **40/40** |
| CI | skipped by convention — Actions billing has been dead since 2026-10-07; gates run locally |
| deploy | `~/bin/deploy-energy-dashboard.sh` → the `8fdc1ec` stack these checks ran against. Ops wrinkle: the host hit **100% disk** (docker vfs) mid-run and one deploy died on `no space left on device`; a sibling freed it to 30 GB and the next deploy landed clean (deploys are flock-serialized, so my retry correctly refused while theirs ran) |

New tests: `lib/statistics.test.ts` (387 lines — weighted means, the overlap
rule, OLS + stderr verdict, the exact behaviour+rate recombination, empty
states) and `components/WaveS.test.tsx` (304 lines — card placement, strip
restatement, chip/sentence contract, per-point attributes, click-through).

## Honest limitations — they change what the panel means

- **All-time (24) ≠ in-view at full span (23), on purpose.** The export's
  metered readings start **2024-10-06**, after bill 1 ends (2024-09-25), so
  that bill has no readings on screen; `viewRange` reads the days the chart
  actually has, so it is out of view but still counted for all-time. The
  check that proves both halves is in the JSON.
- **The default window shows 1 bill.** The app opens on the Billing Period
  scope, whose window is the current period — the strip's in-view then reads
  the single bill that touches it. Not a Wave S default; Wave S only reports
  the window it is given.
- **"Behaviour" holds the OEB commodity schedule fixed, not the whole bill.**
  Delivery/regulatory are utility-set with no public rate schedule to reprice,
  so they ride with the bill as issued — a delivery-rate increase lands on the
  behaviour side. The counterfactual only claims what it can compute, and the
  card says so in its footer.
- **The rate baseline is TODAY's set**, so a bill priced at current rates has
  rate¢/kWh ≈ 0; the rate component's *trend* is the rate story, which is why
  the window must cross a Nov 1 boundary (it does: two of them).
- **The dashed overlay fits the black (observed) series** — it is the NET fit;
  the IMPROVING chip is the BEHAVIOUR fit. They differ by design, and the
  sentence directly above the chart prints both halves so they can never
  silently disagree.
- **Stable threshold = the slope's own standard error**, no hand-picked band;
  window = the newest up-to-12 closed bills (one seasonal cycle, a 6-month
  window over a twice-yearly series is half a cycle), floor of 4 with an
  honest empty state below it.
- An unpriceable usage category voids the split for that window rather than
  guessing a rate — the ¢/kWh headline still stands and the card says the
  split is off (`data-split="false"`).
- Cosmetic: the IMPROVING chip is wider than its neighbours, and the red
  *rates* label sits close to a band label at some widths.

## Re-running

```bash
# the deployed stack (what the committed JSON is from):
WAVE_S_XML=/path/to/2-year-export.xml node evidence/wave-s-verify.cjs

# the second parser alone:
python3 evidence/wave-s-audit.py /path/to/2-year-export.xml
```
