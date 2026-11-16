# Truth-in-UI sweep — plan-alternative + EV counters (PR #53) evidence notes

**Landed:** branch `electricity/t_37945e30-truth-in-ui-sweep` @ `6bb7b2f` merged to
main as **`2c822ac`** (PR #53), deployed with `~/bin/deploy-energy-dashboard.sh`
(`DEPLOY_OK at 2c822ac`). Re-based tree was already on current main — origin/main
had not moved past `55fdf27` since the parent card (t_6ee5c407) pushed, so the
merge was a fast no-op rebase-wise; gates re-run locally on the merged tree before
the merge was created.

**Why the fixture is this one.** Every claim this sweep closes is invisible on
billed data. The Green Button Alliance reference sample
(`webapp/tests/fixtures/green-button-alliance-sample.xml`, sha256
`18e54b8b1ebdfa2f249a97ee602362ca95ba8dd0d030cba236c39e945259c7fb`) is a bare
`ElectricPowerUsageSummary`: 216 hourly readings, one summary, **no charge lines
and no rates at all**. `billTotals()` sums it to exactly `$0.00`, which is not a
bill of nothing — it is the absence of a statement, and printing it under a
payment header asserts a number the utility never quoted.

## What each surface now does, on that file

| Surface | Before | Now (EN / FR on screen) |
| --- | --- | --- |
| Your actual bill (Plans tab) | `you paid · 199,563 kWh billed` over a `$0.00` derived from nothing | payable cell `—`, label `no charge lines in this bill` / `aucune ligne de frais dans cette facture`, commodity check `Not compared — this bill states no charge lines…` |
| Switch track record | `Not modeled — …. You paid $0.00.` | `Not modeled — this bill states no charge lines, so there is nothing to compare.` / `Non modélisé — cette facture n'indique aucune ligne de frais, donc rien à comparer.` — no payment line in either language, and the row skips **before** the coverage gate, so nothing is modeled against nothing |
| Plan cards | a 6xl dollar figure with no scope | every card: `commodity only · Jan 1 – Jan 9 on screen` / `électricité seulement · 1 janv – 9 janv à l'écran` |
| EV card (Money tab) | the whole-file baseline labelled `Today` / `vs today`; the peak-exposure `/mo` disclosed nothing in the empty state | `Baseline $22.60` / `Référence $22.60`, `vs baseline` / `vs référence`; both peak-exposure blocks — priced **and** the empty state a car-less household sees first — read `Commodity only — no delivery, regulatory charges or HST. And a run-rate, not a metered month: … from N days of your data.` |

## Verification

`evidence/truth-in-ui-verify.cjs` — **58/58 checks per pass, 174/174 total**, three
passes against the same commit:

| Pass | Base | Viewport | Result |
| --- | --- | --- | --- |
| deployed | `http://dashboard.example.internal:3939/` | 1440×900 | **58/58** (`truth-in-ui-verification.json`) |
| deployed | same | 390×844 | **58/58** (`truth-in-ui-verification-phone.json`) |
| local production build | `http://127.0.0.1:3111/` (`next start` on the merged tree) | 1440×900 | **58/58** (`truth-in-ui-verification-local.json`) |

The local and deployed desktop renders are not merely equivalent, they are
**byte-identical** — all four PNG pairs share a sha256
(`plans-en 4bcc18ffb7cd7496`, `plans-fr fab60b61ca5b9663`, `ev-en f95fdd7e99d20e4f`,
`ev-fr 1230f25993495f1f`), so the container serves exactly what the build
produced. The `-local` PNGs are therefore not committed; the identity is recorded
here and re-checkable with `sha256sum`.

Each pass imports the fixture, then in **both** locales:

- payable is a dash and the label under it carries the no-charge-lines sentence;
- the card prints no `$0.00` / `0,00 $` and never says you paid (`vous avez payé`);
- the commodity check refuses — no mismatch is raised against a zero;
- the track record's skip states the reason, with no payment line in it;
- all three plan cards declare scope and their window is a real date range;
- the EV card prices a comparison once kWh is typed (Baseline/Référence on all
  three plans, never "Today"/"vs today"), the peak exposure declares the run-rate
  basis, and clearing the input drops it to the empty state **where the same
  disclosure is still on screen**;
- no catalog key leaks to the screen (a missing `fr.json` key renders as its own
  key text), and there is no horizontal overflow at that width.

The French pass is not a re-render of English strings: FR boots by seeding the
`oeo_locale` the toggle itself persists (the upload modal covers the toolbar on a
fresh page, which is where the toggle lives), and the toggle is then exercised for
real in both directions — `Grilles ⇄ Plans`, `Coûts ⇄ Money` — with the tab strip
re-labelling live.

## What this card does NOT close

_(the residual this section described is now closed — see the next section.
Keeping the original wording here so the sweep's own record stays intact.)_

> The Money tab's own per-period table (`MoneyStackedChart`'s `money-table`) still
> prints `YOU PAID … $0.00` / `VOUS AVEZ PAYÉ … $0.00` for the same alliance bill —
> the exact shape this sweep closed on the Plans tab, one surface over. It is out of
> this card's scope (the sweep was scoped to the plan-alternative surface and the EV
> card), and it is now its own board card rather than a silent gap. Every pass above
> records the hit in `moneyTabZeroHits` so a future regression there cannot be
> mistaken for this sweep's, and the zero check is deliberately scoped to the EV
> card and the Plans tab rather than the whole Money tab.

## Closed by t_f915a15c — the Money tab's own zeros

`moneyTabZeroHits` is no longer *recorded and ignored*: it is a **check**, and it
must come back empty.

The single hit the recorder used to keep was hiding two more surfaces. Re-running
the gate against the pre-fix deployed build, with the recorder changed to keep
EVERY occurrence, finds **10 hits in EN and 10 in FR**:

| surface | EN | FR |
| --- | --- | --- |
| `money-table` payment column | `YOU PAID … $0.00` | `VOUS AVEZ PAYÉ … $0.00` |
| `money-deltas` baseline column | `TOTAL ELECTRICITY CHARGES $0.00` · `AMOUNT PAID … $0.00` | `TOTAL DES CHARGES D'ÉLECTRICITÉ 0,00 $` · `MONTANT PAYÉ … 0,00 $` |
| `money-waterfall` | `AMOUNT DUE $0.00 over 28 days · the same figure the bill panel prints` + the `COMMODITY → SUBTOTAL → AMOUNT DUE` steps (7 hits) | same shape (8 hits) |

Three surfaces, one predicate: `summaryStatesMoney(summary)` — a bill whose lines
state amounts keeps its figure (including a genuine `$0.00`), a bill that states
nothing gets a dash and the sentence the Plans tab already uses
(`actualBill.noChargeLines` — "no charge lines in this bill" / "aucune ligne de
frais dans cette facture"). The waterfall's existing
`moneyViz.waterfallNoCharges` reason ("This period states no charges.") is now
what its empty state shows for that bill instead of a derived amount-due.

Against the fixed build the same two checks PASS in both locales, at both
1440x900 and 390x844: `truth-in-ui-verification-local.json` and
`truth-in-ui-verification-phone-local.json`, **60/60** each, `moneyTabZeroHits: []`.
Re-running the gate against the still-unfixed deployed stack (58/60) is how you
re-prove the check bites.

## Re-running

```
TUI_SHA=<serving commit> TUI_BASE_URL=http://dashboard.example.internal:3939/ \
  TZ=America/Toronto node evidence/truth-in-ui-verify.cjs            # deployed
TUI_SUFFIX=-phone TUI_VIEWPORT=390x844 …                             # phone
TUI_SUFFIX=-local TUI_BASE_URL=http://127.0.0.1:3111/ …              # local build
```

Gates on the merged tree, run locally (GitHub Actions is billing-dead for this
repo — every run fails in 2–8s with the "recent account payments have failed"
annotation): `npm run lint` 0 · `npm run typecheck` 0 ·
`node scripts/i18n-merge.mjs --check` 0 (958 keys) · `npm run test` **1188 passed
/ 6 skipped**, 68 files · `npm run build` 0 (10 routes + proxy, `sw.js` restored
after the prebuild bump) · `pytest tests/ -q` 41 passed.

## Gates for t_f915a15c (the money-zero card), run on its branch

Same CI-equivalent set, on `electricity/t_f915a15c-money-zero-paid` off `7cf9c0b`:
`npm run lint` 0 · `npm run typecheck` 0 ·
`node scripts/i18n-merge.mjs --check` 0 (**959** keys — `money.overlayTotal`) ·
`npm run test` **1197 passed / 6 skipped**, 69 files · `npm run build` 0
(11 routes + proxy, `sw.js` restored) · `pytest -q` **57 passed, 1 skipped**.

Component tests (`TruthInUi.test.tsx`, "Truth in UI — the Money tab") pin both
locales, the `summaryStatesMoney` distinction, the overlay key and the
period-over-period table's columns — 11 new tests, 28 in the file. Revert-proven
in two passes, one per surface pair:

- `git checkout -- webapp/src/components/MoneyStackedChart.tsx` → **6 red**
  (the EN and FR period-table tests, the overlay key's no-charge-lines test, the
  French overlay-key translation test, both whole-section tests); the delta-table
  tests stay green because they pin a different file;
- `git checkout -- webapp/src/lib/moneyViz.ts webapp/src/components/PeriodDeltaTable.tsx`
  → **4 red** (both period-over-period tests, both whole-section tests — the
  waterfall and baseline zeros come back);
- restored → **28/28 green**.

Green under BOTH reverts: a bill whose stated lines sum to a real `$0.00`, and a
priced bill's payment — that behaviour never changed, which is the whole point of
`summaryStatesMoney`. The English overlay key also stays green under its revert
(raw English and its translation read identically); only the French one can catch
that key missing.
