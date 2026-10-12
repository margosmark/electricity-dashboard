# Mobile-defect build — D2, D4, D3 (t_c58f1459)

Spec: `ux-fix-spec.md` (t_fcbba376 attachment 231) + soft-dev's verification
corrections on that card. Build branch
`electricity/t_c58f1459-mobile-defects`, three commits in the spec's ship
order (D2 → D4 → D3). Grounded on `main` @ `7fee30d`.

**D1 is deliberately not in this diff.** Its structural fix is settled, but
the colour of the tab strip's rule is @designerbot's open call
(`border-accent` vs `border-b-2 border-edge-muted`) and the card gates it:
three low-risk fixes were not going to wait behind one human decision.

## What changed

| Defect | Fix | Commit |
| --- | --- | --- |
| D2 blue sliver beside the OVERVIEW pill | `TabNav.tsx:97` `gap-1 md:gap-2` → `gap-2 md:gap-3` — the pill's `shadow-hard-blue-3` is a 3px hard offset that ate 4 of the 4px gap; 8 − 3 = 5px of air now | `d859636` |
| D4 projected-bill card under the gesture bar | `globals.css` `body { padding-bottom: env(…) }` → `max(2.5rem, env(safe-area-inset-bottom, 0px))`, comment corrected to 108 image px ÷ DPR 3.0 = **36 CSS px** (the spec's 2.25rem was a zero-clearance no-op) | `01d87ba` |
| D3 chart labels at 390px | `labelFs = 9 × 720 / boxW` (floor 10) on every chart label; **PAD rides with it** (`top: max(22, labelFs + 2)`, `left: max(46, 2 × labelFs + 6)` — correction 2); rate word off the shared baseline onto its own row (3b); band-label gate becomes a width/fit test (3c); `#b91c1c`/`#2563eb` → `var(--bad)`/`var(--info)` (3d) | `6879732` |

## Measured (harness: `node evidence/mobile-defects-verify.cjs`)

33/33 checks pass; full results in `mobile-defects-verification.json`,
screenshots `mobile-defects-*.png` (gitignored — pixels never land on main).

| Check | 390×844 | 427×952 (Mark's device) | 1280×900 |
| --- | --- | --- | --- |
| chart width | 298 px | 335 px | 1128 px |
| compensated `labelFs` (user units) | 22 | 19 | 10 = the pre-change literal |
| tallest/smallest label box | min **10 px** (was 4–5 px) | min **10 px** | min 17 px |
| label boxes intersecting | **0** | **0** | **0** |
| season labels escaping their band | **0** (4 of 5 bands labelled — the 1-bill edge season is narrower than the word) | **0** | **0** |
| pill gap / clearance past the blue shadow | 8 px / **5 px** | 8 px / **5 px** | — |
| body bottom floor | 40 px | 40 px | 40 px |
| projection card at max scroll | ready, bottom 787.9/844 → **56.1 px clear** (bar = 36) | ready, **56.3 px clear** | — |
| horizontal overflow | 0 px | 0 px | 0 px |

The compensation is what makes one code path pass both phone widths: the same
formula resolves to 22 units at 298 px and 19 at 335 px, both landing the type
at ~9 CSS px, while ≥768 px layout floors it at exactly the old literal 10.

## Gates (local battery, no CI — billing-dead workflow)

| Gate | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | 0 errors |
| `npm run lint` (eslint) | 0 problems |
| `npm run test` (vitest, incl. the i18n coverage gate) | **1241 passed / 6 skipped**, 72 files + 1 skipped file, 0 failed |
| `npm run build` (next build, 11 routes) | success |
| playwright full suite vs `next start` (`SMOKE_BASE_URL=…`) | **35 passed / 3 skipped / 0 failed** — skips are the env-gated background-refresh + 2 greenbutton-connect tests, same on baseline |
| playwright `mobile-defects` (new spec, both viewports + desktop) | 3/3 |
| `pytest tests/` · `pytest ops/dmd/tests` | 41 passed · 19 passed, 1 skipped |
| `evidence/mobile-defects-verify.cjs` | 33/33 checks, exit 0 |

One flake seen once while the full suite ran under load: the FOUC timing
assertion in `theme.spec.ts` failed (theme-boot 215 ms vs FCP 160 ms), then
passed 4/4 — 3× isolated + the second full-suite run. `theme-boot.js` and
`<head>` are untouched by this diff; the race is load, not the change.

## Known costs, stated rather than hidden

1. **D4's floor is unconditional** (that is what the spec'd one line is), so a
   document whose content is shorter than the viewport now carries a 40 px
   reserve: measured `scrollHeight − innerHeight` = **40 px at both 1280×900
   and 390×844** on the empty state, where baseline (`env()` = 0 in a browser
   tab) had none. No horizontal cost (0 px). If the reviewer wants that gone,
   scoping the floor to `@media (pointer: coarse)` (phones, i.e. the device
   that has a gesture bar) is a two-line follow-up — it is NOT in this diff
   because the card pins the expression.
2. **3c swaps a bar count for a fit test**, so a band the old `bars >= 3` gate
   dropped now carries its label when the word fits (WaveS's 2-bar Nov–Dec
   winter segment: 110 units wide, word ≈41). Every band the old gate labelled
   still has its label — the spec's one-directional bar — so
   `WaveS.test.tsx`'s `getByText('Winter')` moved to `getAllByText(…)` with
   that reason inline. With Mark's 24-bill data the bands are 1/6/6/6/5 bills
   wide and desktop renders exactly the labels it rendered before.
3. **Two desktop deltas from 3a/3b, both spec'd:** the rate tick's size goes
   9 → 10 user units (it is now driven by the same `labelFs`), and it moves
   from the band labels' baseline to its own row at the bottom of the plot.
   `chartPad(10)` itself is byte-identical to `{22, 16, 30, 46}` — pinned in
   `EfficiencyChart.test.tsx`.

## Re-running

```sh
cd webapp && npm run lint && npm run typecheck && npm run test && npm run build
npx next start -p 3210 &                                  # or any running build
SMOKE_BASE_URL=http://localhost:3210 npx playwright test   # full suite
node evidence/mobile-defects-verify.cjs                    # evidence JSON + PNGs
```
