# Wave R — four tabs, the answer unburied, three new graphs

**What shipped** — all four slices:

| # | Slice | Where |
|---|---|---|
| 1 | Four tabs, sticky under the header, ARIA tabs pattern + keyboard | `components/TabNav.tsx`, `hooks/useTabs.ts`, `lib/tabs.ts`; panels `OverviewPanel` / `UsagePanel` / `PlansPanel` / `MoneyPanel` |
| 2 | "Best choice" unburied three ways from one computation | `lib/verdict.ts` → `BestChoiceBanner` (Overview, first element), `BestChoiceChip` (toolbar, every tab, click-to-jump), `VerdictLine` (above the Plans evidence) |
| 3 | Toolbar declutter: only global chrome stays global | rate staleness → Usage, file/GB status → Overview, the CHART/INSIGHTS toggle retired in favour of the tab strip |
| 4 | Three graphs, test-first | `lib/heatmapSplit.ts` + `DualHeatmap`, `lib/billAccrual.ts` + `BillAccrualCurve`, `lib/switchTimeline.ts` + `PlanSwitchTimeline` |

## The numbers a reviewer should check

From `wave-r-verification.json` — **72/72** on the **deployed** stack
(`http://10.10.11.110:3939`, deploy `08f3643`; re-run against the evidence
commit itself, not just the feature commit) with the committed Green
Button Alliance sample (sha256 `18e54b8b1ebdfa2f…`, printed by the script
before it drives anything; pass `WAVE_R_XML` to run it against Mark's real
export instead — that file is never committed):

- **decision-first, proved structurally**: `tab-panel-overview`'s
  `firstElementChild` is `best-choice-banner`, at 1440 **and** at 390;
- **the strip is a real ARIA tablist**: 4 tabs, exactly one
  `aria-selected="true"` (Overview by default), roving tabindex (`0` on the
  active tab, `-1` on the other three);
- **click AND keyboard**: click → `#tab=usage` in the address bar;
  ArrowRight → Plans (state *and* focus move together), End → Money,
  Home → Overview;
- **the chip agrees with the banner** (`data-best-plan` equal) and **jumps to
  the banner from Usage, Plans and Money** — three separate checks, one per
  tab;
- **deep link and Back both work**: `#tab=money` opens Money cold; two tab
  clicks then a real `page.goBack()` returns to the tab that entry opened;
- **the evidence is where it belongs**: Usage shows chart + season chips +
  anomalies + both heatmap grids (**6 rows** weekday = 5 days + header,
  **3 rows** weekend = 2 days + header) + year-over-year; Plans shows the
  verdict line (same plan as the banner), 3 plan cards, shift advice, shift
  verification, the new switch timeline (segments = detected plan) + Wave P's
  editor, track record and the actual-bill panel; Money shows the accrual
  card plus every Wave O panel — money section, stacked composition, period
  deltas, hour histogram, waterfall — and the true bill and EV card;
- **declutter proved by containment**: the file/GB status is inside
  `tab-panel-overview` and **not** inside the toolbar; the rate-staleness
  banner (when a newer OEB set exists) is not in the toolbar either;
- **no sideways scrolling anywhere**: 0 px overflow at 1440 and at 390 on
  all four tabs; every tab is a ≥44×44 px touch target at 390; the weekday
  heatmap grid scrolls inside its own card while the page stays put.

Screenshots: `wave-r-desktop-{overview,usage,plans,money}.png` (1440) and
`wave-r-mobile-{overview,usage,plans,money}.png` (390), taken from the
deployed stack.

## Gates run locally before the push

| Gate | Result |
|---|---|
| `npm run lint` | clean (0 errors, 0 warnings) |
| `npm run typecheck` | clean |
| `npm run test` (vitest) | **961/961**, 58 files |
| `npm run build` | `next build` OK (11 routes, proxy middleware) |
| `bash tests/e2e/http_smoke.sh` | OK — `/`, `/api/rates`, manifest, sw.js, icons |
| `npx playwright test` (against `next start :3100`) | **21 passed, 3 skipped, 0 failed** |
| `npx lhci autorun` (desktop ≥ 0.90) | performance **1.0**, CLS **0** |
| `npx lhci autorun --config=lighthouserc.mobile.json` (≥ 0.85, CLS ≤ 0.1) | performance **0.91**, CLS **0**, LCP 3 202 ms, TBT 171 ms |

New tests: `lib/tabs.test.ts`, `lib/verdict.test.ts`,
`lib/heatmapSplit.test.ts`, `lib/billAccrual.test.ts`,
`lib/switchTimeline.test.ts` and `components/WaveR.test.tsx` (31 — strip
roles/keyboard/persistence/hash/Back, chip jump, declutter containment,
dual heatmap, accrual geometry, switch timeline).

## Honest limitations

- **The accrual curve draws its empty state on the committed fixtures**, not
  its line: `axis.open` only exists when readings run past the last bill, and
  neither the alliance sample (readings sit inside their bills) nor the other
  bundled fixtures have that tail. Mark's real export does — it carries a
  47-day unbilled tail — so the curve is the normal case there. The drawn
  geometry is covered by the component test that parses the SVG and asserts
  every coordinate is finite, the accrual rises monotonically and the pace
  line runs from the origin to a higher endpoint.
- **The alerts bell only renders once a feed is connected**
  (`NotificationToggle` returns null otherwise), so the browser check asserts
  the *slot* — toolbar present, upload inside it — rather than a bell this
  run never authorised.
- **The toolbar wraps to two rows at ≥1024 px**, leaving an empty band at the
  bottom-left of the card (measured: card 1280×289, row 1 = left cluster
  1035×58 at x=108, row 2 = right cluster 585×151 at x=747). This predates
  Wave R — the same two clusters wrapped before — but it reads as dead space
  and is queued as a follow-up rather than folded into this wave.
