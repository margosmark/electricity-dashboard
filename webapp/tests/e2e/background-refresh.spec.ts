import { test, expect, type Page } from '@playwright/test';

/**
 * Wave M / t_b0d80b86 — the browser half of the background refresh.
 *
 * What only a real browser can prove here:
 *
 *  1. a tab that goes away and comes back triggers exactly ONE pull, even
 *     though restoring a window fires both `visibilitychange` and `focus`;
 *  2. the pull's result actually moves the plan comparison, and the switch
 *     banner appears as a consequence of that refresh;
 *  3. no part of load, connect or refresh ever calls
 *     `Notification.requestPermission()` — the prompt is the settings
 *     drawer's click and nothing else;
 *  4. a browser with no authorisation gets no alert chrome at all.
 *
 * Like `greenbutton-connect.spec.ts` it needs a CONFIGURED shim (the mock
 * custodian booted by `scripts/e2e-greenbutton-browser.sh`); against the
 * production default it skips with that reason, unless GB_E2E_REQUIRED=1
 * says a skip would be a lie.
 *
 * Two seams, both documented in the source they read:
 *   - `window.__GB_BG_MIN_MS` shortens the 15-minute throttle so the gate can
 *     be exercised in a second instead of a quarter hour (the DEFAULT is
 *     pinned by a unit test, so the seam cannot quietly become "no throttle");
 *   - `page.route` on `/greenbutton/usage` serves a second feed whose usage
 *     pattern is deliberately extreme, so "the best plan changed" is a real
 *     consequence of new readings rather than of a stubbed acknowledgement.
 */

/** The throttle the spec installs (ms). Must be > 0 so the second flip is refused. */
const TEST_MIN_INTERVAL_MS = 1500;

/** Two hand-made rows from September 2026 — a browser that already has a
 *  profile. Recent on purpose: the very first DERIVATION runs as soon as the
 *  authorisation lands, and its rate baseline is whatever the data says then.
 *  A 2020 seed would baseline at 2023-11-01, so the October feed would count
 *  as a genuine rate advance (correct behaviour, wrong thing to assert here). */
const SEED = [
  { timestamp: Date.UTC(2026, 8, 1, 5) / 1000, usage_kwh: 4.25 },
  { timestamp: Date.UTC(2026, 8, 1, 6) / 1000, usage_kwh: 3.5 },
];

const HOUR = 3600;

/**
 * An ESPI/Atom feed shaped exactly like `scripts/mock-custodian.mjs` builds
 * one (readings as children of IntervalBlock, entry self-link carrying the
 * UsagePoint — the shape `parseGreenButtonUsagePoints` groups on), but with a
 * usage pattern chosen to make ONE plan win decisively:
 *
 *   `pattern: 'overnight'` → every reading at 02:00 ⇒ ULO's overnight rate
 *                            (4.1¢) beats off-peak TOU (10.2¢) and Tiered.
 *   `pattern: 'weekday-afternoon'` → Mon–Fri 13:00 ⇒ TOU On-Peak (21¢) and
 *                            ULO Mid-Peak (16.1¢) both lose to Tiered.
 *
 * Values are Wh, and a feed with no ReadingType multiplier is scaled by
 * `/1000` (see `scaleReadingValue`), so 5000 ⇒ 5 kWh.
 */
function feed(options: {
  subscriptionUri: string;
  startEpoch: number;
  days: number;
  pattern: 'overnight' | 'weekday-afternoon';
}): string {
  const { subscriptionUri, startEpoch, days, pattern } = options;
  const readings: string[] = [];
  for (let d = 0; d < days; d++) {
    const day = new Date((startEpoch + d * 24 * HOUR) * 1000);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    if (pattern === 'weekday-afternoon' && weekend) continue;
    const hour = pattern === 'overnight' ? 2 : 13;
    const start = Math.floor(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime() / 1000);
    readings.push(
      `        <espi:IntervalReading>\n` +
        `          <espi:timePeriod>\n` +
        `            <espi:start>${start}</espi:start>\n` +
        `            <espi:duration>${HOUR}</espi:duration>\n` +
        `          </espi:timePeriod>\n` +
        `          <espi:value>5000</espi:value>\n` +
        `        </espi:IntervalReading>`,
    );
  }
  const entry =
    `  <entry>\n` +
    `    <title>usage-point-1 IntervalBlock</title>\n` +
    `    <link rel="self" href="${subscriptionUri}/UsagePoint/usage-point-1/MeterReading/meter-reading-1/IntervalBlock/block-1"/>\n` +
    `    <link rel="up" href="${subscriptionUri}/UsagePoint/usage-point-1"/>\n` +
    `    <content type="application/xml">\n` +
    `      <espi:IntervalBlock>\n` +
    `${readings.join('\n')}\n` +
    `      </espi:IntervalBlock>\n` +
    `    </content>\n` +
    `  </entry>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://www.opengis.net/espi/1.0">\n` +
    `  <title>Green Button Customer Energy Usage</title>\n` +
    `  <id>${subscriptionUri}</id>\n` +
    `${entry}\n` +
    `</feed>`
  );
}

/** Count the client's pulls of the piped feed. */
function trackUsagePulls(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/greenbutton/usage') n += 1;
  });
  return { count: () => n };
}

/** Record every `Notification.requestPermission()` the page ever makes. */
async function installPermissionSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __permCalls: number };
    w.__permCalls = 0;
    const target = typeof Notification === 'undefined' ? null : Notification;
    const original = target ? target.requestPermission : null;
    if (target && typeof original === 'function') {
      target.requestPermission = function patched(this: unknown, ...args: unknown[]) {
        w.__permCalls += 1;
        return (original as (...a: unknown[]) => Promise<NotificationPermission>).apply(
          this,
          args,
        );
      };
    }
  });
}

async function permissionCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __permCalls: number }).__permCalls ?? 0,
  );
}

/** Drive `visibilitychange` (hidden → visible) plus the `focus` that follows it. */
async function simulateTabAwayAndBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    // A restored window fires this too — the pair must still be ONE pull.
    window.dispatchEvent(new Event('focus'));
  });
}

/** `data-gb-state` flips to `synced` from the shim's process-wide
 *  `lastSyncAt`, which is stamped BEFORE the browser has merged anything — so
 *  "synced" is not a claim that the readings are in this browser. The
 *  toolbar's "N readings … M new" message IS: it is written only after the
 *  merge commits. Wait on that instead of on the chip. */
async function waitForFeedLanded(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="gb-message"]')).toContainText('new', {
    timeout: 60_000,
  });
}

/** Click through the mock custodian's authorise round trip, back on `/`. */
async function connect(page: Page): Promise<void> {
  await page.getByTestId('gb-connect').click();
  await expect
    .poll(async () => new URL(page.url()).pathname, {
      message: 'the callback never returned to the dashboard',
      timeout: 30_000,
    })
    .toBe('/');
  await expect(page.getByTestId('gb-chip')).toHaveAttribute('data-gb-state', 'synced', {
    timeout: 30_000,
  });
}

test.describe('Wave M background refresh (browser)', () => {
  /**
   * The shim's `lastSyncAt` is PROCESS-WIDE (one in-memory `SyncMeta` for the
   * whole server), and `data-gb-state` reads it. So a spec that pipes a feed
   * leaves every LATER browser's chip claiming `synced` before its own pull
   * has merged anything — which is exactly how `greenbutton-connect.spec.ts`
   * ended up asserting against a two-row localStorage. Disconnecting here
   * calls `clearSyncMeta()` and restores the "fresh browser starts fresh"
   * invariant the rest of the suite relies on.
   */
  test.afterEach(async ({ page }) => {
    await page
      .evaluate(() => fetch('/greenbutton/disconnect', { method: 'POST' }))
      .catch(() => {});
  });

  test('a manual-DMD-only browser gets no alert chrome and no permission prompt', async ({
    page,
  }) => {
    await installPermissionSpy(page);

    await page.goto('/');
    // NOT the gb-chip: against an unconfigured shim (the production default,
    // and CI's container) the control is deliberately not rendered at all.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });

    // Scope 4: nothing new is rendered for a browser that never authorised.
    await expect(page.locator('[data-testid="notification-toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="refresh-notice-banner"]')).toHaveCount(0);
    expect(await permissionCalls(page), 'page load must never prompt').toBe(0);
  });

  test('tab-away → tab-back pulls once, and the switch banner follows the data', async ({
    page,
  }) => {
    test.setTimeout(240_000);

    const status0 = await (await page.request.get('/greenbutton/status')).json();
    if (!status0.configured && process.env.GB_E2E_REQUIRED !== '1') {
      test.skip(
        true,
        'shim is not configured on this server (no GB_CLIENT_ID/GB_CLIENT_SECRET) — ' +
          'run scripts/e2e-greenbutton-browser.sh to gate the background refresh',
      );
    }
    expect(status0.configured, 'GB_E2E_REQUIRED=1 but the shim is unconfigured').toBe(true);

    await installPermissionSpy(page);
    // Shorten ONLY the throttle; the default value is pinned by a unit test.
    await page.addInitScript((ms: number) => {
      (window as unknown as { __GB_BG_MIN_MS: number }).__GB_BG_MIN_MS = ms;
    }, TEST_MIN_INTERVAL_MS);

    const pulls = trackUsagePulls(page);

    // ---- 1. a browser with a profile, then authorise --------------------
    await page.goto('/');
    await page.evaluate((rows) => {
      localStorage.setItem('energy_data', JSON.stringify(rows));
    }, SEED);
    await page.reload();
    await expect(page.getByTestId('gb-chip')).toHaveAttribute('data-gb-state', 'disconnected', {
      timeout: 20_000,
    });
    await connect(page);
    await waitForFeedLanded(page);

    // ---- 2. park the acknowledgement on the current answer --------------
    // Both keys are what the derivation reads: "you are on {best}" and
    // "the last sync said {best} was best", so the banner starts silent and
    // has something to change FROM.
    const beforeBest = await page.getByTestId('totals-strip').getAttribute('data-best-plan');
    expect(beforeBest, 'the totals strip must publish the current winner').toBeTruthy();
    await page.evaluate(
      ({ plan }) => {
        localStorage.setItem('selected_plan', plan);
        localStorage.setItem('wave_m_ack_plan', plan);
      },
      { plan: beforeBest as string },
    );
    // Wait out the load-time pull BEFORE installing the override: if it were
    // still in flight the fetch handler would refuse the flip as "busy" (no
    // request counted) or the route would feed it the second dataset early.
    const loadPull = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/greenbutton/usage',
      { timeout: 60_000 },
    );
    await page.reload();
    await loadPull;
    await expect(page.getByTestId('gb-chip')).toHaveAttribute('data-gb-state', 'synced', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('totals-strip')).toBeVisible({ timeout: 30_000 });
    expect(
      await page.getByTestId('totals-strip').getAttribute('data-best-plan'),
      'reload must not change the answer',
    ).toBe(beforeBest as string);
    await expect(page.locator('[data-testid="refresh-notice-banner"]')).toHaveCount(0);
    expect(await permissionCalls(page), 'load + refresh must never prompt').toBe(0);

    // ---- 3. the next pull returns a feed that makes a different plan win -
    // Started two months back so every timestamp is NEW for this browser
    // (the live feed only covers the last 48 hours) and nothing lands in the
    // future. The pattern is chosen against the current winner: an
    // overnight-heavy dataset lets ULO win outright, and a weekday-afternoon
    // one hands Tiered the win — either way the comparison MOVES.
    const pattern = beforeBest === 'ULO' ? 'weekday-afternoon' : 'overnight';
    const expectedBest = beforeBest === 'ULO' ? 'Tiered' : 'ULO';
    const nowSec = Math.floor(Date.now() / 1000);
    await page.route('**/greenbutton/usage*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/xml',
        body: feed({
          subscriptionUri: 'http://localhost/espi/1_1/resource/Subscription/mock-sub-1',
          startEpoch: nowSec - 60 * 24 * HOUR,
          days: 30,
          pattern,
        }),
      }),
    );

    // Let the load-time pull's throttle window pass, then go away and back.
    await page.waitForTimeout(TEST_MIN_INTERVAL_MS + 200);
    const beforePulls = pulls.count();
    await simulateTabAwayAndBack(page);

    // ---- 4. exactly ONE pull fired --------------------------------------
    await expect
      .poll(() => pulls.count(), {
        message: 'visibilitychange did not trigger a background refresh',
        timeout: 30_000,
      })
      .toBe(beforePulls + 1);

    // ---- 5. and the banner followed the DATA ---------------------------
    const banner = page.getByTestId('refresh-notice-plan');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveAttribute('data-plan', expectedBest);
    await expect(banner).toHaveAttribute('data-previous-plan', beforeBest!);
    await expect(page.getByTestId('totals-strip')).toHaveAttribute('data-best-plan', expectedBest);
    await expect(page.getByTestId('refresh-notice-headline')).toContainText(
      'Your best plan changed',
    );
    await expect(page.getByTestId('refresh-notice-headline')).toContainText('/mo vs');

    // The prompt is still the drawer's business alone.
    expect(await permissionCalls(page), 'a refresh must never prompt').toBe(0);

    // The drawer exists for an authorised browser, but is closed on load.
    await expect(page.locator('[data-testid="notification-drawer"]')).toHaveCount(0);
    await page.getByTestId('notification-toggle').click();
    await expect(page.locator('[data-testid="notification-drawer"]')).toBeVisible();

    // ---- 6. dismissing sticks across the next refresh ------------------
    await page.getByTestId('refresh-notice-dismiss').first().click();
    await expect(page.locator('[data-testid="refresh-notice-banner"]')).toHaveCount(0);

    await page.waitForTimeout(TEST_MIN_INTERVAL_MS + 200);
    const beforeSecond = pulls.count();
    await simulateTabAwayAndBack(page);
    await expect.poll(() => pulls.count(), { timeout: 30_000 }).toBe(beforeSecond + 1);
    await page.waitForTimeout(250);
    await expect(
      page.locator('[data-testid="refresh-notice-banner"]'),
      'an acknowledged answer must not come back on the next refresh',
    ).toHaveCount(0);
  });
});
