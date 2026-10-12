# fr-CA money formatting — one formatter, symbol-free units, a contract

**Card `t_618875d9`.** Wave U translated 165 strings and a later fix (`7ee0375`)
was titled "French money". The deployed fr-CA build still showed:

| # | what a French reader saw | why |
| --- | --- | --- |
| 1 | `1 420,89 $$/AN` on all four plan-cost headlines | `fmtMoney` emits `1 420,89 $`; the unit label beside it was `t('overview.perYear')` = `$/an` |
| 2 | `kWh kWh` ×3 on Plans | the catalog prints the unit (`{kwh} kWh`) and was handed `fmtKwh()`, which prints it too |
| 3 | `11.9¢` beside `3,9 ¢` | an en `toFixed` decimal on the same page as a fr one |

The formatters were already locale-correct. Nothing in the battery could see a
**render site**, so the class came back. That is what this card adds.

## The contract

Two rules, both enforced locally:

1. **A number a person reads is formatted by `@/i18n`.** No `$${n.toFixed(2)}`,
   no `toFixed(1)}¢`, no `toLocaleString('en-CA', …)`. `webapp/scripts/money-contract.mjs`
   walks `src/` with the TypeScript compiler and reports five classes:

   | rule | class |
   | --- | --- |
   | M1 | a hand-built money/cent string |
   | M2 | a pinned numeric locale |
   | M3 | ANY hand-rolled numeric format outside `@/i18n` (`data-*` attributes, an `<input>`'s value and a `Number(…)` rounding cast are exempt) |
   | M4 | a catalog template that prints the unit handed a value that prints it too |
   | M5 | a catalog that keeps the English `${token}` symbol order in French |

   `node scripts/money-contract.mjs` → report + exit 1; `--list` prints the 30
   unit-bearing render sites the sweep pins; `--json` for machines.

2. **A unit that rides next to money is symbol-free.** `moneyPeriodUnit('yr')`
   is `/yr` · `/an`, never the `$/yr` · `$/an` toggle label. And a translated
   sentence puts the dollar sign where its own locale puts it: fr-CA writes
   `0,0252 $/kWh`.

`webapp/src/i18n/money-contract.test.ts` is the gate: formatter invariants for
every money/unit formatter in both locales, the repository sweep, and a
**planted-failure probe per rule** — one scratch file per rule, scanned through
the same code path. That probe earned its keep during this work: a cleanup pass
deleted the M3 block, and the probe went red instead of the sweep silently
reporting a green zero.

`webapp/src/components/MoneyLocale.test.tsx` sweeps the **painted** page — all
four tabs, both locales, over the three-bill open-tail fixture — counting text
nodes for a doubled symbol, a doubled unit and the wrong decimal separator. It
sweeps text nodes rather than `textContent` because a whole-page string glues
neighbouring table cells into a `$` in front of a number nobody sees; the one
cross-node rule is limited to **inline** siblings, which is the exact shape that
painted `1 420,89 $` + `$/AN` as `$$/AN`.

**Revert-watch-flip** (the `fin-tracker` §9 procedure): reverting the
`OverviewPanel` fix fails it with `overview — fr: doubledSymbol × 4` — the four
headlines PM measured; reverting the `PlansPanel` fix fails it in **both**
locales with `plans — {en,fr}: doubledUnit × 1`, which matches PM's note that
the unit duplication is locale-independent.

## The numbers a reviewer should check

`evidence/money-locale-verify.cjs` — **17/17** on the **deployed** stack
(`http://10.10.11.110:3939`, deploy **dd28c61**, the squash of PR #80) and
**17/17** locally at `http://127.0.0.1:3100` → `money-locale-verification.json`
and `money-locale-verification-local.json`. Both runs, read off the rendered DOM:

| check | en | fr |
| --- | --- | --- |
| doubled currency symbol | 0 | **0** |
| money strings with `$` before the number | n/a | **0** |
| doubled unit (`kWh kWh` · `¢ ¢` · `% %`) | 0 | **0** |
| wrong decimal separator (fr dot / en comma) | 0 | **0** |
| **money renders counted** (a sweep that finds nothing is broken) | 363 | **710** |

The counted column is the point of the script: "0 defects" is also what a
sweep that silently stopped working reports, so every leg asserts it found
money first. The fixture is the committed three-bill + open-tail feed, so the
money views have money in them (an unbilled tail included).

## What this card did NOT fix, and who owns it

22 text nodes are still **English on the French page**, all on Plans, 0 on
Overview / Usage / Money — `Off-peak share down 8 pts · $1.80/wk worse than the
prior 7 days`, `Last 7 days (Sep 13 – Sep 19): 59.0% off-peak · $33.58 · …`,
`Requires switching to the ULO plan and moving the load into 23:00–07:00.` and
19 more, listed in the verification JSON.

That is `t_5e0926f1`'s class, and the mechanism is worth stating because it
changes the fix: a clean-mount render under `setLocale('fr')` is already French
(the `MoneyLocale` fr leg proves it), while the same page **after clicking the
toggle** keeps the English text — Wave U's rule 2, a text-producing `useMemo`
missing `t` in its deps. The money inside those strings is en-format *because
the sentence is*, and it is composed with `fmtMoney`/`fmtNumber`, so it turns
French for free once the memo recomputes; there is no second formatter to route.
The full list and the mechanism are recorded in a comment on `t_5e0926f1`.

The verify script reports those nodes in a separate `untranslated` bucket and
excludes them from the money checks — otherwise a French page that is still
English would report as a money-format defect. The `MoneyLocale` vitest leg is
strict (it mounts under the locale, so those nodes are French there).

## Where the pixels live

`evidence/money-locale-{en,fr}-{overview,usage,plans,money}.png` are written by
the script and **not committed** (`.gitignore`: `evidence/**/*.png` — see
`ASSETS.md`). The records are the JSON files above.
