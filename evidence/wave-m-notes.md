# Wave M — background refresh + plan-switch notifications: verification notes

Every number below comes from a command that was actually run in this
worktree (or against the deployed origin) on 2026-10-07. Re-runnable:

```bash
cd webapp
npm ci && npm run lint && npm run typecheck && npm test && npm run build
python3 -m pytest ../tests/ -q                      # 33 passed

npx next start -p 3100 &                            # production build
bash tests/e2e/http_smoke.sh http://127.0.0.1:3100
SMOKE_BASE_URL=http://127.0.0.1:3100 npx playwright test
npx lhci autorun                                    # desktop budget
npx lhci autorun --config=lighthouserc.mobile.json  # phone budget
npx lhci assert --config=lighthouserc.json
npx lhci assert --config=lighthouserc.mobile.json

scripts/e2e-greenbutton-browser.sh                  # configured shim + mock custodian
cd .. && NODE_PATH=$PWD/webapp/node_modules node evidence/wave-m-verify.cjs
```

## 1. What shipped

| # | Scope item | Where |
|---|---|---|
| 1 | Background refresh loop, Periodic Background Sync + focus/visibility fallback | `src/lib/backgroundRefresh.ts` (`shouldBackgroundRefresh`), `src/lib/periodicSync.ts`, `src/hooks/useDashboard.ts` (one gated entry point + both listeners), `public/sw.js` (`periodicsync` handler) |
| 2 | Plan-switch notification: in-app banner + **optional** Notification, explicit toggle | `src/lib/backgroundRefresh.ts` (`detectPlanChange`, `notificationPayload`), `src/components/RefreshNoticeBanner.tsx`, `src/components/NotificationToggle.tsx`, `src/lib/notifications.ts` |
| 3 | Rate-change detection on refresh | `detectRateChange` / `maxActiveEffectiveDate` + the sky-blue notice |
| 4 | Zero change for manual-DMD-only browsers | the `connected` gate lives inside `buildRefreshNotices`, and the timer/listeners/`periodicSync` are never installed when `status.connected` is false |
| 5 | Tests first | `src/lib/backgroundRefresh.test.ts` (30), `src/components/RefreshNoticeBanner.test.tsx` (13), `tests/e2e/background-refresh.spec.ts` (2) |

## 2. The one gate that could not run

**GitHub Actions is blocked by billing, not by this change.**

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased. Please check the 'Billing & plans'
> section in your settings

Every job on PR #26 — and on `main` — fails in ~2 s with **zero steps
executed**. Last green run: `37530464465` (2026-10-06T20:58Z); every run since
2026-10-06T21:00Z looks identical, including a `gh run rerun`. So CI is
**unverified**, not red-on-merits. Fix the account and re-run; the same code
is what the table below already measured locally.

## 3. Every other gate, with numbers

| Gate | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` | **652 passed** (39 files) — 43 of them new in this wave |
| `npm run build` | pass |
| `python3 -m pytest tests/ -q` | **33 passed** |
| `tests/e2e/http_smoke.sh` vs the production build | OK — `/`, `/api/rates`, manifest, sw.js, icons all 200 |
| `npx playwright test` vs that same unconfigured server | **21 passed, 3 skipped** (the skips are the specs that need a configured shim — exactly what CI's container does) |
| `scripts/e2e-greenbutton-browser.sh` (configured shim + mock custodian) | **BROWSER E2E OK — 4 checks, 24/24 Playwright** |
| Lighthouse desktop | performance **1.00** (budget ≥ 0.90), CLS 0.002, LCP 700 ms, TBT 0 ms, FCP 224 ms |
| Lighthouse mobile | performance **0.93** (budget ≥ 0.85), **CLS 0** (budget ≤ 0.1), LCP 3198 ms, TBT 85 ms, FCP 760 ms |
| `npx lhci assert`, both configs | exit 0 |
| Deploy | `DEPLOY_OK at 4eca137` via `~/bin/deploy-energy-dashboard.sh` on hermescomputer |

Background work did not regress the phone score: **0.93 / CLS 0** against
budgets of 0.85 / 0.1.

## 4. Browser verification

### 4a. Configured stack (the card's full loop)

`scripts/e2e-greenbutton-browser.sh` boots the mock custodian + a configured
`next start` and runs `tests/e2e/background-refresh.spec.ts` against it:

| Claim | Evidence |
|---|---|
| Tab-away → tab-back pulls **exactly once** | request counter on `/greenbutton/usage` polls to `beforePulls + 1` — restoring a window fires `visibilitychange` **and** `focus`, and the throttle is stamped at the start of a pull so the second is refused |
| The switch banner follows the **data** | `page.route` serves a second feed (overnight-heavy → ULO wins; weekday-afternoon when ULO already won → Tiered wins). `data-plan` / `data-previous-plan` asserted on the banner, `data-best-plan` on the totals strip |
| Dismissing sticks | dismiss → banner count 0 → a second refresh → still 0 |
| No prompt, ever | `Notification.requestPermission` spied with `addInitScript`: **0 calls** on load, connect and refresh |
| Manual-DMD-only visitor | `notification-toggle` count 0, `refresh-notice-banner` count 0, 0 prompt calls |

### 4b. Deployed origin

`node evidence/wave-m-verify.cjs` against `https://electricity.markarslan.ca`:

```json
{
  "permission_prompt_calls_on_load": 0,
  "permission_state_after_load": "default",
  "settings_drawer_rendered_for_visitor": false,
  "refresh_notice_banner_rendered": false,
  "sw_serves_periodicsync_handler": true,
  "sw_serves_staged_feed_cache": true,
  "sw_version": "oeo-v1-muyavq86",
  "ok": true
}
```

Screenshot: `evidence/wave-m-deployed.png`. The deployed commit on `.110` is
`4eca137`, and the Wave M notice keys are present in the served JS bundle
(`/_next/static/chunks/1pyzyttc-9fdi.js` contains `wave_m_ack_plan`).

The **connected** half cannot be exercised against production — the shim has
no `GB_CLIENT_ID` there (that is the whole point of the mock-custodian gate),
so it is covered by 4a instead, and labelled as such rather than implied.

## 5. Honest limitations (documented in the code, not just here)

- **Periodic Background Sync is a bonus, not the loop.** Chromium-only, and in
  Chrome only for an app installed to the device and launched as a distinct
  application — *"not available in the context of a regular tab"* (Chrome's own
  docs). `minInterval` is a floor; the real cadence follows the site's
  engagement score. Safari and Firefox do not implement it at all (MDN: not
  Baseline). The focus/visibility fallback is what actually delivers
  freshness everywhere.
- **The service worker cannot merge.** No `localStorage` in a worker, so its
  handler only stages the feed in Cache Storage and messages open windows;
  the merge, the three-plan re-price and the banner all happen in the page.
  A staged feed nobody is looking at is merged the next time a window opens.
- **No email, no SMS.** With no account server the only channels are the
  in-app banner and an on-device notification the user explicitly switched on.
  That tradeoff is printed in the settings drawer where the decision is made;
  a local account server is Wave N's separate product call.
- **A tie is not a change.** The notice is suppressed when the margin rounds
  to `$0.00/mo` — 43 kWh spread across seven years measures a difference that
  is not worth interrupting anyone for.

## 6. One fixture gotcha worth remembering

The shim's `lastSyncAt` is **process-wide** (`let meta` in
`src/lib/greenbutton/session.ts`), and `data-gb-state` reads it. A spec that
pipes a feed therefore leaves every *later* browser's chip claiming `synced`
before its own pull has merged anything — which is how
`greenbutton-connect.spec.ts` first failed against two rows of
`localStorage`. `greenbutton-connect.spec.ts` already disconnects at the end
for this reason; `background-refresh.spec.ts` now does the same in
`afterEach` (its `POST /greenbutton/disconnect` calls `clearSyncMeta()`).
