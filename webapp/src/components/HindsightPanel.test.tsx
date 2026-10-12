/**
 * Wave V — the HINDSIGHT panel, as painted.
 *
 * The numbers come from the engine's own fixtures (real `processRawData`
 * categories, a bill the model reproduces to the cent), so the assertions here
 * are about what the household SEES: two lever chips per period, the three
 * headline numbers and their sum, a move list behind a disclosure, an honest
 * empty state, and a period the engine refuses to price carrying its reason
 * instead of a number.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import {
  planCostFor,
  processRawData,
  type BillLineItem,
  type DataPoint,
  type RateSet,
  type UsageSummary,
} from '@/lib/energy';
import HindsightPanel from './HindsightPanel';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

const line = (note: string, dollars: number, kind = 10): BillLineItem => ({
  note,
  amount: dollars,
  rawAmount: Math.round(dollars * 100000),
  itemKind: kind,
  unitCost: null,
  measurement: null,
});

function localStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0);
}

function dayString(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function hourly(day: string, days: number, kwhAt: (dt: Date) => number) {
  const start = localStart(day);
  const raw: DataPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    for (let h = 0; h < 24; h += 1) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, h, 0, 0);
      raw.push({ timestamp: Math.floor(dt.getTime() / 1000), usage_kwh: kwhAt(dt) });
    }
  }
  return processRawData(raw, [RATES]);
}

/** A TOU winter bill whose commodity lines reproduce the readings exactly. */
function touSummary(day: string, days: number, commodity: number, season = 'Winter'): UsageSummary {
  const start = Math.floor(localStart(day).getTime() / 1000);
  const duration = days * 86400;
  const off = Math.round(commodity * 0.45 * 100) / 100;
  const on = Math.round((commodity - off) * 100) / 100;
  const delivery = 75.5;
  const regulatory = 8.6;
  const total = Math.round((commodity + delivery + regulatory) * 100) / 100;
  return {
    source: 'UsageSummary',
    start,
    duration,
    startDate: day,
    endDate: dayString(new Date((start + duration) * 1000)),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null,
    items: [
      line(`Off Peak-${season}`, off),
      line(`On Peak-${season}`, on),
      line('Delivery', delivery, 4),
      line('Regulatory', regulatory, 4),
      line('H.S.T. # 123456789', Math.round(total * 0.13 * 100) / 100, 5),
      line('Ontario Electricity Rebate', -Math.round(total * 0.235 * 100) / 100, 8),
      line('Total Electricity Charges', total),
    ],
  };
}

/** A house with a 3 kWh/h weekday 07:00–10:00 block over `days` days. */
function house(day: string, days: number, blockKwh = 3.0) {
  const set = new Set([7, 8, 9]);
  const rows = hourly(day, days, (dt) => {
    const dow = dt.getDay();
    const weekday = dow !== 0 && dow !== 6;
    return 0.4 + (weekday && set.has(dt.getHours()) ? blockKwh : 0);
  });
  return { rows, summary: touSummary(day, days, planCostFor(rows, 'TOU')) };
}

describe('HindsightPanel', () => {
  it('paints both levers and an additive headline, signs included', () => {
    const { rows, summary } = house('2026-11-02', 28);
    render(<HindsightPanel summaries={[summary]} allData={rows} />);

    expect(screen.getByTestId('hindsight-panel')).toBeInTheDocument();
    // Signed on purpose: a plan the alternatives would have beaten carries a
    // minus, because the three numbers have to READ as a sum on screen.
    const money = (s: string | null) => {
      const text = (s ?? '').replace(/\s/g, '');
      const value = Number(text.replace(/[^0-9.]/g, ''));
      return /^−/.test(text) ? -value : value;
    };
    const plan = money(screen.getByTestId('hindsight-plan-total').textContent);
    const behaviour = money(screen.getByTestId('hindsight-behaviour-total').textContent);
    const total = money(screen.getByTestId('hindsight-total').textContent);

    expect(behaviour).toBeGreaterThan(0);
    expect(total).toBeCloseTo(plan + behaviour, 2);
    expect(screen.getByTestId('hindsight-lever')).toBeInTheDocument();
  });

  it('gives every period a plan chip AND a behaviour chip', () => {
    const { rows, summary } = house('2026-11-02', 28);
    render(<HindsightPanel summaries={[summary]} allData={rows} />);

    const row = screen.getByTestId(`hindsight-period-${summary.startDate}`);
    expect(within(row).getByTestId('hindsight-plan-chip').textContent).toBeTruthy();
    expect(within(row).getByTestId('hindsight-behaviour-chip').textContent).toMatch(/BEHAVIOUR/);
    expect(within(row).getByTestId('hindsight-plan-badge').textContent).toMatch(/TIME-OF-USE/i);
    expect(row.getAttribute('data-plan')).toBe('TOU');
    expect(row.getAttribute('data-origin')).toBe('detected');
    // The season is stated, because the rates that applied depend on it.
    expect(row.textContent).toMatch(/Winter/i);
  });

  it('hides the move list until the household opens it', () => {
    const { rows, summary } = house('2026-11-02', 28);
    const { container } = render(<HindsightPanel summaries={[summary]} allData={rows} />);

    const details = screen.getByTestId(`hindsight-moves-${summary.startDate}`);
    expect(details.tagName.toLowerCase()).toBe('details');
    expect((details as HTMLDetailsElement).open).toBe(false);
    // The moved block is named, hour by hour, with both rates.
    const mon = within(details).getByTestId('hindsight-move-mon-7-10');
    expect(mon.textContent).toContain('07:00–10:00');
    expect(mon.textContent).toContain('Off-peak');
    expect(mon.textContent).toContain('¢/kWh');
    // The formatter carries the unit: the key must not add a second one.
    expect(mon.textContent).toMatch(/kWh/);
    expect(mon.textContent).not.toMatch(/kWh\s*kWh/);
    expect(container.querySelectorAll('details[data-testid^="hindsight-moves-"]')).toHaveLength(1);
  });

  it('orders the periods worst-first', () => {
    const big = house('2026-11-02', 28, 3.0);
    const small = house('2026-12-01', 28, 1.0);
    render(<HindsightPanel summaries={[small.summary, big.summary]} allData={[...small.rows, ...big.rows]} />);

    const rows = screen.getAllByTestId(/^hindsight-period-/);
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-testid')).toBe(`hindsight-period-${big.summary.startDate}`);
  });

  it('says nothing at all when the file holds no bills', () => {
    const { container } = render(<HindsightPanel summaries={[]} allData={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an honest empty state instead of a number it cannot stand behind', () => {
    // Readings that do not cover the period: both levers are refused.
    const { rows, summary } = house('2026-11-02', 28);
    const partial = rows.slice(0, 24 * 8);
    render(<HindsightPanel summaries={[summary]} allData={partial} />);

    expect(screen.getByTestId('hindsight-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('hindsight-total')).toBeNull();
    const row = screen.getByTestId(`hindsight-period-${summary.startDate}`);
    expect(within(row).getByTestId('hindsight-skip').textContent).toMatch(/readings cover/i);
    expect(within(row).queryByTestId('hindsight-behaviour-chip')).toBeNull();
  });

  it('on a flat rate says the hour does not change the price — not "$0.00 saved"', () => {
    const { rows } = house('2026-11-02', 28);
    const commodity = planCostFor(rows, 'Tiered');
    const summary: UsageSummary = {
      ...touSummary('2026-11-02', 28, 0),
      items: [
        line('BLOCK 1 - Winter', commodity),
        line('Delivery', 75.5, 4),
        line('Regulatory', 8.6, 4),
        line('H.S.T. # 123456789', Math.round((commodity + 84.1) * 0.13 * 100) / 100, 5),
        line('Total Electricity Charges', Math.round((commodity + 84.1) * 100) / 100),
      ],
    };
    render(<HindsightPanel summaries={[summary]} allData={rows} />);

    const chip = screen.getByTestId('hindsight-behaviour-chip');
    expect(chip.textContent).toMatch(/FLAT RATE/);
    expect(screen.getByTestId('hindsight-behaviour-total').textContent).toMatch(/0\.00/);
    // …and the plan lever is still priced beside it.
    expect(screen.getByTestId('hindsight-plan-total').textContent).toBeTruthy();
  });
});
