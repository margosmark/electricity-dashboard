# Tier split — BLOCK 1 / BLOCK 2 as Tier 1 / Tier 2, on screen

**Correction card `t_b6141256`.** The classifier existed (`planTimeline`'s BLOCK
detection, `statistics.rateForUsageNote`) but the money vocabulary never got a
tier: every Tiered period's commodity landed in one *"Commodity · not split by
window"* bucket, so the PeriodDeltaTable had no tier rows and the stacked chart
had no tier slices.

| # | Slice | Where |
|---|---|---|
| 1 | `tier1` / `tier2` in `DeltaRowKey` + `COST_SLICE_META` (labels, blue pair, draw order) | `lib/moneyViz.ts` |
| 2 | The existing classifier wired into period stack building — BLOCK-1 notes → tier 1, BLOCK-2 → tier 2, unmapped wording → `commodityOther` | `commodityWindowOf` (same patterns `rateForUsageNote` prices with) |
| 3 | Table cells that are a dash where a tier does not apply, and the OPEN row never labelled a tier | `components/PeriodDeltaTable.tsx`, `components/MoneyStackedChart.tsx` |
| 4 | Pace-chart tier markers untouched (their own regression test kept green) | `components/BillAccrualCurve.tsx` — unchanged |

Two supporting rules, both test-pinned:

- **the split is a SPLIT**: `estimateFromSlices` and `shareBreakdown` count the
  tiers, so a period's slices still add to `billTotals().commodity` to the cent
  (asserted for every fixture period in `moneyViz.test.ts`, and for Sep / Oct
  2025 from the real export in the browser check);
- **the kWh stack keeps its four windows** (`usageKeyOf`): a tier *usage* line
  folds into `commodityOther` instead of landing as an invisible extra key that
  would drop out of `usageTotal`.

## The numbers a reviewer should check

From `tier-split-verification.json` — **38/38** on the **deployed** stack
(`http://dashboard.example.internal:3939`, deploy **fd40595**) against Mark's real 2-year
export (sha256 `e292de50a560f56e…`, printed by the script before it drives
anything; the file itself is never committed). The same **38/38** locally at
`http://127.0.0.1:3100` → `tier-split-verification-local.json`.

Read off the rendered DOM, never the lib:

- **legend and the chart's raw-numbers table carry `Tier 1` and `Tier 2`**
  columns (headers: `Period · Plan · Off-peak · Mid-peak · On-peak · Tier 1 ·
  Tier 2 · Delivery · Regulatory · HST · OEB rebate · You paid · Est. total ·
  Data coverage`);
- **Nov 25, 2024 → Tier 1 $85.69 · Tier 2 —** (the bill has one BLOCK line);
- **Sep 25, 2025 → Tier 1 $58.68 · Tier 2 $91.14**, and the two cells add to
  **$149.82** — the commodity Wave P's audit states for that period;
- **Oct 27, 2025 → Tier 1 $100.55 · Tier 2 $6.47**, adding to **$107.02**,
  again the bill's own commodity;
- **Aug 26, 2025 (TOU) → — / —** while its off-peak cell still reads
  **$122.82**: a TOU period keeps its own windows and claims no tier;
- **OPEN row (2026-08-20) → — / —**, badged `Estimate`, with the estimate
  stated where it honestly lives: `Est. commodity ~$456.93` (+ `Est. total
  ~$701.65`);
- the **PeriodDeltaTable has a `Tier 1` and a `Tier 2` row**, their cells carry
  the period's tier dollars as changes (`+$85.69 … +$58.68 +$41.87 …`), and
  the OPEN column is a **dash in both** — 35 `money-delta-no-tier` dashes in
  total, never `TIER 1 ~$41.00`;
- switch the plan on screen to **Tiered**: the billed figures are byte-identical
  ($58.68 / $91.14), the OPEN tier cells stay dashes, and the **pace-chart tier
  marker still draws** (1 marker) with its `accrual-note` explanation — the
  marker's "no marker off-Tiered" rule stays pinned by `WaveR.test.tsx`.

Screenshots: `tier-split-money-desktop.png` (Money tab, 1440),
`tier-split-money-table.png` (the table above), `tier-split-deltas-desktop.png`
(the delta table) — all taken from the deployed stack.

## A correction to the card's UI check

Two of the three figures in the card's slice 3 do not match the bill. Checked
straight against the export, where `<espi:amount>` immediately precedes its
`<espi:note>`:

| Period | Card says | The bill says | Why |
|---|---|---|---|
| Sep 2025 | TIER 1 $91.14 / TIER 2 $58.68 | **TIER 1 $58.68 · TIER 2 $91.14** | `BLOCK 1- Summer` = 631 kWh at 9.3¢ = $58.68 (`<amount>5868000`); `BLOCK 2 - Summer` = 828.6 kWh at 11.0¢ = $91.14 (`<amount>9114000`). The card's two figures are transposed. |
| Oct 2025 | $91.44 / $6.47 | **$100.55 · $6.47** | That bill has TWO BLOCK 1 lines — `BLOCK 1 - Winter` $91.44 (762 kWh × 12.0¢) and `BLOCK 1- Summer` $9.11 (98 kWh × 9.3¢). Dropping the summer one would leave the bar $9.11 short of the bill's own $107.02 commodity. |
| Nov 2024 | $85.69 / — | $85.69 / — ✅ | `BLOCK 1 - Winter` = $85.69, no BLOCK 2 line. |

`BLOCK 1` is the *cheap* tier on every one of these bills (rate × kWh proves
it), so BLOCK 1 → Tier 1 is not a convention anybody has to remember. Shipped
the bill's figures; the browser check asserts them, and the two add-up checks
(`$149.82`, `$107.02`) are what catch a lost line.

## Gates run locally before the push

GitHub Actions is still **blocked by billing, not by this change** — every CI
run on the repo fails in 3–4 s (including the merge to `main` before this one),
so all three CI jobs were replicated locally:

| Gate (CI job) | Result |
|---|---|
| `npm run lint` (frontend) | clean |
| `npm run typecheck` (frontend) | clean |
| `npm run test` (frontend, vitest) | **1065/1065**, 62 files |
| `npm run build` (frontend) | `next build` OK (11 routes, proxy middleware) |
| `bash tests/e2e/http_smoke.sh` (smoke) | OK — `/`, `/api/rates`, manifest, sw.js, icons |
| `npx playwright test` (smoke, vs `next start :3107`) | **21 passed, 3 skipped, 0 failed** |
| `npx lhci autorun` (smoke, desktop ≥ 0.90) | performance **1.0**, CLS **0** |
| `npx lhci autorun --config=lighthouserc.mobile.json` (≥ 0.85, CLS ≤ 0.1) | performance **0.92**, CLS **0**, LCP 3 350 ms, TBT 89 ms |
| `pytest tests/ -v` (python) | **41 passed** |
| `node evidence/tier-split-verify.cjs` local | **38/38** |
| `node evidence/tier-split-verify.cjs` deployed (fd40595) | **38/38** |

New tests: `lib/moneyViz.test.ts` (+10: the classifier's BLOCK/spacing variants,
the three real Tiered shapes, the add-up invariant, the kWh fold, the delta
rows) and `components/TierSplit.test.tsx` (4 — legend/table figures, the TOU
dash, the OPEN dash in both tables, the estimate still labelled an estimate).

Landed as PR #44 → `main` **fd40595**; deployed with
`ssh hermescomputer '~/bin/deploy-energy-dashboard.sh'` → `DEPLOY_OK at fd40595`.

## Honest limitations

- **The mirror image is untouched:** a *Tiered* row's `Off-peak` / `Mid-peak` /
  `On-peak` cells still print `$0.00` (the card asked for the tier columns, and
  that is what changed). Same class of "zero reads like a charge" nit — worth a
  follow-up card rather than a quiet widening of this diff.
- **`Commodity · not split by window` does not appear on this export** — every
  commodity wording in it maps to a window or a tier. The fallback is covered
  by the unit fixture's `Tiered Electricity` line (`$3.50` → `commodityOther`),
  not by a deployed row.
- **The OPEN row's Plan cell says `Unknown`** (pre-existing: no bill exists for
  those days, so `detectPlanType` has nothing to read a plan from).
- **The harness needs `TIER_SPLIT_XML`** — no committed fixture carries a
  Tiered bill, so a run without Mark's export exits 2 rather than checking
  nothing.
- Screenshots are 1440-wide only; nothing in this change is layout, and the
  phone budget (Lighthouse mobile 0.92, no horizontal overflow) is re-run as a
  gate rather than as evidence here.
