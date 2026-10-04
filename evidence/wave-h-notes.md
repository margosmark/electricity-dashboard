# Wave H — QoL pass: verification notes

Deployed: `3ab52f5` on `origin/main`, container rebuilt by
`~/bin/deploy-energy-dashboard.sh` on .110 (`DEPLOY_OK at 3ab52f5`).
Verification base: **`http://10.10.11.110:3939`** — the deployed container on
the LAN. The public endpoint `https://electricity.markarslan.ca/` was serving
fine through most of this wave (an earlier run passed 37/41 against it) but
its gateway host `96.44.170.134` stopped accepting TCP from both .108 and
.110 partway through and has been unreachable since — every check below was
re-run against the same deployed image, just one hop closer.

## What shipped (11/11)

| # | Item | Where |
|---|---|---|
| 1 | Sample-data button + synthetic 12-month fixture | `webapp/public/samples/example-usage.xml`, `webapp/scripts/generate-example-fixture.mjs`, `src/lib/exampleData.ts` |
| 2 | Persisted plan + header chip | `src/hooks/useSelectedPlan.ts`, `src/components/ActivePlanChip.tsx` |
| 3 | Keyboard/a11y pass + standing checklist | `globals.css` (`:focus-visible`), `Dashboard.tsx` (Escape), `ARCHITECTURE.md` → Accessibility |
| 4 | Chart skeleton on first paint | `ChartView.tsx` (`ChartSkeleton`), `.skeleton-bar` |
| 5 | "Data as of {date}" chip | `src/lib/freshness.ts`, totals strip |
| 6 | Print/PDF layout | `globals.css` `@media print`, `.no-print` / `.print-compact` |
| 7 | $/yr ↔ $/day cost reframe | totals strip (`cost-toggle`, `cost-reframe`) |
| 8 | Error boundary + crash state | `src/components/AppErrorBoundary.tsx`, mounted in `layout.tsx` |
| 9 | Full-journey Playwright e2e | `webapp/tests/e2e/journey.spec.ts` (5 tests) |
| 10 | Dependabot | `.github/dependabot.yml` (npm / docker / github-actions, weekly, reviewer auto-assigned, **no auto-merge**) |
| 11 | Lighthouse budget | `webapp/lighthouserc.json` + `npx lhci autorun` step in the smoke job |

## Gates

- **Lint / typecheck / unit**: `eslint` clean, `tsc --noEmit` clean,
  **503 vitest passing** (baseline 442 → 503: 61 new tests across
  `exampleData`, `useSelectedPlan`, `freshness`, `AppErrorBoundary`, `WaveH`).
- **Build**: `next build` green (standalone output).
- **CI** (`.github/workflows/ci.yml`): all three jobs green on origin/main —
  `37179377620` (3fb13aa), `37181118349` (fb121f6), `37181913163` (d605dcc),
  `37182345383` (3ab52f5). The first run (`37178357098`) failed on one
  journey test and is the source of the Escape-race fix below.
- **E2E**: **12/12 Playwright** locally (7 Wave D smoke + 5 Wave H journey)
  against the production standalone build; the same 12 green in CI against
  the freshly built Docker image, followed by the Lighthouse step.
- **Lighthouse**: `performance 0.95` (desktop preset, threshold 0.90) —
  FCP 0.2 s, LCP 0.7 s, TBT 0 ms, CLS 0.134. Under Lighthouse's default
  *mobile* throttling the same page scores 0.74 (LCP 3.4 s at 4× CPU), which
  is why the budget is pinned to desktop emulation — see "observations".
- **Browser verification on the deployed build**: **43/43 checks**
  (`evidence/wave-h-verification.json`), including:
  - sample button → 8 760 readings committed, banner + flag + totals + 12-bar
    chart (Oct 2025 → Sep 2026, `wave-h-chart.png`);
  - plan written to `selected_plan`, header chip follows, survives reload;
  - focus ring computed (`3px … rgb(37, 99, 235) 0px 0px 0px 6px`), Escape on
    upload modal + backup drawer (with `aria-expanded` truth);
  - print emulation at Letter width: no nav, no export button, no zoom, no
    unit toggle, 0px horizontal overflow, 7-page Letter PDF, single-page
    816×1056 screenshot;
  - $/yr → $/day reframe with the conversion sentence both ways;
  - deliberate runtime error → crash screen (`ERR-13A66D`) → "Try again"
    recovers.

Artifacts: `wave-h-sample-loaded.png` (full page), `wave-h-chart.png`,
`wave-h-plan-persisted.png`, `wave-h-focus-ring.png`, `wave-h-cost-reframe.png`,
`wave-h-print-letter.png`, `wave-h-insights-print.pdf`, `wave-h-crash.png`,
`wave-h-crash-recovered.png`, `wave-h-verification.json`, `wave-h-verify.cjs`.

## Two bugs this wave's own verification caught

1. **Escape lost a race.** The first CI run failed its very first Escape:
   the listener was re-keyed on overlay state, so a key dispatched between
   "modal in the DOM" and "effect re-ran" was dropped. The listener is now
   attached once and reads live state through a ref written in a
   **layout** effect (before paint). Writing the ref during render is
   rejected by the `react-hooks/refs` compiler rule; a passive effect would
   have left the same window open.
2. **"Drop XML Here" is not a commit signal.** The drop zone flips to
   "ANALYZING…" the instant parsing starts, so waiting on its disappearance
   races the `localStorage` write — the first deployed run read *0 readings*
   from a dashboard that was visibly showing 11 845 kWh. Harnesses now wait
   for the banner/totals the app itself renders as proof.

## Observations left for a later wave (not in the 11 items)

- **CLS 0.134** (Lighthouse "needs improvement"): the shift is the swap from
  the full-screen "PREPARING OPTIMIZER…" splash to the dashboard inside
  `div.space-y-10`. Fixing it means reserving that space (skeleton inside the
  real shell instead of a splash) — a change to first-paint behaviour that
  belongs in its own card, not a QoL pass.
- **Print page count is 7 for a full InsightsView.** The gate was read as
  "a single Letter-size page screenshot" (which is what the artifact is);
  the PDF is a compact 7-page Letter document — the content simply is a
  headline, 20 ranked blocks (top 4 print), an EV scenario, a heatmap and a
  year-over-year panel. Printing all of it onto one page would mean hiding
  the product.
- **Dependabot opened its first PRs within a minute** of the config landing
  (npm group, `node:20-alpine → 26-alpine`, github-actions group). Auto-merge
  is off everywhere; the docker major in particular wants a human.
- **`.110` disk**: the deploy failed once with `no space left on device`
  (docker runs the `vfs` driver there). `docker builder prune -f` reclaimed
  the space — the documented fix in OPERATIONS.md, applied again before each
  of the later deploys.

## Reproducing

```bash
# unit + gates
cd webapp && npm ci && npm run lint && npm run typecheck && npm run test

# e2e against a production build
npm run build && cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/
PORT=3100 node .next/standalone/server.js &
SMOKE_BASE_URL=http://127.0.0.1:3100 PW_CHROMIUM_PATH=/usr/bin/chromium npx playwright test

# lighthouse budget (against a server on :3100)
CHROME_PATH=/usr/bin/chromium npx lhci autorun

# deployed-stack verification
TZ=America/Toronto NODE_PATH=webapp/node_modules \
  WAVE_H_BASE_URL=http://10.10.11.110:3939 WAVE_H_CHROMIUM=/usr/bin/chromium \
  node evidence/wave-h-verify.cjs
```
