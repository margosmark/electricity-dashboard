# Wave P — plan-type timeline, per-period alternatives, and the audited switch track record

**What shipped** — all five slices:

| # | Slice | Where |
|---|---|---|
| 1 | Plan-type detection per billing period (pure, test-first) | `lib/planTimeline.ts` — `detectPlanType` |
| 2 | User-editable timeline, persisted next to `billing_day`, carried by the backup | `components/PlanTimelineEditor.tsx`, `hooks/usePlanTimeline.ts`, `lib/backup.ts` |
| 3 | Per-period alternative modeling with the rate set in force during the period | `lib/planTimeline.ts` — `modelPeriod` |
| 4 | Switch-decision track record (paid vs modeled vs best saving, audited totals) | `components/SwitchTrackRecord.tsx` — mounted under "Your actual bill" on the Chart tab |
| 5 | Plan-type overlay on Wave O's money chart (banded + labelled periods + table column) | `components/PlanBands.tsx`, `planAnnotations()`, wired in `MoneySection`/`MoneyStackedChart` (#33) |

## The numbers a reviewer should check

From `wave-p-verification.json` — **48/48** on the deployed stack
(`http://dashboard.example.internal:3939`, deploy `dc83ed9`) with Mark's real
**24-period export** (sha256 `e292de50…`, pinned by the script before it
runs anything; the file itself is never committed):

- **24/24 periods fingerprinted from the bill's own charge lines**, sequence
  `TOU×3 · Tiered×5 · TOU×5 · Tiered×6 · TOU×5` — Mark's seasonal switching
  is visible in the data exactly as he said it would be, no input needed;
- evidence is verbatim: `BLOCK 1 - Winter` (note the inconsistent spacing
  Oakville writes) on Tiered periods, `On/Off/Mid Peak-Summer` on TOU ones;
- timeline editor end to end: add → `plan_timeline` in localStorage next to
  `billing_day` → invalid range refused with a message and **nothing
  invalid reaches storage** → edit → remove;
- track record: 24 rows, **22 counted** (modeled AND trusted), **2 honest
  skips** (readings start 2024-10-06, so Aug 2024 has none and Sep 2024
  covers 20/30 days);
- **all 22 modeled rows reproduce their own bill within $1** (max Δ $0.82,
  `Model check ✓` on every one, zero exclusions);
- headline: **$251.89 net saving for staying put** — TOU 11 periods
  $210.25 saved · Tiered 11 periods $41.64 saved. Mark's switch decisions
  were good ones; the tool audited them and confirmed it;
- the audited period: 2026-07-22 Total Electricity Charges **$442.10**,
  paid **$395.68**, alternatives modeled **above** it — Tiered $428.87,
  ULO **$463.67**, saving shown as **−$33.19** (already the cheapest);
- mobile 390×844: no horizontal overflow, 44px touch targets.

Slice 5 (on the money chart): **24 bands behind the 24 bars, in the
detected sequence** `OOOTTTTT OOOOO TTTTTT OOOOO`, each tinted and labelled
TOU/TIERED (text on the chart, plus a **Plan column** in the numbers table
reading `Time-of-Use / Tiered` in the same order) — rendered on both the
dollar and share views, desktop and the 390px phone, no overflow.

Rerun:
`NODE_PATH=$PWD/webapp/node_modules WAVE_P_XML=/path/to/export.xml WAVE_P_BASE_URL=http://dashboard.example.internal:3939/ node evidence/wave-p-verify.cjs` → 48/48.

Screens: `wave-p-timeline-desktop.png`, `wave-p-track-record-desktop.png`,
`wave-p-desktop-full.png`, `wave-p-timeline-mobile.png`,
`wave-p-track-record-mobile.png`, `wave-p-money-bands-desktop.png`,
`wave-p-money-bands-mobile.png`.

## Finding 1 — the 2024-11-01 rate set was carrying 2023-11-01 prices

Before trusting any modeled number, the whole real export was run through
the model offline (`wave-p-groundtruth.json`). 14 periods modeled ~10–12%
high. Every commodity line in the file divides out to the ¢/kWh actually
charged, which made the truth checkable:

| in force | TOU (off/mid/on) | Tiered (t1/t2) | source |
|---|---|---|---|
| 2023-11-01 | 8.7 / 12.2 / 18.2 ✓ | 10.3 / 12.5 ✓ | OEB announcement 2023-10-19 |
| 2024-11-01 | **was 8.7/12.2/18.2 → now 7.6 / 12.2 / 15.8** | **was 10.3/12.5 → now 9.3 / 11.0** | OEB announcement 2024-10-18 |
| 2025-11-01 | 9.8 / 15.7 / 20.3 ✓ | 12.0 / 14.2 ✓ | live OEB page (Wave C parse) |

Also corrected: the 2023-11-01 ULO set (overnight 2.4→2.8, on-peak
24.0→28.6) and 2024-11-01 ULO (weekend 8.7→7.6, on-peak 28.6→28.4).
`src/app/api/rates/route.test.ts` now pins all three sets to their sources,
so this class of bug cannot come back silently. The app's ULO/TOU window
definitions were verified against the same announcements — they were already
exact (overnight 23:00–07:00, ULO on-peak 16:00–21:00, winter/summer TOU
windows, holiday rule).

## Finding 2 — billWindow truncated rate-straddling bills (real bug)

Three of the 24 bills straddle a rate change (Nov 1 / May 1), and Oakville
writes the season boundary as a read pair: "previous → current" then spans
**5–8 days instead of the billed ~31**. `billWindow()` (Wave L) took reads
at face value, so those periods compared ~7 days of readings against a full
bill: commodity modeled ~80% low **while still reporting "full coverage"**,
producing a fake $145 "biggest miss". Reads now win only when their span
matches the billed period within a day (`BILL_WINDOW_TOLERANCE`); otherwise
the coarse `billingPeriod` stamp is used — covered by a new test in
`usageSummary.test.ts` built from the exact straddler shape.

## Finding 3 — the model must earn its totals (trust gate)

`MODEL_TRUST_TOLERANCE = $1`: a row's saving only enters `overpaid`,
`byPlan` and the callouts when re-pricing the plan Mark WAS on reproduces
that bill within a dollar — the same tolerance the commodity cross-check
uses. Rows that miss show `Model check Δ … · excluded from the total` and
stay out of every sum. After Findings 1–2 all 22 covered rows pass; the gate
stays armed for future feeds.

## Finding 4 — the "overnight-heavy, switch to ULO" expectation is wrong

The card brief expected ULO-modeled to be dramatically BELOW the actual for
2026-07. The audited numbers say the opposite: **ULO would have cost
$463.67 vs $395.68 paid (+$68)**. His readings are only 29% overnight
(777.9 of 2,641.6 kWh); the killer is the 16:00–21:00 weekday block —
497 kWh at ULO's 39.1¢ on-peak = ~$194 of that period. ULO never wins on
any of the 22 modeled periods. This is the tool doing its job: the folklore
dies against his own meter.

## CI note

Every GitHub Actions run on every branch (including `main`) since
2026-10-07 16:28 fails in ~1s with **zero steps executed** (runner-side
startup failure; `gh run rerun` reproduces it). Not caused by this PR —
the local gates are the enforceable ones here: `eslint` ✓, `tsc --noEmit` ✓,
`vitest` **762/762** ✓, `next build` ✓, deployed browser check 38/38 ✓.
