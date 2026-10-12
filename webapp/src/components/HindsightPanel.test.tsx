/**
 * Wave V (corrected) — the HINDSIGHT panel, as painted.
 *
 * The numbers come from the engine's own fixtures (real `processRawData`
 * categories, a bill the model reproduces to the cent), so the assertions here
 * are about what the household SEES: one plan verdict per closed period, a
 * single headline number, an honest empty state, and a period the engine
 * refuses to price carrying its reason instead of a number.
 *
 * The panel is also pinned on what it must NOT show: no behaviour chip, no
 * move list, no hypothetical-usage wording of any kind.
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

/** Readings that only ever run 00:00–06:00 — billed on Tiered, TOU/ULO win. */
function nightHouse(day: string, days: number, kwh = 3.0) {
  const rows = hourly(day, days, (dt) => (dt.getHours() < 6 ? kwh : 0));
  const commodity = planCostFor(rows, 'Tiered');
  const summary: UsageSummary = {
    ...touSummary(day, days, 0),
    items: [
      line('BLOCK 1 - Winter', commodity),
      line('Delivery', 75.5, 4),
      line('Regulatory', 8.6, 4),
      line('H.S.T. # 123456789', Math.round((commodity + 84.1) * 0.13 * 100) / 100, 5),
      line('Total Electricity Charges', Math.round((commodity + 84.1) * 100) / 100),
    ],
  };
  return { rows, summary };
}

describe('HindsightPanel', () => {
  it('paints ONE plan headline — the plan you were on, against the other two', () => {
    const { rows, summary } = nightHouse('2026-11-02', 28);
    const { container } = render(<HindsightPanel summaries={[summary]} allData={rows} />);

    expect(screen.getByTestId('hindsight-panel')).toBeInTheDocument();
    expect(screen.getByTestId('hindsight-plan-total').textContent).toBeTruthy();
    // There is no second lever and no sum of levers on this surface.
    expect(screen.queryByTestId('hindsight-behaviour-total')).toBeNull();
    expect(screen.queryByTestId('hindsight-total')).toBeNull();
    expect(container.querySelector('[data-testid^="hindsight-moves-"]')).toBeNull();
    expect(container.querySelector('[data-testid="hindsight-behaviour-chip"]')).toBeNull();
  });

  it('never mentions behaviour, a move or a hypothetical shift', () => {
    const { rows, summary } = nightHouse('2026-11-02', 28);
    const { container } = render(<HindsightPanel summaries={[summary]} allData={rows} />);
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/behaviour/i);
    expect(text).not.toMatch(/\bmove[ds]?\b/i);
    expect(text).not.toMatch(/had run in|would have done|if you had|shift/i);
    // …and it does say what it IS doing.
    expect(text).toMatch(/same readings/i);
    expect(text).toMatch(/Time-of-Use|tiered|ultra-low/i);
  });

  it('gives every period its plan chip, detected badge and season', () => {
    const { rows, summary } = house('2026-11-02', 28);
    render(<HindsightPanel summaries={[summary]} allData={rows} />);

    const row = screen.getByTestId(`hindsight-period-${summary.startDate}`);
    expect(within(row).getByTestId('hindsight-plan-chip').textContent).toBeTruthy();
    expect(within(row).getByTestId('hindsight-plan-badge').textContent).toMatch(/TIME-OF-USE/i);
    expect(row.getAttribute('data-plan')).toBe('TOU');
    expect(row.getAttribute('data-origin')).toBe('detected');
    // The season is stated, because the rates that applied depend on it.
    expect(row.textContent).toMatch(/Winter/i);
    // The period states the kWh that were actually metered.
    expect(row.textContent).toMatch(/kWh/);
  });

  it('names the better plan when the billed one was not it', () => {
    const { rows, summary } = nightHouse('2026-11-02', 28);
    render(<HindsightPanel summaries={[summary]} allData={rows} />);

    const chip = screen.getByTestId('hindsight-plan-chip').textContent ?? '';
    expect(chip).toMatch(/WOULD HAVE SAVED/);
    expect(chip).toMatch(/Ultra-Low|Time-of-Use/i);
    expect(screen.getByTestId(`hindsight-worst-${summary.startDate}`)).toBeInTheDocument();
  });

  it('orders the periods worst-first', () => {
    const big = nightHouse('2026-11-02', 28, 3.0);
    const small = nightHouse('2026-12-01', 28, 1.0);
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
    // Readings that do not cover the period: nothing is priced.
    const { rows, summary } = house('2026-11-02', 28);
    const partial = rows.slice(0, 24 * 8);
    render(<HindsightPanel summaries={[summary]} allData={partial} />);

    expect(screen.getByTestId('hindsight-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('hindsight-plan-total')).toBeNull();
    const row = screen.getByTestId(`hindsight-period-${summary.startDate}`);
    expect(within(row).getByTestId('hindsight-skip').textContent).toMatch(/readings cover/i);
    expect(within(row).queryByTestId('hindsight-plan-chip')).toBeNull();
  });

  it('claims nothing when the plan cannot be known', () => {
    const { rows, summary } = house('2026-11-02', 28);
    const silent: UsageSummary = {
      ...summary,
      items: [
        line('Monthly Basic Charge', 18.4),
        line('Standard Service Charge', 5.0, 4),
        line('Total Electricity Charges', 23.4),
      ],
    };
    render(<HindsightPanel summaries={[silent]} allData={rows} />);

    const row = screen.getByTestId(`hindsight-period-${silent.startDate}`);
    expect(within(row).getByTestId('hindsight-plan-chip').textContent).toMatch(/UNKNOWN/);
    expect(screen.getByTestId('hindsight-empty')).toBeInTheDocument();
  });
});
