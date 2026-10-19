import { expect, test } from '@playwright/test';
import { seedPlanSwitchFixture } from './plan-switch-fixture';

test('loads a populated synthetic Plan-Switch report in production preview', async ({ page }) => {
  const consoleErrors: string[] = [];
  const unexpectedHttpErrors: string[] = [];
  let accountFeatureOff404 = false;
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname === '/account/session' && response.status() === 404) {
      accountFeatureOff404 = true;
    } else if (response.status() >= 400) {
      unexpectedHttpErrors.push(`${response.status()} ${pathname}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await seedPlanSwitchFixture(page);
  await page.goto('/#tab=plans');
  const timeline = page.getByTestId('plan-switch-timeline');
  await expect(timeline).toHaveAttribute('data-periods', '3');
  await expect(page.getByTestId('switch-bubble-2026-06-23')).toBeVisible();
  await expect(page.getByTestId('switch-bubble-2026-07-22')).toBeVisible();
  await expect(page.getByTestId('switch-bubble-2026-06-23')).toHaveAttribute('data-counted', 'true');
  await expect(page.getByTestId('switch-bubble-2026-07-22')).toHaveAttribute('data-counted', 'true');
  await expect(page.getByTestId('switch-bubble-2026-06-23')).toHaveAttribute('aria-label', /actual plan was cheaper/i);
  await expect(page.getByTestId('switch-bubble-2026-07-22')).toHaveAttribute('aria-label', /Potential amount saved/i);
  expect(accountFeatureOff404).toBe(true);
  expect(unexpectedHttpErrors).toEqual([]);
  expect(consoleErrors.filter((message) => message !== 'Failed to load resource: the server responded with a status of 404 (Not Found)')).toEqual([]);
});

test('keeps the populated French mobile dashboard within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('oeo_locale', 'fr'));
  await seedPlanSwitchFixture(page);
  await page.goto('/#tab=plans');
  await expect(page.getByTestId('plan-switch-timeline')).toHaveAttribute('data-periods', '3');
  await expect(page.getByTestId('switch-timeline-note')).toContainText('périodes de facturation');
  await expect(page.getByTestId('best-choice-chip')).toBeVisible();
  await expect(page.getByTestId('switch-bubble-2026-06-23')).toHaveAttribute('data-counted', 'true');
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    chipRight: document.querySelector('[data-testid="best-choice-chip"]')?.getBoundingClientRect().right ?? 0,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.chipRight).toBeLessThanOrEqual(dimensions.viewport + 1);
});
