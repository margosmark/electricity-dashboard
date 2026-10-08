# Wave O — money visuals: the bill, drawn

**What shipped** (all client-side again: `UsageSummary` → localStorage → render,
zero server round trips — both verification runs record 21 GETs and nothing
else):

| # | Slice | Where |
|---|---|---|
| 1 | Stacked composition per billing period — commodity split into its own off/mid/on windows, delivery, regulatory, HST, and the OEB rebate **below the zero line**; itemized tooltip + a raw-numbers table | `lib/moneyViz.ts` (`buildPeriodStacks`), `components/MoneyStackedChart.tsx` |
| 2 | `% Share` state: 100% horizontal composition per period + the "delivery + regulatory is N% of the bill" stat row | `shareBreakdown`, `MoneyStackedChart` |
| 3 | `kWh` state: the bill's own per-window usage lines, so cost movement with flat consumption stops reading like a usage change | `buildPeriodStacks` (`usage`), `MoneyStackedChart` |
| 4 | Period → period delta table, first column explicitly a baseline | `periodDeltaRows`, `components/PeriodDeltaTable.tsx` |
| 5a | ¢/kWh by hour of day, bars coloured by rate window, dashed window average | `hourCostProfile`, `components/HourCostHistogram.tsx` |
| 5b | Attribution waterfall for one chosen period, landing on the bill's own amount due | `billWaterfall`, `components/BillWaterfall.tsx` |
| 5c | Plan overlay: three alternatives as horizontal lines over the same covered periods, plus what was actually paid | `planOverlay`, `MoneyStackedChart` |
| 6 | `MONEY` section under ShiftOptimizer on Insights, honest empty state, behind `next/dynamic` so Recharts stays off the first paint | `components/MoneySection.tsx`, `InsightsView.tsx` |

## The numbers a reviewer should check

From `evidence/wave-o-verification.json` — **Mark's real 3-period Oakville
export** (never committed), fresh browser profile:

- payables per period **$406.65 · $419.38 · $395.68** — the money table prints
  exactly the same three numbers as the "Your actual bill" panel (checked
  period by period, Δ < ½¢);
- shares of everything charged: **65.4¢ electricity · 23.1¢ delivery+regulatory
  · 11.5¢ HST = 100.0¢**, then the rebate hands back **20.8¢** and you net
  **$1,221.71**;
- plan overlay on the only fully-covered period: **Time-of-Use $394.35 ·
  Tiered $427.55 · Ultra-Low Overnight $462.36 · you paid $395.68** (Wave P
  models the same period at Tiered $428.87 — within $1.32, two independent
  models agreeing);
- waterfall for that period: **$325.00 commodity → +$102.34 delivery →
  +$14.76 regulatory = $442.10 total electricity charges → +$57.47 HST →
  −$103.89 rebate = $395.68** — the same figure the bill panel prints;
- ¢/kWh window average **12.4¢**, bars stair-stepping 9.8 → 15.7 → 20.3 with
  the rate windows (weekends and the Civic Holiday pull the on-peak bars below
  20.3, which is the holiday rule Wave L fixed showing up again).

From `evidence/wave-o-verification-long.json` — the **24-period export**
(2024-04-30 → 2026-10-06), i.e. the file that covers the periods where Mark
was NOT on TOU:

- 24 stacked rows, **23 delta columns**, 146 bar segments, no horizontal page
  overflow at 390 px;
- shares **58.6 + 29.9 + 11.5 = 100.0%** — the double-count tripwire passes;
- the tiered periods' `BLOCK 1 - Winter` / `BLOCK 2 - Summer` lines stack as
  **"Commodity · not split by window"** — the chart does not pretend to know
  which TOU window a tiered line belongs to;
- overlay totals across **23 covered periods**: TOU **$4,976.26**, Tiered
  **$5,148.74**, ULO **$5,544.49**, actual **$5,273.46**.

Rerun: `WAVE_O_XML=/path/to/export.xml WAVE_O_EXPECT_PERIODS=3 \
NODE_PATH=$PWD/webapp/node_modules node evidence/wave-o-verify.cjs`
(add `WAVE_O_SUFFIX=-long` for a second file's JSON; add
`WAVE_O_BASE_URL=http://10.10.11.110:3939/` and `WAVE_O_SUFFIX=-deployed`
to check the deployed stack instead of a local `next start`).

## Decisions, and why they read this way

**The rebate hangs below the axis.** The spec allowed either that or a
delta-labelled annotation. Below-zero is the only rendering where the bar's
top (charges before rebate) and the pile that remains (what you paid) are both
true at once; a separate annotation would have made the positive stack look
like the amount due. The caption under the legend says the bars are
pre-rebate, and the tooltip and table carry the net figure.

**The overlay models FULL amounts due, not the plan cards' commodity-only
totals.** Delivery, regulatory and HST come from `calculateTrueBill` with the
bill's own rates and the observed rebate rate (−23.5% of the subtotal) is
applied the same way the bill applies it — that is what makes a horizontal
line comparable to a bar at all. The lines plot the **per-period average**
(the totals are printed in the key), because a whole-span total on a
per-period axis is an order of magnitude off the scale. Delivery and
regulatory are modelled plan-independently; that is stated on screen as an
assumption, not presented as the utility's tariff.

**Only fully-covered periods are modelled.** The same ≥90% coverage gate Wave
L reconciles with. On Mark's 3-period file that means one period (his readings
start 2026-07-02), and the chart says "Lines cover 1 of 3 billing periods" —
modelling May and June off no readings would be a guess in a chart's clothes.

**One three-state control, not two toggles.** `$ Dollars / % Share / kWh` —
the spec's "breakdown view" and "energy-vs-cost split" are the same chart in
three states, and `% Share × kWh` (share of energy) was a combination nobody
asked for. The overlay checkbox only draws over dollars and says so.

**Shares exclude the rebate.** The denominator is the positive charges, so
every period is exactly 100%; a negative share of a 100% stack is a
contradiction. The rebate is reported as the percentage it hands back, and it
gets no column in the share table (a column of 0.0% reads like a bug).

**The histogram prices commodity only.** Delivery, regulatory and HST arrive
once per billing period with no hour attached; there is no honest per-hour
figure for them, and the panel says that instead of implying an all-in rate.

**The waterfall is built forward, and it has to land.** The spec sketched
"from total down: −rebate −commodity −delivery …"; that arithmetic does not
equal the amount due, so the waterfall builds up instead: commodity →
delivery → regulatory → *(Total electricity charges)* → HST → rebate →
amount due, where every step is `billTotals`' own arithmetic and the last bar
equals `payable` to the cent (asserted for every period, in unit tests and in
the browser). A stated total that disagrees with its own itemized lines
becomes a visible "Not itemized" step rather than being absorbed.

**MONEY lives under ShiftOptimizer and is honest when empty.** No bill →
"Upload a Green Button export with billing periods to unlock the money views",
and nothing is drawn. The section is behind `next/dynamic` for the same reason
`YearOverYearPanel` is: Recharts should not land on a first visit that has no
bill to draw.

## Six findings the real files forced out

1. **The rebate was painting on top of the bill.** With one `stackId`, d3
   walks the cumulative total in series order, so a negative slice drawn after
   the positives hangs *down from the top of the pile*: measured on Mark's
   file, the −$103.89 credit spanned y 56→116 while zero sat at 342 — i.e.
   covering delivery, regulatory and HST. The credit now gets its own stack
   group, which baselines at zero and hangs below (measured again: 259→303
   under a zero line at 259).
2. **Out-of-domain reference lines are silently discarded.** Plotting the
   overlay as whole-span totals put a $4,741 line over $400 bars and Recharts
   rendered *nothing* (0 reference lines on the 24-period file). The lines now
   plot the per-period average and carry `ifOverflow="extendDomain"` so an
   expensive plan stretches the axis instead of vanishing.
3. **A non-zero "Amount Due" was stacked as a charge (real bug, pre-existing).**
   `classifyBillLine` only routed `Amount Due` to `info` when the amount was
   0; on Mark's long export 20 of 24 periods have a non-zero one, so the whole
   payable amount landed in "Other lines" and every bar roughly doubled (the
   share stats read 30.8% electricity instead of ~59%). The note now matches
   regardless of amount, which is what `billTotals`' `info` branch (the one
   that reads `amountDue` back out) has always assumed. Regression pinned in
   `usageSummary.test.ts`; the browser check "the charge shares add to 100%"
   is the tripwire.
4. **The kWh stack would have been empty by construction.** The bill's
   `… Usage` lines classify as `info` (their note contains "usage"), and the
   cost loop returned before reaching the usage extraction. Extraction now
   runs first; `moneyViz.test.ts` asserts the stack sums to `billedKwh` for
   every period.
5. **24 periods break the furniture.** Date labels every 4th bar, a delta
   table that sizes itself (`220 + columns × 110` px) and scrolls inside its
   own box, and a chart key that replaces on-chart line labels — three plans
   landed $7 apart and the labels printed on top of each other.
6. **Per-reading `costTiered` is tier-1 only, so the overlay's Tiered line was
   $40 too cheap.** `processRawData` fills `costTiered` with `usage × tier1`;
   the tier-2 threshold only exists in the monthly buckets
   (`aggregateChartData`), which is why `calculateFullDataTotals` goes out of
   its way to route through them. Pricing the overlay with `planCostFor` (the
   per-reading sum) put Tiered **$8 below** the real TOU bill on Mark's July
   period — the opposite conclusion to Wave P's track record for the very same
   period. The overlay now goes through `aggregateChartData(…, 'monthly')` +
   `calculateComparison`, i.e. exactly the plan cards' math: **$427.55** vs
   Wave P's **$428.87** for that period. `TrueBillEstimate` and
   `reconcileBillingPeriods` still use `planCostFor` — pre-existing, out of
   scope here, filed as its own card.

## Gates run locally

| Gate | Result |
|---|---|
| `npm run lint` / `npm run typecheck` | clean |
| `npm run test` | **820 / 820** (48 files) on the tree rebased onto `main` (Wave P + Wave EV-2 included) |
| `npm run build` | ok (`sw.js` VERSION restored to `oeo-v1-local` afterwards) |
| `evidence/wave-o-verify.cjs` on the 3-period Oakville XML | **33 / 33** (re-run on the rebased build) |
| `evidence/wave-o-verify.cjs -long` on the 24-period export | **33 / 33** (re-run on the rebased build) |
| **deployed** — `WAVE_O_BASE_URL=http://10.10.11.110:3939/`, both files | **33 / 33** + **33 / 33** (`wave-o-verification-deployed.json`, `wave-o-verification-long-deployed.json`), stack at `e0a0efa` |
| 390 × 844 mobile pass | included above: 0 px page overflow, 44 px toggles, charts/tables scroll inside their own boxes |
| CI | **cannot start jobs, repo-wide and pre-existing**: every run on `main` and on every branch finishes in 3–5 s with all jobs failed and *zero steps* (e.g. run 37724113959, `E2E Smoke` / `Frontend` / `Python`, `steps: []`). Local gates above are the evidence, as for Waves L/P. |

Screens: `wave-o-money-desktop.png` (stacked + overlay key),
`wave-o-share-desktop.png`, `wave-o-waterfall-desktop.png`,
`wave-o-hour-histogram.png`, `wave-o-deltas-desktop.png`,
`money-section-desktop.png`, `wave-o-insights-full.png`,
`wave-o-money-mobile.png`.

## Follow-ups deliberately not taken here

- **Plan-type timeline / switch-decision report** — landed as **Wave P** while
  this branch was being rebased (it mounted on the Chart tab and left "the
  money-chart overlay" to this wave, per `wave-p-notes.md`). The two agree:
  P models Tiered for 2026-07-22 at $428.87, this overlay at $427.55.
- **`planCostFor` prices Tiered at tier 1 only** (finding 6) — `TrueBillEstimate`
  and `reconcileBillingPeriods` inherit it, so a Tiered estimate over a
  threshold month is low. Filed as a follow-up card rather than folded in here.
- `BLOCK n - Season` lines stay labelled "not split by window". Guessing which
  tier or window they belong to is that card's job, not this chart's.
- Backups (`lib/backup.ts`) still carry readings/billing-day/charges only.
- Per-period overlay lines (one modelled line per bar) instead of a single
  average line — possible later, but four lines per bar would be unreadable at
  24 periods.
