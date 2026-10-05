/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: run with `node scripts/…`, not bundled. */
/**
 * Wave I helper — seed a persistent Chrome profile with the bundled 8,760-row
 * example year, so Lighthouse can be run against the HEAVY state a real
 * returning user audits (cold cache + a full year in localStorage), instead
 * of the empty first-visit state that every stock Lighthouse run measures.
 *
 * Usage: node scripts/seed-profile.cjs <user-data-dir> <base-url>
 */
const { chromium } = require('@playwright/test');

(async () => {
  const dir = process.argv[2];
  const base = process.argv[3] || 'http://127.0.0.1:3199';
  if (!dir) { console.error('need user-data-dir'); process.exit(2); }

  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: process.env.PW_CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=upload-modal]', { timeout: 20000 });
  const t0 = Date.now();
  await page.locator('[data-testid=try-example-data]').click();
  await page.waitForSelector('[data-testid=totals-strip]', { timeout: 60000 });
  const rows = await page.evaluate(() => {
    try { return (JSON.parse(localStorage.getItem('energy_data') || '[]')).length; } catch { return -1; }
  });
  console.log(`seeded ${rows} readings in ${Date.now() - t0} ms`);
  await ctx.close();
  if (rows < 8000) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
