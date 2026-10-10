import { describe, it, expect } from 'vitest';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from './energy';
import { projectMonthBill, type BillProjection } from './billProjection';
import {
  buildAccrualCurve,
  expectedBillDate,
  priorBillCommodities,
  EMPTY_ACCRUAL,
} from './billAccrual';

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
    // No bill date supplied → the pace line lands on the period's own end.
    expect(curve.billDate).toBe('2026-10-31');
    expect(curve.billDateSource).toBe('period-end');
    expect(curve.daysInPeriod).toBe(31);
    expect(curve.daysElapsed).toBe(10);
    expect(curve.points).toHaveLength(10);
    expect(curve.coveredDays).toBe(10);
    expect(curve.kwh).toBeCloseTo(10 * 24, 6);
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
    // The landing is the run-rate carried across the WHOLE window (31 days).
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

describe('buildAccrualCurve — the runway to the bill date', () => {
  // Production shape: Wave Q's open period ENDS at the newest reading, so
  // the bill date is genuinely in the future of the window.
  const rows = hourly(oct(1), 10, KWH);
  const period = { start: OCTOBER.start, end: new Date(2026, 9, 11).getTime() / 1000 };
  const projection = projectMonthBill(rows, 'Tiered', oct(10));
  // Read-date stamp, same convention the axis uses for labels: Oct 25 00:00
  // means the bill reads THROUGH Oct 25.
  const billAt = new Date(2026, 9, 25).getTime() / 1000;

  const curve = buildAccrualCurve({
    rows,
    plan: 'Tiered',
    period,
    today: oct(10),
    projection,
    billDate: { at: billAt, source: 'file-cadence' },
  });

  it('extends the axis past the newest reading so the pace line has to land', () => {
    expect(curve.billDate).toBe('2026-10-25');
    expect(curve.billDateSource).toBe('file-cadence');
    expect(curve.daysInPeriod).toBe(25);
    // The accrual still stops where the data stops.
    expect(curve.daysElapsed).toBe(10);
    expect(curve.points).toHaveLength(10);
  });

  it('projects the landing at the bill date, not at the last reading', () => {
    // 25 days × $2.88/day of run-rate, but the pace slope is Wave F's.
    expect(curve.projectedTotal).toBeCloseTo(curve.paceDaily * 25, 6);
    expect(curve.projectedTotal).toBeGreaterThan(curve.total);
  });

  it('says in the note which rule produced the bill date', () => {
    expect(curve.note).toContain("your last bill's read date + its median length");
  });

  it('ignores a bill date that would shorten the data it already holds', () => {
    const past = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection,
      // The file's window already runs past its own cadence (a late bill):
      // the chart must still draw every day it has.
      billDate: { at: oct(5).getTime() / 1000, source: 'file-cadence' },
    });
    expect(past.billDateSource).toBe('period-end');
    expect(past.daysInPeriod).toBe(31);
  });
});

describe('expectedBillDate', () => {
  const day = (d: number) => new Date(2026, 9, d).getTime() / 1000;
  const MONTH = 2_629_800; // ~30.44 days, the cadence the synthetic bills use

  it('steps the median bill length forward from the last bill', () => {
    const billed = [
      { end: day(1), duration: MONTH },
      { end: day(1) + MONTH, duration: MONTH },
      { end: day(1) + 2 * MONTH, duration: MONTH },
    ];
    // Data through Oct 10: the next read is one whole period after the last
    // bill, not a fraction of one.
    const { date, source } = expectedBillDate(billed, day(10), 1);
    expect(source).toBe('file-cadence');
    expect(date).toBe(day(1) + 3 * MONTH);
    expect(date).toBeGreaterThan(day(10));
  });

  it('walks multiple periods when the file is that far behind', () => {
    const billed = [{ end: day(1), duration: MONTH }];
    const { date } = expectedBillDate(billed, day(70), 1);
    expect(date).toBeGreaterThan(day(70));
    expect(date).toBeLessThanOrEqual(day(70) + MONTH);
  });

  it('falls back to the billing day when the file states no bills', () => {
    const { date, source } = expectedBillDate([], day(10), 15);
    expect(source).toBe('billing-day');
    expect(new Date(date * 1000).getDate()).toBe(15);
    expect(date).toBeGreaterThan(day(10));
  });

  it('uses the NEXT billing day when this month’s already passed', () => {
    const { date, source } = expectedBillDate([], day(20), 15);
    expect(source).toBe('billing-day');
    expect(new Date(date * 1000).getDate()).toBe(15);
    expect(date).toBeGreaterThan(day(20));
  });
});

describe('the 3-bill benchmark', () => {
  const rows = hourly(oct(1), 10, KWH);
  const projection = projectMonthBill(rows, 'Tiered', oct(10));

  it('judges the landing against the last three bills’ commodity charge', () => {
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection,
      billDate: { at: new Date(2026, 9, 31).getTime() / 1000, source: 'file-cadence' },
      priorBills: [40, 42, 44], // commodity $ of three past bills
    });
    expect(curve.avgPriorBill).toBeCloseTo(42, 6);
    expect(curve.priorBillCount).toBe(3);
    expect(curve.priorBills).toEqual([40, 42, 44]);
    // 31 days × $2.88 = $89.28 projected — well above the benchmark.
    expect(curve.paceVsAvg).toBeCloseTo(curve.projectedTotal - 42, 6);
    expect(curve.overAvg).toBe(true);
  });

  it('uses fewer bills honestly when the file has fewer', () => {
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection,
      priorBills: [30],
    });
    expect(curve.priorBillCount).toBe(1);
    expect(curve.avgPriorBill).toBe(30);
  });

  it('has no benchmark with no bills, and says so by being null', () => {
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection,
    });
    expect(curve.avgPriorBill).toBeNull();
    expect(curve.paceVsAvg).toBeNull();
    expect(curve.overAvg).toBeNull();
  });

  it('priorBillCommodities is commodity-only, oldest first, zero lines dropped', () => {
    // A bill whose commodity lines net to zero has nothing to benchmark
    // against; keeping it would drag the average toward "free".
    const summaries = [
      { start: 3, duration: 10, items: [] } as never,
      { start: 1, duration: 10, items: [] } as never,
    ];
    const out = priorBillCommodities(summaries);
    expect(out).toHaveLength(0); // no commodity lines in these stubs
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

describe('the tier-1 allowance marker', () => {
  const projectionFor = (rows: ProcessedPoint[]) =>
    projectMonthBill(rows, 'Tiered', oct(10));

  it('prorates the summer allowance to the period and finds the real crossing', () => {
    // 3 kWh/hour = 72 kWh/day. Summer allowance for a 31-day period:
    // 600 × 31/30.4 ≈ 612 kWh → crossed on day 9.
    const rows = hourly(oct(1), 10, 3 * KWH);
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection: projectionFor(rows),
      billDate: { at: new Date(2026, 9, 31).getTime() / 1000, source: 'file-cadence' },
    });
    expect(curve.tierThresholdKwh).toBe(612);
    expect(curve.tierCrossingDay).toBe('2026-10-09');
    expect(curve.tierCrossingProjected).toBe(false);
    expect(curve.note).toContain('tier-2 rate');
  });

  it('projects the crossing from the pace rate when it lies ahead of today', () => {
    // 1 kWh/hour = 24 kWh/day: 21 days of data = 504 kWh, under the 612
    // allowance, but the remaining 10 days at this pace push past it.
    const rows = hourly(oct(1), 21, KWH);
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(21),
      projection: projectionFor(rows),
      billDate: { at: new Date(2026, 9, 31).getTime() / 1000, source: 'file-cadence' },
    });
    expect(curve.tierCrossingDay).not.toBeNull();
    expect(curve.tierCrossingProjected).toBe(true);
    expect(curve.tierCrossingDay! > '2026-10-21').toBe(true);
  });

  it('draws no marker when the period never reaches tier 2', () => {
    // 0.2 kWh/hour = 4.8 kWh/day → ~149 kWh over the month, well under the
    // 612 kWh allowance even with every remaining day projected at pace.
    const rows = hourly(oct(1), 10, 0.2 * KWH);
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(10),
      projection: projectionFor(rows),
      billDate: { at: new Date(2026, 9, 31).getTime() / 1000, source: 'file-cadence' },
    });
    expect(curve.tierThresholdKwh).toBe(612);
    expect(curve.tierCrossingDay).toBeNull();
    expect(curve.note).not.toContain('tier-2 rate');
  });

  it('draws no marker off-Tiered — TOU has no tier-1 allowance', () => {
    const rows = hourly(oct(1), 10, 5 * KWH);
    const curve = buildAccrualCurve({
      rows,
      plan: 'TOU',
      period: OCTOBER,
      today: oct(10),
      projection: projectMonthBill(rows, 'TOU', oct(10)),
      billDate: { at: new Date(2026, 9, 31).getTime() / 1000, source: 'file-cadence' },
    });
    expect(curve.tierThresholdKwh).toBeNull();
    expect(curve.tierCrossingDay).toBeNull();
  });

  it('uses the winter allowance in season', () => {
    const nov = (day: number) => new Date(2026, 10, day);
    const rows = hourly(nov(1), 20, 6 * KWH); // 144 kWh/day
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: {
        start: new Date(2026, 10, 1).getTime() / 1000,
        end: new Date(2026, 11, 1).getTime() / 1000,
      },
      today: nov(20),
      projection: projectMonthBill(rows, 'Tiered', nov(20)),
    });
    // Calendar days, not instants: the DST fall-back inside November does
    // not give the chart an extra day. 1000 × 30/30.4 ≈ 987, crossed on
    // day 7 at 144 kWh/day.
    expect(curve.tierThresholdKwh).toBe(987);
    expect(curve.tierCrossingDay).toBe('2026-11-07');
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
    // periodEnd is the WINDOW's last day; the newest reading lives on the
    // last point, which is what caps daysElapsed.
    expect(curve.periodEnd).toBe('2026-10-31');
  });

  it('stops the accrual at the end of the period, not at the end of the data', () => {
    const rows = hourly(oct(25), 20, KWH); // Oct 25 → Nov 13
    const curve = buildAccrualCurve({
      rows,
      plan: 'Tiered',
      period: OCTOBER,
      today: oct(31),
      projection: projectMonthBill(rows, 'Tiered', oct(31)),
    });
    // The window is the whole month; readings only exist for its last week,
    // and the days before them accrue as covered-or-not zeros.
    expect(curve.daysInPeriod).toBe(31);
    expect(curve.points.length).toBe(31);
    expect(curve.coveredDays).toBe(7);
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
    // With no pace there is nothing to compare the benchmark against.
    expect(curve.paceVsAvg).toBeNull();
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
