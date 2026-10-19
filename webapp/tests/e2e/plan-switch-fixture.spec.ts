import { expect, test } from '@playwright/test';
import { seedPlanSwitchFixture } from './plan-switch-fixture';

test('loads a populated synthetic Plan-Switch report in production preview', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/\/api\/(session|notify)(?:\?|$)/.test(message.text())) {
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
  await expect(page.getByTestId('switch-bubble-2026-06-23')).toHaveAttribute('aria-label', /actual plan was cheaper/i);
  await expect(page.getByTestId('switch-bubble-2026-07-22')).toHaveAttribute('aria-label', /Potential amount saved/i);
  expect(consoleErrors).toEqual([]);
});
