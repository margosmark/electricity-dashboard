# Wave V — HINDSIGHT: what SHOULD have happened, per closed bill

**Shipped:** `9dcd1cd` (PR #72, squashed from `0043193`), deployed via
`~/bin/deploy-energy-dashboard.sh` → `DEPLOY_OK at 9dcd1cd`.

**Verified:** `132/132` on the **deployed** stack (`wave-v-verification.json`,
`http://10.10.11.110:3939/`) and `132/132` on the local build
(`wave-v-verification-local.json`), both against **both** of Mark's real
exports, at 1440 px and 390 px.

## The two levers

Per closed billing period, from the ACTUAL interval readings:

| lever | what it answers | where the number comes from |
| --- | --- | --- |
| **PLAN** | "would another plan have been cheaper for this exact period?" | Wave P's `buildSwitchReport` row for row — `saving`, `bestPlan`, `modeled`, the $1 model check, the coverage skip. Never re-priced here. |
| **BEHAVIOUR** | "if that recurring block had run in the plan's own cheap window instead, what would this period have cost?" | new (`lib/hindsight.ts`): the same readings priced twice — at the hours they ran, and in TOU off-peak / ULO overnight — each reading with the rate set in force on its own day. |

The plan total is Wave P's own `overpaid`, read off its report, so the two
panels can never disagree (checked directly in the browser: the HINDSIGHT plan
figure equals the switch track record's above it, to the cent).

## The numbers on Mark's real files

| | 2-year export (24 bills) | 3-month export (3 bills, 1 countable) |
| --- | --- | --- |
| plan lever | **−$251.89** (the alternatives would have cost more) | −$33.19 |
| behaviour lever | **$452.50** | $61.35 |
| both levers | **$200.61** | $28.16 |
| plan timeline detected | 13 TOU · 11 Tiered | 3 TOU |
| seasons judged | 12 summer · 12 winter · **4 straddling** | 1 summer |
| periods with a moveable routine | 11 | 1 |
| moves printed | 167 — **every one strictly cheaper after the shift** | 16 |

`sha256` of both files is pinned inside the JSON; neither enters the repo.

## What the browser checks (all 132, in the JSON)

- the panel renders in PLANS & TRACK RECORD and nowhere else;
- one row per closed bill (24 / 3), each with the detected-plan badge, the
  season, the period's kWh, a plan chip AND a behaviour chip;
- **the three headline numbers read as a sum on screen** — the plan lever
  prints signed (−$251.89 + $452.50 = $200.61), because a plan the
  alternatives would have beaten is money the alternatives would have cost;
- **each period's behaviour figure equals the sum of the moves printed under
  it** (tolerance n × half a cent for the printed rounding);
- every printed move shows the destination rate BELOW the rate actually paid,
  a positive saving, and the counterfactual wording ("IF … had run in …");
- the plan figure equals the switch track record's, read off the other panel;
- a Tiered period says the hour does not change the price and claims no money;
- an uncovered bill carries its reason and no number (the 3-month file's two
  older bills: "readings cover 21 of 29 days (72%, 90% needed)" and "no
  readings in this browser fall inside this period");
- no raw key, `undefined`, `NaN` or `{placeholder}` leaks into the panel;
- worst-first ordering (the callout names the first row) and the callout's
  split adds to its total;
- the move list is a closed `<details>` until opened;
- the headline figures and the plan chip clear AA against their **own painted**
  backgrounds (colours read through a 1×1 canvas — Chrome serialises Tailwind
  v4 colours as `lab()`/`oklch()`, so a `rgb()` regex would silently measure
  the card behind the chip): 13.71:1, 10.92:1, 21:1, chip 5.21:1;
- no horizontal overflow at 390 px, and both viewports print identical numbers.

Screenshots (not tracked — see `ASSETS.md`): `wave-v-{desktop,mobile}-{long,short}.png`
(full page), `-panel.png` (the panel), `-headline.png` (the three numbers).

## Decisions taken while building

1. **Blocks are keyed by (weekday, hour), not by tier.** Across Nov 1 the same
   wall-clock hour changes tier (a summer 07:00 is Mid-Peak, the winter 07:00
   is On-Peak); keying by tier split one real routine into two cells that each
   failed the "3 weeks" bar and reported "$0, nothing to shift" for exactly the
   bills the card calls out. The four straddling periods on the 2-year file now
   produce real, blended-rate verdicts.
2. **Two guards stop the card saying something nobody can act on:** a block
   below 0.5 kWh/h is the always-on floor (fridge, standby), and adjacent hours
   only merge while their level stays within a factor of 0.35 — without them a
   three-hour appliance cycle glues itself to every baseline hour next door and
   the answer becomes "move Wed 07:00–19:00".
3. **Tiered is a real zero, not a missing value.** Within a tier the price per
   kWh does not depend on the hour, and a same-day shift never changes the
   month's volume, so the period says "the hour does not change the price" —
   it does not say "unknown" and it does not invent a saving.
4. **The headline colours are the audited accent family, not the raw slice
   hues.** Wave O's on-peak slice is `#EF4444`; on the inverted headline chip
   that is 3.2:1 in light and 2.2:1 in dark, so the three numbers use
   `--accent-yellow` / `--accent-emerald` (13.7:1 and 10.9:1 on that surface,
   both themes). The **chips** keep the charge/credit association the card
   asked for: `bad`/`bad-soft` for the plan, `good`/`good-soft` for behaviour.
5. **The optional Efficiency mini-line underlay was not built.** The card marks
   it optional and conditional on not degrading Wave S's mobile behaviour;
   underlaying a red segment on `statistics.ts`' sparkline risks that for
   information the panel already states.

## Re-running

```bash
# the deployed stack (what wave-v-verification.json is from):
WAVE_V_XML_LONG=/path/to/2-year-export.xml \
WAVE_V_XML_SHORT=/path/to/3-month-export.xml TZ=America/Toronto \
  node evidence/wave-v-verify.cjs

# the local build (needs a running server on :3939):
WAVE_V_XML_LONG=… WAVE_V_XML_SHORT=… WAVE_V_BASE_URL=http://127.0.0.1:3939/ \
WAVE_V_SUFFIX=-local node evidence/wave-v-verify.cjs
```

## Gates run before the push

| gate | result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run test` | **1429 passed \| 6 skipped** (82 files) |
| `npm run build` | ok |
| `node scripts/i18n-merge.mjs --check` | up to date, 1240 keys |
| `.venv/bin/pytest tests/` | 41 passed |
| `.venv/bin/pytest ops/dmd/tests` | 19 passed, 1 skipped |
| `node evidence/wave-v-verify.cjs` (local) | 132/132 |
| `node evidence/wave-v-verify.cjs` (deployed) | 132/132 |
| CI | skipped by convention — Actions billing dead; the local battery is the gate |
