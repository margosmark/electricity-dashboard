# Dark mode — build notes (card t_146bc8e5)

Implements the design spec on card **t_d5d0a86b** (uxbot's comment 119 +
`dark-mode-spec.md`). The spec decided everything; this wave is the mechanical
build plus the verification that it actually landed.

**What shipped:** one attribute (`data-theme` on `<html>`) repaints the whole
app from a CSS custom-property layer. Zero per-site `dark:` variants. A 3-state
Light/Dark/System radiogroup in toolbar row 2, a pre-paint FOUC guard, and a
print rule that always inks the light palette.

---

## 1. The token layer (`src/app/globals.css`)

`:root` declares the light palette as custom properties; `[data-theme='dark']`
redeclares the same names; `@theme inline` surfaces each one as a Tailwind v4
utility (`bg-card`, `text-ink`, `border-edge`, `bg-inv`, `text-accent-yellow`, …)
that resolves through `var()` **at paint time**. Flipping the attribute
therefore repaints every surface that reads a token, with no `dark:` branch
anywhere to drift.

Beyond the spec's table the layer carries the pieces the neobrutalist system
needs to survive a theme flip:

| token | why it exists |
|---|---|
| `--shadow` (+ `shadow-hard-N` utilities) | paint flips `rgba(0,0,0,1)` → `rgba(255,255,255,.12)`, geometry unchanged — the sticker edge stays visible (spec §0 #1) |
| `--inv` / `--inv-ink` / `--inv-ink-2` | the "selected = flipped" chip inverts to a LIGHT chip, so its ink and its muted second line need theme values too |
| `--accent-yellow/-sky/-orange/-emerald` | accent-as-text ON that inverted chip: bright on black in light, dark on the light chip in dark (the same pastel cannot serve both) |
| `--good` / `--bad` / `--info` / `--warn` / `--ulo` | verdict + alert text, each pinned per theme to clear 4.5:1 on `--card` |
| `--good-soft` / `--warn-soft` / `--bad-soft` / `--info-soft` | the tinted verdict/alert slabs, which were `bg-emerald-50`-style one-offs and would otherwise stay light in dark |
| `--ok-bg`/`--ok-ink`, `--err-bg`/`--err-ink` | GreenButtonSync's status pills — background and ink move as a pair (spec §3.5) |
| `--heat-0…4`, `--plan-*`, `--hatch-*`, `--grid`, `--axis`, `--season-*`, `--data-*` | chart furniture: heatmap ramp keeps its hue direction (only the two pale steps swap), plan bands wash at 22% over the card, axes/gridlines tokenised |
| `--anomaly-slab*` | the anomalies slab de-escalates in dark so the best-choice banner keeps the yellow-flood monopoly (spec §3.5) |

`@media print` re-declares **every** token to its light value, for both screen
themes, so ⌘P from dark mode prints paper-white (spec §3.7).

## 2. The toggle (`src/components/ThemeToggle.tsx`, `src/lib/theme.ts`)

`role="radiogroup"` with three `role="radio"` buttons (☀ Light / ☾ Dark / 🖥
System), roving tabindex, arrows/Home/End move the selection, default
**System**, persisted to `localStorage['theme']`, live `matchMedia` follow while
System is selected, `<meta name="theme-color">` updated per theme. Mounted in
toolbar row 2 immediately after `LocaleToggle` (spec §3.1). `storage.ts` is
untouched — `storage.test.ts:244-260` already pins that the `theme` key is not
app data.

## 3. FOUC guard — one deviation, and why

The spec asked for an **inline** `<script>` as the first element of `<head>`.
Two verified blockers made that impossible:

1. the app router does not render a user-authored `<head>` — the inline script
   was dropped from the served HTML entirely (measured against the real build);
2. `src/lib/security.test.tsx` forbids `dangerouslySetInnerHTML` in source,
   which is the only way to inline a script from JSX. That gate is correct.

So the guard ships as `public/theme-boot.js` — dependency-free ES5, no JSX sink
— rendered from `<head>` with `<script src async>` (not `defer`: defer runs
after parsing, which is the flash itself). Measured in the served document at
offset ~1258, `<body>` at ~2330. `colorScheme: "light dark"` in the viewport
metadata is the other half: iOS paints the standalone window from it before any
script runs.

## 4. Gates (all run against a local production build, `next build` + `next start`)

| gate | result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `eslint` (whole webapp) | 0 errors, 0 warnings |
| `vitest run` | **1231 passed**, 6 skipped, 72 files (rebased on `main`, so this includes the new i18n-coverage and sw-cache-version gates) — including the new `src/lib/darkMode.test.ts` token budget (every text pairing ≥4.5:1 and every border/chart pairing ≥3:1, both themes) |
| `npx playwright test` (production build) | **32 passed, 3 skipped, 0 failed** — theme FOUC (7), the new painted-page contrast walk (2), the toolbar-layout gate (90 measurements across 15 viewport×height pairs), journey, smoke, import, background-refresh |
| FOUC, all four paths | green: cold dark, cold light (beats an OS that prefers dark), manual override across a reload, System following the OS both ways — plus "the boot script is in `<head>`, `async` not `defer`" and "it finished before first contentful paint" |
| painted-page contrast walk | **DARK: 0 pairings under AA across all four tabs.** LIGHT: 0 new ones — only the pre-existing `--ink-4` micro-label defect (2.45–2.56:1), pinned by token so it cannot widen |
| `evidence/dark-mode-verify.cjs` | **39/39** — token paint in both themes at 1440 and 390, `<meta theme-color>`, hard-shadow paint, radiogroup semantics, keyboard arrows, persistence, and print-from-dark rendering the light palette |
| `scripts/mobile-audit.cjs` (390x844 + 360x800, 5 states each) | **CLS 0.0000, 0 shifts, 0 document overflow** everywhere; the only sub-44px target is the pre-existing `sr-only` JSON-import input (present on `origin/main` too) |
| Lighthouse **desktop** | performance **1.0**, accessibility **1.0**, best-practices 1.0, seo 1.0 (gate ≥0.90) |
| Lighthouse **mobile** | accessibility **1.0**, CLS 0, best-practices 0.96, performance **0.86** — gate ≥0.85 met on the rebased build. The same build measured 0.80 / 0.83 / 0.89 across four runs and today's deployed `main` measured 0.84, so the metric is noise-dominated on this box (LCP 3.0–3.8s, TBT 160–430ms under 4× simulated CPU). Nothing in this change touches the render path — the guard is a 1.3KB async script and the palette is `var()` indirection. |


## 5. Deviations from the spec, and the reason for each

| spec said | shipped | why |
|---|---|---|
| inline FOUC `<script>` in `<head>` | `public/theme-boot.js` + `<script src async>` | §3 above — the inline form never reached the served HTML and cannot be written without tripping the security gate |
| replacement map: `border-black`/`text-black`/`bg-white`/slate/yellow | done, plus an **alert-token pass** the map did not enumerate | the map did not cover coloured text (`text-red-600`, `text-blue-700`, `bg-emerald-50` pills, TOU rate hues). On a dark card blue-700 is 2.66:1 and red-600 is 3.7:1 — unreadable. They are now `--info`/`--warn`/`--good`/`--bad`/`--ulo` + their soft slabs, every pairing measured by the budget test |
| `--bad` = red-600 (4.83:1) | `--bad` = **red-700** in light | red-600 on its own soft slab is 4.41:1 — under AA by 0.09. red-700 clears 5.9:1 on the slab and 6.1:1 on the card, and keeps "red is one step darker than green" |
| toolbar card `shadow-xl` → `shadow-hard-8` | done | spec §3.2 — while the row was being re-measured anyway |
| — | fixed-slab ink rule, applied app-wide | `bg-yellow-400`/`bg-emerald-400`/`bg-red-400`/`bg-purple-200` slabs do not flip, so their ink must not either: they now carry `text-accent-ink` (#000 both themes) or literal `text-white` on the dark slabs (`bg-blue-600`, `bg-red-600`). Without this, dark paints near-white `--ink` on yellow at 1.5:1 — found by the DOM walk below, not by the spec |
| toggle labels at `md:text-xs` | `text-[10px]` at every width, 8px side padding | row 2 is billing-day + plan switcher + locale + theme + the floor button; at 12px labels the group is 266px and the floor button has to wrap, which opens a 45,936px² dead band — 936px² over the toolbar gate. 10px labels match the plan switcher's own chip grammar and keep all five on one line from 1279px up |
| — | `lg:min-w-max` on the floor button; `xl:gap-8` removed | the same measurement: the button must never shrink below what it prints (its annual number), so when the row cannot hold it, flex-wrap gives it a line of its own instead of truncating |
| — | `BestChoiceBanner`'s small window line: `--ink-4` → black | it sat on the yellow flood at 2.2:1 (light) / 2.0:1 (dark). On a surface that loud the second line steps down in size, not contrast |

## 6. Screenshots and harnesses

- `evidence/dark-mode-verify.cjs` — the token-paint / toggle / print /
  persistence checks, 39 assertions; writes
  `evidence/dark-mode-verification[-local].json` and the four screenshots.
- `evidence/dark-mode-*.png` — 1440×900 and 390×844 in both themes, plus
  print-from-dark. Pixels live on the `evidence-assets` branch (main tracks
  JSON + notes only — see `evidence/ASSETS.md`); the mobile-audit
  screenshots are under `evidence/dark-mode-mobile-audit/`.
- `webapp/tests/e2e/theme.spec.ts` — the FOUC guard, 7 tests.
- `webapp/tests/e2e/theme-contrast.spec.ts` — the painted-page contrast walk
  (§4): every visible text node, every tab, both themes.

## 7. What is deliberately NOT changed

- The heatmap ramp keeps its hue direction and its yellow/orange/red steps
  (spec §0 #6) — only blue-300 and slate-100 swap.
- The focus ring (3px white + 6px blue halo) is untouched — it wins on every
  chip in both themes and `WaveH.test.tsx:412` pins its exact values.
- `text-ink-4`'s light-mode 2.56:1 micro-label defect (56 sites) — out of scope
  by the spec's §2 #4, pinned in `darkMode.test.ts` and in the light contrast
  walk so it can neither widen nor hide.
- The manifest's `background_color` still says `#f8fafc`: a manifest cannot
  follow the theme, so a cold PWA start can flash light. Accepted platform
  limitation (spec §3.8) — no service-worker splash hack.
- Remaining soft shadows (`shadow-xl` on the totals strip, EfficiencyCard,
  TempBandCard, the best-choice receipt) — pre-existing light-mode design
  choices; converting them would restyle LIGHT, which is not this card's job.
  In dark they are invisible-but-harmless (a black blur on a navy card).
