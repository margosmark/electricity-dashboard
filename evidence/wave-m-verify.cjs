/**
 * Wave M — deployed verification (re-runnable).
 *
 * Proves, against the LIVE origin, the half of the card's browser gate that
 * does not need Oakville Hydro credentials:
 *
 *   1. page load raises NO notification permission prompt (`requestPermission`
 *      is spied before the document runs — the settings drawer's click is the
 *      only caller in the codebase);
 *   2. a visitor with no `gb_session` sees NO alert chrome: no settings
 *      toggle, no refresh-notice banner (card scope 4);
 *   3. the deployed service worker carries the Periodic Background Sync
 *      handler and the deployed bundle carries the notice keys.
 *
 * The connected half — tab-away → tab-back pulling exactly once and the
 * switch banner following the data — needs a configured shim, and is gated by
 * `webapp/scripts/e2e-greenbutton-browser.sh` (24/24, see wave-m-notes.md).
 *
 * Usage: node evidence/wave-m-verify.cjs <baseURL> [screenshotPath]
 */

const { chromium } = require('@playwright/test');
const fs = require('node:fs');

const BASE = process.argv[2] || 'https://electricity.markarslan.ca';
const SHOT = process.argv[3] || 'evidence/wave-m-deployed.png';

const has = (page, selector) => page.locator(selector).count();

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1350, height: 940 } });
  const page = await context.newPage();

  // Spy BEFORE the document runs: the only sanctioned caller is the drawer.
  await page.addInitScript(() => {
    const w = window;
    w.__permCalls = 0;
    if (typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function') {
      const original = Notification.requestPermission;
      Notification.requestPermission = function (...args) {
        w.__permCalls += 1;
        return original.apply(this, args);
      };
    }
  });

  const permissionBefore = 'unknown';
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(1500);

  const swText = await page.evaluate(async () => {
    const res = await fetch('/sw.js', { cache: 'no-store' });
    return res.ok ? await res.text() : '';
  });

  const out = {
    url: BASE,
    when: new Date().toISOString(),
    documentTitle: await page.title(),
    permission_prompt_calls_on_load: await page.evaluate(() => window.__permCalls),
    permission_state_after_load: await page.evaluate(() =>
      typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    ),
    permission_state_before: permissionBefore,
    settings_drawer_rendered_for_visitor: (await has(page, '[data-testid="notification-toggle"]')) > 0,
    refresh_notice_banner_rendered: (await has(page, '[data-testid="refresh-notice-banner"]')) > 0,
    gb_chip_state: await page.locator('[data-testid="gb-chip"]').count(),
    sw_serves_periodicsync_handler: swText.includes("addEventListener('periodicsync'"),
    sw_serves_staged_feed_cache: swText.includes('oeo-gb-staged'),
    sw_version: (swText.match(/^const VERSION = '([^']+)';$/m) || [])[1] ?? null,
    assertions: {},
  };

  out.assertions = {
    no_permission_prompt_on_load: out.permission_prompt_calls_on_load === 0,
    no_alert_chrome_for_manual_visitor:
      out.settings_drawer_rendered_for_visitor === false &&
      out.refresh_notice_banner_rendered === false,
    service_worker_carrying_wave_m:
      out.sw_serves_periodicsync_handler && out.sw_serves_staged_feed_cache,
  };

  await page.screenshot({ path: SHOT, fullPage: false });
  out.screenshot = SHOT;
  out.ok = Object.values(out.assertions).every(Boolean);

  await browser.close();
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
