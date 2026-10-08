/**
 * "What will this month's bill be?" — month-to-date actuals plus an
 * extrapolation to month end.
 *
 * Deliberately conservative:
 *  - it says nothing before day 5 (one day of data says nothing about a month);
 *  - the extrapolation uses the household's OWN recent daily average, not a
 *    national default;
 *  - it prices commodity only, exactly like every other figure in the app —
 *    delivery, regulatory and HST never enter this file;
 *  - each window is priced with the shared `planCostFor`, so Tiered carries
 *    the month-scoped tier-2 threshold instead of the per-reading tier-1 field;
 *  - it never claims to be the bill. It is a projection and says so.
 *
 * `today` is always a parameter, never `Date.now()`, so the gate is testable.
 */

import { endOfMonth, format, getDate, startOfMonth } from 'date-fns';
// Wave U — captions/gate notes come from the catalog at call time; month
// names follow the active locale (fmtDate is date-fns bound to it).
import { fmtDate, fmtMoney, t } from '@/i18n';
import { planCostFor, type ProcessedPoint } from './energy';

export type BillPlan = 'TOU' | 'Tiered' | 'ULO';

/** The month must be at least this far along before we project. */
export const MIN_DAYS_FOR_PROJECTION = 5;
/** Window the daily average is taken over. */
export const PROJECTION_RECENT_DAYS = 7;
/** Below this many recorded days the average is guesswork. */
export const MIN_RECENT_DAYS_WITH_DATA = 3;

export type BillProjectionEmptyReason =
  | 'no-data'
  | 'too-early'
  | 'no-recent-data';

export type BillProjection = {
  ready: boolean;
  emptyReason: BillProjectionEmptyReason | null;
  plan: BillPlan;
  /** yyyy-MM of the month being projected. */
  month: string;
  /** "October 2026" */
  monthLabel: string;
  daysIntoMonth: number;
  daysInMonth: number;
  /** Distinct days of the month we actually have readings for. */
  monthDaysCovered: number;
  monthToDateKwh: number;
  monthToDateCost: number;
  recentDays: number;
  avgDailyKwh: number;
  avgDailyCost: number;
  /** Days left to fill in after the measured ones. */
  remainingDays: number;
  projectedKwh: number;
  projectedCost: number;
  /** yyyy-MM-dd of the newest reading (or today, whichever is older). */
  dataThrough: string;
  /** What the number includes / how it was built. */
  caption: string;
  /** Why the banner is not showing a number yet. */
  gateNote: string;
};

export function projectMonthBill(
  rows: ProcessedPoint[],
  plan: BillPlan,
  today: Date,
): BillProjection {
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const month = format(monthStart, 'yyyy-MM');
  const monthLabel = fmtDate(monthStart, 'MMMM yyyy');
  const daysIntoMonth = getDate(today);
  const daysInMonth = getDate(monthEnd);

  const base: BillProjection = {
    ready: false,
    emptyReason: null,
    plan,
    month,
    monthLabel,
    daysIntoMonth,
    daysInMonth,
    monthDaysCovered: 0,
    monthToDateKwh: 0,
    monthToDateCost: 0,
    recentDays: 0,
    avgDailyKwh: 0,
    avgDailyCost: 0,
    remainingDays: 0,
    projectedKwh: 0,
    projectedCost: 0,
    dataThrough: '',
    caption: t('projection.captionBase'),
    gateNote: '',
  };

  if (rows.length === 0) {
    return {
      ...base,
      emptyReason: 'no-data',
      gateNote: t('projection.gateNoData', { month: monthLabel }),
    };
  }

  // Anchor on the newest reading, but never past today (a clock-skewed export
  // must not project a month nobody has lived yet).
  let newest = rows[0].dateObj;
  for (const r of rows) if (r.dateObj > newest) newest = r.dateObj;
  const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  const dataEnd = newest > todayEnd ? todayEnd : newest;
  const dataThrough = format(dataEnd, 'yyyy-MM-dd');
  const monthKey = format(monthStart, 'yyyy-MM');

  const daysCovered = new Set<string>();
  let mtdKwh = 0;
  const mtdRows: ProcessedPoint[] = [];
  for (const r of rows) {
    if (r.dayStr.slice(0, 7) !== monthKey) continue;
    if (r.dayStr > dataThrough) continue;
    daysCovered.add(r.dayStr);
    mtdKwh += r.usage_kwh;
    mtdRows.push(r);
  }
  // Priced as a window, not reading by reading: on Tiered the per-reading
  // `costTiered` is tier 1 only, and a summer month is over the threshold.
  const mtdCost = planCostFor(mtdRows, plan);

  const recentEnd = dataEnd;
  const recentStart = new Date(recentEnd);
  recentStart.setDate(recentStart.getDate() - (PROJECTION_RECENT_DAYS - 1));
  const recentFloor = format(
    new Date(recentStart.getFullYear(), recentStart.getMonth(), recentStart.getDate()),
    'yyyy-MM-dd',
  );

  const recentDaysSet = new Set<string>();
  let recentKwh = 0;
  const recentRows: ProcessedPoint[] = [];
  for (const r of rows) {
    if (r.dayStr < recentFloor || r.dayStr > dataThrough) continue;
    recentDaysSet.add(r.dayStr);
    recentKwh += r.usage_kwh;
    recentRows.push(r);
  }
  const recentCost = planCostFor(recentRows, plan);
  const recentDays = recentDaysSet.size;

  const monthDaysCovered = daysCovered.size;
  const remainingDays = Math.max(0, daysInMonth - monthDaysCovered);

  const resolved: BillProjection = {
    ...base,
    monthDaysCovered,
    monthToDateKwh: mtdKwh,
    monthToDateCost: mtdCost,
    recentDays,
    avgDailyKwh: recentDays > 0 ? recentKwh / recentDays : 0,
    avgDailyCost: recentDays > 0 ? recentCost / recentDays : 0,
    remainingDays,
    dataThrough,
  };

  if (daysIntoMonth < MIN_DAYS_FOR_PROJECTION) {
    return {
      ...resolved,
      emptyReason: 'too-early',
      gateNote: t('projection.gateTooEarly', {
        // `count` drives the _one/_other plural variant; `days` is the
        // placeholder the sentence interpolates.
        count: daysIntoMonth,
        days: daysIntoMonth,
        month: monthLabel,
        threshold: MIN_DAYS_FOR_PROJECTION,
        remaining: MIN_DAYS_FOR_PROJECTION - daysIntoMonth,
      }),
    };
  }

  if (monthDaysCovered === 0) {
    return {
      ...resolved,
      emptyReason: 'no-data',
      gateNote: t('projection.gateNoDataThrough', { month: monthLabel, through: dataThrough }),
    };
  }

  if (recentDays < MIN_RECENT_DAYS_WITH_DATA) {
    return {
      ...resolved,
      emptyReason: 'no-recent-data',
      gateNote: t('projection.gateNoRecent', { count: recentDays, days: recentDays, window: PROJECTION_RECENT_DAYS }),
    };
  }

  const projectedKwh = mtdKwh + remainingDays * resolved.avgDailyKwh;
  const projectedCost = mtdCost + remainingDays * resolved.avgDailyCost;
  const staleNote =
    dataThrough < format(today, 'yyyy-MM-dd')
      ? ` ${t('projection.staleNote', { through: dataThrough })}`
      : '';

  return {
    ...resolved,
    ready: true,
    projectedKwh,
    projectedCost,
    caption: `${t('projection.captionBase')} ${t('projection.captionDetail', {
      covered: monthDaysCovered,
      daysInMonth,
      remaining: remainingDays,
      window: recentDays,
      daily: fmtMoney(resolved.avgDailyCost),
    })}.${staleNote}`,
    gateNote: '',
  };
}
