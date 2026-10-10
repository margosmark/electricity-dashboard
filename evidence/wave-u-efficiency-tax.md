# Wave U — Efficiency card honesty: what the ¢/kWh numerator actually contains

**Question (kanban `t_4f100918`, Mark's own)**: "does the avg kWh cost include
all fees?"

**Answer**: no — and the card never said so. The numerator IS the bill's own
**"Total Electricity Charges"** line (commodity + Delivery + Regulatory), and
**HST is a separate line beneath it** on the itemized bill. So the headline
16.3¢/kWh was a *pre-tax* figure published with no label, which is exactly the
ambiguity the owner ran into. Fixed by naming it, and by publishing the
all-in reading beside it.

## What shipped

1. **The subtitle now answers the question where the number is.** Both the
   EFFICIENCY card and the totals strip carry, verbatim:

   > ALL electricity charges (commodity + delivery + regulatory) ÷ billed kWh — tax excluded

   One line, the charges named, the divisor named, the exclusion stated.
2. **The headline is published TWICE, simultaneously** — not a toggle, not a
   hover, nothing to discover. The existing figure is relabelled **excl. tax**
   and a new **incl. tax** figure sits beside it (numerator = Total Electricity
   Charges + that bill's own tax line, same kWh divisor).
3. **Every view gained the same pair**, so no two views of the same bills can
   disagree: all-time, in-view, and the mini-line (each drawn bill carries
   `data-cents` *and* `data-cents-incl-tax` *and* `data-tax`; the range line
   prints both readings at both endpoints).
4. **The footnote quotes the rate the FILE states**, derived as
   Σtax ÷ ΣTotal Electricity Charges — not the 13% Ontario happens to charge.
   It also says the two things these numbers are *not*: water and gas are
   billed separately and never enter a Green Button electricity export, and
   the figures are pre-rebate (the rebate is its own line on the Money tab).

The behaviour/rate/delivery split chips are untouched: they were already
slicing delivery separately, which is consistent, and a tax line is a
**constant multiplier** — it moves every ¢/kWh by the same factor, so it moves
no slope and changes no verdict. The verdict, the regression and the split
all stay on the pre-tax number, and the browser check asserts that.

## How it was checked

`evidence/wave-u-efficiency-tax-audit.py` — a **second parser** (Python
ElementTree over the raw Green Button XML, no webapp code), run against both
of Mark's real exports (never committed; only sha256 lands in the JSON). It
computes, per bill and kWh-weighted:

```
¢/kWh excl. tax = "Total Electricity Charges"          ÷ billed kWh
¢/kWh incl. tax = ("Total Electricity Charges" + HST)  ÷ billed kWh
implied rate    = ΣHST ÷ ΣTotal Electricity Charges
```

Nothing multiplies by 1.13 — each bill's own tax line is used, so a file whose
tax is not 13%, or absent entirely, is reported as it is.

`evidence/wave-u-efficiency-tax-verify.cjs` then asserts the **deployed DOM**
against that audit, twice over, on both exports:

| figure | short export (3 bills) | 2-year export (24 bills) |
|---|---|---|
| Σ Total Electricity Charges | $1,365.03 | $6,114.64 |
| Σ HST | $177.46 | $794.90 |
| Σ billed kWh | 8,083.8 | 37,611.1 |
| **¢/kWh excl. tax** | **16.8860** → 16.9¢ | **16.2575** → 16.3¢ |
| **¢/kWh incl. tax** | **19.0812** → 19.1¢ | **18.3710** → 18.4¢ |
| implied HST rate | 13.0004% | 12.9999% |
| verdict | none (3 bills < the 4-bill trend floor) | **stable**, unchanged |

- **short export**: 41/41 checks (`wave-u-efficiency-tax-verification-local-short.json`)
- **2-year export**: 43/43 checks (`wave-u-efficiency-tax-verification-local-long.json`)

Also pinned by unit tests that fail loudly if either parser drifts:
`src/lib/statistics.test.ts` (Wave U block — subtitle text, per-bill tax
lines, weighted incl-tax mean, the no-tax-line collapse, the derived rate)
and `src/lib/statistics.realdata.test.ts` (the same figures against the real
24-bill export, inert unless `WAVE_S_XML` is set).

## A correction to the task's own expected numbers

The task body predicted the short file would yield "≈16.36¢ excl. tax and
≈18.46¢ incl. tax". **It does not, and no divisor in the file produces those
figures.** $1,365.03 over the file's 8,083.8 billed kWh is 16.886¢; over the
8,063.8 kWh in its metered interval readings it is 16.93¢. 16.36¢ would need
8,344 kWh, which the file does not contain anywhere. The repo's committed test
already pins the same three bills at `data-cents 16.89` on the synthetic
fixture that reproduces this file's arithmetic, so the pre-existing number was
right and the task's estimate was the outlier. The 2-year export *does* match
the task's other expectation exactly (16.3¢ excl. → 18.4¢ incl.). Both figures
above are the arithmetic, unrounded, with no games.

## Files touched

- `webapp/src/lib/statistics.ts` — `PeriodEfficiency.{tax,centsInclTax}`,
  `EfficiencyAverage.{centsInclTax,cost,tax}`, `EFFICIENCY_SUBTITLE`,
  `impliedTaxPct()`, `taxFootnote()`; module header rewritten to state that
  every ¢/kWh here is pre-tax and why both readings are published.
- `webapp/src/components/EfficiencyCard.tsx` — subtitle, the excl/incl pair in
  one headline block, the tax footnote, both readings on every mini-line
  point and at both range endpoints.
- `webapp/src/components/OverviewPanel.tsx` — same subtitle, same pair for
  all-time AND in-view inside the existing totals strip.
- `webapp/src/lib/statistics.test.ts`, `webapp/src/components/WaveS.test.tsx`,
  `webapp/src/lib/statistics.realdata.test.ts` — 14 new tests (6 lib, 6
  component, 2 real-export).
- `evidence/wave-u-efficiency-tax-{audit.py,verify.cjs}` + this file.

## Re-running

```bash
# the second parser alone:
python3 evidence/wave-u-efficiency-tax-audit.py /path/to/export.xml

# the browser check against the deployed stack:
WAVE_U_XML=/path/to/export.xml TZ=America/Toronto WAVE_U_SHA=<commit> \
  node evidence/wave-u-efficiency-tax-verify.cjs

# …or locally against a `next start`:
WAVE_U_XML=/path/to/export.xml WAVE_U_BASE_URL=http://127.0.0.1:3107/ \
  WAVE_U_SUFFIX=-local node evidence/wave-u-efficiency-tax-verify.cjs

# the real-data unit tests:
WAVE_S_XML=/path/to/2-year-export.xml npx vitest run src/lib/statistics.realdata.test.ts
```
