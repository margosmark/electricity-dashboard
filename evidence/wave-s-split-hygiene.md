# Wave S follow-through — behaviour-vs-rate split, baseline hygiene review

**Question (kanban `t_fee3d256`)**: is the efficiency panel's behaviour-vs-rate
split double-counting a TOU-season / rate-period change as a *behaviour*
change?

**Answer**: the price half is clean — an OEB rate change is counted **once**,
in the rate component, to the cent. The verdict half was **not** clean: the
component the chip credited with "your usage mix improved" was 96% the
delivery/fixed-charge term, a seasonal arithmetic artefact. Fixed here as a
three-way exact split whose verdict reads the usage component alone.

## How it was checked

`evidence/wave-s-split-hygiene.py` — a **second parser** (Python ElementTree
over the raw Green Button XML, no webapp code) over Mark's real 2-year export
(sha256 `e292de50a560f56e…`, 6,424,909 bytes, never committed). It reproduces
the deployed split **exactly**:

| component | audit (Python) | deployed app (Wave S evidence) |
|---|---|---|
| net slope | +0.0552 (±0.1326) | +0.0552 |
| behaviour slope | −0.1570 | −0.157 |
| rate slope | +0.2122 | +0.212 |
| recombination | 0.000000 | exact |

The audit's per-bill ¢/kWh also matches the Wave S spot checks (Aug 2024 =
15.90¢, Jul 2025 = 13.93¢, Jan 2026 = 19.35¢), and the metered-hour splits
reconcile against each bill's own "… Usage" lines to **±0.18%** on every bill
with full coverage (the three bills with −77/−82% "error" are the ones whose
metered readings start after their read date — the audit skips them for
hour-level probes, never for money).

## Finding 1 — no double count of price changes (confirmed)

For every bill read on/after **2025-11-01** (today's `latestRateSet`), the rate
component is **0.0000¢**. For bills priced at the earlier sets it is exactly
Σ q·(p_billed − p_today)/kWh:

- Aug 2025 (billed 7.6 / 12.2 / 15.8): rate = **−2.761¢**
- Sep 2024 (billed 8.7 / 12.2 / 18.2): rate = **−1.617¢**
- the 2025-10-27 transition bill (9.3 → 12.0¢ tier inside one bill): blended
  tier-1 11.692¢, rate = −0.493¢ — half-weighted, as it should be.

The two Nov 1 boundaries inside the billed span (2024-11-01, 2025-11-01) show
up once, in the rate component. **Nothing to fix here.**

## Finding 2 — the verdict was crediting the delivery charge as "usage" (fixed)

The old split was `behaviour = commodity@today's rates + non-commodity as
billed`. Over the 12-bill verdict window (2025-07-25 → 2026-07-22):

| term | slope ¢/period | stderr | verdict |
|---|---|---|---|
| **behaviour (old)** | **−0.157** | 0.076 | *improving* ← the chip |
| └ usage mix @ today's prices | −0.006 | 0.033 | flat |
| └ delivery/regulatory/fixed per kWh | −0.151 | 0.089 | improving |
| rate | +0.212 | 0.070 | worsening |
| net (observed) | +0.055 | 0.133 | stable |

**96% of the "improvement" was the delivery term.** That term is seasonal —
summer mean 5.11¢/kWh vs winter 6.61¢ (min 4.37, max 7.35) — and the window
starts and ends on summer bills at 4.39 and 4.43¢: the slope is the *shape* of
one seasonal cycle, not a trend. It is exactly the fixed-charge-spread effect
the module's own header already described as a season effect. Meanwhile the
usage-mix term the chip was talking about is inside its own error bar: flat.

**Fix**: three components that sum to observed exactly —
`usageCents` (commodity repriced at today's rates), `deliveryCents`
(delivery/regulatory/other as billed), `rateCents` (residual, unchanged). The
verdict reads the usage fit; delivery gets its own line on the card and its own
clause in the sentence. The residual is untouched: the same 2.0679¢ the old
split produced on the fixture still falls out of the rate component.

## Finding 3 — the rate-period artefacts that remain in "usage" (documented, sized)

The counterfactual keeps each bill's own **billed block split**, so a
rate-schedule change that moves the split without any change in usage still
moves the usage component. Measured on the real data:

- **TOU window re-draw (Nov 1)**: re-splitting the same metered hours under one
  fixed window set moves the usage component by **≤0.13¢/kWh** (Mar 2026 bill
  12.546¢ under billed winter windows vs 12.476¢ under summer windows; Jul 2026
  12.457 vs 12.591). Small because this household's load is flat across the
  window edges Ontario moves.
- **Tiered threshold season (Nov 1)**: winter bills are 100% BLOCK 1 at
  12.00¢; the same kWh under summer's 600 kWh/month threshold prices at
  12.66–12.92¢ — a **0.63–0.88¢** level shift, purely the threshold calendar.
- **Plan switches (4 in the export)**: the counterfactual reprices each bill in
  its own plan's structure, so the usage component **steps +0.89¢** at the
  2025-08→09 TOU→tiered switch and **+0.55¢** at the 2026-02→03 tiered→TOU
  switch, with no change in usage behaviour.

These are level shifts inside one component, not slope double counts; they are
now stated in the module header instead of being invisible. A follow-up card
tracks the deeper fix (re-splitting metered hours under today's schedule).

## What is on screen now (owner's data, 12-bill window)

Before: `IMPROVING −0.2¢/kWh per period — Your usage mix improved
(−0.2¢/kWh behavior-driven), but rates rose (+0.2¢/kWh) — net stable ±0.1¢.`

After: `STABLE ±0.0¢/kWh per period — Your usage mix is flat (±0.0¢
behavior-driven), rates rose (+0.2¢/kWh); delivery & fixed charges fell
(−0.2¢/kWh) — net stable ±0.1¢.`

## Files

- `evidence/wave-s-split-hygiene.py` — the audit (prints one JSON object).
- `webapp/src/lib/statistics.ts` — three-way split, verdict on usage.
- `webapp/src/components/EfficiencyCard.tsx` — `data-usage-slope`,
  `data-delivery-slope`, the delivery & fixed line, updated footer copy.
- `webapp/src/lib/statistics.test.ts` — rule tests, incl. the regression test
  *"never credits the user with a DELIVERY-driven improvement either"*.
- `webapp/src/lib/statistics.realdata.test.ts` — the app's own pipeline against
  this audit's numbers; inert unless you pass `WAVE_S_XML=`.

## Verified deployed — 37/37 at `58202db`

Wave S landed as **PR #46** (merge commit `0d81870`, 14:07:28 EDT) and was
deployed with `~/bin/deploy-energy-dashboard.sh` → `DEPLOY_OK at 0d81870`.
Wave T (PR #47) then merged and redeployed at 14:13:57, so by the time this
check ran the stack was serving **`58202db`** — which contains the Wave S
merge and touches none of this card's files (no `EfficiencyCard.tsx`,
no `statistics.ts`). The recorded run is against that live container, whose
`StartedAt` (14:13:57Z) predates the run (14:26:08Z) with no deploy in
between:

```
WAVE_S_SPLIT_XML=/path/to/export.xml TZ=America/Toronto \
  node evidence/wave-s-split-hygiene-verify.cjs
→ evidence/wave-s-split-hygiene-verification.json   37/37 checks passed
     base http://10.10.11.110:3939/  deploy 58202db  at 14:26:08Z
  + wave-s-split-hygiene-desktop.png, -efficiency-card.png
```

The export is uploaded through the deployed UI — Mark's real 2-year file,
sha256 `e292de50a560f56e…`, 6,424,909 bytes, never committed:

Every number on screen, read back out of the DOM, against the independent
Python audit over the same file (window = the last 12 of 24 bills):

| what | DOM attribute | audit (Python) | published |
|---|---|---|---|
| verdict | `data-verdict="stable"` | — | **stable** |
| usage slope | `data-usage-slope` −0.006 | −0.0061 (±0.0327) | −0.006 |
| delivery slope | `data-delivery-slope` −0.151 | −0.1508 (±0.0894) | −0.151 |
| rate slope | `data-rate-slope` +0.212 | +0.2122 (±0.0704) | +0.212 |
| net slope | `data-net-slope` +0.055 | +0.0552 (±0.1326) | +0.055 |
| verdict source | `data-slope` ≡ `data-usage-slope` | — | usage only |
| all-time headline | 16.3¢/kWh · All time · 24 bills | 16.2575¢, 24 bills | 16.3¢ / 24 |

Recombination is exact on screen: −0.006 + −0.151 + 0.212 = +0.055, and
`data-slope` equals `data-usage-slope` while differing from
`data-delivery-slope` — the verdict *cannot* read the term that used to own it.
`usage + delivery` = −0.1569, i.e. the −0.157 the old chip printed, now split
into its two real parts.

The sentence the card now renders, verbatim:

> Your usage mix is flat (±0.0¢ behavior-driven), rates rose (+0.2¢/kWh);
> delivery & fixed charges fell (-0.2¢/kWh) — net stable ±0.1¢.

with three chips beside it — `rates +0.2¢/period` (up), `delivery & fixed
-0.2¢/period` (down), `net stable ±0.1¢` — and the sentence no longer contains
the phrase *usage mix improved* anywhere.

The all-time headline is untouched: **16.3¢/kWh over 24 bills**, `data-cents`
16.26 in both the card and the existing totals strip (Σcost/ΣkWh from the audit
= 16.2575). Note the headline's bill count is the sibling label
`All time · 24 bills`, not a `data-bills` attribute — the only `data-bills` on
the card is the card's own.

CI does not gate this: the three GitHub Actions jobs die in 2 s with
*"The job was not started because recent account payments have failed"* (billing
dead since the M114 budget). Both merges were gated on local-green instead.
PR #46's own tree: lint clean, typecheck clean, `npm run test` **1066 passed /
4 skipped (63 files)**, `npm run build` OK (11 routes), real-export check 4/4.
After Wave T landed, this branch was rebased onto `origin/main` and the gates
were re-run on the exact tree that merges: lint clean, typecheck clean,
`npm run test` **1123 passed / 4 skipped (66 files)**, `npm run build` OK
(11 routes), `WAVE_S_XML=… npx vitest run src/lib/statistics.realdata.test.ts`
4/4.
