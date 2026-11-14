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
 * Slice 7 (the "am I on pace?" rework) adds the three things the first
 * version was missing to be answerable at a glance:
 *
 *   • a RUNWAY. The first version drew the accrual only as far as the newest
 *     reading — a closed book of the past, so "where will it land?" had no
 *     x-axis to land ON. The curve now runs to `billDate`, the next read
 *     date the file's own billing cadence implies (median billed duration
 *     after the last bill; the user's billing-day setting when the file
 *     states no bills), and the pace line crosses the empty future to it.
 *   • a BENCHMARK. `avgPriorBill` — the commodity charge of the last ≤3
 *     bills, averaged — is the level the projected landing is judged
 *     against, so "pacing below / above" is a look, not arithmetic.
 *   • a TIER MARKER. On a Tiered plan the 600 kWh (summer) / 1000 kWh
 *     (winter) tier-1 allowance, prorated to this period's length exactly
 *     the way `aggregateChartData` prorates it, is the day the cheap rate
 *     runs out — worth a vertical line, because everything after it bills
 *     at tier 2.
 *
 * Everything here is commodity/variable charges, like every other figure
 * here. `avgPriorBill` is therefore the bills' COMMODITY lines, not their
 * amounts due — comparing an accrual of electricity-only cost against a
 * all-in bill total would always read "you're way below".
 */

import { differenceInCalendarDays, format, parseISO, addDays } from 'date-fns';
import { billTotals, tieredCostFor, type ProcessedPoint, type UsageSummary } from './energy';
import type { BillProjection } from './billProjection';
// Wave U — the pace/bill-date note comes from the locale catalog at call
// time; the EN catalog keeps the Wave F wording the tests pin verbatim.
import { fmtMoney, t } from '@/i18n';

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
  /** Metered kWh that day (0 = no readings). */
  kwh: number;
  /** Running kWh through that day — what the tier allowance is measured on. */
  cumulativeKwh: number;
};

export type AccrualPaceSource = 'projection' | 'run-rate' | 'none';

/** Where the bill date came from — printed, because it is an estimate. */
export type AccrualBillDateSource = 'file-cadence' | 'billing-day' | 'period-end';

export type AccrualCurve = {
  points: AccrualPoint[];
  /** `yyyy-MM-dd` of the open period's first day. */
  periodStart: string;
  /** `yyyy-MM-dd` of the LAST DAY THAT HAS HAPPENED. */
  periodEnd: string;
  /** `yyyy-MM-dd` of the expected bill date — where the pace line lands. */
  billDate: string;
  /** Which rule produced `billDate`. */
  billDateSource: AccrualBillDateSource;
  /** Days the period spans to the bill date (≥ 1). */
  daysInPeriod: number;
  /** Calendar days of the period that have already happened (≥ 0). */
  daysElapsed: number;
  /** Of those, how many actually carry readings (a gap is not $0 usage). */
  coveredDays: number;
  /** Commodity cost accrued so far. */
  total: number;
  /** Metered kWh accrued so far. */
  kwh: number;
  /** Slope of the pace line, $/day. */
  paceDaily: number;
  /** Where the pace line is TODAY. */
  paceToDate: number;
  /** Where the pace line lands at the bill date. */
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
  /** Commodity charge of each prior bill, oldest first. */
  priorBills: number[];
  /** Mean commodity charge of the last ≤3 bills, or null with no bills. */
  avgPriorBill: number | null;
  /** How many bills the average used (0–3). */
  priorBillCount: number;
  /** projectedTotal − avgPriorBill; null when there is nothing to compare. */
  paceVsAvg: number | null;
  /** Projected landing above the 3-bill average (true), below (false). */
  overAvg: boolean | null;
  /** Tier-1 kWh allowance prorated to this period, or null off-Tiered. */
  tierThresholdKwh: number | null;
  /** The `yyyy-MM-dd` the allowance runs out (actual or at the pace rate),
   *  or null when the period never reaches tier 2. */
  tierCrossingDay: string | null;
  /** True when the crossing is projected from the pace rate, not yet real. */
  tierCrossingProjected: boolean;
  /** One honest sentence about where the pace came from. */
  note: string;
};

export const EMPTY_ACCRUAL: AccrualCurve = {
  points: [],
  periodStart: '',
  periodEnd: '',
  billDate: '',
  billDateSource: 'period-end',
  daysInPeriod: 0,
  daysElapsed: 0,
  coveredDays: 0,
  total: 0,
  kwh: 0,
  paceDaily: 0,
  paceToDate: 0,
  projectedTotal: 0,
  gap: 0,
  overPace: null,
  paceSource: 'none',
  priorBills: [],
  avgPriorBill: null,
  priorBillCount: 0,
  paceVsAvg: null,
  overAvg: null,
  tierThresholdKwh: null,
  tierCrossingDay: null,
  tierCrossingProjected: false,
  note: t('accrual.emptyNote'),
};

/** Half a cent: being a float ULP over the line is not "over budget". */
const PACE_EPSILON = 0.005;
/** Days per bill period the tier allowance is prorated over (same as
 *  aggregateChartData's per-bucket scaling). */
const TIER_PERIOD_DAYS = 30.4;
/** How many prior bills the benchmark averages. */
export const BENCHMARK_BILL_COUNT = 3;

/**
 * Per-reading cost, for the two plans that HAVE a per-reading price.
 *
 * Tiered is deliberately not here: its tier-2 threshold is a volume
 * allowance for a month, so a day's cost depends on the days before it and
 * cannot be read off one reading. `buildAccrualCurve` prices Tiered through
 * `tieredCostFor` — the shared month-scoped rule — instead, so the spend
 * line and Wave F's pace line (already on that rule via `projectMonthBill`)
 * are the same arithmetic.
 */
function costOf(row: ProcessedPoint, plan: 'TOU' | 'ULO'): number {
  return plan === 'TOU' ? row.costTOU : row.costULO;
}

/**
 * Commodity charges of the prior bills, oldest first, for the benchmark.
 * Commodity ONLY — the accrual is commodity-only, and averaging all-in bill
 * totals against it would make every month read "you're way below average".
 */
export function priorBillCommodities(summaries: UsageSummary[]): number[] {
  return [...summaries]
    .sort((a, b) => a.start - b.start)
    .map((s) => billTotals(s).commodity)
    .filter((n) => n > 0);
}

/**
 * The date the next bill will read through, from the file's own rhythm.
 *
 * Bills land on the utility's cadence, not on the calendar, so the estimate
 * is the median billed duration stepped forward from the last bill until it
 * sits ON or AFTER the newest reading — the next read is one whole period
 * out, not a fraction of one. A file with no bills falls back to the user's
 * billing day (the same rule the axis's `derived` periods use). Returns the
 * source so the card can print which rule it used.
 */
export function expectedBillDate(
  billed: { end: number; duration: number }[],
  dataEnd: number,
  billingDay: number,
): { date: number; source: AccrualBillDateSource } {
  if (billed.length > 0) {
    const durations = billed.map((b) => b.duration).sort((a, b) => a - b);
    const cadence = Math.max(1, durations[Math.floor(durations.length / 2)]);
    const anchor = billed[billed.length - 1].end;
    const steps = Math.max(1, Math.ceil((dataEnd - anchor) / cadence));
    return { date: anchor + steps * cadence, source: 'file-cadence' };
  }
  // No bills: the billing-day setting decides, exactly as the axis does.
  const d = new Date(dataEnd * 1000);
  const endOfPeriod = new Date(d.getFullYear(), d.getMonth(), billingDay);
  if (endOfPeriod.getTime() / 1000 <= dataEnd) {
    endOfPeriod.setMonth(endOfPeriod.getMonth() + 1);
  }
  return { date: Math.floor(endOfPeriod.getTime() / 1000), source: 'billing-day' };
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
  /**
   * The read date the open period will be billed through — an instant stamp
   * in the SAME convention the axis uses for labels (Aug 20 00:00Z means the
   * bill reads through Aug 20). Null/absent = the period's own end (the
   * pre-slice-7 behaviour: the pace line lands on the newest reading, which
   * is no landing at all). Supplied by the caller because the cadence lives
   * on the axis, which this module deliberately does not build — the source
   * rides along so the card can print which rule produced the date.
   */
  billDate?: { at: number; source: AccrualBillDateSource } | null;
  /** Commodity charge of each prior bill (see {@link priorBillCommodities}). */
  priorBills?: number[];
};

export function buildAccrualCurve({
  rows,
  plan,
  period,
  today,
  projection,
  billDate,
  priorBills = [],
}: AccrualInput): AccrualCurve {
  if (!period || period.end <= period.start) return EMPTY_ACCRUAL;

  // An instant outside the Date range is not a period a chart can draw:
  // date-fns `format()` throws `RangeError: Invalid time value` on it, and
  // a NEGATIVE start slips the ordering guard above (the end is larger).
  // `MoneyPanel` derives this period from the billing axis, whose bill
  // starts are only ceiling-bounded upstream — so degrade to the empty
  // curve, the caller's existing "no data" state, instead of taking the
  // Money tab down (F5, t_bcc1b9c6).
  const startMs = period.start * 1000;
  const endMs = (period.end - 1) * 1000;
  if (Number.isNaN(new Date(startMs).getTime()) || Number.isNaN(new Date(endMs).getTime())) {
    return EMPTY_ACCRUAL;
  }

  const startDay = format(new Date(startMs), 'yyyy-MM-dd');
  // `period.end` is exclusive: the last day it accounts for is end − 1s.
  const endDay = format(new Date(endMs), 'yyyy-MM-dd');
  const startDate = parseISO(startDay);
  // Calendar days, not instant arithmetic: a window that spans a DST
  // transition is 29d23h or 30d1h of instants but always 30 days of chart.
  const dataDays = Math.max(
    1,
    differenceInCalendarDays(parseISO(endDay), startDate) + 1,
  );

  // The runway: the pace line needs somewhere to land, so the axis extends
  // to the expected read date when the caller has one — but only when that
  // date is genuinely past the data. A file that already runs beyond its own
  // cadence (a late bill) still draws every day it holds, and stops there.
  // A read date that is not a DATE (undateable instant) has nowhere to
  // land: no runway, same as a caller that supplied none (F5, t_bcc1b9c6).
  const runwayMs = billDate ? billDate.at * 1000 : Number.NaN;
  const runwayDay =
    billDate && !Number.isNaN(new Date(runwayMs).getTime())
      ? format(new Date(runwayMs), 'yyyy-MM-dd')
      : '';
  const hasRunway = runwayDay > endDay;
  const billDay = hasRunway ? runwayDay : endDay;
  const billDateSource: AccrualBillDateSource = hasRunway
    ? (billDate?.source ?? 'file-cadence')
    : 'period-end';
  const daysInPeriod = Math.max(
    1,
    differenceInCalendarDays(parseISO(billDay), startDate) + 1,
  );

  // Cost + kWh per calendar day, only for readings inside the period.
  const daily = new Map<string, number>();
  const dailyKwh = new Map<string, number>();
  let firstRow: ProcessedPoint | null = null;
  const inPeriod: ProcessedPoint[] = [];
  for (const row of rows) {
    if (row.timestamp < period.start || row.timestamp >= period.end) continue;
    inPeriod.push(row);
    if (plan !== 'Tiered') {
      daily.set(row.dayStr, (daily.get(row.dayStr) ?? 0) + costOf(row, plan));
    }
    dailyKwh.set(row.dayStr, (dailyKwh.get(row.dayStr) ?? 0) + row.usage_kwh);
    if (!firstRow) firstRow = row;
  }

  // Tiered is priced on the WINDOW, never per reading (see `costOf`), so the
  // day's cost is booked as the MARGINAL increase of the shared month-scoped
  // rule over the days so far. Every point then foots to `tieredCostFor` of
  // the days through it, and this line can no longer disagree with the pace
  // slope above it — which is what shipping both on different rules did.
  //
  // The marginals are NOT monotonic, and that is the rule speaking, not a bug
  // here: each added day also grows the prorated allowance, which shifts kWh
  // from tier 2 (14.2¢) back down to tier 1 (12¢). On a near-empty day after
  // an over-threshold month that reclassification can outweigh the day's own
  // cost, so the day books NEGATIVE and the running total dips. Measured: 10
  // days of 24 kWh then one 2 kWh day costs −$0.1502 (29.7379 → 29.5877). A
  // curve that never dipped would mean we were summing the tier-1 column.
  if (plan === 'Tiered' && inPeriod.length > 0) {
    const ordered = [...inPeriod].sort((a, b) => a.timestamp - b.timestamp);
    // `running` only ever grows: it is the window from the period's first
    // reading through the row being read, so the rule always sees the days
    // (and the prorated allowance) that came before this one. Resetting it
    // per day would price each day alone and the marginals would all be
    // identical — a flat load would accrue the same cost as a spiky one.
    const running: ProcessedPoint[] = [];
    let spent = 0;
    let day = '';
    for (const row of ordered) {
      if (row.dayStr !== day) {
        if (day !== '') {
          const cumulative = tieredCostFor(running);
          daily.set(day, cumulative - spent);
          spent = cumulative;
        }
        day = row.dayStr;
      }
      running.push(row);
    }
    daily.set(day, tieredCostFor(running) - spent);
  }

  // Nothing accrues past today: a clock-skewed export must not book days
  // nobody has lived yet (the same rule projectMonthBill applies).
  const todayKey = format(today, 'yyyy-MM-dd');
  const newestData = [...daily.keys()].sort().pop() ?? '';
  const throughKey = [todayKey, newestData].filter(Boolean).sort()[0] ?? todayKey;

  const throughDate = parseISO(throughKey);
  if (throughDate.getTime() < startDate.getTime()) {
    return {
      ...EMPTY_ACCRUAL,
      periodStart: startDay,
      periodEnd: endDay,
      billDate: billDay,
      billDateSource,
      daysInPeriod,
      note: t('accrual.notStartedNote'),
    };
  }

  const daysElapsed = Math.min(
    dataDays,
    differenceInCalendarDays(throughDate, startDate) + 1,
  );

  const points: AccrualPoint[] = [];
  let cumulative = 0;
  let cumulativeKwh = 0;
  let coveredDays = 0;
  for (let i = 0; i < daysElapsed; i++) {
    const date = addDays(startDate, i);
    const day = format(date, 'yyyy-MM-dd');
    const dayCost = daily.get(day) ?? 0;
    const dayKwh = dailyKwh.get(day) ?? 0;
    if (daily.has(day)) coveredDays += 1;
    cumulative += dayCost;
    cumulativeKwh += dayKwh;
    points.push({ day, dayCost, cumulative, pace: 0, kwh: dayKwh, cumulativeKwh });
  }
  const total = cumulative;
  const kwh = cumulativeKwh;

  // The slope: Wave F's recent daily average when it has one, otherwise the
  // period's own run-rate. `projection.avgDailyCost` is a RATE (per day), so
  // it is valid even when the projection itself is gated for another reason.
  let paceDaily = 0;
  let paceKwhDaily = 0;
  let paceSource: AccrualPaceSource = 'none';
  if (projection.ready && projection.avgDailyCost > 0) {
    paceDaily = projection.avgDailyCost;
    paceKwhDaily = projection.avgDailyKwh;
    paceSource = 'projection';
  } else if (daysElapsed > 0 && total > 0) {
    paceDaily = total / daysElapsed;
    paceKwhDaily = kwh / daysElapsed;
    paceSource = 'run-rate';
  }

  const paceToDate = paceDaily * daysElapsed;
  const projectedTotal = paceDaily * daysInPeriod;
  points.forEach((point, index) => {
    point.pace = paceDaily * (index + 1);
  });

  // The benchmark: the last ≤3 bills' commodity charges, averaged. Bills are
  // the only honest yardstick the file carries for "is this a big month?".
  const recent = priorBills.slice(-BENCHMARK_BILL_COUNT);
  const avgPriorBill =
    recent.length > 0 ? recent.reduce((n, v) => n + v, 0) / recent.length : null;
  const paceVsAvg =
    avgPriorBill === null || paceSource === 'none'
      ? null
      : projectedTotal - avgPriorBill;
  const overAvg = paceVsAvg === null ? null : paceVsAvg > PACE_EPSILON;

  // Tier 1 runs out when the period's prorated allowance is spent. The
  // allowance scales with the period's length exactly the way the per-bucket
  // tiered pricing scales it, so the marker and the money agree. Known days
  // use the real cumulative kWh; beyond today the pace rate extends it, and
  // the marker says which one it is.
  let tierThresholdKwh: number | null = null;
  let tierCrossingDay: string | null = null;
  let tierCrossingProjected = false;
  if (plan === 'Tiered' && firstRow) {
    const allowance =
      (firstRow.isWinter
        ? firstRow.activeRateSet.tiered.thresholdWinter
        : firstRow.activeRateSet.tiered.thresholdSummer) *
      (daysInPeriod / TIER_PERIOD_DAYS);
    tierThresholdKwh = Math.round(allowance);
    const crossed = points.find((p) => p.cumulativeKwh >= allowance);
    if (crossed) {
      tierCrossingDay = crossed.day;
    } else if (paceKwhDaily > 0 && kwh + paceKwhDaily * (daysInPeriod - daysElapsed) >= allowance) {
      const daysToCross = Math.ceil((allowance - kwh) / paceKwhDaily);
      const index = daysElapsed - 1 + daysToCross;
      if (index < daysInPeriod) {
        tierCrossingDay = format(addDays(startDate, index), 'yyyy-MM-dd');
        tierCrossingProjected = true;
      }
    }
  }

  const note =
    (paceSource === 'projection'
      ? t('accrual.paceProjection', {
          days: projection.recentDays,
          daily: fmtMoney(projection.avgDailyCost),
          period: daysInPeriod,
        })
      : paceSource === 'run-rate'
        ? t('accrual.paceRunRate', { daily: fmtMoney(paceDaily) })
        : t('accrual.paceNone')) +
    (billDateSource === 'file-cadence'
      ? t('accrual.billDateCadence', { day: billDay })
      : billDateSource === 'billing-day'
        ? t('accrual.billDateBillingDay', { day: billDay })
        : t('accrual.billDateNewest', { day: billDay })) +
    (tierCrossingDay
      ? t(tierCrossingProjected ? 'accrual.tierCrossPace' : 'accrual.tierCross', {
          // tierCrossingDay can only be set inside the Tiered branch that
          // also always assigns tierThresholdKwh, so this ?? never fires.
          kwh: tierThresholdKwh ?? 0,
          day: tierCrossingDay,
        })
      : '');

  return {
    points,
    periodStart: startDay,
    periodEnd: endDay,
    billDate: billDay,
    billDateSource,
    daysInPeriod,
    daysElapsed,
    coveredDays,
    total,
    kwh,
    paceDaily,
    paceToDate,
    projectedTotal,
    gap: total - paceToDate,
    overPace: paceSource === 'none' ? null : total - paceToDate > PACE_EPSILON,
    paceSource,
    priorBills: recent,
    avgPriorBill,
    priorBillCount: recent.length,
    paceVsAvg,
    overAvg,
    tierThresholdKwh,
    tierCrossingDay,
    tierCrossingProjected,
    note,
  };
}
