# Wave V — HINDSIGHT (scope-corrected): the same readings, repriced

**Correction of `9dcd1cd` (PR #72).** Mark's requirement, stated explicitly:
historical hindsight compares **only the same actual metered readings**, at the
same timestamps and quantities, repriced across TOU / Tiered / ULO per actual
bill window and the historical seasonal rate sets. Nothing about behaviour.

Removed from the Hindsight surface and from every total it prints:

| removed | what it was |
| --- | --- |
| the second verdict per period | the recurring-block "move" analysis, priced twice (real hours vs the plan's own cheap window) |
| `scanPeriodBlocks`, `pickLever`, `blockLabel`, `destinationRateCents`, the block/tier constants | the whole behaviour engine in `lib/hindsight.ts` |
| the behaviour chip, the per-block move list (`<details>`), the block/rate copy | `components/HindsightPanel.tsx` |
| the behaviour total, the plan+behaviour sum, the "which lever mattered" line, the shiftable-kWh legend count | the panel's headline and legend |
| 30 catalog keys + the `hindsight.moveSaved` bilingual-identical whitelist entry | the copy those surfaces needed |

Kept, unchanged in behaviour and still pinned by tests: Wave P's plan
comparison (read row for row off `buildSwitchReport`, never re-priced), actual
plan detection, per-period pricing with each reading's own rate set, the
skip / unknown / untrusted honesty gates, the season and rate-season-straddle
labels, and the worst-first ordering.

The forward-looking **What-If / EV** cards (`ShiftOptimizer`, `EvScenarioCard`,
`lib/touShift.ts`, `lib/evScenario.ts`) are untouched and remain separately
labelled; no number they print is merged into Hindsight.

## The numbers on Mark's real files (local build, `112/112` checks)

| | 2-year export (24 bills) | 3-month export (3 bills) |
| --- | --- | --- |
| headline (staying put vs the cheapest of the other two, same readings) | **−$251.89** — the alternatives would have cost more | −$33.19 |
| agreement with the switch track record above it | $251.89 = \|−$251.89\| | $33.19 = \|−$33.19\| |
| rows / priced / skipped | 24 / 22 / 2 | 3 / 1 / 2 |
| periods whose alternative was cheaper | 3 — $12.66 of per-period savings (the headline is a NET figure, so the chips are not expected to sum to it) | 0 |
| plan timeline detected | 13 TOU · 11 Tiered | 3 TOU |
| seasons judged | 12 summer · 12 winter · **4 straddling** Nov 1 | 1 summer |
| biggest single-period loss | Sep 25 – Oct 27 (Tiered): $7.60 against the cheapest alternative, on a $234.11 bill | — (none positive) |
| skip reasons printed | "readings cover 20 of 30 days (67%, 90% needed)" · "no readings in this browser fall inside this period" | "readings cover 21 of 29 days (72%, 90% needed)" · "no readings in this browser fall inside this period" |

`sha256` of both files is pinned inside the JSON; neither enters the repo.

**Where they live on this box** (so the next wave does not have to hunt): both are in the
`pm` profile's document cache — the 2-year export is
`~/.hermes/profiles/pm/cache/documents/doc_3d4f339925bf_oakvillehydro_Electricity_60_Minute_30-04-2024_06-10-2026.xml`
(6,424,909 bytes, sha256 `e292de50a560f56e…` — the same file the Wave S/T/U write-ups pin) and the
3-month export is
`~/.hermes/profiles/pm/cache/documents/doc_936968b747af_oakvillehydro_Electricity_60_Minute_01-07-2026_02-10-2026.xml`
(807,118 bytes). Copy them somewhere writable, point `WAVE_V_XML_LONG` / `WAVE_V_XML_SHORT` at the
copies, and delete the copies when done.

## What the browser harness checks (all 112, in the JSON)

`evidence/wave-v-verify.cjs` reads the PAINTED DOM only — it shares no code with
`lib/hindsight.ts`, so agreement between the two is evidence, not a tautology.

- the panel renders in PLANS & TRACK RECORD and nowhere else;
- one row per closed bill (24 / 3), each with the detected-plan badge, the season,
  the period's kWh and a plan chip;
- **exactly one headline figure**, and it equals the audited switch track record's
  number read off the other panel;
- **the scope correction, enforced on the painted panel**: no behaviour chip, no
  move list, no second headline, no lever line, and no hypothetical-usage /
  load-shift wording anywhere; the panel says it compares the same readings;
- a period only ever claims a saving against a plan OTHER than the one it was
  billed under, and never prints a negative "would have saved";
- an unaudited bill carries its reason and no chip; a file with nothing countable
  says so instead of printing a number;
- no raw key, `undefined`, `NaN` or `{placeholder}` leaks into the panel;
- summer bills, winter bills and the four bills that cross Nov 1 are each
  labelled, and the detected TOU/Tiered timeline reaches the panel;
- worst-first ordering (the callout names the first row, and its amount is the
  figure that row's chip names);
- the headline figure and the plan chip clear AA against their **own painted**
  backgrounds (colours read through a 1×1 canvas — Chrome serialises Tailwind
  v4 colours as `lab()`/`oklch()`, so a `rgb()` regex would silently measure the
  card behind the chip): 13.71:1 headline, 5.91:1 chip (desktop-long);
- no horizontal overflow at 390 px, and both viewports print identical numbers.

Screenshots (not tracked — see `ASSETS.md`): `wave-v-{desktop,mobile}-{long,short}.png`
(full page), `-panel.png` (the panel), `-headline.png` (the headline figure).

`evidence/wave-v-verification.json` is the SUPERSEDED `9dcd1cd` record: it was
written against the pre-correction surface (two levers, move lists) and is kept
only as history. The live record for this change is
`evidence/wave-v-verification-local.json` (local build, both exports, both
viewports). The deployed re-run follows QA — see below.

## Gates run before the push

| gate | result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run test` | **1576 passed \| 6 skipped** (97 files) |
| `npm run build` | ok |
| `node scripts/i18n-merge.mjs --check` | up to date, 1229 keys (from 1240: −30 behaviour keys, +19 new) |
| `.venv/bin/pytest tests/` | 41 passed |
| `.venv/bin/pytest ops/dmd/tests` | 19 passed, 1 skipped |
| `node evidence/wave-v-verify.cjs` (local build :3939, both real exports, 1440 + 390 px) | **112/112** |
| CI | skipped by convention — Actions billing dead; the local battery is the gate |

## Re-running

```bash
# the local build (npm run build && npx next start -p 3939):
WAVE_V_XML_LONG=/path/to/2-year-export.xml \
WAVE_V_XML_SHORT=/path/to/3-month-export.xml TZ=America/Toronto \
  WAVE_V_BASE_URL=http://127.0.0.1:3939/ WAVE_V_SUFFIX=-local \
  node evidence/wave-v-verify.cjs

# the deployed stack (after QA gates the merge and the deploy):
WAVE_V_XML_LONG=… WAVE_V_XML_SHORT=… TZ=America/Toronto node evidence/wave-v-verify.cjs
```

## Deploy status

Not deployed by this change: the QA task (`t_fdc11c3f`) gates both the merge and
the deploy, so `10.10.11.110` still serves the pre-correction build and nothing
here claims otherwise.
