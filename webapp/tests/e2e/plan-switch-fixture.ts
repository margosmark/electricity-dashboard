/**
 * Synthetic browser fixture for populated Plan-Switch acceptance.
 *
 * Load with `await seedPlanSwitchFixture(page)` before navigating to the app.
 * All billing periods, bill lines and readings are synthetic and deterministic;
 * no private/customer export is read or written.
 */
import type { Page } from '@playwright/test';
import type { UsageSummary } from '../../src/lib/energy';
import { billTotals, billWindow, classifyBillLine, planCostFor, processRawData } from '../../src/lib/energy';
import sourceSummaries from '../fixtures/plan-switch-browser-periods.json';

const PERIODS = sourceSummaries as UsageSummary[];

const BASE_RATES = {
  effectiveDate: '2023-01-01',
  tou: { offPeak: 25, midPeak: 30, onPeak: 35 },
  tiered: { tier1: 12, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};
const TIERED_WINS = {
  ...BASE_RATES,
  tou: { offPeak: 100, midPeak: 100, onPeak: 100 },
  tiered: { ...BASE_RATES.tiered, tier1: 0.1, tier2: 0.1 },
  ulo: { overnight: 100, weekendOffPeak: 100, midPeak: 100, onPeak: 100 },
};

function withPlan(summary: (typeof PERIODS)[number], tiered = false) {
  return {
    ...summary,
    items: summary.items.map((item) => {
      if (tiered && /peak/i.test(item.note)) return { ...item, note: 'Tiered' };
      return item;
    }),
  };
}

function reconcileSyntheticBill(summary: UsageSummary, actualPlan: 'TOU' | 'Tiered', cost: number): UsageSummary {
  const original = billTotals(summary);
  const total = cost + original.delivery + original.regulatory;
  const taxRate = original.total > 0 ? original.tax / original.total : 0;
  const creditRate = original.total > 0 ? original.credit / original.total : 0;
  let assignedCommodity = false;
  return {
    ...summary,
    items: summary.items.map((item) => {
      const line = classifyBillLine(item);
      if (line === 'commodity') {
        const isPlanEvidence = actualPlan === 'Tiered'
          ? /tier|block|bloc/i.test(item.note)
          : /peak/i.test(item.note);
        if (isPlanEvidence && !assignedCommodity) {
          assignedCommodity = true;
          return { ...item, amount: cost };
        }
        return { ...item, amount: 0 };
      }
      if (line === 'total') return { ...item, amount: total };
      if (line === 'tax') return { ...item, amount: total * taxRate };
      if (line === 'credit') return { ...item, amount: total * creditRate };
      return item;
    }),
  };
}

export function makePlanSwitchFixture() {
  const source = [
    withPlan(PERIODS[0]),
    withPlan(PERIODS[1], true),
    withPlan(PERIODS[2]),
  ];
  const points = source.flatMap((summary) => {
    const rows: { timestamp: number; usage_kwh: number }[] = [];
    const hourlyUsage = (summary.consumption?.scaled ?? 0) / (summary.days * 24);
    for (let day = 0; day < summary.days; day++) {
      const date = new Date(`${summary.startDate}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + day);
      for (let hour = 0; hour < 24; hour++) {
        date.setUTCHours(hour);
        rows.push({ timestamp: Math.floor(date.getTime() / 1000), usage_kwh: hourlyUsage });
      }
    }
    return rows;
  });
  const priced = processRawData(points, planSwitchFixtureRates);
  const plans = ['TOU', 'Tiered', 'TOU'] as const;
  const summaries = source.map((summary, index) => {
    const { start, end } = billWindow(summary);
    const rows = priced.filter((point) => point.timestamp >= start && point.timestamp < end);
    return reconcileSyntheticBill(summary, plans[index], planCostFor(rows, plans[index]));
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
