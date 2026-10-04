import { describe, it, expect } from 'vitest';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from './energy';
import {
  projectMonthBill,
  MIN_DAYS_FOR_PROJECTION,
  PROJECTION_RECENT_DAYS,
} from './billProjection';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** `days` of hourly readings starting at `start` (local time). */
function hourlyFrom(start: Date, days: number, kwhPerHour: number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, h, 0, 0);
      raw.push({ timestamp: Math.floor(dt.getTime() / 1000), usage_kwh: kwhPerHour });
    }
  }
  return processRawData(raw, [RATES]);
}

const oct = (day: number) => new Date(2026, 9, day);
const KWH_PER_HOUR = 1; // 24 kWh/day — easy arithmetic on the assertions below

describe('projectMonthBill', () => {
  it('reports no-data for an empty dataset', () => {
    const p = projectMonthBill([], 'Tiered', oct(10));
    expect(p.ready).toBe(false);
    expect(p.emptyReason).toBe('no-data');
    expect(p.gateNote).toContain('No readings for October 2026 yet');
    expect(p.caption).toContain('Commodity cost only');
  });

  it('refuses to project before day 5 and says when it will switch on', () => {
    const rows = hourlyFrom(oct(1), 2, KWH_PER_HOUR);
    const p = projectMonthBill(rows, 'Tiered', oct(2));
    expect(p.ready).toBe(false);
    expect(p.emptyReason).toBe('too-early');
    expect(p.daysIntoMonth).toBe(2);
    expect(p.gateNote).toContain('2 days into October 2026');
    expect(p.gateNote).toContain(`switches on at day ${MIN_DAYS_FOR_PROJECTION}`);
    expect(p.gateNote).toContain('3 to go');
    expect(p.monthLabel).toBe('October 2026');
  });

  it('projects month-to-date + the rest at the recent daily average', () => {
    const rows = hourlyFrom(oct(1), 10, KWH_PER_HOUR); // Oct 1–10, 24 kWh/day
    const p = projectMonthBill(rows, 'Tiered', oct(10));

    expect(p.ready).toBe(true);
    expect(p.emptyReason).toBeNull();
    expect(p.daysIntoMonth).toBe(10);
    expect(p.daysInMonth).toBe(31);
    expect(p.monthDaysCovered).toBe(10);
    expect(p.monthToDateKwh).toBeCloseTo(240, 6);
    // Tiered tier-1 at 12c: 24 kWh/day -> $2.88/day.
    expect(p.monthToDateCost).toBeCloseTo(28.8, 6);
    expect(p.recentDays).toBe(PROJECTION_RECENT_DAYS);
    expect(p.avgDailyKwh).toBeCloseTo(24, 6);
    expect(p.avgDailyCost).toBeCloseTo(2.88, 6);
    expect(p.remainingDays).toBe(21);
    expect(p.projectedKwh).toBeCloseTo(240 + 21 * 24, 6);
    expect(p.projectedCost).toBeCloseTo(28.8 + 21 * 2.88, 6);
    expect(p.dataThrough).toBe('2026-10-10');
    expect(p.caption).toContain('Commodity cost only');
    expect(p.caption).toContain('no delivery, regulatory charges or HST');
    expect(p.caption).toContain('10 of 31 days measured');
    expect(p.caption).toContain('$2.88/day');
    expect(p.gateNote).toBe('');
  });

  it('prices the same month differently per plan', () => {
    const rows = hourlyFrom(oct(1), 10, KWH_PER_HOUR);
    const tou = projectMonthBill(rows, 'TOU', oct(10));
    const tiered = projectMonthBill(rows, 'Tiered', oct(10));
    const ulo = projectMonthBill(rows, 'ULO', oct(10));
    expect(tou.ready && tiered.ready && ulo.ready).toBe(true);
    // Same kWh, three different commodity prices.
    expect(tou.projectedCost).not.toBeCloseTo(tiered.projectedCost, 3);
    expect(ulo.projectedCost).not.toBeCloseTo(tiered.projectedCost, 3);
    expect(tou.projectedKwh).toBeCloseTo(tiered.projectedKwh, 6);
    expect(ulo.projectedKwh).toBeCloseTo(tiered.projectedKwh, 6);
  });

  it('says the month has no readings yet once day 5 has passed', () => {
    const rows = hourlyFrom(new Date(2026, 8, 1), 30, KWH_PER_HOUR); // September only
    const p = projectMonthBill(rows, 'TOU', oct(10));
    expect(p.ready).toBe(false);
    expect(p.emptyReason).toBe('no-data');
    expect(p.monthDaysCovered).toBe(0);
    expect(p.gateNote).toContain('No readings for October 2026 yet');
    expect(p.gateNote).toContain('2026-09-30');
  });

  it('refuses to average a month with fewer than 3 recorded recent days', () => {
    const rows = hourlyFrom(oct(5), 1, KWH_PER_HOUR);
    const p = projectMonthBill(rows, 'Tiered', oct(8));
    expect(p.ready).toBe(false);
    expect(p.emptyReason).toBe('no-recent-data');
    expect(p.monthDaysCovered).toBe(1);
    expect(p.recentDays).toBe(1);
    expect(p.gateNote).toContain('not enough to project');
  });

  it('flags the projection as stale when the data stops short of today', () => {
    const rows = hourlyFrom(oct(1), 10, KWH_PER_HOUR);
    const p = projectMonthBill(rows, 'Tiered', oct(20));
    expect(p.ready).toBe(true);
    expect(p.dataThrough).toBe('2026-10-10');
    expect(p.caption).toContain('Your readings stop at 2026-10-10');
  });

  it('never counts readings that are ahead of the clock', () => {
    const rows = hourlyFrom(oct(1), 12, KWH_PER_HOUR); // runs to Oct 12
    const p = projectMonthBill(rows, 'Tiered', oct(8));
    expect(p.dataThrough).toBe('2026-10-08');
    expect(p.monthDaysCovered).toBe(8);
  });
});
