import { test, expect } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

for (const locale of ['en', 'fr'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`Analytics plots usage bars in ${locale}/${theme}`, async ({ page }) => {
      await page.addInitScript(
        ({ lang, colorTheme }) => {
          localStorage.setItem('oeo_locale', lang);
          localStorage.setItem('theme', colorTheme);
        },
        { lang: locale, colorTheme: theme },
      );
      await seedMarkShaped(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByTestId('tab-analytics').click();
      await expect(page.getByTestId('chart-view')).toBeVisible();
      await expect
        .poll(
          () =>
            page.locator('.recharts-bar-rectangle').evaluateAll((nodes) =>
              nodes.filter((node) => {
                const box = node.getBoundingClientRect();
                return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
              }).length,
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
    });
  }
}
