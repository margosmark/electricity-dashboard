/**
 * buildAccrualCurve degrades for a period (or read date) whose instant is
 * not a date — F5 of t_bcc1b9c6, probed real rather than assumed:
 * `format(new Date(period.start * 1000))` / `format(new Date(billDate.at *
 * 1000))` throw `RangeError: Invalid time value` on an out-of-range
 * instant.
 *
 * Live reachability: `MoneyPanel` derives the open period from the billing
 * axis, and `assertBillPeriodStart` (limits.ts) is ceiling-only, so a fresh
 * negative bill start parks an undateable instant in `axis.open.start` —
 * `period.end <= period.start` does NOT catch a negative start (end is
 * larger), which is exactly why the guard below is a date-validity check
 * and not another ordering check.
 *
 * RED control (measured): revert the date-validity guards in
 * `lib/billAccrual.ts` — both case groups fail with
 * `RangeError: Invalid time value`, the stacks landing on exactly the two
 * `format()` calls the card names (billAccrual.ts:259 for a negative
 * period start, :274 for an undateable read date).
 */
import { describe, expect, it } from 'vitest';
import { buildAccrualCurve } from './billAccrual';
import { processRawData } from './energy';
import type { DataPoint, RateSet } from './energy';
import type { BillProjection } from './billProjection';

/**
 * The five shapes `GasSection.outOfRangeStart.test.tsx` pins — every one a
 * finite number whose `new Date(ts * 1000)` is Invalid, both signs.
 */
const HOSTILE_STARTS = [
  1_000_000_000_000_000,
  -1_000_000_000_000_000,
  8_640_000_000_001,
  Number.MAX_SAFE_INTEGER,
  1e308,
];

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** Five daily rows inside January 2026 — a period the curve can draw. */
const ROWS = processRawData(
  Array.from({ length: 5 }, (_, i): DataPoint => ({
    timestamp: Math.floor(new Date(2026, 0, 1 + i, 12).getTime() / 1000),
    usage_kwh: 2,
  })),
  [RATES],
);

const JAN1 = Math.floor(new Date(2026, 0, 1).getTime() / 1000);
const FEB1 = Math.floor(new Date(2026, 1, 1).getTime() / 1000);
const TODAY = new Date(2026, 0, 10, 12);

const PROJECTION = {
  ready: false,
  emptyReason: 'no-data',
  plan: 'TOU',
  month: '2026-01',
  monthLabel: 'January 2026',
  daysIntoMonth: 10,
  daysInMonth: 31,
  monthDaysCovered: 0,
  monthToDateKwh: 0,
  monthToDateCost: 0,
  recentDays: 0,
  avgDailyKwh: 0,
  avgDailyCost: 0,
  remainingDays: 21,
  projectedKwh: 0,
  projectedCost: 0,
  dataThrough: '',
  caption: '',
  gateNote: 'No data',
} as BillProjection;

describe('buildAccrualCurve over undateable instants', () => {
  it.each(HOSTILE_STARTS)('a period starting at %s yields the empty curve, no throw', (ts) => {
    const curve = buildAccrualCurve({
      rows: ROWS,
      plan: 'TOU',
      period: { start: ts, end: FEB1 },
      today: TODAY,
      projection: PROJECTION,
    });
    expect(curve.points).toHaveLength(0);
  });

  it.each(HOSTILE_STARTS)('a bill read date at %s does not throw the pace line', (ts) => {
    const curve = buildAccrualCurve({
      rows: ROWS,
      plan: 'TOU',
      period: { start: JAN1, end: FEB1 },
      today: TODAY,
      projection: PROJECTION,
      billDate: { at: ts, source: 'file-cadence' },
    });
    expect(curve.points.length).toBeGreaterThan(0);
  });

  it('control: a healthy period with a read date past its end accrues', () => {
    const curve = buildAccrualCurve({
      rows: ROWS,
      plan: 'TOU',
      period: { start: JAN1, end: FEB1 },
      today: TODAY,
      projection: PROJECTION,
      billDate: { at: FEB1, source: 'file-cadence' },
    });
    expect(curve.points.length).toBeGreaterThan(0);
  });

  it('control: a null period is still the empty curve', () => {
    const curve = buildAccrualCurve({
      rows: ROWS,
      plan: 'TOU',
      period: null,
      today: TODAY,
      projection: PROJECTION,
    });
    expect(curve.points).toHaveLength(0);
  });
});