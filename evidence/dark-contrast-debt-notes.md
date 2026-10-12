# Dark-mode contrast debt at HEAD — t_fbf590fa

Card: `t_fbf590fa` (rides the `t_fcbba376` defects build; parent `t_c58f1459`).
Record: `evidence/dark-contrast-debt.json` (regenerate with
`node evidence/dark-contrast-debt.cjs`, 39 checks / 0 failures).

## What changed

1. **TempBandCard `BAR_FILL` → per-theme tokens.** The ramp is the card's
   temperature AXIS, so it cannot be "left alone because saturated hues read on
   dark": on the dark card three of the seven stops were under the 3:1 graphics
   floor (blue-700 **2.66:1**, blue-600 **3.45:1**, red-700 **2.76:1**). Seven
   new tokens (`--temp-band-1..7`) carry a LIGHT value byte-identical to the
   literals they replace and a DARK value lifted one family step per stop, so
   the hue direction and the step weight survive (the luminance arc still peaks
   at the amber stop).

   | stop | light | light on white | dark | dark on `--card` | was |
   | --- | --- | --- | --- | --- | --- |
   | 1 | `#1d4ed8` | 6.70:1 | `#3b82f6` | **4.85:1** | 2.66:1 |
   | 2 | `#2563eb` | 5.17:1 | `#60a5fa` | **7.02:1** | 3.45:1 |
   | 3 | `#3b82f6` | 3.68:1 | `#93c5fd` | **9.90:1** | 4.85:1 |
   | 4 | `#f59e0b` | 2.15:1 | `#fbbf24` | **10.69:1** | 8.31:1 |
   | 5 | `#f97316` | 2.80:1 | `#fb923c` | **7.89:1** | 6.37:1 |
   | 6 | `#ef4444` | 3.76:1 | `#f87171` | **6.45:1** | 4.74:1 |
   | 7 | `#b91c1c` | 6.47:1 | `#ef4444` | **4.74:1** | 2.76:1 |

   The `¢/kWh` label rides INSIDE each bar in `--card` ink, so the fill is also
   that label's background: the dark ramp clears 4.5:1 for it (the light ramp
   never did — amber is 2.15:1 on white; see "newly measured" below).
   `@media print` re-declares the seven to the light values, or a dark-mode
   print would put the lifted fills on paper.

2. **EfficiencyCard `#b91c1c`/`#2563eb` → `var(--bad)`/`var(--info)`** — landed
   already in the parent build (PR #66, commit 3d) and **verified here**, not
   re-edited. `--bad` 2.76 → 6.45:1 on the dark card, 5.29:1 winter /
   5.13:1 summer band; `--info` 2.66 → 7.02:1, 5.75 / 5.58 on the bands.

   Deviation from the card text, stated plainly: the card said the light values
   stay byte-identical "`#b91c1c`/`#2563eb`", but **`--info` is `#1d4ed8`
   (blue-700) in light**, not `#2563eb` — so the regression line's light ink
   moved one Tailwind step in #66 (2.66:1 on the dark card was the old value;
   light went blue-600 → blue-700, 5.17 → 6.70:1 on white). A strict
   improvement, already shipped, not undone here.

3. **BillProjectionBanner** (pm addendum 1): `text-ink` on both `bg-card`
   mini-cards (light byte-identical — `--ink` and `--accent-ink` are both
   `#000` in light; dark 1.18 → **17.06:1**), caption → `text-accent-ink`
   (dark 1.29 → **10.92:1**; pm's report had 1.31 → 10.83 — the difference is
   only the composited background each measured). **The caption
   is a LIGHT RESTYLE** (slate-600 → black, 3.94 → 10.92:1) and is flagged for
   Mark's sign-off in the merge summary.

4. **ChartView USAGE header row** (pm addendum 2): `min-w-0` on the title group,
   `shrink-0` on the cost block. Two classes; the row's `scrollWidth` exceeds
   its `clientWidth` without them and equals it with them.

## Gate holes closed

- `theme-contrast.spec.ts` no longer uploads the small Green Button sample: it
  loads the **Mark-shaped dashboard** (`tests/e2e/mark-seed.ts`, shared with
  `mobile-defects.spec.ts`), so data-gated cards are in the DOM during the walk.
  `loadFixture` asserts `[data-testid="bill-projection"][data-state="ready"]`,
  so the seed cannot silently hollow out again.
- The thermometer ramp gets its own probe (bar `fill` vs the painted surface):
  DARK asserts every stop ≥ 4.5:1, LIGHT asserts the seven rendered pixels are
  the old literals — byte-identity, measured on the page rather than in the CSS.
- `toolbar-layout.spec.ts` gains the USAGE header row at 1440/1383/1280/1152/
  1024, plus an **anti-furniture check**: the same row with `min-w-0`/`shrink-0`
  removed from the live DOM must FAIL those checks. A sweep row that is green on
  the buggy build is decoration.

## Newly measured — pre-existing, NOT fixed here

Closing the seed hole exposed the real size of the debt. The pinned ledger in
`theme-contrast.spec.ts` enumerates it by `(foreground, background)` pair:

- **DARK: 52 painted pairings under AA, in 13 pairs.** Dominated by the FIXED
  `bg-yellow-400` (`#fdc700`) slab carrying themed ink — 29 sites at 1.5:1 —
  plus the amber-200 sample-data strip (1.19:1), and the light-soft slabs
  emerald-50 / emerald-100 / blue-50 with `--ink`, `--ink-2`, `--ink-4` on them
  (1.01–2.93:1). Two are not slabs at all: a literal emerald accent block, and
  recharts' own legend text (`blue-600`, 3.45:1 on the dark card).
- **LIGHT: 10 pairings, in 7 pairs** — `--ink-3` at 3.0–4.4:1 and `--ink-4` at
  2.4:1 on those same slabs, plus recharts' legend `orange-500` at 2.8:1 on
  white. These predate dark mode entirely.
- **LIGHT ramp**: stops 4 and 5 (amber 2.15:1, orange 2.80:1) are under the 3:1
  graphics floor on a white card. Frozen here by byte-identity; needs a
  light-side decision.

Fixing any of these changes LIGHT rendering too, so it needs a colour call and
Mark's sign-off. Filed as a follow-up card assigned to `designer` (see the card
comment). The ledger is one-sided: a NEW pairing fails the walk, the pinned ones
are named in the repo instead of living in a comment.

## Verification run (this branch)

| gate | result |
| --- | --- |
| `evidence/dark-contrast-debt.cjs` | 39 checks, 0 failures, 12 recorded facts |
| `npx vitest run` | 80 files passed / 1 skipped, 1393 tests passed / 6 skipped |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |
| `playwright theme-contrast` | **5/5** — both walks pinned-clean, projection pairings, both ramp probes |
| `playwright toolbar-layout` | **2/2** — the 15-viewport toolbar sweep + the new USAGE header row |
| `playwright mobile-defects` | **3/3** (33 checks) — the shared seed did not move them |
| `playwright theme` | **7/7** — FOUC guard unaffected |

USAGE header row, post-fix vs the anti-furniture counterfactual (`min-w-0` and
`shrink-0` removed from the live DOM), cost block clip in px:

| width | post-fix | pre-fix (this seed) | pre-fix (pm's `$2,131.93` seed) |
| --- | --- | --- | --- |
| 1440 | 0 | 0 | 38 |
| 1383 | 0 | 0 | 38 |
| 1280 | 0 | 9 | 102 |
| 1152 | 0 | 137 | 230 |
| 1024 | 0 | 265 | 358 |

The Mark-shaped seed's window is the default 7 days, so its cost string is
`$8.63` rather than the `$2,131.93` the addendum's table used — the row has
slack at 1440/1383 either way (title group unchanged at 711px in both states),
and the decisive widths are 1280/1152/1024, which is why the sweep covers all
five.
