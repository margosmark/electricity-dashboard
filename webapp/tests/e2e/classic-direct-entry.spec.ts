import { test, expect } from '@playwright/test';

test.describe('Classic direct entry', () => {
  test('root and /classic direct entry and refresh serve the dashboard', async ({ page, request }) => {
    expect((await request.get('/')).status()).toBe(200);
    for (const path of ['/classic', '/classic']) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/Ontario Energy Optimizer/);
      await expect(page.getByTestId('tab-plans')).toBeAttached();
    }
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
