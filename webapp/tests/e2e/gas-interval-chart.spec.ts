import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * The gas interval chart in a real browser (t_78f788b3) — the smoke the card
 * requires against a built server, covering what jsdom cannot paint:
 *
 *  - the multi-series import (`69F1A08B-…`-style ids, 4 volume series × 6
 *    daily readings + bills) charts all 24 readings with the m³ unit on the
 *    Y axis, in the hover tooltip and in the sr-only table — never a kWh
 *    figure anywhere on the gas profile;
 *  - a BILL-ONLY import (bills, zero volume series) says "No interval data
 *    in this import" and paints no chart at all — no zero baseline;
 *  - `prefers-reduced-motion: reduce` flags the chart and still paints its
 *    final geometry (all 24 bars), i.e. no animation dependency.
 *
 * FIXTURE POLICY: SYNTHETIC only (`tests/fixtures/…`); the owner's real EGD
 * export never enters this repo.
 */

const MULTISERIES = path.resolve(
  __dirname,
  '../../tests/fixtures/enbridge-gas-multiseries-synthetic.xml',
);
const BILL_ONLY = path.resolve(
  __dirname,
  '../../tests/fixtures/mixed-commodity-synthetic.xml',
);

/** Land on a fresh profile and push a fixture through the real upload input. */
async function landAndImport(page: Page, fixture: string): Promise<void> {
  const resp = await page.goto('/');
  expect(resp?.status()).toBe(200);
  expect(await page.evaluate(() => localStorage.getItem('energy_data_v2'))).toBeNull();
  await expect(page.getByText('Drop XML Here')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(fixture);
  await expect(page.getByText('Drop XML Here')).toBeHidden({ timeout: 60_000 });
}

async function openAnalytics(page: Page): Promise<void> {
  await page.getByTestId('tab-analytics').click();
  await expect(page.getByTestId('tab-analytics')).toHaveAttribute('aria-selected', 'true');
}

/** Ensure the GAS section is the selected commodity (the switcher is idempotent). */
async function selectGas(page: Page): Promise<void> {
  await page.getByTestId('commodity-gas').click();
  await expect(page.getByTestId('commodity-gas')).toHaveAttribute('aria-pressed', 'true');
}

test.describe('gas interval chart', () => {
  test('multi-series import: 24 readings charted in m³ — axis, tooltip, table, no kWh', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await landAndImport(page, MULTISERIES);
    await selectGas(page);
    await openAnalytics(page);

    // Card chrome + the dynamic chart chunk painted.
    await expect(page.getByText('Gas volume by interval')).toBeVisible();
    const chart = page.getByTestId('gas-chart');
    await expect(chart).toBeVisible({ timeout: 15_000 });

    // The m³ unit sits ON the Y axis (the card's hard requirement).
    await expect(chart.locator('text', { hasText: 'Gas volume (m³)' })).toBeVisible();

    // One bar per stored reading: 4 series × 6 daily readings. Scoped to
    // THIS chart since t_a2343a2f added the monthly overview + year-over-
    // year charts to the same tab (their bars are counted by their own
    // testids in gas-monthly-yoy.spec.ts) — the count is unchanged, only
    // the container narrowed.
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(24);

    // The sr-only table reaches every reading, each cell with its unit.
    const table = page.getByTestId('gas-chart-data-table');
    await expect(table.locator('tbody tr')).toHaveCount(24);
    await expect(table.locator('tbody tr').first()).toContainText('m³');
    await expect(table.locator('tbody tr').first()).toContainText('8.4');

    // Hover a bar → the tooltip states the value in m³ (interval chart's
    // own first bar — the monthly chart also renders bars below it).
    await chart.locator('.recharts-bar-rectangle').first().hover();
    await expect(page.getByTestId('gas-chart-tooltip')).toBeVisible();
    await expect(page.getByTestId('gas-chart-tooltip')).toContainText('m³');
    await expect(page.getByTestId('gas-chart-tooltip')).toContainText('8.4');

    // Honesty: not one kWh figure anywhere on the painted gas profile.
    const figures = await page.evaluate(
      () => document.body.innerText.match(/(?:\d[\d,.]*\s*kWh|¢\/kWh)/gi) || [],
    );
    expect(figures, `kWh figures leaked: ${figures.join(', ')}`).toEqual([]);
  });

  test('bill-only import: honest "No interval data in this import", no chart, no zero baseline', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // mixed-commodity-synthetic.xml = electric intervals + gas BILLS and
    // zero gas volume rows — the many-Enbridge-exports-are-bill-only shape.
    await landAndImport(page, BILL_ONLY);
    await selectGas(page);
    await openAnalytics(page);

    await expect(page.getByText('No interval data in this import')).toBeVisible();
    await expect(page.getByTestId('gas-chart-empty')).toContainText(
      'billing periods but no interval readings for gas',
    );
    // No chart frame, no table, and no fabricated zero-height bars — the
    // INTERVAL chart paints none. (The monthly overview below may chart
    // this file's stated billed volumes; that is a different claim and is
    // asserted in gas-monthly-yoy.spec.ts.)
    await expect(page.getByTestId('gas-chart')).toHaveCount(0);
    await expect(page.getByTestId('gas-chart-data-table')).toHaveCount(0);
    await expect(page.getByTestId('gas-chart').locator('.recharts-bar-rectangle')).toHaveCount(0);
  });

  test('reduced motion: chart flagged and painted in its final state', async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await landAndImport(page, MULTISERIES);
    await selectGas(page);
    await openAnalytics(page);

    const chart = page.getByTestId('gas-chart');
    await expect(chart).toBeVisible({ timeout: 15_000 });
    await expect(chart).toHaveAttribute('data-reduced-motion', 'true');
    // Final geometry present: every bar painted, not waiting on a grow-in.
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(24);
  });
});
