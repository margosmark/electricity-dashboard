import { describe, it, expect } from 'vitest';
import { buildYearOverYear, type YearOverYearTrend } from './trend';
import { processRawData, type DataPoint, type RateSet } from './energy';

const rateA: RateSet = {
  effectiveDate: '2023-11-01',
  tou: { offPeak: 8.7, midPeak: 12.2, onPeak: 18.2 },
  tiered: { tier1: 10.3, tier2: 12.5, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 2.4, weekendOffPeak: 8.7, midPeak: 12.2, onPeak: 24.0 },
};

const rateB: RateSet = {
  effectiveDate: '2024-11-01',
  tou: { offPeak: 8.7, midPeak: 12.2, onPeak: 18.2 },
  tiered: { tier1: 10.3, tier2: 12.5, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 2.8, weekendOffPeak: 8.7, midPeak: 12.2, onPeak: 28.6 },
};

const rateC: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

const ALL_RATES = [rateA, rateB, rateC];

/**
 * One reading per day at 12:00 local, `kwhPerDay` for every day in the range.
 * Runs through the real processRawData so activeRateSet assignment matches prod.
 */
function makeData(
  start: Date,
  end: Date,
  kwhPerDay: number,
  rates: RateSet[] = ALL_RATES,
): ReturnType<typeof processRawData> {
  const raw: DataPoint[] = [];
  const cur = new Date(start);
  cur.setHours(12, 0, 0, 0);
  const stop = new Date(end);
  stop.setHours(23, 59, 59, 999); // include the end day itself
  while (cur <= stop) {
    raw.push({ timestamp: Math.floor(cur.getTime() / 1000), usage_kwh: kwhPerDay });
    cur.setDate(cur.getDate() + 1);
  }
  return processRawData(raw, rates);
}

/** July 1 → Oct 1 2026: matches the currently-loaded dataset shape. */
function recentFourMonths(): ReturnType<typeof processRawData> {
  return makeData(new Date(2026, 6, 1), new Date(2026, 9, 1), 20);
}

describe('buildYearOverYear', () => {
  it('is not ready with no data and says so honestly', () => {
    const t = buildYearOverYear([]);
    expect(t.ready).toBe(false);
    expect(t.emptyMessage).toMatch(/upload/i);
    expect(t.series).toHaveLength(0);
  });

  it('gates the 4-month dataset (Jul–Oct 2026) with an honest "need 12+ months" message', () => {
    const t = buildYearOverYear(recentFourMonths());
    expect(t.ready).toBe(false);
    expect(t.emptyMessage).toContain('Need 12+ months of data');
    expect(t.emptyMessage).toContain('4 months'); // distinct months Jul..Oct 2026
    expect(t.firstMonthLabel).toBe('Jul 2026');
    expect(t.lastMonthLabel).toBe('Oct 2026');
    // The builder still computes what it can; the PANEL keys off `ready`
    // and renders the empty state instead of a half-baked chart.
    expect(t.series).toHaveLength(1);
    expect(t.deltas).toHaveLength(0); // 2025 absent → no prior year to compare
  });

  it('gates a 4-month span with a single rate set (current real dataset pre-2025 history)', () => {
    // Jul–Oct 2026 only, one rate set: neither gate condition met
    const data = makeData(new Date(2026, 6, 1), new Date(2026, 9, 1), 15);
    const t = buildYearOverYear(data);
    expect(t.ready).toBe(false);
    expect(t.spanMonths).toBe(4);
    expect(t.rateSetChanges).toBe(0);
    expect(t.emptyMessage).toContain('Need 12+ months');
  });

  it('becomes ready past 12 calendar months of span (one rate-set change)', () => {
    // 13 calendar months: Jun 2025 → Jun 2026, crosses the 2025-11-01 change
    const data = makeData(new Date(2025, 5, 15), new Date(2026, 5, 14), 10);
    const t = buildYearOverYear(data);
    expect(t.ready).toBe(true);
    expect(t.spanMonths).toBeGreaterThan(12);
    expect(t.emptyMessage).toBeNull();
  });

  it('becomes ready after >1 rate-set change even inside 12 months', () => {
    // Mid-year change (2025-06-01) on top of the Nov 1 changes: Oct 2024 →
    // Aug 2025 spans only ~11 calendar months but crosses two boundaries.
    const midYearChange: RateSet = {
      effectiveDate: '2025-06-01',
      tou: { offPeak: 9.0, midPeak: 13.0, onPeak: 19.0 },
      tiered: { tier1: 11.0, tier2: 13.0, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.0, weekendOffPeak: 9.0, midPeak: 13.0, onPeak: 30.0 },
    };
    const data = makeData(new Date(2024, 9, 15), new Date(2025, 7, 15), 12,
      [rateA, rateB, midYearChange]);
    const t = buildYearOverYear(data);
    expect(t.spanMonths).toBeLessThanOrEqual(12);
    expect(t.rateSetChanges).toBe(2);
    expect(t.ready).toBe(true);
  });

  it('reports exactly one rate-set change as NOT ready (spec: >1 change)', () => {
    // Oct 2024 → Sep 2025 crosses only the 2024-11-01 boundary = 1 change
    const data = makeData(new Date(2024, 9, 1), new Date(2025, 8, 30), 10);
    const t = buildYearOverYear(data);
    expect(t.rateSetChanges).toBe(1);
    expect(t.spanMonths).toBe(12);
    expect(t.ready).toBe(false);
  });

  it('aggregates kWh per month-of-year per year and computes YoY delta %', () => {
    // Full year 2025 + matching months of 2026
    const data = makeData(new Date(2025, 0, 1), new Date(2026, 5, 30), 10);
    const t = buildYearOverYear(data);
    expect(t.ready).toBe(true);
    expect(t.years).toEqual([2025, 2026]);

    const s2025 = t.series.find((s) => s.year === 2025)!;
    const s2026 = t.series.find((s) => s.year === 2026)!;
    // Jan 2025: 31 days × 10 kWh
    expect(s2025.kwh[0]).toBeCloseTo(310, 5);
    // Feb 2025: 28 days × 10
    expect(s2025.kwh[1]).toBeCloseTo(280, 5);
    // Jul 2025 falls inside the range: 31 days × 10 kWh
    expect(s2025.kwh[6]).toBeCloseTo(310, 5);
    // ...but Nov/Dec 2025 are beyond the Jun 2026 end only for 2026; 2025 is
    // fully covered, so no nulls there (absent months elsewhere stay null)
    expect(s2025.kwh[11]).toBeCloseTo(310, 5);
    // Jan 2026 present
    expect(s2026.kwh[0]).toBeCloseTo(310, 5);
    // Jul 2026 not yet in data → null
    expect(s2026.kwh[6]).toBeNull();

    // Delta row for 2026 vs 2025: same rate, same daily kWh → 0% for Jan
    const d2026 = t.deltas.find((d) => d.year === 2026)!;
    expect(d2026.label).toBe('2026 vs 2025');
    expect(d2026.pct[0]).toBeCloseTo(0, 5);
    // Jul has no 2026 data → null (honest "not comparable", not 0%)
    expect(d2026.pct[6]).toBeNull();
    // 2025 gets no delta row (its prior year isn't present)
    expect(t.deltas.find((d) => d.year === 2025)).toBeUndefined();
  });

  it('computes non-zero delta % when usage changes year over year', () => {
    const y1 = makeData(new Date(2025, 0, 1), new Date(2025, 11, 31), 10);
    const y2 = makeData(new Date(2026, 0, 1), new Date(2026, 5, 30), 15);
    const t = buildYearOverYear([...y1, ...y2]);
    expect(t.ready).toBe(true);
    const d = t.deltas.find((x) => x.year === 2026)!;
    // +50% every overlapping month
    expect(d.pct[0]).toBeCloseTo(50, 5);
    expect(d.pct[5]).toBeCloseTo(50, 5);
    // December has no 2026 data → null
    expect(d.pct[11]).toBeNull();
  });

  it('flags rate-set boundaries that fall inside the data span', () => {
    // Spans 2024-11-01 AND 2025-11-01 boundaries
    const data = makeData(new Date(2024, 9, 1), new Date(2026, 0, 31), 10);
    const t = buildYearOverYear(data);
    expect(t.boundaries).toEqual(['2024-11-01', '2025-11-01']);
    expect(t.rateSetChanges).toBe(2); // rateB, rateC (rateA only if pre-2024-11 data)
    expect(t.ready).toBe(true);
  });

  it('does not flag a boundary the dataset starts after', () => {
    const data = makeData(new Date(2025, 10, 5), new Date(2026, 0, 31), 10);
    const t = buildYearOverYear(data);
    expect(t.boundaries).toEqual([]); // 2025-11-01 precedes first reading
    expect(t.rateSetChanges).toBe(0);
  });

  it('marks first/last calendar months as partial when data does not cover them fully', () => {
    const data = makeData(new Date(2025, 6, 15), new Date(2026, 6, 10), 10);
    const t = buildYearOverYear(data);
    expect(t.partialMonths).toContain('2025-07'); // starts Jul 15
    expect(t.partialMonths).toContain('2026-07'); // ends Jul 10
    expect(t.partialMonths).not.toContain('2025-08');
  });

  it('does not mark a partial month when data covers the full calendar month', () => {
    const data = makeData(new Date(2025, 6, 1), new Date(2026, 6, 31), 10);
    const t = buildYearOverYear(data);
    expect(t.partialMonths).toHaveLength(0);
  });

  it('counts distinct months of data separately from calendar span', () => {
    // Gap: Jul–Sep 2025 then Jul–Oct 2026 → 7 distinct months, 16-month span
    const a = makeData(new Date(2025, 6, 1), new Date(2025, 8, 30), 10);
    const b = makeData(new Date(2026, 6, 1), new Date(2026, 9, 1), 10);
    const t = buildYearOverYear([...a, ...b]);
    expect(t.spanMonths).toBe(16);
    expect(t.monthsOfData).toBe(7);
    expect(t.ready).toBe(true); // span > 12 months
  });

  it('handles duplicate timestamps/unsorted input without corrupting sums', () => {
    const a = makeData(new Date(2025, 0, 1), new Date(2026, 0, 31), 10);
    const shuffled = [...a].reverse();
    const t = buildYearOverYear(shuffled);
    const s = t.series.find((x) => x.year === 2025)!;
    expect(s.kwh[0]).toBeCloseTo(310, 5);
  });
});

describe('YearOverYearTrend shape contract', () => {
  it('always exposes the fields the panel reads', () => {
    const t: YearOverYearTrend = buildYearOverYear(recentFourMonths());
    for (const key of [
      'ready', 'emptyMessage', 'years', 'series', 'deltas',
      'boundaries', 'partialMonths', 'spanMonths', 'rateSetChanges',
      'monthsOfData', 'firstMonthLabel', 'lastMonthLabel',
    ]) {
      expect(t).toHaveProperty(key);
    }
  });
});
