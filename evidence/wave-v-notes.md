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

## The numbers on Mark's real files

Byte-identical on the local build and on the **deployed** stack (`112/112` checks
each, both viewports, both exports) — the deployed run is the record in
`evidence/wave-v-verification.json`.

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

## What the browser harness checks (all 112 at the `054d60f` record, 120 from t_97f4c904 on)

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
- **the headline's own sub-line agrees with the headline** (t_97f4c904): a
  negative figure never sits above a "cost you $0.00 more" clause (the old
  `Math.max(0, planMiss)` clamp), and the sub-line names the alternatives'
  difference at that figure's own magnitude — "would have cost you $251.89
  more" under −$251.89;
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

`evidence/wave-v-verification.json` is the **DEPLOYED** record: the same harness
run against `http://dashboard.example.internal:3939/`, `120/120`, `failed: 0`,
`ranAt 2026-10-12T22:12:06.825Z`, and it carries the two pins that make it
attributable — `"base": "http://dashboard.example.internal:3939/"` and
`"deployedCommit": "fe7a5ff91bcb1b97660d6687df8495dd86c73d56"` (this is the
t_97f4c904 fix; the pre-fix `112/112` record for `054d60f` is superseded). The
local-build record is `evidence/wave-v-verification-local.json`. The
pre-correction `9dcd1cd` record (two levers, move lists) is history only.

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

Those are the numbers at the rebased head `3051c7f`. `main` moved a second time
(`695a839`, PR #99) between the rebase and the squash, so the merged commit was
re-gated on its own tree before the deploy:

| gate (at the merged commit `054d60f`) | result |
| --- | --- |
| `npm run lint` / `npm run typecheck` | clean / clean |
| `npm run test` | **1640 passed \| 6 skipped** (101 files passed, 2 skipped) |
| `npm run build` (`GIT_SHA=054d60f…`) | ok — the stamped tree is what the image builds |
| `node scripts/i18n-merge.mjs --check` | up to date, **1256** keys (1229 + 23 from #98/#97 + 4 from #99) |
| `.venv/bin/pytest tests/` / `ops/dmd/tests` | 41 passed / 19 passed, 1 skipped |
| `node evidence/wave-v-verify.cjs` (local build :3939) | **112/112** |

## Re-running

```bash
# the local build (npm run build && npx next start -p 3939):
WAVE_V_XML_LONG=/path/to/2-year-export.xml \
WAVE_V_XML_SHORT=/path/to/3-month-export.xml TZ=America/Toronto \
  WAVE_V_BASE_URL=http://127.0.0.1:3939/ WAVE_V_SUFFIX=-local \
  node evidence/wave-v-verify.cjs

# the deployed stack (no WAVE_V_SUFFIX: it writes the -unsuffixed deployed record):
WAVE_V_XML_LONG=… WAVE_V_XML_SHORT=… TZ=America/Toronto \
  WAVE_V_DEPLOY=$(curl -s http://dashboard.example.internal:3939/api/version | grep -o '[0-9a-f]\{40\}') \
  node evidence/wave-v-verify.cjs
```

## Deploy status

Merged and deployed. PR #93 was rebased onto `origin/main` (`f22e3ef` → `567702e`)
and re-gated, then squash-merged; `main` had moved again to `695a839` by the time
it landed, so the merge commit itself was re-gated (table above) and only then
deployed.

| | |
| --- | --- |
| merged commit = deployed SHA | `054d60fb335e63b0d7d29b081d30f16ec0e29760` |
| deploy | `ssh hermescomputer '~/bin/deploy-energy-dashboard.sh'` → `DEPLOY_OK at 054d60f`, `DEPLOY_SHA=054d60f…` |
| served identity | `GET http://dashboard.example.internal:3939/api/version` → `{"sha":"054d60fb335e63b0d7d29b081d30f16ec0e29760","buildId":"BvEgAjcF6a2v9XfLgSZkp"}` |
| deployed browser re-run | `WAVE_V_XML_LONG=… WAVE_V_XML_SHORT=… TZ=America/Toronto node evidence/wave-v-verify.cjs` → **112/112**, 0 failures, both exports at 1440 px and 390 px |
| builder pruned after the build | `ssh hermescomputer 'docker builder prune -af'` → 1.441 GB reclaimed (the vfs store keeps every layer) |
| export copies | copied from the `pm` document cache to a scratch dir, used, **deleted**; sha256 verified against the pins before use (`e292de50…` long, `6a3f0e14…` short); neither ever entered the repo |

The deployed numbers reproduce the local ones exactly: 2-year file `−$251.89`
(24 rows, 22 priced / 2 skipped, 13 TOU · 11 Tiered, 12 summer · 12 winter ·
4 straddling, worst Sep 25 – Oct 27 at $7.60 on a $234.11 bill), 3-month file
`−$33.19` (3 rows, 1 priced / 2 skipped), and both viewports print identical
figures.

QA's one cosmetic flag — the `headlineNote` sub-line printing `$0.00 more` beside
the negative headline — is untouched by this merge and is left to its own card.

## t_97f4c904 — the sub-line may not contradict the headline

The flag above, fixed. `HindsightPanel.tsx` interpolated the subtitle through
`Math.max(0, planMiss)`, so on a net SAVING — which is what **both** of Mark's
exports are — the clamp decided the copy and the panel printed
"…cost you **$0.00 more**…" under the headline "THE ALTERNATIVES WOULD HAVE COST
MORE −$251.89". The clamp is gone: the figure's own sign picks the sentence, and
the saving one interpolates the unclamped magnitude.

| | en | fr |
| --- | --- | --- |
| net loss (`planMiss > 0`) | `hindsight.headlineNote` — unchanged | unchanged |
| net saving (`planMiss < 0`) | `hindsight.headlineNoteSaved` = "The alternatives would have cost you {plan} more on the very same readings." | "Les autres tarifs vous auraient coûté {plan} de plus, sur exactement les mêmes relevés." |

The sub-line now carries `data-testid="hindsight-headline-note"`.

**Control vs fix — the same harness, the same two exports, 1440 + 390 px:**

| build | harness | painted sub-line (2-year / 3-month) |
| --- | --- | --- |
| DEPLOYED `054d60f` (pre-fix control) | **112/120**, 8 failed — 2 per run, all four runs | "…cost you **$0.00 more** than the cheapest of the other two…" / same |
| local build of the fix (`next start` on `127.0.0.1:3939`) | **120/120**, 0 failed | "The alternatives would have cost you **$251.89 more** on the very same readings." / "$33.19 more" |
| DEPLOYED `fe7a5ff` (the fix, the record) | **120/120**, 0 failed | same sentence, read off the deployed stack |

The failing control run is the defect QA flagged, read verbatim out of the painted
DOM by the new check (`wave-v-verification-control.json`, written to scratch and
**not** tracked — a deliberately red run does not belong in `evidence/`; the
deployed re-run above is the tracked record).

**FR, live on the deployed stack** (the 2-year export, the locale toggle flipped
after the panel painted, probe output in the task's scratch): the headline reads
`LES AUTRES TARIFS AURAIENT COÛTÉ PLUS CHER −251,89 $` above
`Les autres tarifs vous auraient coûté 251,89 $ de plus, sur exactement les mêmes
relevés.` — the fr-CA sentence, composed from the catalog, no English on the page.

`HindsightPanel.test.tsx` pins the same rule at the component: the net-negative
fixture (`peakHouse` — a Tiered bill whose readings only ever run at 08:00, so the
plan the household was on WAS the cheapest), the unchanged loss wording on a
net-positive fixture, and the French sentence composed from the catalog. Swapping
only the copy logic back to the clamped `headlineNote` (testid kept) turns exactly
the two saving pins red and reproduces the shipped sentence byte for byte
("Staying on the plan you were on cost you **$0.00 more** than the cheapest of the
other two, on the very same readings.").

| gate (working tree, `3111cbd` + this change) | result |
| --- | --- |
| `npm run lint` / `npm run typecheck` | clean / clean |
| `npm run test` | **1643 passed \| 6 skipped** (101 files passed, 2 skipped) — +3 pins |
| `npm run build` (`GIT_SHA=3111cbd`) | ok |
| `node scripts/i18n-merge.mjs --check` | up to date, **1257** keys (+1: `hindsight.headlineNoteSaved`, en + fr) |
| `.venv/bin/pytest tests/` / `ops/dmd/tests` | 41 passed / 19 passed, 1 skipped |
| `node evidence/wave-v-verify.cjs` (local build, both exports, 1440 + 390 px) | **120/120** (`wave-v-verification-local.json`) |

`main` did not move between the branch point (`3111cbd`) and the squash, so the
merged commit is that tree: PR #101 → squash `fe7a5ff`.

| | |
| --- | --- |
| merged commit = deployed SHA | `fe7a5ff91bcb1b97660d6687df8495dd86c73d56` |
| deploy | `ssh hermescomputer '~/bin/deploy-energy-dashboard.sh'` → `DEPLOY_OK at fe7a5ff`, `DEPLOY_SHA=fe7a5ff…` |
| served identity | `GET http://dashboard.example.internal:3939/api/version` → `{"sha":"fe7a5ff91bcb1b97660d6687df8495dd86c73d56","buildId":"8zXl19S9MYhSMqeey27kr"}` |
| deployed browser re-run | `120/120`, `failed: 0`, both exports at 1440 px and 390 px (`evidence/wave-v-verification.json`) |
| builder pruned after the build | `ssh hermescomputer 'docker builder prune -af'` → 1.441 GB reclaimed (the vfs store keeps every layer) |
| export copies | taken from the `pm` document cache (the two `oakvillehydro_…60_Minute…xml` files the Wave S/T/U write-ups pin), sha256-verified before use (`e292de50…` long, `6a3f0e14…` short), used, **deleted**; neither ever entered the repo |
