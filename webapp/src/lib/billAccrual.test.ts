import { describe, it, expect } from 'vitest';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from './energy';
import { projectMonthBill, type BillProjection } from './billProjection';
import { buildAccrualCurve, EMPTY_ACCRUAL } from './billAccrual';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** `days` of hourly readings at `kwhPerHour`, starting at `from` (local). */
function hourly(from: Date, days: number, kwhPerHour: number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const dt = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h);
      raw.push({ timestamp: Math.floor(dt.getTime() / 1000), usage_kwh: kwhPerHour });
    }
  }
  return processRawData(raw, [RATES]);
}

const oct = (day: number) => new Date(2026, 9, day);
/** The open (unbilled) period: all of October 2026. */
const OCTOBER = {
  start: new Date(2026, 9, 1).getTime() / 1000,
  end: new Date(2026, 10, 1).getTime() / 1000,
};

// Tiered tier-1 at 12¢: 1 kWh/hour → 24 kWh/day → $2.88/day.
const KWH = 1;
const DAILY = 2.88;

describe('buildAccrualCurve — no period', () => {
  it('returns the empty model instead of inventing a window', () => {
    const curve = buildAccrualCurve({
      rows: hourly(oct(1), 5, KWH),
      plan: 'Tiered',
      period: null,
      today: oct(10),
      projection: projectMonthBill([], 'Tiered', oct(10)),
    });
    expect(curve).toEqual(EMPTY_ACCRUAL);
    expect(curve.points).toHaveLength(0);
    expect(curve.overPace).toBeNull();
    expect(curve.note).toContain('No open billing period');
  });

  it('rejects a zero-length period', () => {
    const curve = buildAccrualCurve({
      rows: [],
      plan: 'Tiered',
      period: { start: OCTOBER.start, end: OCTOBER.start },
      today: oct(10),
      projection: projectMonthBill([], 'Tiered', oct(10)),
    });
    expect(curve.points).toHaveLength(0);
  });
});

describe('buildAccrualCurve — the accrual itself', () => {
  const rows = hourly(oct(1), 10, KWH); // Oct 1–10
  const projection = projectMonthBill(rows, 'Tiered', oct(10));

  const curve = buildAccrualCurve({
    rows,
    plan: 'Tiered',
    period: OCTOBER,
    today: oct(10),
    projection,
  });

  it('accrues one point per elapsed day of the open period', () => {
    expect(curve.periodStart).toBe('2026-10-01');
    expect(curve.periodEnd).toBe('2026-10-31');
    expect(curve.daysInPeriod).toBe(31);
    expect(curve.daysElapsed).toBe(10);
    expect(curve.points).toHaveLength(10);
    expect(curve.coveredDays).toBe(10);
  });

  it('the running total is the sum of the days actually spent', () => {
    expect(curve.total).toBeCloseTo(10 * DAILY, 6);
    expect(curve.points[0].cumulative).toBeCloseTo(DAILY, 6);
    expect(curve.points[9].cumulative).toBeCloseTo(10 * DAILY, 6);
    // Monotonic: energy costs money, so the curve never dips.
    for (let i = 1; i < curve.points.length; i++) {
      expect(curve.points[i].cumulative).toBeGreaterThanOrEqual(curve.points[i - 1].cumulative);
    }
  });

  it('paces with Wave F projection math and lands on the projected total', () => {
    expect(curve.paceSource).toBe('projection');
    expect(curve.paceDaily).toBeCloseTo(DAILY, 6);
    expect(curve.paceToDate).toBeCloseTo(10 * DAILY, 6);
    expect(curve.projectedTotal).toBeCloseTo(31 * DAILY, 6);
    expect(curve.points[9].pace).toBeCloseTo(curve.paceToDate, 6);
    expect(curve.note).toContain('Wave F');
    expect(curve.note).toContain('$2.88/day');
  });

  it('a month spent exactly on pace reports exactly on pace', () => {
    expect(curve.gap).toBeCloseTo(0, 6);
    expect(curve.overPace).toBe(false);
  });

  it('prices the same accrual under each plan', () => {
    const tou = buildAccrualCurve({ rows, plan: 'TOU', period: OCTOBER, today: oct(10), projection });
    expect(tou.total).not.toBe(curve.total);
    expect(tou.points).toHaveLength(curve.points.length);
  });
});

describe('buildAccrualCurve — above and below the line', () => {
  it('reports a front-loaded period as sitting ABOVE the even-spend line', () => {
    // Five heavy days then five light ones: the accrual runs hot early, then
    // the run-rate cools and the pace line drops under the curve.
    const rows = [...hourly(oct(1), 5, 3 * KWH), ...hourly(oct(6), 5, KWH)];
    const projection = projectMonthBill(rows, 'Tiered', oct(10));
    expect(projection.ready).toBe(true);

    const curve = buildAccrualCurve({ rows, plan: 'Tiered', period: OCTOBER, today: oct(10), projection });
    expect(curve.paceSource).toBe('projection');
    expect(curve.gap).toBeGreaterThan(0);
    expect(curve.overPace).toBe(true);
    // 5 × $8.64 + 5 × $2.88
    expect(curve.total).toBeCloseTo(5 * 8.64 + 5 * DAILY, 6);
    // The landing point is the current run-rate across the whole period.
    expect(curve.projectedTotal).toBeCloseTo(curve.paceDaily * 31, 6);
  });

  it('a single expensive day does not by itself flip the verdict', () => {
    // The pace line is built from the LAST 7 days, so a spike on the final
    // day is already priced into the line it is being compared against.
    const rows = [...hourly(oct(1), 9, KWH), ...hourly(oct(10), 1, 3 * KWH)];
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection: projectMonthBill(rows, 'Tiered', oct(10)),
    });
    expect(curve.paceSource).toBe('projection');
    expect(curve.overPace).toBe(false);
    expect(curve.gap).toBeLessThan(0);
  });
});

describe('buildAccrualCurve — honesty gates', () => {
  it('falls back to the period’s own run-rate when the projection is gated', () => {
    // Day 2 of the month: projectMonthBill refuses (too early), so the pace
    // has to come from somewhere — and it has to say where.
    const rows = hourly(oct(1), 2, KWH);
    const projection = projectMonthBill(rows, 'Tiered', oct(2));
    expect(projection.ready).toBe(false);

    const curve = buildAccrualCurve({ rows, plan: 'Tiered', period: OCTOBER, today: oct(2), projection });
    expect(curve.paceSource).toBe('run-rate');
    expect(curve.paceDaily).toBeCloseTo(DAILY, 6);
    expect(curve.note).toContain('run-rate');
    expect(curve.daysElapsed).toBe(2);
  });

  it('never books a day that has not happened yet', () => {
    // Readings run to Oct 20 but the clock says Oct 10.
    const rows = hourly(oct(1), 20, KWH);
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection: projectMonthBill(rows, 'Tiered', oct(10)),
    });
    expect(curve.daysElapsed).toBe(10);
    expect(curve.points).toHaveLength(10);
    expect(curve.total).toBeCloseTo(10 * DAILY, 6);
    expect(curve.points.at(-1)?.day).toBe('2026-10-10');
  });

  it('stops at the end of the period, not at the end of the data', () => {
    const rows = hourly(oct(25), 20, KWH); // Oct 25 → Nov 13
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(31),
      projection: projectMonthBill(rows, 'Tiered', oct(31)),
    });
    expect(curve.daysInPeriod).toBe(31);
    expect(curve.points.length).toBeLessThanOrEqual(31);
    expect(curve.points.at(-1)?.day).toBe('2026-10-31');
  });

  it('draws no pace line at all when there is nothing to pace', () => {
    const curve = buildAccrualCurve({
      rows: [],
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection: projectMonthBill([], 'Tiered', oct(10)),
    });
    expect(curve.paceSource).toBe('none');
    expect(curve.overPace).toBeNull();
    expect(curve.projectedTotal).toBe(0);
    expect(curve.note).toContain('Not enough readings');
  });

  it('counts a day with no readings as a covered-or-not fact, not as $0 usage', () => {
    // Readings on Oct 1–3 and Oct 5–7: Oct 4 is a hole in the export.
    const rows = [...hourly(oct(1), 3, KWH), ...hourly(oct(5), 3, KWH)];
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(7),
      projection: projectMonthBill(rows, 'Tiered', oct(7)),
    });
    expect(curve.daysElapsed).toBe(7);
    expect(curve.coveredDays).toBe(6);
    expect(curve.points[3].dayCost).toBe(0);
    expect(curve.points[3].day).toBe('2026-10-04');
  });
});

describe('buildAccrualCurve — a projection type guard', () => {
  it('accepts a projection object without ever reading a future date', () => {
    const projection: BillProjection = projectMonthBill([], 'TOU', oct(10));
    expect(projection.ready).toBe(false);
    const curve = buildAccrualCurve({ rows: [], plan: 'TOU', period: OCTOBER, today: oct(10), projection });
    expect(curve.paceSource).toBe('none');
  });
});
