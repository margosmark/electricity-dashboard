# Lighthouse accessibility 0.87 → 1.0 (t_d5cc9a2d)

Four pre-existing a11y findings, found while gating the toolbar-density pass
(t_7f224ead) and fixed here rather than folded into that diff. Every number
below was measured, not inferred — commands at the bottom.

## Before → after

| Config | Run | performance | **accessibility** | CLS | LCP | TBT |
| --- | --- | --- | --- | --- | --- | --- |
| desktop 1350×940 | pre-fix, local build of `d9e9f2b` components on `:3101` | 1.00 | **0.87** | 0 | 0.72 s | 0 ms |
| desktop 1350×940 | post-fix, deployed `3cc2932` at `http://10.10.11.110:3939/` | 1.00 | **1.00** | 0 | 0.72 s | 0 ms |
| mobile 390×844 @3× | pre-fix, local build of `d9e9f2b` components on `:3101` | 0.91 | **0.87** | 0 | 3.1 s | ~190 ms |
| mobile 390×844 @3× | post-fix, deployed `3cc2932` at `http://10.10.11.110:3939/` | 0.91 | **1.00** | 0 | 3.0 s | 197 ms |

Performance and CLS are unchanged in both configs (the pre-fix desktop
baseline was re-measured in the same environment, so the comparison is
apples-to-apples; the deployed best-practices dips are the LAN origin's
`http://` + a 502 from one resource behind the edge router — unrelated to this
change, and absent when the same build is audited on `127.0.0.1:3100`).

## The four audits

Pre-fix failing nodes, measured on the deployed old build and reproduced on a
local build of the old components (identical in both):

| audit | score | nodes | what axe reported |
| --- | --- | --- | --- |
| `aria-valid-attr-value` | 0 | 1 | `button#tab-overview` — invalid `aria-controls="panel-overview"` (no element with that id) |
| `color-contrast` | 0 | 1 | `span.opacity-40` — "TO", #999999 on white = **2.84:1** at 10 px |
| `label-content-name-mismatch` | 0 | 2 | the TOU and ULO plan buttons — visible text not in the accessible name |
| `label` | 0 | 1 | the upload modal's `input.absolute[type=file]` — no accessible name |

Post-fix: `aria-valid-attr-value` 1, `color-contrast` 1, `label` 1, and
`label-content-name-mismatch` reports **notApplicable** (axe's state when the
rule has nothing to flag), i.e. no violation. Accessibility category **1.00** on
both configs.

## What changed

1. **Tab strip** (`TabNav.tsx` + the four panels): the panels never rendered an
   `id`, so all four `aria-controls` dangled. Only the **selected** tab now
   carries `aria-controls` — the other three panels are not in the DOM, and an
   `aria-controls` naming nothing is exactly what axe dings. The panels carry
   `id="panel-<name>" role="tabpanel" aria-labelledby="tab-<name>"`, so the one
   reference that exists resolves and points back at its tab.
2. **"TO" separator** (`Dashboard.tsx`): `text-[#475569]` (7.02:1 on white)
   instead of `text-black opacity-40` (2.84:1). The hex is literal so the test
   can compute the ratio instead of trusting a palette name.
3. **Plan switcher** (`Dashboard.tsx`): the `Select … plan` aria-label is gone;
   the visible `Tiered`/`TOU`/`ULO` *is* the accessible name, `aria-pressed`
   still carries the state. (Keeping a label meant the label had to contain the
   visible text anyway, and it read worse.)
4. **Upload modal** (`Dashboard.tsx`): `aria-label="Upload Green Button XML"`
   on the file input.

Every fix lands with a test that fails without it — verified by stashing the
six component files and re-running: **8 tests fail** pre-fix (the 4 new gates
plus the 3 plan-name lookups that now use the new names, and the tab-wiring
test), 0 post-fix. New tests live in `WaveH.test.tsx` ("Wave H 3b") and
`WaveR.test.tsx` ("Wave R 1").

Two evidence scripts looked the switcher up by its old aria-label
(`wave-h-verify.cjs`, `wave-ev-verify.cjs`); both now use the visible name.

## Regression net, re-run against the deployed build

```
WAVE_R_BASE_URL=http://10.10.11.110:3939/ NODE_PATH=$PWD/webapp/node_modules \
  node evidence/wave-r-verify.cjs      → 72/72
TOOLBAR_BASE_URL=http://10.10.11.110:3939/ NODE_PATH=$PWD/webapp/node_modules \
  node evidence/toolbar-verify.cjs     → 24/24
```

Local gates: `npm run lint` clean, `npm run typecheck` clean,
`npm run test` **965/965** (was 961 — +4 new), `npm run build` OK (11 routes),
`npx playwright test` **21 passed / 3 skipped** against `next start :3100`.

## Reproducing the Lighthouse numbers

```
# post-fix (deployed)
cd webapp && CHROME_PATH=/usr/bin/chromium npx lhci autorun                      # → lhci-reports/
             CHROME_PATH=/usr/bin/chromium npx lhci autorun \
               --config=lighthouserc.mobile.json                                 # → lhci-reports-mobile/

# pre-fix baseline: same worktree, old components
git checkout d9e9f2b -- src/components/{Dashboard,TabNav,OverviewPanel,UsagePanel,PlansPanel,MoneyPanel}.tsx
npm run build && npx next start -p 3101        # then point a copy of each config at :3101
```

Full report JSONs for all four runs are in `evidence/a11y-lighthouse-summary.json`
(category + audit + metric values, with source report names and fetch times).
