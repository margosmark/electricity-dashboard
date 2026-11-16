# Wave I — mobile experience: verification notes

Viewports under test: **390x844 @3x** (iPhone-ish, the majority in our
analytics) and **360x800 @3x** (the small-Android floor). Every number below
comes from `webapp/scripts/mobile-audit.cjs`, `cls-probe.cjs`, `pwa-check.cjs`
or a raw Lighthouse run — all four are committed and re-runnable:

```bash
node scripts/mobile-audit.cjs <baseURL> <outdir>          # responsive + touch
WAVE_I_XML=<export.xml> node scripts/mobile-audit.cjs …   # same, other dataset
node scripts/cls-probe.cjs <baseURL> <out.json>           # CLS under throttling
node scripts/pwa-check.cjs <baseURL> <out.json>           # installability
```

## 1. What shipped

| # | Scope item | Where |
|---|---|---|
| 1 | Responsive audit 390/360, fix + evidence | `scripts/mobile-audit.cjs`, `evidence/wave-i-audit-{before,after}`, `evidence/wave-i-oakville` |
| 2 | Touch targets ≥44px, no hover-only affordances, safe-area insets | every interactive element; `globals.css` (`.overlay-safe`, `touch-action`), `BackupControls.tsx` (outside-tap) |
| 3 | Form fields ≥16px, scrollable inset-padded modals | `Dashboard.tsx` (dates, billing day), `TrueBillEstimate.tsx`, `MultiFileMerge.tsx` |
| 4 | Mobile Lighthouse ≥0.85 as a real CI budget | `lighthouserc.mobile.json`, `.github/workflows/ci.yml` |
| 5 | CLS on the PREPARING OPTIMIZER swap | `Dashboard.tsx` (keyed shell) |
| 6 | PWA install polish | `layout.tsx` (`viewportFit`, `colorScheme`), `public/icons/icon-maskable-512.png` |

## 2. Responsive + touch audit — before / after

"Before" is the build currently deployed at
`https://electricity.markarslan.ca/` (pre-Wave-I), audited with the *same*
script so the two columns are comparable. "After" is this build. Full JSON in
`evidence/wave-i-audit-{before,after}/audit.json`.

| Check | 390x844 before → after | 360x800 before → after |
|---|---|---|
| States with any finding | **10 → 0** | **10 → 0** |
| Document horizontal overflow (backup drawer open) | **63px → 0** | **93px → 0** |
| Interactive elements < 44×44 (worst state) | **24 → 0** | **24 → 0** |
| Form fields < 16px (worst state) | **7 → 0** | **7 → 0** |
| Upload modal closed by a *tap* on Cancel | true → true | true → true |
| Floor-help modal closed by a *tap* on Close | true → true | true → true |
| Backup drawer closed by Escape | true → true | true → true |
| Backup drawer closed by tapping **outside** it | **false → true** | **false → true** |

Per state (after), all ten combinations of 2 viewports × 5 states report
`docOverflow=0px, contained=0, targets<44=0, inputs<16px=0`.

**`inScrollRegion` is deliberately not zero**: the weekday×hour heatmap is a
600px grid inside an `overflow-x:auto` card with a "Scroll horizontally to see
all hours →" hint (97 elements at 390, 113 at 360 stick out *inside* that
card). That is the intended mobile treatment of a 24-column grid — it does not
scroll the page (`documentElement.scrollWidth === clientWidth`), and the audit
counts it separately so it can never mask a real overflow.

### The two real bugs behind those numbers

1. **The backup drawer scrolled the whole page.** It was
   `absolute left-0 w-[300px]` inside a wrapper that was `relative` at every
   width, so its position followed the toggle — which sits at x≈153 on a phone.
   `153 + 300 = 453` against a 390 (or 360) viewport. Below `md` the wrapper is
   no longer the positioning context, so the drawer anchors to the nav card and
   spans it (`left-0 right-0`); at `md`+ it anchors to the toggle again.
2. **The drawer had no touch path to dismiss.** Escape worked, but a phone has
   no Escape key and there is no backdrop. `pointerdown` outside the drawer now
   closes it — verified by tapping the page title (`outsideTapClosedBackup`).

A third, quieter fix: the nav card's z-index was raised to `z-[200]` so the
drawer, which now drops below that card, can never paint behind the totals strip
(the audit's `occlusion` check reads `elementFromPoint` at each surface's centre
— 0 covered after the fix).

## 3. CLS — the PREPARING OPTIMIZER swap

Wave H recorded 0.134; `cls-probe.cjs` reproduced it deterministically by
forcing the race the stock Lighthouse run only sometimes catches (4x CPU
slowdown, 400 ms RTT, 500 kbps):

```
before: CLS=0.1479 over 1 shift
  div.space-y-10.text-black.relative.font-black.uppercase
    {"x":0,"y":0,"w":358,"h":844} -> {"x":16,"y":131,"w":358,"h":713}
after:  CLS=0.0000 over 0 shifts        (same throttle)
after:  CLS=0.0000 over 0 shifts        (harsher: 6x CPU, 900 ms RTT, 200 kbps)
```

**Cause.** Both branches of the old early return handed React a bare `<div>` at
the same position, so React *reused that node* and patched its className, top
and height in one frame — a whole-page element moving is exactly what layout
shift scores. The two states now carry different `key`s (`"loading"` /
`"ready"`), so React removes the shell and inserts the dashboard instead of
mutating one node: nothing that was on screen moves. The shell itself mirrors
the two cards the dashboard opens with (nav controls + totals strip at their
real padding/border) so the height either side of the swap is close and the
change reads as a load rather than a relayout.

## 4. Lighthouse

Mobile settings are exactly what CI now asserts (`lighthouserc.mobile.json`):
390x844 @3x, `formFactor: mobile`, simulated throttling at rtt 150 ms /
1638 Kbps / 4x CPU. Desktop keeps Wave H's `lighthouserc.json` (1350x940,
rtt 40 ms, ≥0.90).

| Run | Before | After |
|---|---|---|
| **Desktop**, performance | 0.95 (Wave H), 0.95 re-measured here | **1.00** |
| **Mobile 390**, performance, fresh profile | 0.87 / 0.88 / 0.89 | **0.94 / 0.94 / 0.94** |
| **Mobile 390**, performance, 8 760 rows in localStorage | **0.85** (exactly at the line) | **0.92 / 0.94 / 0.95** |
| Mobile 390, LCP, fresh profile | 3 327–3 512 ms | **3 030–3 049 ms** |
| Mobile 390, total blocking time, fresh profile | 110–146 ms | **62–77 ms** |
| Mobile 390, total blocking time (8 760 rows) | 355 ms | **272–347 ms** |
| Mobile 390, CLS | 0.134–0.152 when the race hit | **0** in every run |

The "8 760 rows in localStorage" column is not a synthetic number either:
`scripts/seed-profile.cjs` points a persistent Chrome profile at the app, loads
the example year through the real parser, and the Lighthouse run then audits
that profile with `--disable-storage-reset` — i.e. the state a returning
installable-PWA user actually lands in, which is where the old 0.85 came from.

`npx lhci autorun` (desktop) and `npx lhci autorun --config=lighthouserc.mobile.json`
both pass locally against the production build.

### The first CI run failed at 0.82 — and that is the useful number

The new mobile step ran green through everything except its own assertion on
the first push: **0.82 against the Docker container on the GitHub runner**
(desktop 1.00 in the same job, CLS 0). Same repo, same config, 0.09 below the
local number — a shared 4-vCPU runner at 4x CPU slowdown, and Lighthouse's
simulated LCP broke down as **TTFB 453 ms (14%) / Render Delay 2 864 ms
(86%)**, i.e. the bottleneck was never the network: it was download + parse +
execute of the first-load JS before React could commit the upload modal.

That turned three things into measurable work instead of guesses:

1. **`date-fns` `format()` in the hot path** — it re-parses its pattern on
   *every* call and the pipeline issued ~35 000 of them per cold load.
   Head-to-head on the same host, same session, 8 760 readings
   (`HEAD:energy.ts` → Wave I):

   | Step | Before | After |
   |---|---|---|
   | `processRawData` | 41.2 ms | **22.6 ms** (−45%) |
   | `buildActiveChartData` | 26.4 ms | **5.0 ms** (−81%) |
   | `calculateFullDataTotals` | 20.3 ms | **5.0 ms** (−75%) |
   | **Cold-load pipeline (excl. XML parse)** | **121.8 ms** | **60.9 ms** (−50%) |

   Six local helpers (`fmtDay`, `fmtHour`, `fmtMonthKey`, `fmtMonthLabel`,
   `fmtDayLabel`, `mondayOf`) build byte-identical strings with arithmetic in
   local time, plus a per-day cache for the bucket label/key and one for the
   rate schedule. All 515 unit tests — including the whole `energy.test.ts`
   suite — still pass, which is the regression guard on the strings.

2. **Recharts off the first visit.** Lighthouse's own `unused-javascript`
   audit named it: the vendor chunk was **74.7% unused (141 KB of 190 KB)**
   on a first visit, whose chart area is the "no readings in this window"
   panel. Both Recharts entry points now sit behind `next/dynamic` —
   `ChartView`'s bars (`BarChartPanel`, rendered only when there is at least
   one bar) and the Insights tab's trend chart (`YearOverYearPanel`). The
   first alone changed nothing (the trend chart still imported Recharts
   statically, so Turbopack kept the chunk in the page's script list); with
   both split, **initial JS dropped 1 212 KB → 849 KB (−30%)**, TBT
   110–146 → **62–77 ms**, LCP 3 330 → **3 030 ms**.

3. **The upload modal stopped waiting for `/api/rates`.** `init()` used to
   `await fetch("/api/rates")` before touching localStorage, so the first
   large paint (the modal's paragraph — Lighthouse's LCP element) could not
   exist until a network round trip had answered. localStorage now runs
   first; with no readings the shell is left *before* the fetch, because the
   rate schedule has nothing to price. With readings it still waits, so a
   plan card can never paint a price computed from an empty rate set.

The re-run after those three fixes passed, and CI now prints the numbers on
every green run instead of hiding them behind an opaque check:

```
mobile performance 0.89 | CLS 0 | LCP 3080 ms | TBT 259 ms   (GitHub runner)
```

`gh pr checks` on the merged PR: **3/3 jobs pass** — Frontend (lint, typecheck,
515 tests, build), E2E Smoke (Docker boot, HTTP, Playwright 12/12, desktop
budget, mobile budget), Python.

What was *rejected* after measuring: deferring the Insights-only computations
(anomalies, heatmap, ToU-shift, verification) to first open of the Insights tab
saves **11 ms** of the 122 ms — not worth the added statefulness. Splitting
`fast-xml-parser` out of the initial bundle saves parse work that only happens
on an upload (178 ms, off the cold-load path). Both stay as-is.

**Honest residual.** The budget is **0.85** and the local ceiling is now 0.94
on a fresh profile (0.92–0.95 with a year of data) — 0.09 of headroom measured
over three consecutive runs each, instead of the 0.00 the first CI run showed.
No assertion was weakened: the desktop budget is untouched at 0.90 and the
mobile one is new. Runner variance is the one thing the budget cannot
control: the *pre-optimisation* build scored 0.89 locally and 0.82 on the
shared runner, so the CI number is re-checked on every push rather than
treated as a constant.

## 5. PWA install experience

`scripts/pwa-check.cjs` → `evidence/wave-i-pwa.json`: **25/25 passed.**
It decodes the PNGs (IHDR *and* the real pixel data) rather than trusting
filenames, and checks the one thing maskable icons are graded on — artwork
inside the circle that is 80% of the icon's diameter:

- `icon-maskable-512.png` before: artwork bbox x 168–458, y 134–492 — the bolt's
  tips ran to 96% of the height and 89% of the width, off-centre. A circular
  mask clipped them.
- after: bbox x 131–380, y 101–409 → **half-diagonal 198.0 px vs a 204.8 px safe
  radius, centre offset (−0.5, −1.0) px**, on the same full-bleed `#facc15`
  background.

Also verified: `display: standalone`, `start_url`/`scope`/`id`, theme colour
`#facc15` in both the manifest and `<meta name="theme-color">`, 192 + 512 `any`
icons whose pixels match their `sizes` claim, `apple-touch-icon`,
`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
`viewport-fit=cover` (without it every `env(safe-area-inset-*)` in the app is 0
and the padding is a no-op), `.overlay-safe` resolving real padding, and the
upload modal being `overflow-y: auto` with that padding applied.

## 6. Datasets

Both required datasets were run through the *real* upload path at both
viewports, all five states, zero findings:

| Dataset | Evidence |
|---|---|
| Bundled sample fixture — the synthetic 8 760-reading year (`public/samples/example-usage.xml`, loaded via the app's own "Try with example data" button) | `evidence/wave-i-audit-after/` |
| **Real Oakville Hydro export** — `oakvillehydro_Electricity_60_Minute_01-07-2026_02-10-2026.xml`, 807 KB, 4 368 `IntervalReading`s, uploaded through the modal's file input (`WAVE_I_XML=…`) | `evidence/wave-i-oakville/` |

The real export is **not committed**: the repo's root `.gitignore` has `*.xml`
and it carries a real meter. It lives at the task workspace root as
`oakville-real-export.xml` for this run only; re-point `WAVE_I_XML` at any
Green Button export to repeat the pass.

## 7. Deployed verification

`~/bin/deploy-energy-dashboard.sh` on .110 rebuilt the container from `main` and
reported `DEPLOY_OK at 24f6026`. Everything below was then run against the
**public origin a real phone installs from** — `https://electricity.markarslan.ca`
(200), with the LAN container `http://dashboard.example.internal:3939` as a second check.

| Check | Result |
|---|---|
| `mobile-audit.cjs`, bundled example year, 390x844 + 360x800, 5 states | **0 findings**, CLS 0, all four dismissal paths true → `wave-i-deployed-sample-audit.json` |
| `mobile-audit.cjs`, **real Oakville export**, same 10 runs | **0 findings**, CLS 0, all four dismissal paths true → `wave-i-deployed-oakville-audit.json` |
| `cls-probe.cjs` (4x CPU / 400 ms RTT / 500 kbps) | **CLS 0.0000, 0 shifts** |
| `pwa-check.cjs` | **25/25** → `wave-i-pwa.json` |
| Lighthouse **mobile** 390x844 (the CI config) | **0.92 / 0.98**, LCP 2 462 / 2 467 ms, CLS 0 |
| Lighthouse **desktop** 1350x940 (the Wave H config) | **1.00** |

Screenshots: `wave-i-deployed-390-chart.jpg`, `wave-i-deployed-360-insights.jpg`
(sample year) and `wave-i-deployed-oakville-390-chart.jpg` (real export).

## 8. Gates

- `npm run lint` — clean (the four `scripts/*.cjs` carry an explicit
  `eslint-disable` for `no-require-imports`; they are run by `node`, not bundled)
- `npm run typecheck` (`tsc --noEmit`) — clean
- `npm test` — **515 passed** (31 files)
- `npm run build` — green (standalone output)
- `bash tests/e2e/http_smoke.sh` — OK: `/`, `/api/rates`, manifest, `sw.js`, icons
- `npx playwright test` — **12/12** (7 smoke + 5 journey) against the production
  build
- `npx lhci autorun` (desktop ≥0.90) — pass
- `npx lhci autorun --config=lighthouserc.mobile.json` (mobile ≥0.85, CLS ≤0.1)
  — pass
- `node scripts/pwa-check.cjs` — **25/25**
- **CI on the PR**: 3/3 jobs green (Frontend, E2E Smoke with *both* Lighthouse
  budgets, Python) — mobile **0.89 / CLS 0**, desktop 1.00
- **Deployed**: `DEPLOY_OK at 24f6026`, then the whole audit repeated against
  the public origin — see §7
