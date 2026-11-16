# Wave EV-2 — "when do you charge?" hour anchor + stay-vs-move counterfactual: verification notes

Every number below comes from a command that was actually run in this
worktree (or against the deployed stack) on 2026-10-08. Re-runnable:

```bash
cd webapp
npm ci && npm run lint && npm run typecheck && npm test && npm run build
python3 -m pytest ../tests/ -q                          # 33 passed

npx next start -p 3111 &                                # production build
PW_CHROMIUM_PATH=/usr/bin/chromium SMOKE_BASE_URL=http://127.0.0.1:3111/ npx playwright test
CHROME_PATH=/usr/bin/chromium npx lhci autorun --collect.url=http://127.0.0.1:3111/
CHROME_PATH=/usr/bin/chromium npx lhci autorun --config=lighthouserc.mobile.json --collect.url=http://127.0.0.1:3111/

# deployed stack (ssh hermescomputer '~/bin/deploy-energy-dashboard.sh' first)
cd .. && NODE_PATH=$PWD/webapp/node_modules \
  WAVE_EV_BASE_URL=http://dashboard.example.internal:3939/ \
  WAVE_EV_XML=/path/to/your-oakville-export.xml \
  TZ=America/Toronto node evidence/wave-ev-verify.cjs
```

## 1. What shipped

| # | Scope item | Where |
|---|---|---|
| 1 | Charge-hour **anchor** on the scenario: `chargeHour` + `chargeHourSource` + `currentPlan` inputs; null falls back to the detected block's first hour (reuse the winning candidate rather than asking blind) | `src/lib/evScenario.ts` (`buildEvScenario`) |
| 2 | **±1 h habit-drift band** `anchorBand(19) → [18, 19, 20]`, wrapped at midnight; the kWh are spread across it (a third of nights early, a third on the dot, a third late), never pinned to one clock hour | `anchorBand`, `priceStayHours` (uniform weights) |
| 3 | **Season-aware "today"**, read from the readings' own period charges (`costTOU`/`costULO`/`costTiered`) — each row already carries the season, the day type and the RateSet **its own day** used, so nothing re-derives a window from a static table | `priceStayHours` |
| 4 | **Stay vs move** counterfactual, split into `plan` + `shift` that sum to `total` exactly | `buildChargeMove` |
| 5 | One credit: the three-plan comparison's `currentEvCost` is the same stay rate × dataset days — the two views can never disagree or double-book | `buildEvScenario` + the invariant test |
| 6 | Hour wheel (`ev-charge-hour`) prefilled from the detected block, stay/move panel (`ev-charge-move`), `plan` plumbed from Dashboard's switcher through `InsightsView` | `EvScenarioCard.tsx`, `InsightsView.tsx`, `Dashboard.tsx` |
| 7 | Honest edges: already-overnight (books `$0.00` for the shift and says "you're optimal at this hour"), no readings at the hour (upper bound), no hour and no block (asks on screen, keeps the shipped worst-case fallback) | `chargeMove`, `EvScenarioCard.tsx` |

Tests first: **17 new** (13 in `evScenario.test.ts`, 4 in `EvScenarioCard.test.tsx`) —
winter vs summer rate parity, cadence independence (hourly vs 15-minute feed),
the double-credit invariant, the already-overnight `$0.00` shift, and the
hour-wheel prefill/override behaviour.

## 2. The window audit the brief asked for (and one correction)

**Audited, and still static on purpose** — `overnightRateCents()` and
`worstCaseRateCents()`:

- TOU off-peak is 19:00–07:00 **in both seasons** (plus weekends/holidays), so
  `tou.offPeak` is the correct rate for a charge that lands in 23:00–07:00;
- ULO's overnight window is 23:00–07:00 all year, so `ulo.overnight` is correct;
- on-peak exists in both seasons at the same price, so `worstCaseRateCents` is
  a true upper bound; Tiered has no windows at all.

The number that was **not** safe was the one this wave replaced: the charge's
"today" price was either the detected block's blended rate or each plan's worst
case — never the household's actual charging hour. It is now read per hour, per
season, per day type, from the readings.

**Correction to the brief's premise.** "7 PM is summer Off-Peak but winter
On-Peak" is not right for Time-of-Use: winter on-peak is 07:00–11:00 and
17:00–**19:00**, so **19:00–20:00 is Off-Peak in both seasons** — it is **18:00**
that is winter On-Peak (20.3¢) and summer Mid-Peak (15.7¢). That is exactly why
the ±1 h band matters: the band's blend moves from **12.30¢ (winter) to 11.20¢
(summer)** for the identical anchor, while a single-hour model at 19:00 would
show the same number all year and look season-blind.

**Where the user's skew actually comes from is ULO**: 19:00 is weekday
On-Peak (39.1¢) year-round, 16:00–21:00. So on the plan they are moving *to*,
their existing habit is the most expensive kind of hour — which is why the
answer is now split:

```
stay 18:00–21:00 on Time-of-Use   12.30¢/kWh  →  $36.90/mo
move 23:00–07:00 on ULO            3.90¢/kWh  →  $11.70/mo
total $25.20/mo = +$80.49/mo (move the hour) − $55.29/mo (change plan at 19:00)
```

A single "savings" number cannot say that. The shipped card said `−$98.56 vs
today` for the same dataset (worst case 39.1¢); the anchored number is
`−$75.12 vs today`, both asserted in the browser check.

**Design note — why the stay side uses each reading's own RateSet.**
`withChargeOnOvernight = baseline − currentEvCost + overnightEvCost`: the stay
cost is *subtracted from* a baseline that was priced with the rates in force on
each day, so it has to be in the same money. For any feed inside a single rate
schedule (the normal 6–12 month upload) that is identical to today's rates —
all of the synthetic fixtures here are exactly that — and for a multi-year feed
it is what the household actually paid (the real export's 19:00 row blends the
8.7¢, …, 9.8¢ off-peak schedules across three rate sets, and says so per hour).
The move side is always priced at the rate set **in force**, because that is
what they would pay if they switched today.

**Deliberate deviation:** the anchor is *not* a parameter of
`detectEvCandidate`. Detection stays a pure function of the readings — it is
the evidence, and it must not be steered by an answer the household just gave.
The anchor is consumed one step downstream (`buildEvScenario`), which is also
where "your hour is inside the block we found → price the block" lives.

## 3. Every other gate, with numbers

| Gate | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` | **778 passed** (46 files) after rebasing onto main (728 at this branch's own base — +17 from this wave) |
| `npm run build` | pass (Next 16.3.8, 11 routes) |
| `python3 -m pytest tests/ -q` | **33 passed** |
| `npx playwright test` vs the production build | **21 passed, 3 skipped** (the skips are the Green Button shim specs, same as every wave) |
| `npx lhci autorun` (desktop budget ≥ 90) | **performance 1.00**, LCP 690 ms |
| `npx lhci autorun --config=lighthouserc.mobile.json` (≥ 85, CLS ≤ 0.1) | **performance 0.93, CLS 0**, LCP 3 175 ms, TBT 64 ms |
| `node evidence/wave-ev-verify.cjs` | **24/24** |

## 4. The one gate that could not run

**GitHub Actions is still blocked by billing, not by this change.** PR #31's
run `37723328965` failed in 4 s with **zero steps executed**:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased. Please check the 'Billing & plans'
> section in your settings

Every run on `main` and on every open PR looks identical (the last runs before
this wave: `37722942999`, `37717772675`, … all 3–6 s, all three jobs never
started). So CI is **unverified, not red-on-merits**; the `frontend` and
`python` job commands were run locally (table above), and the `smoke` job's
Playwright specs were run against the production build rather than the Docker
container. Fix the account and re-run — the same code is what this table
measured.

## 5. Browser verification — 24/24 on the deployed stack

`evidence/wave-ev-verification.json` (base `http://dashboard.example.internal:3939/`, the
deployed `edge-router`) — screenshots `wave-ev-winter-7pm-desktop.png`,
`wave-ev-winter-7pm-mobile.png`, `wave-ev-oakville-7pm.png`.

**A. Synthetic winter 7 PM fixture** — generated by the script (2026-01-05 →
2026-02-01, 28 days = 20 weekdays + 8 weekend days, no Ontario holiday in the
window, base 0.4 kW plus 3.4 kW at 19:00 and 20:00 — 672 readings, value in Wh,
same shape as `tests/fixtures/synthetic.xml`):

- the wheel starts **unanswered** and `data-source=none` — a 7 PM charge is
  invisible to night detection, so the card asks instead of inventing an hour;
- typing 10 kWh first still refuses: `ev-charge-move-empty` says "Answer When
  do you usually charge? …";
- answering 19:00 renders the comparison: **`12.3¢/kWh → $36.90/mo`** to stay
  (the winter blend — the summer blend `11.2¢ → $33.61` is asserted *absent*),
  `3.9¢/kWh → $11.70/mo` moved, `$25.20/mo better off`;
- split asserted on screen: `+$80.49/mo for moving the hour`,
  `−$55.29/mo for changing plan … never counted twice`;
- three-plan ULO column reads **`−$75.12 vs today`** and the shipped
  assume-overnight number `−$98.56` is asserted **absent**;
- evidence line: `18:00 On-Peak + Off-Peak 17.3¢ · 19:00 Off-Peak 9.8¢ ·
  20:00 Off-Peak 9.8¢`; assumptions say `Winter rates`;
- the plan switcher really drives it: flipping to ULO re-prices the stay side
  to `30.7¢/kWh → $92.19/mo` and the plan half to `+$0.00`;
- fits a 390 px phone (panel width 302 px).

**B. Real Oakville Hydro export** (`oakvillehydro_Electricity_60_Minute_
30-04-2024_06-10-2026.xml`, 6.4 MB, **17 539 readings / 731 days** — never
committed, path passed in): the wheel pre-fills from the block the data really
holds (**22:00**), exactly one of the comparison / "need the hour" states
renders, and the 7 PM counterfactual on the app owner's own data is

> Staying at 18:00–21:00 on Time-of-Use costs **$30.22/mo** (10.1¢/kWh —
> `18:00 Mid-Peak + Off-Peak + On-Peak 12.8¢ · 19:00 Off-Peak 8.7¢ ·
> 20:00 Off-Peak 8.7¢`). Moving the same charge to 23:00–07:00 on Ultra-Low
> Overnight costs **$11.70/mo** — **$18.52/mo** better off
> (`+$63.77` shift, `−$45.26` plan).

`18:00` showing all three windows at once is the season/day-type blend doing
its job on real readings: winter weekdays On-Peak, summer weekdays Mid-Peak,
weekends Off-Peak.

## 6. Privacy

The app owner's own export is passed in by path and **never committed** (the
root `.gitignore` rule stands). The synthetic fixture is generated in-memory by
`wave-ev-verify.cjs` from a fixed calendar — nothing about a real meter is in
the repo.
