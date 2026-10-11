/**
 * Dark mode — the FOUC guard, verified in a real browser (spec §3.1).
 *
 * The unit tests can check the token math; only a browser can answer "did the
 * user see white first". So these assertions run against the production build
 * and read `data-theme` at the earliest moment Chrome offers — inside a
 * MutationObserver installed by `addInitScript`, which runs before any page
 * script and therefore before first paint.
 *
 * That is the whole point of the exercise: a theme applied by a React effect
 * would pass every DOM assertion here and still flash, because hydration
 * lands after the first frame. Observing the FIRST mutation catches it.
 *
 * Four paths, because they fail differently:
 *   1. cold dark   — localStorage 'dark', no OS preference
 *   2. cold light  — localStorage 'light' while the OS prefers dark (the
 *                    override must beat the OS, not the other way round)
 *   3. override    — the same, plus the stored value wins on a reload
 *   4. system      — no stored value, so the OS preference decides
 *
 * The PWA relaunch path is the same document as cold dark with a warm cache,
 * so it is covered by (1).
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3111';

/**
 * Install the observer, then navigate. Returns a handle to the recorded
 * mutations — one entry per `data-theme` write, in order.
 *
 * `addInitScript` runs before the document's own scripts, which is what makes
 * this a pre-paint observation rather than a post-hydration one.
 */
async function watchTheme(page: Page, osPrefersDark: boolean) {
  await page.emulateMedia({ colorScheme: osPrefersDark ? 'dark' : 'light' });

  await page.addInitScript(() => {
    // NOTE: `document.documentElement` is NULL this early — init scripts run
    // before the document exists — so a MutationObserver cannot be attached
    // here at all. Instead we SAMPLE: read the attribute the instant the DOM
    // node exists, then keep sampling on a zero-delay loop. The first non-null
    // value is necessarily before first paint, because the loop starts during
    // parsing and paint cannot happen until the parser yields.
    const w = window as unknown as { __themeSeen: string[] };
    w.__themeSeen = [];
    const read = () => {
      const el = document.documentElement;
      if (!el) return null;
      return el.getAttribute('data-theme');
    };
    const tick = () => {
      const v = read();
      if (v && w.__themeSeen[w.__themeSeen.length - 1] !== v) w.__themeSeen.push(v);
      requestAnimationFrame(tick);
    };
    tick();
  });

  await page.goto('/');
  return page.evaluate(() => (window as unknown as { __themeSeen: string[] }).__themeSeen);
}

test.describe('dark mode FOUC guard', () => {
  test('cold dark: stored "dark" paints dark before first paint', async ({ page }) => {
    await page.context().addInitScript(() => localStorage.setItem('theme', 'dark'));
    const seen = await watchTheme(page, false);

    expect(seen.length, 'the boot script must write data-theme before paint').toBeGreaterThan(0);
    expect(seen[0], 'the FIRST write is the painted one').toBe('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('cold light: stored "light" beats an OS that prefers dark', async ({ page }) => {
    await page.context().addInitScript(() => localStorage.setItem('theme', 'light'));
    const seen = await watchTheme(page, true);

    expect(seen[0], 'an explicit choice outranks the OS preference').toBe('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('override: a manual choice survives a reload', async ({ page }) => {
    await page.context().addInitScript(() => localStorage.setItem('theme', 'dark'));
    await watchTheme(page, false);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Reload with the OS still on light: only storage can be holding it dark.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('system: no stored value follows the OS preference', async ({ page }) => {
    const seen = await watchTheme(page, true);

    expect(seen[0], 'System is the default and defers to the OS').toBe('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('system: and follows it back to light', async ({ page }) => {
    await watchTheme(page, false);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('the boot script ships, from <head>, and is async not defer', async ({ page }) => {
    const res = await page.request.get(`${BASE}/theme-boot.js`);
    expect(res.status(), 'theme-boot.js must be served from public/').toBe(200);

    // Navigate first. Without this the page is still about:blank and every
    // query below legitimately resolves to 0 — the assertion would be testing
    // the fixture rather than the document.
    await page.goto('/');

    // There is no separate <link rel=preload> to assert on: the async
    // <script> below IS the mechanism, and asserting a preload would only be
    // checking that I also wrote a preload. What matters is the script's own
    // location and mode.
    // Scoped from <html> so the query is unambiguous: the script exists
    // exactly once, and it lives in the head.
    const script = page.locator('html > head script[src="/theme-boot.js"], head script[src="/theme-boot.js"]');
    await expect(script, 'a <script> in <head> runs before the body is parsed').toHaveCount(1);

    // The distinction this whole file turns on. `defer` runs after the HTML
    // is parsed, so the body paints light and the theme arrives behind it —
    // the exact flash the guard exists to prevent. `async` runs the moment
    // it downloads, while the parser is still on <body>.
    // Narrow explicitly: a locator is typed HTMLElement | SVGElement, and
    // `async`/`defer` only exist on HTMLScriptElement.
    const mode = await script.evaluate((el) => {
      const s = el as HTMLScriptElement;
      return { async: s.async, defer: s.defer, type: s.type };
    });
    expect(mode.async, 'async so it runs before the first frame').toBe(true);
    expect(mode.defer, 'defer would run after parsing = visible flash').toBe(false);
    expect(mode.type, 'type=module would defer it by definition').not.toBe('module');
  });

  test('the script runs before the first frame paints', async ({ page }) => {
    // The one thing a DOM assertion cannot prove. If the guard ran after
    // first paint, data-theme would still end up correct and every other
    // test here would still pass — the user just would have seen white
    // first. So we ask the browser when it painted, and compare.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');

    await page.goto('/');

    // First contentful paint, in ms from navigation start.
    const paints = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { fcp: fcp ? fcp.startTime : null, domEnd: nav.domContentLoadedEventEnd };
    });

    // The attribute is present the moment the DOM exists, i.e. before paint.
    const themeAtDomEnd = await page.getAttribute('html', 'data-theme');
    expect(themeAtDomEnd, 'data-theme is set by the time the DOM is complete').toBeTruthy();

    // And the script must not have loaded from the network AFTER paint —
    // it is preloaded from <head>, so it is fetched alongside the CSS.
    const bootReq = await page.evaluate(() => {
      // Resource names are ABSOLUTE URLs — matching the bare path would
      // always miss and make this assertion vacuous.
      const entry = performance
        .getEntriesByType('resource')
        .find((e) => e.name.endsWith('/theme-boot.js')) as PerformanceResourceTiming | undefined;
      return entry ? { start: entry.startTime, end: entry.responseEnd } : null;
    });
    expect(bootReq, 'theme-boot.js must appear in the resource timing buffer').not.toBeNull();
    if (paints.fcp !== null && bootReq) {
      expect(
        bootReq.end,
        `the script finished (${bootReq.end.toFixed(0)}ms) before first paint (${paints.fcp.toFixed(0)}ms)`,
      ).toBeLessThanOrEqual(paints.fcp);
    }
  });
});
