/**
 * Wave R — "am I on pace for a big bill?", drawn.
 *
 * Within the OPEN billing period (the unbilled tail Wave Q's axis already
 * models), accumulate the days that have actually happened and lay a pace
 * line alongside them. The projection banner answers "what will this month
 * cost?"; this answers the same question as a shape — you can see a bad week
 * the moment it happens instead of at month end.
 *
 * The pace line's slope is Wave F's own arithmetic: the household's recent
 * daily average (`projection.avgDailyCost`, a 7-day window measured over
 * days that exist), carried across the whole period. When the projection is
 * gated (first days of a month, no recent readings) the curve falls back to
 * the period's own run-rate and says which one it used — `paceSource` is
 * part of the model, not a comment, so the UI has to display it.
 *
 * Everything is commodity/variable charges, like every other figure here.
 */

import { differenceInCalendarDays, format, parseISO, addDays } from 'date-fns';
import type { ProcessedPoint } from './energy';
import type { BillProjection } from './billProjection';

export type AccrualPlan = 'TOU' | 'Tiered' | 'ULO';

/** One calendar day inside the open period. */
export type AccrualPoint = {
  /** `yyyy-MM-dd`. */
  day: string;
  /** Commodity cost of that day under the selected plan (0 = no readings). */
  dayCost: number;
  /** Running total through that day. */
  cumulative: number;
  /** Where the pace line sits at that day. */
  pace: number;
};

export type AccrualPaceSource = 'projection' | 'run-rate' | 'none';

export type AccrualCurve = {
  points: AccrualPoint[];
  /** `yyyy-MM-dd` of the open period's first and last day. */
  periodStart: string;
  periodEnd: string;
  /** Days the period spans (≥ 1). */
  daysInPeriod: number;
  /** Calendar days of the period that have already happened (≥ 0). */
  daysElapsed: number;
  /** Of those, how many actually carry readings (a gap is not $0 usage). */
  coveredDays: number;
  /** Commodity cost accrued so far. */
  total: number;
  /** Slope of the pace line, $/day. */
  paceDaily: number;
  /** Where the pace line is TODAY. */
  paceToDate: number;
  /** Where the pace line lands at the end of the period. */
  projectedTotal: number;
  /**
   * total − paceToDate: how far the accrual sits ABOVE (+) or BELOW (−) the
   * even-spend line at this point in the period. The line's slope is the
   * household's current run-rate, so positive means the earlier days cost
   * more than the rate you are now running at — the shape to look at before
   * reading the projected total.
   */
  gap: number;
  /** Above the line (true), below it (false), or no line at all (null).
   *  Anything inside a cent is ON the line — floating-point noise is not a
   *  verdict. */
  overPace: boolean | null;
  paceSource: AccrualPaceSource;
  /** One honest sentence about where the pace came from. */
  note: string;
};

export const EMPTY_ACCRUAL: AccrualCurve = {
  points: [],
  periodStart: '',
  periodEnd: '',
  daysInPeriod: 0,
  daysElapsed: 0,
  coveredDays: 0,
  total: 0,
  paceDaily: 0,
  paceToDate: 0,
  projectedTotal: 0,
  gap: 0,
  overPace: null,
  paceSource: 'none',
  note: 'No open billing period to accrue against yet.',
};

const MS_PER_DAY = 86_400_000;
/** Half a cent: being a float ULP over the line is not "over budget". */
const PACE_EPSILON = 0.005;

function costOf(row: ProcessedPoint, plan: AccrualPlan): number {
  if (plan === 'TOU') return row.costTOU;
  if (plan === 'ULO') return row.costULO;
  return row.costTiered;
}

export type AccrualInput = {
  /** Every priced reading (the period is wider than the chart window). */
  rows: ProcessedPoint[];
  plan: AccrualPlan;
  /** The open (unbilled) period, or null when the file ends at a bill. */
  period: { start: number; end: number } | null;
  /** Never `Date.now()` — the gate has to be testable. */
  today: Date;
  /** Wave F's projection for the current calendar month. */
  projection: BillProjection;
};

export function buildAccrualCurve({
  rows,
  plan,
  period,
  today,
  projection,
}: AccrualInput): AccrualCurve {
  if (!period || period.end <= period.start) return EMPTY_ACCRUAL;

  const startDay = format(new Date(period.start * 1000), 'yyyy-MM-dd');
  // `end` is exclusive: the last day the period accounts for is end − 1s.
  const endDay = format(new Date((period.end - 1) * 1000), 'yyyy-MM-dd');
  const daysInPeriod = Math.max(
    1,
    Math.ceil((period.end - period.start) / (MS_PER_DAY / 1000)),
  );

  // Cost per calendar day, only for readings inside the period.
  const daily = new Map<string, number>();
  for (const row of rows) {
    if (row.timestamp < period.start || row.timestamp >= period.end) continue;
    daily.set(row.dayStr, (daily.get(row.dayStr) ?? 0) + costOf(row, plan));
  }

  // Nothing accrues past today: a clock-skewed export must not book days
  // nobody has lived yet (the same rule projectMonthBill applies).
  const todayKey = format(today, 'yyyy-MM-dd');
  const newestData = [...daily.keys()].sort().pop() ?? '';
  const throughKey = [todayKey, newestData].filter(Boolean).sort()[0] ?? todayKey;

  const startDate = parseISO(startDay);
  const throughDate = parseISO(throughKey);
  if (throughDate.getTime() < startDate.getTime()) {
    return {
      ...EMPTY_ACCRUAL,
      periodStart: startDay,
      periodEnd: endDay,
      daysInPeriod,
      note: 'The open period starts after your newest reading — nothing has accrued yet.',
    };
  }

  const daysElapsed = Math.min(
    daysInPeriod,
    differenceInCalendarDays(throughDate, startDate) + 1,
  );

  const points: AccrualPoint[] = [];
  let cumulative = 0;
  let coveredDays = 0;
  for (let i = 0; i < daysElapsed; i++) {
    const date = addDays(startDate, i);
    const day = format(date, 'yyyy-MM-dd');
    const dayCost = daily.get(day) ?? 0;
    if (daily.has(day)) coveredDays += 1;
    cumulative += dayCost;
    points.push({ day, dayCost, cumulative, pace: 0 });
  }
  const total = cumulative;

  // The slope: Wave F's recent daily average when it has one, otherwise the
  // period's own run-rate. `projection.avgDailyCost` is a RATE (per day), so
  // it is valid even when the projection itself is gated for another reason.
  let paceDaily = 0;
  let paceSource: AccrualPaceSource = 'none';
  if (projection.ready && projection.avgDailyCost > 0) {
    paceDaily = projection.avgDailyCost;
    paceSource = 'projection';
  } else if (daysElapsed > 0 && total > 0) {
    paceDaily = total / daysElapsed;
    paceSource = 'run-rate';
  }

  const paceToDate = paceDaily * daysElapsed;
  const projectedTotal = paceDaily * daysInPeriod;
  points.forEach((point, index) => {
    point.pace = paceDaily * (index + 1);
  });

  const note =
    paceSource === 'projection'
      ? `Pace = your last ${projection.recentDays}-day average of $${projection.avgDailyCost.toFixed(2)}/day (Wave F's projection math), carried across all ${daysInPeriod} days of this period.`
      : paceSource === 'run-rate'
        ? `Pace = this period's own run-rate of $${paceDaily.toFixed(2)}/day — no projection is available yet.`
        : 'Not enough readings yet to draw a pace line.';

  return {
    points,
    periodStart: startDay,
    periodEnd: endDay,
    daysInPeriod,
    daysElapsed,
    coveredDays,
    total,
    paceDaily,
    paceToDate,
    projectedTotal,
    gap: total - paceToDate,
    overPace: paceSource === 'none' ? null : total - paceToDate > PACE_EPSILON,
    paceSource,
    note,
  };
}
