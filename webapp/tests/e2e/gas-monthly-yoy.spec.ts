import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * The gas monthly overview, year-over-year and money-per-period in a real
 * browser (t_a2343a2f) — what jsdom cannot paint:
 *
 *  - a SYNTHETIC two-year Enbridge-shaped import (24 monthly bills +
 *    24 metered readings, 2025-01-25 → 2026-12-25) charts all 24 calendar
 *    months — the declared INTERVAL source, with each bill's stated volume
 *    and Amount Due beside it in the table — and opens the year-over-year
 *    panel (delta row + full-year totals) because the span exceeds 12
 *    months;
 *  - the Money tab's per-period disclosure reveals the bill's own line
 *    items without disturbing the ten/24-row contract;
 *  - FR localizes every new surface, `prefers-reduced-motion` paints the
 *    final geometry, and no kWh token ever reaches the gas profile;
 *  - the classic route renders the same panels on its Usage tab.
 *
 * FIXTURE POLICY: SYNTHETIC only — scripts/generate-enbridge-gas-twoyear-fixture.mjs.
 */

const TWO_YEAR = path.resolve(
  __dirname,
  '../../tests/fixtures/enbridge-gas-twoyear-synthetic.xml',
);

/** First period's stated figures (generator's seasonal tables, verified). */
const P1_AMOUNT_DUE = '$157.30';

/** Land on a fresh profile and push the fixture through the real upload input. */
async function landAndImport(page: Page, fixture: string): Promise<void> {
  const resp = await page.goto('/');
  expect(resp?.status()).toBe(200);
  expect(await page.evaluate(() => localStorage.getItem('gas_usage_summaries'))).toBeNull();
  await expect(page.getByText('Drop XML Here')).toBeVisible({ timeout: 30_000 });
  await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(fixture);
  await expect(page.getByText('Drop XML Here')).toBeHidden({ timeout: 60_000 });
}

async function openTab(page: Page, tab: 'tab-analytics' | 'tab-money'): Promise<void> {
  await page.getByTestId(tab).click();
  await expect(page.getByTestId(tab)).toHaveAttribute('aria-selected', 'true');
}

test.describe('gas monthly + year-over-year + money per period', () => {
  test('two-year import: 24 monthly rows, 24 metered bars, ready YoY — no kWh', async ({ page }) => {
    test.setTimeout(180_000);
    await landAndImport(page, TWO_YEAR);
    await openTab(page, 'tab-analytics');

    // Monthly overview: card chrome, the declared source note (this file
    // carries one metered reading per period → the INTERVAL source), and
    // one row per calendar month.
    const monthly = page.getByTestId('gas-monthly-panel');
    await expect(monthly).toBeVisible({ timeout: 30_000 });
    await expect(monthly).toContainText('Gas by calendar month');
    await expect(monthly).toContainText('Bars: stored interval readings');
    const rows = page.getByTestId('gas-monthly-row');
    await expect(rows).toHaveCount(24, { timeout: 30_000 });
    await expect(rows.first()).toHaveAttribute('data-month', '2025-01');
    await expect(rows.last()).toHaveAttribute('data-month', '2026-12');

    // The stated money: P1's Amount Due, exactly as the file states it.
    await expect(rows.first()).toContainText(P1_AMOUNT_DUE);

    // One metered reading per calendar month → 24 bars, scoped to THIS
    // chart (the tab also carries the interval chart and the YoY chart).
    const monthlyChart = page.getByTestId('gas-monthly-chart');
    await expect(monthlyChart).toBeVisible({ timeout: 30_000 });
    await expect(monthlyChart.locator('.recharts-bar-rectangle')).toHaveCount(24);

    // Year-over-year: past the 13-month gate → chart, delta row, totals.
    const yoy = page.getByTestId('gas-yoy-panel');
    await expect(yoy).toBeVisible();
    await expect(yoy).toContainText('Year-over-Year — Monthly m³');
    const yoyChart = page.getByTestId('gas-yoy-chart');
    await expect(yoyChart).toBeVisible({ timeout: 30_000 });
    // 12 month rows × 2 year series, all non-null.
    await expect(yoyChart.locator('.recharts-bar-rectangle')).toHaveCount(24);
    await expect(page.getByTestId('gas-yoy-deltas')).toContainText(
      'Δ vs 2025 (2026 vs 2025)',
    );
    const totals = page.getByTestId('gas-yoy-year-total');
    await expect(totals).toHaveCount(2);
    await expect(totals.first()).toContainText('12/12');
    await expect(page.getByTestId('gas-yoy-meta')).toContainText(
      '2 years · 24 months of data (Jan 2025 – Dec 2026)',
    );

    // Honesty: not one kWh figure anywhere on the painted gas profile.
    const figures = await page.evaluate(
      () => document.body.innerText.match(/(?:\d[\d,.]*\s*kWh|¢\/kWh)/gi) || [],
    );
    expect(figures, `kWh figures leaked: ${figures.join(', ')}`).toEqual([]);
  });

  test('money tab: 24 periods and the per-period line disclosure', async ({ page }) => {
    test.setTimeout(180_000);
    await landAndImport(page, TWO_YEAR);
    await openTab(page, 'tab-money');

    const rows = page.getByTestId('gas-money-row');
    await expect(rows).toHaveCount(24, { timeout: 30_000 });
    await expect(rows.first()).toContainText(P1_AMOUNT_DUE);

    // The disclosure opens the bill's own line items — feed wording, in the
    // DOM, without disturbing the row contract the count above pins.
    const toggle = page.getByTestId('gas-money-lines-toggle').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const region = page.getByTestId('gas-money-lines');
    await expect(region).toBeVisible();
    await expect(region).toContainText('Charges, as the file reports them');
    const notesAtRest = await region.locator('[data-bill-note]').count();
    expect(notesAtRest).toBeGreaterThanOrEqual(8);

    // The all-zero lines stay reachable, never dropped.
    const zero = region.getByTestId('gas-money-zero-lines');
    await expect(zero).toBeVisible();
    const zeroCount = Number(await zero.getAttribute('data-count'));
    expect(zeroCount).toBeGreaterThanOrEqual(8);
    await zero.locator('button').click();
    await expect(region.locator('[data-bill-note]')).toHaveCount(notesAtRest + zeroCount);

    // The ten/24-row contract: the detail row is NOT a money row.
    await expect(rows).toHaveCount(24);
  });

  test('FR: every new surface localizes from the catalog', async ({ page }) => {
    test.setTimeout(180_000);
    await landAndImport(page, TWO_YEAR);
    await openTab(page, 'tab-analytics');

    const toggle = page.getByTestId('locale-toggle');
    await expect(toggle).toHaveAttribute('data-locale', 'en');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-locale', 'fr');

    await expect(page.getByTestId('gas-monthly-panel')).toContainText(
      'Gaz par mois civil',
    );
    await expect(page.getByTestId('gas-yoy-panel')).toContainText(
      "D'une année à l'autre — m³ mensuels",
    );
    await expect(page.getByTestId('gas-yoy-totals')).toContainText('Totaux annuels');

    await openTab(page, 'tab-money');
    await expect(page.getByTestId('gas-money-lines-toggle').first()).toContainText(
      'Afficher les lignes',
    );
  });

  test('reduced motion: monthly chart flagged and painted in final geometry', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await landAndImport(page, TWO_YEAR);
    await openTab(page, 'tab-analytics');

    const monthlyChart = page.getByTestId('gas-monthly-chart');
    await expect(monthlyChart).toBeVisible({ timeout: 30_000 });
    await expect(monthlyChart).toHaveAttribute('data-reduced-motion', 'true');
    // Final geometry present: every bar painted, not waiting on a grow-in.
    await expect(monthlyChart.locator('.recharts-bar-rectangle')).toHaveCount(24);
  });

  test('classic route renders the same panels on its Usage tab', async ({ page }) => {
    test.setTimeout(180_000);
    await landAndImport(page, TWO_YEAR);
    // The shared `#tab=` vocabulary is the quiet spelling — it opens
    // classic's Usage panel (classic-direct-entry.spec.ts pins this).
    await page.goto('/classic#tab=analytics');
    await expect(page.getByTestId('tab-usage')).toHaveAttribute('aria-selected', 'true', {
      timeout: 30_000,
    });

    await expect(page.getByTestId('gas-monthly-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('gas-monthly-row')).toHaveCount(24);
    await expect(page.getByTestId('gas-yoy-panel')).toBeVisible();
    await expect(page.getByTestId('gas-yoy-chart')).toBeVisible({ timeout: 30_000 });
  });
});
