import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * E2E smoke against a freshly booted production build (CI: docker image;
 * local: `next start` or compose). Covers the real upload flow end-to-end
 * with a tiny synthetic GreenButton XML (tests/fixtures/synthetic.xml), then
 * the PWA surfaces: manifest + service worker + offline shell.
 *
 * Fixture design (America/Toronto, Sep 4 – Oct 1 2026):
 *   weekdays 12:00/13:00 -> summer On-Peak @ 2.4 kWh (the shiftable pattern)
 *   weekdays 08:00       -> Mid-Peak (Wave E: shipped as the LOWER tier)
 *   weekends 12:00       -> Off-Peak (must NOT be recommended)
 * so the Shift Optimizer must find exactly 5 weekday On-Peak blocks plus 5
 * weekday Mid-Peak blocks — and no weekend/Off-Peak recommendation at all.
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/synthetic.xml');

async function uploadFixture(page: Page) {
  await page.goto('/');
  // Fresh browser profile => upload modal is open (empty localStorage)
  await expect(page.getByText('Drop XML Here')).toBeVisible();
  await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(FIXTURE);
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

    // Wave R: the page opens on OVERVIEW, and the decision is the first
    // thing on it — not something you have to scroll to.
    await expect(page.getByTestId('best-choice-banner')).toBeVisible();
    await expect(page.getByTestId('totals-strip')).toBeVisible();

    // Bill projection banner is always on screen — either with a number or
    // saying exactly why it will not give one yet.
    const projection = page.getByTestId('bill-projection');
    await expect(projection).toBeVisible();
    await expect(projection).toHaveAttribute('data-state', /^(ready|gated)$/);

    // Usage: the chart header.
    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.getByText('Monthly Overview')).toBeVisible();

    // Plans & Track Record: the plan card (Wave A's totals strip also says
    // "Time-of-Use" — scope to the role) and its window context.
    await page.getByRole('tab', { name: 'Plans' }).click();
    await expect(page.getByRole('heading', { name: 'Time-of-Use' })).toBeVisible();
    // WFH context annotation is computed from the visible window.
    await expect(page.getByTestId('wfh-annotation')).toBeVisible();

    // Readings persisted to localStorage (all 68)
    const stored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('energy_data_v2') || 'null')?.points || [],
    );
    expect(stored).toHaveLength(68);

    // Shift Optimizer found the 5 weekday On-Peak blocks PLUS the
    // 5 weekday Mid-Peak (08:00) blocks as a labelled lower tier (Wave E) —
    // and says so in the one-line verdict above it.
    await expect(page.getByTestId('verdict-line')).toBeVisible();
    const optimizer = page.getByTestId('shift-optimizer');
    await expect(optimizer).toBeVisible();
    await expect(
      optimizer.getByText(/5 On-Peak \+ 5 Mid-Peak recurring blocks found/i),
    ).toBeVisible();

    // Every block (both tiers) is a weekday 12:00–14:00 / 08:00–09:00 with recurrence evidence
    const blocks = page.locator('[data-testid^="shift-block-"]');
    await expect(blocks).toHaveCount(10);
    await expect(blocks.first()).toContainText('12:00–14:00');
    await expect(blocks.first()).toContainText('seen in 4 of 5 weeks');

    // Wave E: Mid-Peak hours are included, but ONLY as an explicitly marked
    // lower tier ranked behind the On-Peak blocks.
    const midPeakRows = page.locator('[data-testid^="shift-block-"][data-tier="mid-peak"]');
    await expect(midPeakRows).toHaveCount(5);
    await expect(midPeakRows.first()).toContainText('08:00');
    await expect(page.getByTestId('shift-tier-chip').first()).toBeVisible();

    // One destination owns every block → one headline, blocks demoted to rows
    const headline = page.getByTestId('shift-headline');
    await expect(headline).toBeVisible();
    await expect(headline).toContainText('Switch to ULO');
    await expect(page.getByTestId('shift-headline-share')).toContainText('% of the savings');

    // Confidence + effort chips are visible, and the honest fallback label is
    // on screen (a 2h block can never be identified, so it says so).
    await expect(page.getByTestId('confidence-badge').first()).toBeVisible();
    await expect(page.getByTestId('effort-chip').first()).toBeVisible();
    await expect(page.getByText('Unidentified weekday routine').first()).toBeVisible();

    // Off-Peak (weekend) hours still never get recommended
    await expect(page.getByTestId('shift-optimizer')).not.toContainText(/Sun |Sat /);
    // Ranked total is a real number
    await expect(optimizer.getByText(/\$\d+\.\d{2}/).first()).toBeVisible();

    // Wave E's weekly before/after renders from the same fixture — the
    // household sees whether the shift showed up.
    await expect(page.getByTestId('shift-verification')).toBeVisible();

    // Money & What-If: the EV scenario prices a charge three ways from that
    // same fixture.
    await page.getByRole('tab', { name: 'Money' }).click();
    const ev = page.getByTestId('ev-scenario');
    await expect(ev).toBeVisible();
    // If we found nothing overnight, the card must say so — never imply a car.
    if ((await ev.getAttribute('data-source')) !== 'detected') {
      await expect(page.getByTestId('ev-scenario-empty')).toBeVisible();
      await expect(ev).not.toContainText(/Prefilled from your data/);
    }
  });

  test('multi-file merge: 2 exports are reviewed on screen before anything lands', async ({ page }) => {
    // A second export with the same name-shape but its own path, so the file
    // input really does receive two files.
    const second = path.join(os.tmpdir(), 'synthetic-second.xml');
    fs.copyFileSync(FIXTURE, second);

    await page.goto('/');
    await expect(page.getByText('Drop XML Here')).toBeVisible();
    await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles([FIXTURE, second]);

    // The review screen appears BEFORE any reading is written.
    const review = page.getByTestId('merge-review');
    await expect(review).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('merge-rows')).toHaveText('68');
    await expect(page.getByTestId('merge-duplicates')).toHaveText('68 of 136');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('energy_data_v2') || '{"points":[]}').points || []),
    ).toHaveLength(0);

    await page.getByTestId('merge-confirm').click();
    await expect(review).toBeHidden();
    // Lands on Overview with the decision already on screen.
    await expect(page.getByTestId('best-choice-banner')).toBeVisible();
    await expect(page.getByTestId('totals-strip')).toBeVisible();
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('energy_data_v2') || '{"points":[]}').points || []),
    ).toHaveLength(68);
  });

  test('multi-file merge: cancelling imports nothing at all', async ({ page }) => {
    const second = path.join(os.tmpdir(), 'synthetic-second-cancel.xml');
    fs.copyFileSync(FIXTURE, second);

    await page.goto('/');
    await expect(page.getByText('Drop XML Here')).toBeVisible();
    await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles([FIXTURE, second]);

    const review = page.getByTestId('merge-review');
    await expect(review).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('merge-cancel').click();
    await expect(review).toBeHidden();
    // Back to the upload prompt, and still nothing stored.
    await expect(page.getByText('Drop XML Here')).toBeVisible();
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('energy_data_v2') || '{"points":[]}').points || []),
    ).toHaveLength(0);
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
