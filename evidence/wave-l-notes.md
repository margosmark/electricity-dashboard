# Wave L — real bill data, reconciliation, and two bugs the bill itself found

**What shipped** (all client-side: parse → localStorage → render, zero server
round trips — asserted in `wave-l-verification.json`: 21 GETs, nothing else):

| # | Slice | Where |
|---|---|---|
| 1 | UsageSummary parser (3 periods, 21 line items each, money ÷100,000, measurements, LocalTimeParameters) | `lib/energy.ts` — `parseGreenButtonFeed` / `parseUsageSummaryNodes` |
| 2 | "Your actual bill" panel: per-period itemized view + commodity cross-check + billed-vs-metered kWh | `components/ActualBillPanel.tsx` |
| 3 | True Bill inputs auto-populated from the newest period, with provenance | `TrueBillEstimate.tsx`, `useExtraCharges().applyDerivedIfPristine` |
| 4 | LocalTimeParameters as the dataset's DST source of truth (ESPI `DstRuleType` bitmap decode) | `lib/energy.ts` — `decodeDstRule` / `resolveZone` |
| 5 | Client-only invariant kept | one `XMLParser.parse` per document, results in localStorage |

## The numbers a reviewer should check

From `wave-l-verification.json` — a **fresh browser profile uploading Mark's
real Oakville Hydro export** (the file is never committed):

- 3 periods parsed: `2026-05-25 / 2026-06-23 / 2026-07-22`, 29 days each;
- amounts actually paid per period: **$406.65 · $419.38 · $395.68**;
- commodity cross-check on the fully covered period: our rates estimate
  **$324.99**, Oakville billed **$325.00** → **Δ $0.01** (tolerance $1);
- billed kWh vs our own interval readings: **2,641.66 vs 2,641.59 kWh** (Δ 0.07);
- True Bill pre-filled with no typing: `0.0253 $/kWh + $35.69/mo delivery ·
  0.0056 $/kWh regulatory · 13% HST`;
- estimated vs actual for that period: **$499.80 vs $499.57 → Δ $0.23**;
- two uncovered periods are **skipped, not faked** (`commodity-skip`, no red
  banner) — the readings start 2026-07-02, so May/June cannot be compared;
- no horizontal overflow and every touch target ≥44px on 390x844.

Screens: `wave-l-actual-bill-desktop.png`, `wave-l-true-bill-desktop.png`,
`wave-l-desktop-full.png`, `wave-l-actual-bill-mobile.png`.

Rerun: `WAVE_L_XML=/path/to/export.xml WAVE_L_BASE_URL=http://…:3100/ \
node evidence/wave-l-verify.cjs` → 26/26.

## Finding 1 — the bill's own meter reads are the reconciliation window

ESPI's `billingPeriod` is a coarse stamp (Oakville writes `00:00Z` on the read
date), but the line items carry the reads themselves: `Billing Period -
Previous/Current Read Date`. Reconciling against `billingPeriod` put ~33 hours
of readings either side of what was billed into the comparison and moved the
estimate **$4.05** off. `billWindow()` now prefers the read dates and falls
back to `billingPeriod` when a file states no reads (every fixture but
Oakville's shape). Covered by `usageSummary.test.ts` ("reads the billed window
off the meter reads…").

## Finding 2 — the TOU classifier ignored the OEB's holiday rule (real bug)

Mark's bill exposed it. For the fully covered period our TOU split was
off −49.96 kWh / mid +25.35 / on +24.54 against Oakville's — i.e. exactly one
day's hours bucketed differently. That day is **Monday 2026-08-03, the Civic
Holiday**: reclassifying it as off-peak drops the split error to **0.07 kWh**
and the cost delta to **$0.01**.

The OEB publishes the rule (oeb.ca → electricity rates): *"No matter which
season, on weekends and holidays the cheapest rates are in effect all day"*,
plus a per-year holiday table and the observation rule (*"If a holiday falls on
a weekend, the next weekday (that is not also a holiday) will have the holiday
prices in effect all day"*). This app never implemented it, so it priced every
holiday like an ordinary weekday.

- `lib/ontarioHolidays.ts` — computes the table for any year (Easter-based Good
  Friday, nth-weekday rules, observation sliding);
- `ontarioHolidays.test.ts` pins 2026 to the OEB's published ten dates;
- `categorizeTOUAt` / `categorizeULOAt` now treat those days like weekends.

This single fix is what turns the reconciliation from **red banner (Δ $4.06)**
into **green (Δ $0.01)**.

## Finding 3 — money scale and itemKind, confirmed from the schema

- `billLastPeriod` is documented as *"hundred-thousandths of the currency"* →
  **÷100,000**, and the three periods' `Total Electricity Charges` sum to
  **$1,365.03** — the figure the 2026-10-07 data audit took off the bill.
- `itemKind` has **no dependable public enumeration**: the OpenADR-published
  Green Button XSD's `LineItem` has no `itemKind` at all, and beckn's open DEG
  table (1–10) contradicts Oakville's own usage (4 on Delivery/Regulatory, 10 on
  priced TOU lines). So the raw code is kept, never mapped, and every grouping
  keys off the verbatim `note`.

## Why the fixture is synthetic

`webapp/tests/fixtures/README.md` is explicit: *the app owner's own Oakville
Hydro export must never enter this repo*. The committed fixture
`usage-summary-synthetic.xml` is therefore hand-generated — but built so its
three periods sum to exactly the audited figures and are self-consistent
(`total = commodity + delivery + regulatory`, HST 13%, rebate −23.5%, delivery
laid out as a real $35.88 + $0.0252/kWh so the amortized split the panel shows
is fitted rather than asserted). The **real** file is used only by
`evidence/wave-l-verify.cjs` at run time.

## Fixed/variable split (slice 2)

Least squares across the periods in hand, refused when it would be noise:
needs ≥3 periods, ≥3% kWh spread, ≤$0.50 max residual. Real Oakville data fits
**$35.70 fixed + $0.0253/kWh, ±$0.20**; the panel says so on the delivery line,
and says `blended` (no invented fixed part) when the fit does not hold.

## DST source of truth (slice 4)

`360E2000` / `B40E2000` decode to *2nd Sunday of March 02:00* and *1st Sunday
of November 02:00* — the rules are read in the offset in force **before** the
change, which is what puts the transitions at 2026-03-08T07:00Z and
2026-11-01T06:00Z (Wave G's synthesized dates, now derived from the file
alone). `resolveZone` handles southern-hemisphere wrap-around windows, a
disabled rule (`0xFFFFFFFF`) and a tzOffset-only feed; `processRawData` uses the
zone for the day bucket, the hour bucket and the TOU/ULO/winter decision — the
money path. `localTimeParameters.test.ts` also proves a foreign regime (EU
last-Sunday March/October) prices differently from a North-American one on the
same offset.

**Boundary, stated plainly:** `dateObj` stays the true instant, and everything
*outside* the cost funnel (chart annotations, anomaly/heatmap weekday accents,
shift-optimizer hours, trend month buckets) still reads the browser's clock.
With an Ontario feed in an Ontario browser those agree exactly; migrating the
rest is a follow-up, not something to hide.

## Gates run locally (CI cannot start jobs — see the card)

| Gate | Result |
|---|---|
| `npm run typecheck` / `npm run lint` | clean |
| `npm run test` | **668 / 668** (41 files) |
| `npm run build` | ok |
| `bash tests/e2e/http_smoke.sh` | ok |
| `npx playwright test` | **20 passed**, 2 skipped (Green Button connect, pre-existing) |
| `npx lhci autorun` (desktop ≥90) | performance **1.00**, CLS 0.002, LCP 683 ms |
| `npx lhci autorun --config=lighthouserc.mobile.json` (≥85, CLS ≤0.1) | performance **0.92**, CLS **0**, LCP 3222 ms |
| `scripts/mobile-audit.cjs` (390 + 360) | **0 states with findings** |
| `evidence/wave-l-verify.cjs` on the real Oakville XML | **26 / 26** |

## Follow-ups deliberately not taken here

- Backups (`lib/backup.ts`) still carry readings/billing-day/charges only —
  schema-versioned, and bumping it would reject existing backups. A restore in
  a *fresh* browser keeps `usage_summaries` untouched (the import writes three
  keys), it simply has no bill to show until the next upload.
- The rest of the app onto the dataset zone (see the boundary above).
- Whether other Ontario utilities' meters follow the same holiday table is now
  testable: upload the file and read `commodity-check`.
