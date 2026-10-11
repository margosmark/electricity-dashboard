import { describe, it, expect } from 'vitest';
import { buildHeatmapData, processRawData, type DataPoint, type RateSet } from './energy';
import { DAY_LABELS, heatColor, splitHeatmap, WEEKEND_ROWS, WEEKDAY_ROWS } from './heatmapSplit';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/**
 * Two weeks of hourly readings: a weekday 19:00 charger block (2 kWh/hour)
 * and a flat 0.5 kWh/hour background. Weekends carry NO charger, which is
 * exactly the pattern the merged grid hides.
 */
function evWeekdays(from: Date, weeks: number): DataPoint[] {
  const raw: DataPoint[] = [];
  for (let w = 0; w < weeks * 7; w++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + w);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    for (let h = 0; h < 24; h++) {
      const ev = !weekend && h === 19;
      raw.push({
        timestamp: Math.floor(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime() / 1000),
        usage_kwh: ev ? 2.0 : 0.5,
      });
    }
  }
  return raw;
}

describe('splitHeatmap', () => {
  // 2026-10-05 is a Monday, so week 1 gives Mon–Sun in order.
  const grid = buildHeatmapData(processRawData(evWeekdays(new Date(2026, 9, 5), 2), [RATES]));

  it('produces a 5-row weekday grid and a 2-row weekend grid', () => {
    const split = splitHeatmap(grid);
    expect(split.weekday.rows).toHaveLength(5);
    expect(split.weekend.rows).toHaveLength(2);
    expect(split.weekday.dayLabels).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(split.weekend.dayLabels).toEqual(['Sat', 'Sun']);
  });

  it('orders rows the way a person reads them, not the way Date.getDay() does', () => {
    expect(WEEKDAY_ROWS).toEqual([1, 2, 3, 4, 5]);
    expect(WEEKEND_ROWS).toEqual([6, 0]);
    expect(DAY_LABELS[0]).toBe('Sun');
    expect(DAY_LABELS[6]).toBe('Sat');
  });

  it('re-orders cells without re-averaging a single one of them', () => {
    const split = splitHeatmap(grid);
    // Monday 19:00 is grid row 1, hour 19.
    expect(split.weekday.rows[0][19]).toBe(grid.grid[1][19]);
    expect(split.weekend.rows[0][19]).toBe(grid.grid[6][19]);
    expect(split.weekend.rows[1][19]).toBe(grid.grid[0][19]);
    // Same objects, not copies: the split cannot be where numbers drift.
    expect(split.weekday.rows[0][19].avg).toBeCloseTo(grid.grid[1][19].avg, 10);
  });

  it('keeps ONE colour scale across both grids so they stay comparable', () => {
    const split = splitHeatmap(grid);
    expect(split.maxAvg).toBe(grid.maxAvg);
    // The EV hour really is the loud cell on weekdays.
    expect(grid.grid[1][19].avg).toBeGreaterThan(grid.grid[1][10].avg);
    // ...and weekends do not have it, which is the whole reason to split.
    expect(grid.grid[6][19].avg).toBeLessThan(grid.grid[1][19].avg);
  });

  it('carries day coverage into the group for the caption', () => {
    const split = splitHeatmap(grid);
    expect(split.weekday.days).toBeGreaterThanOrEqual(2);
    expect(split.weekend.days).toBeGreaterThanOrEqual(2);
  });

  it('survives an empty grid without dividing by zero', () => {
    const empty = { grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, count: 0, days: 0, avg: 0 }))), maxAvg: 0 };
    const split = splitHeatmap(empty);
    expect(split.weekday.rows).toHaveLength(5);
    expect(heatColor(0, split.maxAvg)).toBe('bg-[var(--heat-0)]');
  });
});

describe('heatColor', () => {
  it('uses the same buckets as the original 7×24 grid', () => {
    // t_d5d0a86b: the two PALE steps are theme tokens now (slate-100 was a
    // white hole on a dark card, blue-300 a pastel that fought the navy).
    // The three saturated steps stay literal — they read on both themes, and
    // keeping them literal is what keeps this bucket test honest.
    expect(heatColor(1, 10)).toBe('bg-[var(--heat-0)]'); // 0.10
    expect(heatColor(3, 10)).toBe('bg-[var(--heat-1)] border-blue-500'); // 0.30
    expect(heatColor(5, 10)).toBe('bg-yellow-400 border-yellow-600'); // 0.50
    expect(heatColor(7, 10)).toBe('bg-orange-500 border-orange-700'); // 0.70
    expect(heatColor(9, 10)).toBe('bg-red-600 border-red-800'); // 0.90
  });

  it('treats zero as "no data", not as "the quietest reading"', () => {
    expect(heatColor(0, 10)).toBe('bg-[var(--heat-0)]');
    expect(heatColor(5, 0)).toBe('bg-[var(--heat-0)]');
  });
});
