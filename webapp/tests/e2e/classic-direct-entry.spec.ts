import { test, expect } from '@playwright/test';

test.describe('Classic direct entry', () => {
  test('root and /classic direct entry and refresh serve the dashboard', async ({ page, request }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    expect((await request.get('/')).status()).toBe(200);
    for (const path of ['/classic', '/']) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/Ontario Energy Optimizer/);
      await expect(page.getByTestId('tab-plans')).toBeAttached();
    }

    const refreshed = await page.goto('/classic');
    expect(refreshed?.status()).toBe(200);
    await expect(page.getByTestId('tab-plans')).toBeAttached();
    await page.reload();
    await expect(page.getByTestId('tab-plans')).toBeAttached();
    expect(runtimeErrors).toEqual([]);
  });

  test('the quiet variant’s `analytics` vocabulary lands on classic Usage', async ({ page }) => {
    // Both variants share the `oeo_active_tab` key and the `#tab=` vocabulary,
    // and spell the analysis destination differently (quiet: analytics,
    // classic: usage). Either statement must open classic's Usage panel —
    // a shared link or a remembered tab must never degrade to Overview.
    await page.goto('/classic#tab=analytics');
    await expect(page.getByTestId('tab-usage')).toHaveAttribute('aria-selected', 'true');

    await page.addInitScript(() => localStorage.setItem('oeo_active_tab', 'analytics'));
    await page.goto('/classic');
    await expect(page.getByTestId('tab-usage')).toHaveAttribute('aria-selected', 'true');
  });

  test('/classic round-trip preserves the exact versioned energy payload', async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    const payload = JSON.stringify({
      version: 2,
      uploadedAt: '2026-10-19T12:00:00.000Z',
      source: 'classic-roundtrip-test',
      points: [
        { timestamp: 1792411200, usage_kwh: 1.25 },
        { timestamp: 1792414800, usage_kwh: 2.5 },
      ],
    });
    await page.addInitScript((value) => localStorage.setItem('energy_data_v2', value), payload);
    await page.goto('/');
    await expect(page.getByTestId('tab-plans')).toBeAttached();
    expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBe(payload);

    await page.goto('/classic');
    await expect(page.getByTestId('tab-plans')).toBeAttached();
    expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBe(payload);

    await page.reload();
    await expect(page.getByTestId('tab-plans')).toBeAttached();
    expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBe(payload);

    await page.goto('/');
    await expect(page.getByTestId('tab-plans')).toBeAttached();
    expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBe(payload);
    expect(runtimeErrors).toEqual([]);
  });

  for (const locale of ['en', 'fr'] as const) {
    for (const width of [1440, 390]) {
      test(`empty Plans guidance is localized and fits at ${width}px (${locale})`, async ({ page }) => {
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('oeo_locale', value), locale);
        const response = await page.goto('/classic#tab=plans');
        expect(response?.status()).toBe(200);
        const dialog = page.getByRole('dialog');
        if (await dialog.isVisible()) {
          await dialog.getByRole('button', { name: /cancel|annuler/i }).click();
          await expect(dialog).toBeHidden();
        }
        await expect(page.getByTestId('tab-plans')).toHaveAttribute('aria-selected', 'true');
        const empty = page.getByTestId('switch-timeline-empty');
        await expect(empty).toBeVisible();
        await expect(empty).toContainText(locale === 'en' ? 'Usage-only analysis already works' : 'L’analyse de la consommation fonctionne déjà');
        await expect(empty).toContainText(locale === 'en' ? 'export that contains bills' : 'export contenant des factures');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(await empty.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
        expect(runtimeErrors).toEqual([]);
      });
    }
  }
});
