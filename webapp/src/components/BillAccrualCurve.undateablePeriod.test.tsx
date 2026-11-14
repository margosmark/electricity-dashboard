/**
 * BillAccrualCurve over undateable instants — the render half of F5
 * (t_bcc1b9c6). `MoneyPanel` passes the axis's open period straight in, and
 * `assertBillPeriodStart` is ceiling-only, so a fresh negative bill start
 * lands an out-of-range instant in `period.start`: `period.end <=
 * period.start` does NOT catch a negative start (the end is larger), and
 * `format(new Date(period.start * 1000))` inside `buildAccrualCurve` throws
 * `RangeError: Invalid time value` — taking the Money tab to the error
 * boundary.
 *
 * RED control: revert the date-validity guards in `lib/billAccrual.ts` and
 * the negative-shape / read-date cases fail with
 * `RangeError: Invalid time value`.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import BillAccrualCurve from './BillAccrualCurve';
import { processRawData } from '@/lib/energy';
import type { DataPoint, RateSet } from '@/lib/energy';
import { setLocale } from '@/i18n';
import type { BillProjection } from '@/lib/billProjection';

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

beforeEach(() => setLocale('en'));
afterEach(() => cleanup());

describe('BillAccrualCurve over undateable instants', () => {
  it.each(HOSTILE_STARTS)('an open period starting at %s renders the honest empty state', (ts) => {
    render(
      <BillAccrualCurve
        rows={ROWS}
        plan="TOU"
        period={{ start: ts, end: FEB1 }}
        projection={PROJECTION}
        today={TODAY}
      />,
    );
    expect(screen.getByTestId('bill-accrual')).toBeInTheDocument();
    expect(screen.getByTestId('accrual-empty')).toBeInTheDocument();
  });

  it.each(HOSTILE_STARTS)('a bill read date at %s still draws the curve', (ts) => {
    render(
      <BillAccrualCurve
        rows={ROWS}
        plan="TOU"
        period={{ start: JAN1, end: FEB1 }}
        projection={PROJECTION}
        billDate={{ at: ts, source: 'file-cadence' }}
        today={TODAY}
      />,
    );
    expect(screen.getByTestId('bill-accrual')).toBeInTheDocument();
    expect(screen.queryByTestId('accrual-empty')).not.toBeInTheDocument();
  });

  it('control: a healthy period with a read date past its end draws', () => {
    render(
      <BillAccrualCurve
        rows={ROWS}
        plan="TOU"
        period={{ start: JAN1, end: FEB1 }}
        projection={PROJECTION}
        billDate={{ at: FEB1, source: 'file-cadence' }}
        today={TODAY}
      />,
    );
    expect(screen.getByTestId('bill-accrual')).toBeInTheDocument();
    expect(screen.queryByTestId('accrual-empty')).not.toBeInTheDocument();
  });
});