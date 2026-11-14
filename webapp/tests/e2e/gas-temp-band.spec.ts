import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Gas usage vs outdoor temperature in a real browser (t_909aa5fa) — what
 * jsdom cannot paint:
 *
 *  - a SYNTHETIC two-year Enbridge-shaped import (24 metered periods) bands
 *    every interval against the SAME Open-Meteo series the electricity card
 *    uses, with the card's own honest states on screen (declared source,
 *    matched-hours coverage footer, verdict sentence);
 *  - WEATHER IS MOCKED, never fetched: the route answers with a deterministic
 *    seasonal + diurnal curve (−14…+24 °C), so band coverage is a fixture of
 *    the test, not of the network — five of the seven bins must carry real
 *    intervals;
 *  - FR localizes every new surface, `prefers-reduced-motion` paints the
 *    final geometry, no kWh token ever reaches the gas profile, and the
 *    classic route renders the card on its Usage tab.
 *
 * FIXTURE POLICY: SYNTHETIC only — scripts/generate-enbridge-gas-twoyear-fixture.mjs.
 */
const TWO_YEAR = path.resolve(
  __dirname,
  '../../tests/fixtures/enbridge-gas-twoyear-synthetic.xml',
);

/** Answer every weather request with a deterministic temperature curve. */
async function mockWeather(page: Page): Promise<void> {
  await page.route('https://archive-api.open-meteo.com/**', async (route) => {
    const url = new URL(route.request().url());
    const start = url.searchParams.get('start_date');
    const end = url.searchParams.get('end_date');
    if (!start || !end) {
      await route.fulfill({ status: 400, json: {} });
      return;
    }
    const time: string[] = [];
    const temperature_2m: number[] = [];
    const dayMs = 86_400_000;
    let day = Date.parse(`${start}T00:00:00Z`);
    const last = Date.parse(`${end}T00:00:00Z`);
    for (; day <= last; day += dayMs) {
      const d = new Date(day);
      const doy = Math.floor((day - Date.UTC(d.getUTCFullYear(), 0, 1)) / dayMs) + 1;
      const seasonal = 5 + 19 * Math.sin((2 * Math.PI * (doy - 110)) / 365);
      for (let h = 0; h < 24; h += 1) {
        time.push(`${d.toISOString().slice(0, 11)}${String(h).padStart(2, '0')}:00`);
        temperature_2m.push(seasonal + 6 * Math.sin((2 * Math.PI * (h - 9)) / 24));
      }
    }
    await route.fulfill({ json: { hourly: { time, temperature_2m } } });
  });
}

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

test.describe('gas usage vs outdoor temperature', () => {
  test('two-year import: seven bands from metered periods, honest coverage, no kWh', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await mockWeather(page);
    await landAndImport(page, TWO_YEAR);
    await openTab(page, 'tab-analytics');

    const card = page.getByTestId('gas-temp-band-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    // The import carries metered readings → the declared interval source.
    await expect(card).toHaveAttribute('data-band-source', 'interval');
    await expect(card).toHaveAttribute('data-matched', String(await card.getAttribute('data-total')));

    // Seven bins, five of them carrying real intervals under this curve.
    const bars = card.getByTestId('gas-temp-band-bar');
    await expect(bars).toHaveCount(7);
    const covered = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('[data-testid="gas-temp-band-bar"]')).filter(
          (el) => Number(el.getAttribute('data-intervals')) > 0,
        ).length,
    );
    expect(covered, `only ${covered} of 7 bands carried intervals`).toBeGreaterThanOrEqual(5);

    // The declared source note and the weather footer are on screen.
    await expect(card).toContainText('Bands average m³ per day');
    await expect(card).toContainText('Open-Meteo (Toronto)');

    // The text alternative: seven rows, every plotted number reachable.
    const table = page.getByTestId('gas-temp-band-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(7);

    // The verdict says the ratio out loud.
    const sentence = page.getByTestId('gas-temp-band-sentence');
    await expect(sentence).toContainText('× as much');

    // Honesty: not one kWh figure anywhere on the painted gas profile.
    const figures = await page.evaluate(
      () => document.body.innerText.match(/(?:\d[\d,.]*\s*kWh|¢\/kWh)/gi) || [],
    );
    expect(figures, `kWh figures leaked: ${figures.join(', ')}`).toEqual([]);
  });

  test('FR: the card localizes from the catalog', async ({ page }) => {
    test.setTimeout(180_000);
    await mockWeather(page);
    await landAndImport(page, TWO_YEAR);
    await openTab(page, 'tab-analytics');

    const toggle = page.getByTestId('locale-toggle');
    await expect(toggle).toHaveAttribute('data-locale', 'en');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-locale', 'fr');

    const card = page.getByTestId('gas-temp-band-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Consommation de gaz vs température extérieure');
    await expect(card).toContainText('durée d\'intervalle indiquée');
    await expect(page.getByTestId('gas-temp-band-table')).toContainText('m³/jour (moy.)');
  });

  test('reduced motion: the card paints its final geometry with the flag set', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockWeather(page);
    await landAndImport(page, TWO_YEAR);
    await openTab(page, 'tab-analytics');

    const plot = page.getByTestId('gas-temp-band-plot');
    await expect(plot).toBeVisible({ timeout: 30_000 });
    await expect(plot).toHaveAttribute('data-reduced-motion', 'true');
    // Final geometry from the first paint: seven bars, no grow-in to wait on.
    await expect(page.getByTestId('gas-temp-band-bar')).toHaveCount(7);
  });

  test('classic route renders the card on its Usage tab', async ({ page }) => {
    test.setTimeout(180_000);
    await mockWeather(page);
    await landAndImport(page, TWO_YEAR);
    await page.goto('/classic#tab=analytics');
    await expect(page.getByTestId('tab-usage')).toHaveAttribute('aria-selected', 'true', {
      timeout: 30_000,
    });
    const card = page.getByTestId('gas-temp-band-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-band-source', 'interval');
    await expect(page.getByTestId('gas-temp-band-bar')).toHaveCount(7);
  });
});
