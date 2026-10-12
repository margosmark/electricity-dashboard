# Dark mode — the regression suite (card t_ec06548e)

`7ba18c9` shipped the token layer, `379ce06` lifted the thermometer ramp and
`a06d70d` released the last 13 dark ledger rows — and the contrast debt kept
coming back anyway, because the gates that were supposed to catch it lived in
places nobody runs. This card turns the three dark-mode claims into pins that
run in ONE command on this box (`.github/workflows` is still
`workflow_dispatch`-only, so the Docker smoke job's Playwright step never runs
for anyone).

```
cd webapp && npm run test:theme
```

## What the suite is, and the three holes it closes

| hole | how it hid | the pin |
| --- | --- | --- |
| the toggle → attribute → storage path | verified once, by hand, in `evidence/dark-mode-verify.cjs` — a script CI never runs; nothing else asserted that a CLICK flips `html[data-theme]` | `tests/e2e/theme-toggle.spec.ts` (8) + `src/components/ThemeToggle.test.tsx` (8) |
| the store that writes the attribute | no test file imported `lib/theme.ts` at all — `setTheme`/`apply()` had no pin anywhere | `src/lib/theme.test.ts` (9) |
| the contrast budget's SHAPE | one global "0 failures" number: no coverage proof, no idea which card owed a failure | per-panel budget in `tests/e2e/theme-contrast.spec.ts` |

`theme.spec.ts` (the FOUC guard, 7 tests) is unchanged and still runs: it seeds
`localStorage` directly, which is why it could not see any of the above.

## The measured numbers (this box, production build, `localhost:3111`)

- **unit**: `theme.test.ts` 9 passed, `ThemeToggle.test.tsx` 8 passed.
- **browser**: `theme` 7/7, `theme-toggle` 8/8, `theme-contrast` 5/5 — 20 passed, 0 skipped.
- **budget, both themes**: 32 panel buckets, 3283 text nodes measured per theme.
  - **DARK: 0 pairings under AA** in every panel (the ledger is empty — `a06d70d`).
  - **LIGHT: 98 findings, all pinned** across 19 panels; the debt is still the
    six `(panel, fg, bg)` rows t_fbf590fa filed plus the panel-agnostic
    `--ink-4` token allowance. Worst: 2.43:1 (`--ink-4` on emerald-50 in
    `actual-bill`), against the unchanged 2.4 floor.
- Raw output: `evidence/dark-mode-regression.json` (written by the spec that
  asserts it — not a second, differently-instrumented measurement).

## What "per-panel budget" means here

Three attempts, in order, because the first two were wrong:

1. **nearest `data-testid` ancestor** → 372 buckets. This page carries 372
   distinct testids and most of them are per-row (`money-row`, `bill-line-*`,
   `shift-block-*`), so the "budget" was a list of rows.
2. **nearest testid that occurs exactly once** → still 348 buckets: the
   date-stamped testids (`switch-row-2025-10-01`, `hindsight-period-2026-01-01`,
   `*-pick-*`) make every row unique.
3. **declared roots** (`PANEL_ROOTS`, 29 card testids) → nearest declared root,
   else the enclosing tab panel, else `chrome`. 32 buckets. `PANEL_COVERAGE`
   asserts every declared panel was MEASURED in both themes, which is what makes
   the budget a budget: the coverage assertion fired twice during development
   (it named `tab-panel-overview`/`tab-panel-money`, which are legitimately
   empty) — i.e. it has teeth and it is not furniture.

The ledger key became `(panel, fg, bg)`. That is the ONLY change to the debt
list, it releases no row, moves no threshold (4.5:1 text / 3:1 graphics are
untouched), and it can only tighten: the same colours turning up in a panel
where they were never measured is now a NEW pairing.

## Two things the browser pins found on the way

1. **The empty-state upload modal covers the toolbar.** On a cold visit with no
   data, `[data-testid="upload-modal"]` (role=dialog, `aria-modal`, `z-[300]`,
   `fixed inset-0`) sits over the page — so a mouse click on a theme option is
   swallowed by the backdrop while the keyboard still reaches it. First run:
   the focus+arrow test passed and all four click tests hung for their whole
   30s timeout. The specs now dismiss it with Escape (Dashboard's top-layer
   handler), which is also what a human does. Anyone automating a mouse path
   through the toolbar will hit this.
2. **Clicking System while System is already selected is a no-op.** The default
   mode IS System and `setTheme` returns early when the mode is unchanged, so
   nothing is written to storage. Behaviour is honest (the state is identical)
   and is now pinned in both layers: the unit test asserts the no-op, the e2e
   test leaves System and comes back before asserting the stored `'system'`.

## Evidence that the pins are not furniture

- The per-panel COVERAGE assertion caught two wrong coverage lists (above).
- **Revert-watch-flip-restore, the boot path.** `public/theme-boot.js` was
  temporarily changed to ignore `localStorage` (a no-build sabotage: the file is
  served verbatim, so `next start` picks it up). Result: **5 failed / 15 passed**
  —
  - `theme-toggle.spec.ts` "a choice made through the control is painted before
    first paint on the next visit" (the new persistence pin), and
  - `theme-toggle.spec.ts` "an explicit Light beats an OS that prefers dark — on
    the way in, too", plus
  - `theme.spec.ts` cold-dark / cold-light / "runs before the first frame paints".

  Restored byte-for-byte (`git diff` empty) → **20 passed** again.
- **Revert-watch-flip-restore, the store.** Commenting out
  `root.dataset.theme = resolved` in `src/lib/theme.ts` turned **11 of 17** unit
  pins red (7 store + 4 toggle — every page-side assertion of the flip). Restored
  → 17 passed.

So both halves of the suite fail for the right reason, not because a fixture
moved.

## How to run

```
cd webapp && npm run test:theme           # the whole suite (unit + browser)
E2E_THEME_SKIP_BUILD=1 npm run test:theme # reuse .next for an inner loop
E2E_THEME_BASE=http://localhost:3111 npm run test:theme   # drive a running stack
```

The script builds, boots `next start`, runs the three specs, fails if any spec
SKIPS (a spec that silently skips is the hole this card exists for), writes
`evidence/dark-mode-regression.json`, and kills its own server.
