/**
 * Gas monthly + year-over-year aggregation (t_a2343a2f) — pure functions,
 * no I/O, no storage keys, no money derivation.
 *
 * Two questions, one dataset:
 *
 *   1. "How much gas, and what did it cost, per CALENDAR month?" —
 *      {@link buildGasMonthly}. Rows are `yyyy-MM` keys, the union of months
 *      that carry interval readings and months where a billing period STARTS.
 *      Both m³ numbers a gas import can state are kept side by side and never
 *      merged:
 *
 *        - `intervalM3` — sum of stored readings whose LOCAL month equals the
 *          row (the same local-day convention `GasChartPanel` labels with;
 *          a reading is counted in the month it STARTS, never split across
 *          months — splitting would be a derived number).
 *        - `billedM3` / `amountDue` — the bill whose period starts that month
 *          (month taken from the feed's own `startDate`, the same stamp the
 *          money table prints), read through `gasVolume` / `gasMoney`, i.e.
 *          straight from the bill's stated lines. A bill that states no
 *          amount yields `amountState: 'missing'` so the UI can say "not in
 *          this import" — never a zero, never a rate × m³ substitute.
 *
 *      One CHART source per import, declared once: `interval` when the file
 *      carries any stored reading, else `billed`, else `none`. Months outside
 *      the chosen source chart as a gap (null), never as a fabricated zero —
 *      the table still shows every number the file states.
 *
 *   2. "How does each month compare with the same month a year earlier?" —
 *      {@link buildGasYearOverYear}, the gas twin of `lib/trend.ts`:
 *      month-of-year rows, one series per year, % deltas for the latest year
 *      that has a prior year, per-year FULL totals (with an honest partial
 *      flag), gated on a span of more than 12 months with a message that
 *      says exactly how much history exists. Gas has no rate-set machinery,
 *      so there are no boundary annotations here — that concept stays on the
 *      electricity side.
 *
 * Money enters ONLY as the bill's own stated figures (see the card's hard
 * rules): this module never multiplies, never rates, never sums line items.
 */
import type { GasPoint } from './storage';
import type { UsageSummary } from './energy';
import { gasMoney, gasVolume, isGasSummary } from './gasBillUi';
import { t } from '@/i18n';
import { monthLabelsFor } from './trend';

/** Which m³ series the monthly chart plots for this import. */
export type GasMonthlySource = 'interval' | 'billed' | 'none';

export type GasMonthlyBill = {
  /** Feed's own `yyyy-MM-dd` of the period start (utcDayKey, as stored). */
  startDate: string;
  /** Feed's own `yyyy-MM-dd` of period end. */
  endDate: string;
  /** Billed volume the bill states, or null when it states none. */
  billedM3: number | null;
  /** The bill's own `Amount Due` line, or null when it states none. */
  amountDue: number | null;
  /** The summary itself — the component derives locale labels from it. */
  summary: UsageSummary;
};

export type GasMonthlyRow = {
  /** `yyyy-MM` — local month for readings, feed startDate month for bills. */
  key: string;
  year: number;
  /** 0–11. */
  monthIndex: number;
  /** Sum of readings starting in this LOCAL month; null when none. */
  intervalM3: number | null;
  /** Bills whose period starts this month (feed startDate), oldest first. */
  bills: GasMonthlyBill[];
  /**
   * What the chart plots for this row, given the import's source: the
   * interval sum when the source is `interval`, else the summed stated
   * billed volume of the month's bills; null = a gap (honest absence).
   */
  chartM3: number | null;
  /** First day-of-month any contribution starts (1-based), when known. */
  firstDay: number | null;
  /** Last day-of-month any contribution covers (1-based), when known. */
  lastDay: number | null;
};

export type GasMonthly = {
  source: GasMonthlySource;
  rows: GasMonthlyRow[];
  /** Any stored interval reading at all (decides the chart source). */
  hasInterval: boolean;
  /** Any gas bill at all. */
  hasBills: boolean;
  /** True when at least one bill states an Amount Due line. */
  hasPaid: boolean;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local `yyyy-MM` of an epoch-second reading start (GasChartPanel's rule). */
function localMonthKey(timestamp: number): { key: string; year: number; monthIndex: number } {
  const d = new Date(timestamp * 1000);
  return {
    key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
    year: d.getFullYear(),
    monthIndex: d.getMonth(),
  };
}

/** `yyyy-MM` from the feed's own `yyyy-MM-dd` startDate (UTC day key). */
function billMonthKey(startDate: string): { key: string; year: number; monthIndex: number } | null {
  const m = /^(\d{4})-(\d{2})/.exec(startDate);
  if (!m) return null;
  return { key: `${m[1]}-${m[2]}`, year: Number(m[1]), monthIndex: Number(m[2]) - 1 };
}

export function buildGasMonthly(
  points: readonly GasPoint[],
  summaries: readonly UsageSummary[],
): GasMonthly {
  const bills = summaries.filter(isGasSummary);
  const hasInterval = points.some((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.volume_m3));
  const hasBills = bills.length > 0;

  type Acc = {
    intervalSum: number;
    intervalCount: number;
    bills: GasMonthlyBill[];
    /** Earliest LOCAL day-of-month a reading starts in this row (interval rows). */
    firstDay: number | null;
    /** Latest day-of-month covered: last reading start, or a bill's end day. */
    lastDay: number | null;
  };
  const acc = new Map<string, Acc>();
  const meta = new Map<string, { year: number; monthIndex: number }>();

  const touch = (key: string, year: number, monthIndex: number): Acc => {
    let a = acc.get(key);
    if (!a) {
      a = { intervalSum: 0, intervalCount: 0, bills: [], firstDay: null, lastDay: null };
      acc.set(key, a);
      meta.set(key, { year, monthIndex });
    }
    return a;
  };

  for (const p of points) {
    if (!Number.isFinite(p.timestamp) || !Number.isFinite(p.volume_m3)) continue;
    const { key, year, monthIndex } = localMonthKey(p.timestamp);
    const a = touch(key, year, monthIndex);
    a.intervalSum += p.volume_m3;
    a.intervalCount += 1;
    const day = new Date(p.timestamp * 1000).getDate();
    a.firstDay = a.firstDay === null ? day : Math.min(a.firstDay, day);
    // The reading's own coverage: start day (we never split a reading across
    // months, so its "covered" extent inside this month is its start day for
    // partial-month purposes — span edges below use start days only).
    a.lastDay = a.lastDay === null ? day : Math.max(a.lastDay, day);
  }

  for (const s of bills) {
    const parsed = billMonthKey(s.startDate);
    if (!parsed) continue;
    const a = touch(parsed.key, parsed.year, parsed.monthIndex);
    a.bills.push({
      startDate: s.startDate,
      endDate: s.endDate,
      billedM3: gasVolume(s).billed,
      amountDue: gasMoney(s).amountDue,
      summary: s,
    });
    const startDay = Number(s.startDate.slice(8, 10));
    const endDay = Number(s.endDate.slice(8, 10));
    if (Number.isFinite(startDay)) {
      a.firstDay = a.firstDay === null ? startDay : Math.min(a.firstDay, startDay);
      // A bill whose END falls in a later month fully covers the rest of THIS
      // row's month — only an end inside the same month bounds coverage.
      const endInsideSameMonth = s.endDate.slice(0, 7) === parsed.key;
      const coveredToEnd = endInsideSameMonth ? endDay : daysInMonth(parsed.year, parsed.monthIndex);
      a.lastDay = a.lastDay === null ? coveredToEnd : Math.max(a.lastDay, coveredToEnd);
    }
  }

  const source: GasMonthlySource = hasInterval ? 'interval' : hasBills ? 'billed' : 'none';
  const hasPaid = bills.some((s) => gasMoney(s).amountDue !== null);

  const rows: GasMonthlyRow[] = Array.from(acc.keys())
    .sort()
    .map((key) => {
      const a = acc.get(key)!;
      const m = meta.get(key)!;
      const billedSum = a.bills.reduce<number | null>((sum, b) => {
        if (b.billedM3 === null) return sum;
        return (sum ?? 0) + b.billedM3;
      }, null);
      const chartM3 =
        source === 'interval'
          ? a.intervalCount > 0
            ? a.intervalSum
            : null
          : source === 'billed'
            ? billedSum
            : null;
      return {
        key,
        year: m.year,
        monthIndex: m.monthIndex,
        intervalM3: a.intervalCount > 0 ? a.intervalSum : null,
        bills: a.bills,
        chartM3,
        firstDay: a.firstDay,
        lastDay: a.lastDay,
      };
    });

  return { source, rows, hasInterval, hasBills, hasPaid };
}

/* ==========================================================================
 * Year-over-year
 * ========================================================================== */

export type GasYoYSeries = {
  year: number;
  label: string;
  /** m³ per month-of-year (Jan..Dec); null = no data for that month. */
  m3: (number | null)[];
};

export type GasYoYDelta = {
  year: number;
  label: string;
  /** Percent change vs the same month one year earlier; null = not comparable. */
  pct: (number | null)[];
};

export type GasYoYYearTotal = {
  year: number;
  /** Sum of the charted m³ over the months this year carries. */
  m3: number;
  /** How many of the 12 months carry data. */
  months: number;
  /** Incomplete year: fewer than 12 months, or touching a partial edge month. */
  partial: boolean;
};

export type GasYearOverYear = {
  ready: boolean;
  /** Honest empty-state text when `ready` is false (null when ready). */
  emptyMessage: string | null;
  series: GasYoYSeries[];
  /** One entry per year that has its prior calendar year present in the data. */
  deltas: GasYoYDelta[];
  yearTotals: GasYoYYearTotal[];
  /** 'yyyy-MM' keys whose data does not cover the whole calendar month. */
  partialMonths: string[];
  /** Inclusive calendar span first..last row, in months. */
  spanMonths: number;
  /** Distinct yyyy-MM rows that carry charted data. */
  monthsOfData: number;
  firstMonthLabel: string | null;
  lastMonthLabel: string | null;
};

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${monthLabelsFor()[Number(m) - 1]} ${y}`;
}

/** Days in a local calendar month (0-based month index). */
export function daysInMonth(year: number, monthIdx: number): number {
  return new Date(year, monthIdx + 1, 0).getDate();
}

/**
 * The gas year-over-year: monthly m³ per year over the import's chart
 * source, gated on MORE than 12 months of span (the electricity gate minus
 * the rate-set clause — gas bills carry ¢/m³ rates but no versioned rate
 * sets, so there are no boundaries to annotate).
 */
export function buildGasYearOverYear(monthly: GasMonthly): GasYearOverYear {
  const base: GasYearOverYear = {
    ready: false,
    emptyMessage: null,
    series: [],
    deltas: [],
    yearTotals: [],
    partialMonths: [],
    spanMonths: 0,
    monthsOfData: 0,
    firstMonthLabel: null,
    lastMonthLabel: null,
  };

  const rows = monthly.rows.filter((r) => r.chartM3 !== null);

  if (rows.length === 0) {
    // Distinguish "nothing stored" from "stored, but states no volume": the
    // first is an upload prompt, the second must never claim data is missing.
    return {
      ...base,
      emptyMessage:
        monthly.rows.length > 0 ? t('gasBill.noChartableVolume') : t('yoy.emptyNoDataLib'),
    };
  }

  // Everything below keys off the CHARTABLE rows: the gate, the span and
  // the labels must describe the months this panel can actually plot, or
  // "you have N months (first – last)" would count months it cannot draw.
  const firstKey = rows[0].key;
  const lastKey = rows[rows.length - 1].key;
  const [fy, fm] = firstKey.split('-').map(Number);
  const [ly, lm] = lastKey.split('-').map(Number);
  const spanMonths = (ly - fy) * 12 + (lm - fm) + 1;

  // year -> month-of-year -> m³
  const buckets = new Map<number, Map<number, number>>();
  for (const r of rows) {
    let byMonth = buckets.get(r.year);
    if (!byMonth) {
      byMonth = new Map<number, number>();
      buckets.set(r.year, byMonth);
    }
    byMonth.set(r.monthIndex, (byMonth.get(r.monthIndex) ?? 0) + (r.chartM3 as number));
  }

  const years = Array.from(buckets.keys()).sort((a, b) => a - b);
  const labels = monthLabelsFor();

  const series: GasYoYSeries[] = years.map((y) => {
    const byMonth = buckets.get(y)!;
    return {
      year: y,
      label: String(y),
      m3: labels.map((_, m) => (byMonth.has(m) ? byMonth.get(m)! : null)),
    };
  });

  const deltas: GasYoYDelta[] = years
    .filter((y) => buckets.has(y - 1))
    .map((y) => {
      const cur = buckets.get(y)!;
      const prev = buckets.get(y - 1)!;
      const pct: (number | null)[] = labels.map((_, m) => {
        if (!cur.has(m) || !prev.has(m)) return null;
        const pv = prev.get(m)!;
        if (pv === 0) return null;
        return ((cur.get(m)! - pv) / pv) * 100;
      });
      return { year: y, label: `${y} vs ${y - 1}`, pct };
    });

  // Partial months: the span's first row when data starts after day 1, and
  // its last row when data ends before the month's last day — the coverage
  // days the builder recorded from the readings' starts and the bills' spans.
  const partialMonths: string[] = [];
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  if (firstRow.firstDay !== null && firstRow.firstDay > 1) partialMonths.push(firstKey);
  if (
    lastRow.lastDay !== null &&
    lastRow.lastDay < daysInMonth(lastRow.year, lastRow.monthIndex) &&
    !partialMonths.includes(lastKey)
  ) {
    partialMonths.push(lastKey);
  }

  const partialSet = new Set(partialMonths);
  const yearTotals: GasYoYYearTotal[] = years.map((y) => {
    const byMonth = buckets.get(y)!;
    let total = 0;
    for (const v of byMonth.values()) total += v;
    const months = byMonth.size;
    const touchesPartial = Array.from(partialSet).some((k) => k.startsWith(`${y}-`));
    return { year: y, m3: total, months, partial: months < 12 || touchesPartial };
  });

  const monthsOfData = rows.length;
  const ready = spanMonths > 12;
  let emptyMessage: string | null = null;
  if (!ready) {
    emptyMessage = t('yoy.emptyNeedMonths', {
      count: monthsOfData,
      months: monthsOfData,
      first: monthLabel(firstKey),
      last: monthLabel(lastKey),
    });
  }

  return {
    ready,
    emptyMessage,
    series,
    deltas,
    yearTotals,
    partialMonths,
    spanMonths,
    monthsOfData,
    firstMonthLabel: monthLabel(firstKey),
    lastMonthLabel: monthLabel(lastKey),
  };
}
