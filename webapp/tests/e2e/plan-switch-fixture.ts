/**
 * Synthetic browser fixture for populated Plan-Switch acceptance.
 *
 * Load with `await seedPlanSwitchFixture(page)` before navigating to the app.
 * All billing periods, bill lines and readings are synthetic and deterministic;
 * no private/customer export is read or written.
 */
import type { Page } from '@playwright/test';
import type { UsageSummary } from '../../src/lib/energy';
import sourceSummaries from '../fixtures/plan-switch-browser-periods.json';

const PERIODS = sourceSummaries as UsageSummary[];

const BASE_RATES = {
  effectiveDate: '2023-01-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};
const TIERED_WINS = {
  ...BASE_RATES,
  tou: { offPeak: 100, midPeak: 100, onPeak: 100 },
  tiered: { ...BASE_RATES.tiered, tier1: 0.1, tier2: 0.1 },
  ulo: { overnight: 100, weekendOffPeak: 100, midPeak: 100, onPeak: 100 },
};

function withTotal(summary: (typeof PERIODS)[number], amount: number, tiered = false) {
  return {
    ...summary,
    items: summary.items.map((item) => {
      if (item.note === 'Total Electricity Charges') return { ...item, amount };
      if (tiered && /peak/i.test(item.note)) return { ...item, note: 'Tiered' };
      return item;
    }),
  };
}

export function makePlanSwitchFixture() {
  const summaries = [
    withTotal(PERIODS[0], 10_000),
    withTotal(PERIODS[1], 0, true),
    withTotal(PERIODS[2], 10_000),
  ];
  const points = summaries.flatMap((summary) => {
    const rows: { timestamp: number; usage_kwh: number }[] = [];
    for (let day = 0; day < summary.days; day++) {
      const date = new Date(`${summary.startDate}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + day);
      for (let hour = 0; hour < 24; hour++) {
        date.setUTCHours(hour);
        rows.push({ timestamp: Math.floor(date.getTime() / 1000), usage_kwh: 1.5 });
      }
    }
    return rows;
  });
  return { summaries, points };
}

/**
 * Seed only app-owned fixture keys in this isolated browser context. Call
 * before page.goto; an empty-state pass should use a fresh context without
 * this helper. `#tab=plans` selects the report directly after startup.
 */
export async function seedPlanSwitchFixture(page: Page) {
  const fixture = makePlanSwitchFixture();
  await page.route('**/api/rates', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ historicalRates: planSwitchFixtureRates }),
  }));
  await page.addInitScript(({ summaries, points }) => {
    localStorage.setItem('energy_data_v2', JSON.stringify({
      version: 2,
      uploadedAt: '2026-01-01T00:00:00.000Z',
      source: 'synthetic-plan-switch-fixture',
      points,
    }));
    localStorage.setItem('usage_summaries', JSON.stringify(summaries));
    localStorage.setItem('billing_day', '1');
    localStorage.removeItem('energy_data_is_example');
  }, fixture);
}

export const planSwitchFixtureRates = [
  { ...BASE_RATES, effectiveDate: PERIODS[0].startDate },
  { ...TIERED_WINS, effectiveDate: PERIODS[1].startDate },
  { ...BASE_RATES, effectiveDate: PERIODS[2].startDate },
];
