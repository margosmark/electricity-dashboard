import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

const THEMES = ['light', 'dark'] as const;

async function paintedBox(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    const shadowAlphas = [...style.boxShadow.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)]
      .map((match) => Number(match[1]));
    return {
      borderTopWidth: style.borderTopWidth,
      borderRadius: style.borderTopLeftRadius,
      boxShadow: style.boxShadow,
      hasVisibleShadow: shadowAlphas.some((alpha) => alpha > 0),
    };
  });
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`Quiet Meter shell ${viewport.width}x${viewport.height} ${theme}`, () => {
      test.use({ viewport });

      test('keeps the fresh Link Data dialog quiet and dismissable', async ({ page }, testInfo) => {
        await page.addInitScript((mode) => localStorage.setItem('theme', mode), theme);
        await page.goto('/');

        const modal = page.getByTestId('upload-modal');
        await expect(modal).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByLabel('Upload Green Button XML')).toBeAttached();
        await expect(page.getByLabel('Import JSON backup')).toBeAttached();
        await expect(page.getByTestId('try-example-data')).toBeVisible();

        const card = await paintedBox(page, '[data-testid="upload-modal"] > div');
        expect(card.borderTopWidth).toBe('1px');
        expect(card.borderRadius).toBe('8px');
        expect(card.hasVisibleShadow).toBe(false);
        await page.screenshot({ path: testInfo.outputPath(`fresh-${theme}-${viewport.width}.png`), fullPage: true });

        await page.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
      });

      test('puts loaded range and scope context in the top shell', async ({ page }, testInfo) => {
        await page.addInitScript((mode) => localStorage.setItem('theme', mode), theme);
        await seedMarkShaped(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const nav = page.getByTestId('tab-nav');
        const context = page.getByTestId('dashboard-context');
        const toolbar = page.getByTestId('dashboard-toolbar');
        await expect(context).toBeVisible();
        await expect(nav).toContainText('Billing Period');
        expect(await nav.locator('[data-testid="dashboard-context"]').count()).toBe(1);
        expect(await toolbar.locator('input[type="date"]').count()).toBe(0);
        expect(await context.locator('input[type="date"]').count()).toBe(2);

        await context.getByRole('button', { name: 'Month' }).click();
        await expect(context.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');

        const [dateRange, scope, themeToggle] = await Promise.all([
          paintedBox(page, '[data-testid="dashboard-date-range"]'),
          paintedBox(page, '[data-testid="dashboard-scope"]'),
          paintedBox(page, '[data-testid="theme-toggle"]'),
        ]);
        for (const control of [dateRange, scope, themeToggle]) {
          expect(control.borderTopWidth).toBe('1px');
          expect(control.hasVisibleShadow).toBe(false);
        }

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath(`loaded-${theme}-${viewport.width}.png`), fullPage: true });
      });
    });
  }
}