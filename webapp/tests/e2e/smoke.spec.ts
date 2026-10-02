import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * E2E smoke against a freshly booted production build (CI: docker image;
 * local: `next start` or compose). Covers the real upload flow end-to-end
 * with a tiny synthetic GreenButton XML (tests/fixtures/synthetic.xml), then
 * the PWA surfaces: manifest + service worker + offline shell.
 *
 * Fixture design (America/Toronto, Sep 4 – Oct 1 2026):
 *   weekdays 12:00/13:00 -> summer On-Peak @ 2.4 kWh (the shiftable pattern)
 *   weekdays 08:00       -> Mid-Peak (must NOT be recommended)
 *   weekends 12:00       -> Off-Peak (must NOT be recommended)
 * so the Shift Optimizer must find exactly 5 weekday blocks and nothing else.
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/synthetic.xml');

async function uploadFixture(page: Page) {
  await page.goto('/');
  // Fresh browser profile => upload modal is open (empty localStorage)
  await expect(page.getByText('Drop XML Here')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  // Modal closes only after a successful parse of all 68 readings
  await expect(page.getByText('Drop XML Here')).toBeHidden({ timeout: 15_000 });
}

test.describe('smoke', () => {
  test('GET / returns 200 with app identity and manifest link', async ({ page }) => {
    const resp = await page.goto('/');
    expect(resp?.status()).toBe(200);
    await expect(page).toHaveTitle(/Ontario Energy Optimizer/);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );
  });

  test('GET /api/rates returns 200 with the three versioned rate sets', async ({ request }) => {
    const resp = await request.get('/api/rates');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.historicalRates).toHaveLength(3);
    expect(body.historicalRates[2].effectiveDate).toBe('2025-11-01');
    expect(body.historicalRates[2].tou.onPeak).toBe(20.3);
  });

  test('upload flow: synthetic XML parses, dashboard + insights render', async ({ page }) => {
    await uploadFixture(page);

    // Dashboard is live: chart header + plan cards visible
    await expect(page.getByText('Monthly Overview')).toBeVisible();
    // Plan card heading (Wave A's totals strip also says "Time-of-Use" — scope to the role)
    await expect(page.getByRole('heading', { name: 'Time-of-Use' })).toBeVisible();

    // Readings persisted to localStorage (all 68)
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('energy_data') || '[]'),
    );
    expect(stored).toHaveLength(68);

    // Insights: Shift Optimizer found exactly the 5 weekday On-Peak blocks
    await page.getByRole('button', { name: 'INSIGHTS' }).click();
    const optimizer = page.getByTestId('shift-optimizer');
    await expect(optimizer).toBeVisible();
    await expect(optimizer.getByText(/5 recurring On-Peak blocks found/i)).toBeVisible();
    // Each block is a weekday 12:00–14:00 with recurrence evidence
    const blocks = page.locator('[data-testid^="shift-block-"]');
    await expect(blocks).toHaveCount(5);
    await expect(blocks.first()).toContainText('12:00–14:00');
    await expect(blocks.first()).toContainText('seen in 4 of 5 weeks');
    // No Mid-Peak (08:00) or weekend recommendation may leak in
    await expect(page.getByTestId('shift-optimizer')).not.toContainText('08:00');
    await expect(page.getByTestId('shift-optimizer')).not.toContainText(/Sun |Sat /);
    // Ranked total is a real number
    await expect(optimizer.getByText(/\$\d+\.\d{2}/).first()).toBeVisible();
  });

  test('PWA: manifest is installable, service worker registers and caches the shell', async ({ page, context }) => {
    // Manifest: valid JSON, icons present, standalone display
    const manifestResp = await page.request.get('/manifest.webmanifest');
    expect(manifestResp.status()).toBe(200);
    const manifest = await manifestResp.json();
    expect(manifest.name).toBe('Ontario Energy Optimizer');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    const icon512 = manifest.icons.find((i: { sizes: string }) => i.sizes === '512x512');
    expect(icon512).toBeTruthy();
    const iconResp = await page.request.get(icon512.src);
    expect(iconResp.status()).toBe(200);

    await page.goto('/');
    // Service worker registers and takes control (prod build only)
    const swState = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { active: !!reg.active, script: reg.active?.scriptURL ?? null };
    });
    expect(swState.active).toBe(true);
    expect(swState.script).toContain('/sw.js');

    // Shell + rates land in the caches (SW precache + warmer fetch)
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const keys = await caches.keys();
            const shell = keys.find((k) => k.endsWith('-shell'));
            const runtime = keys.find((k) => k.endsWith('-runtime'));
            const shellOk = shell
              ? !!(await (await caches.open(shell)).match('/'))
              : false;
            const ratesOk = runtime
              ? !!(await (await caches.open(runtime)).match('/api/rates'))
              : false;
            return { keys: keys.length, shellOk, ratesOk };
          }),
        { timeout: 15_000 },
      )
      .toMatchObject({ shellOk: true, ratesOk: true });

    // Offline: reload with the network cut must still serve the app shell
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText('Ontario Energy Optimizer').first()).toBeVisible();
    // /api/rates must resolve from cache while offline
    const offlineRates = await page.evaluate(async () => {
      const resp = await fetch('/api/rates');
      return { ok: resp.ok, count: (await resp.json()).historicalRates?.length ?? 0 };
    });
    expect(offlineRates.ok).toBe(true);
    expect(offlineRates.count).toBe(3);
    await context.setOffline(false);
  });

  test('PWA: Chrome audit reports the app installable (no installability errors)', async ({ page }) => {
    await page.goto('/');
    // Give the SW a moment to activate so the audit sees a controlling worker
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Chrome's own installability verdict — the same signal the
    // "Install app" menu item / beforeinstallprompt is gated on.
    const cdp = await page.context().newCDPSession(page);
    const { installabilityErrors } = (await cdp.send(
      'Page.getInstallabilityErrors',
    )) as unknown as { installabilityErrors: { errorId: string }[] };
    // Playwright's default context is incognito, where Chrome always reports
    // 'in-incognito' regardless of the app — harness artifact, not a defect.
    // Everything else must be empty.
    const real = installabilityErrors.filter((e) => e.errorId !== 'in-incognito');
    expect(
      real,
      `Chrome installability errors: ${JSON.stringify(real, null, 2)}`,
    ).toEqual([]);

    // And the parsed manifest Chrome sees carries the install requirements
    const { data, errors } = (await cdp.send('Page.getAppManifest')) as unknown as {
      data: string;
      errors: { message: string }[];
    };
    expect(errors).toEqual([]);
    const manifest = JSON.parse(data) as {
      name: string;
      icons: { src: string; sizes: string }[];
      start_url: string;
      display: string;
    };
    expect(manifest.name).toBe('Ontario Energy Optimizer');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    // Chrome requires at least one icon >= 144px; we ship 192 + 512 + maskable
    const big = manifest.icons.filter((i) => parseInt(i.sizes, 10) >= 144);
    expect(big.length).toBeGreaterThanOrEqual(2);
    for (const icon of big) {
      const resp = await page.request.get(icon.src);
      expect(resp.status(), `icon ${icon.src}`).toBe(200);
    }
  });
});
