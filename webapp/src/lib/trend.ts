/**
 * Year-over-year trend aggregation — pure functions, no I/O.
 *
 * The panel answers: "for each calendar month, how does this year's kWh
 * compare with the same month last year?" and gates itself honestly until
 * the loaded dataset actually spans enough history (12+ months) or enough
 * rate-set changes to make the comparison meaningful.
 *
 * Rate-set boundaries are surfaced, not smoothed over: cost math elsewhere
 * in the app keys off `ProcessedPoint.activeRateSet` per reading, and this
 * module tells the UI where a rate change fell inside the loaded span so
 * the panel can call it out instead of implying one flat price.
 */

import { format } from 'date-fns';
import type { ProcessedPoint } from './energy';
// Wave U — month labels and empty-state text follow the active locale.
import { fmtDate, getLocale, t } from '@/i18n';

export const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Wave U — the same 12 headers in the active language. English is the
 * canonical array above (which tests pin); French reads date-fns' `fr`.
 */
export function monthLabelsFor(locale: string = getLocale()): readonly string[] {
  if (locale !== 'fr') return MONTH_LABELS;
  return Array.from({ length: 12 }, (_, m) =>
    fmtDate(new Date(2026, m, 1), 'MMM').replace(/\.$/, ''),
  );
}

export type TrendSeries = {
  year: number;
  label: string;
  /** kWh per month-of-year (Jan..Dec); null = no data for that month. */
  kwh: (number | null)[];
};

export type TrendDelta = {
  /** The later year of the comparison pair. */
  year: number;
  label: string;
  /** Percent change vs the same month one year earlier; null = not comparable. */
  pct: (number | null)[];
};

export type YearOverYearTrend = {
  ready: boolean;
  /** Honest empty-state text when `ready` is false (null when ready). */
  emptyMessage: string | null;
  years: number[];
  series: TrendSeries[];
  /** One entry per year that has its prior calendar year present in the data. */
  deltas: TrendDelta[];
  /** Effective dates of rate-set changes that fall INSIDE the data span. */
  boundaries: string[];
  /** 'yyyy-MM' keys of the dataset's first/last calendar month if not fully covered. */
  partialMonths: string[];
  /** Inclusive calendar span first..last reading, in months. */
  spanMonths: number;
  /** Distinct rate sets observed in the data, minus one (>= 0). */
  rateSetChanges: number;
  /** Distinct yyyy-MM months that actually contain readings. */
  monthsOfData: number;
  firstMonthLabel: string | null;
  lastMonthLabel: string | null;
};

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(d: Date): string {
  return `${monthLabelsFor()[d.getMonth()]} ${d.getFullYear()}`;
}

function daysInMonth(year: number, monthIdx: number): number {
  return new Date(year, monthIdx + 1, 0).getDate();
}

/**
 * Build the year-over-year comparison from the FULL loaded dataset
 * (not the current date-window selection — trend needs all history).
 */
export function buildYearOverYear(data: ProcessedPoint[]): YearOverYearTrend {
  const base: YearOverYearTrend = {
    ready: false,
    emptyMessage: null,
    years: [],
    series: [],
    deltas: [],
    boundaries: [],
    partialMonths: [],
    spanMonths: 0,
    rateSetChanges: 0,
    monthsOfData: 0,
    firstMonthLabel: null,
    lastMonthLabel: null,
  };

  if (data.length === 0) {
    return {
      ...base,
      emptyMessage: t('yoy.emptyNoDataLib'),
    };
  }

  // --- Span, months, years -------------------------------------------------
  let minTs = data[0].timestamp;
  let maxTs = data[0].timestamp;
  const monthSet = new Set<string>();
  const rateSetDates = new Set<string>();
  // year -> month-of-year -> kWh
  const buckets = new Map<number, Map<number, number>>();

  for (const p of data) {
    if (p.timestamp < minTs) minTs = p.timestamp;
    if (p.timestamp > maxTs) maxTs = p.timestamp;
    const d = p.dateObj;
    monthSet.add(monthKey(d));
    rateSetDates.add(p.activeRateSet.effectiveDate);
    const y = d.getFullYear();
    const m = d.getMonth();
    let byMonth = buckets.get(y);
    if (!byMonth) {
      byMonth = new Map<number, number>();
      buckets.set(y, byMonth);
    }
    byMonth.set(m, (byMonth.get(m) ?? 0) + p.usage_kwh);
  }

  const first = new Date(minTs * 1000);
  const last = new Date(maxTs * 1000);
  const spanMonths =
    (last.getFullYear() - first.getFullYear()) * 12 +
    (last.getMonth() - first.getMonth()) +
    1;
  const rateSetChanges = Math.max(0, rateSetDates.size - 1);

  const years = Array.from(buckets.keys()).sort((a, b) => a - b);

  const series: TrendSeries[] = years.map((y) => {
    const byMonth = buckets.get(y)!;
    const kwh: (number | null)[] = MONTH_LABELS.map((_, m) =>
      byMonth.has(m) ? byMonth.get(m)! : null,
    );
    return { year: y, label: String(y), kwh };
  });

  // Deltas: a year only gets a row when its prior calendar year is present.
  const deltas: TrendDelta[] = years
    .filter((y) => buckets.has(y - 1))
    .map((y) => {
      const cur = buckets.get(y)!;
      const prev = buckets.get(y - 1)!;
      const pct: (number | null)[] = MONTH_LABELS.map((_, m) => {
        if (!cur.has(m) || !prev.has(m)) return null;
        const pv = prev.get(m)!;
        if (pv === 0) return null;
        return ((cur.get(m)! - pv) / pv) * 100;
      });
      return { year: y, label: `${y} vs ${y - 1}`, pct };
    });

  // Rate-set boundaries strictly inside the data span: a change only
  // "happened" for this dataset if readings exist on both sides of it.
  // Same day-string format processRawData uses for effectiveDate matching,
  // so boundary detection can't drift from how rates are actually assigned.
  const firstDay = format(first, 'yyyy-MM-dd');
  const lastDay = format(last, 'yyyy-MM-dd');
  const boundaries = Array.from(rateSetDates)
    .filter((eff) => eff > firstDay && eff <= lastDay)
    .sort();

  // First/last calendar months are partial when the data doesn't start/end
  // on a month boundary — a partial month skews month-over-month deltas.
  const partialMonths: string[] = [];
  if (first.getDate() > 1) partialMonths.push(monthKey(first));
  if (last.getDate() < daysInMonth(last.getFullYear(), last.getMonth())) {
    const key = monthKey(last);
    if (!partialMonths.includes(key)) partialMonths.push(key);
  }

  // --- Gate ----------------------------------------------------------------
  // Task spec: render when the dataset spans >12 months OR >1 rate-set change.
  const ready = spanMonths > 12 || rateSetChanges > 1;
  let emptyMessage: string | null = null;
  if (!ready) {
    emptyMessage =
      data.length > 0
        ? t('yoy.emptyNeedMonths', {
            count: monthSet.size,
            months: monthSet.size,
            first: monthLabel(first),
            last: monthLabel(last),
          })
        : null;
  }

  return {
    ready,
    emptyMessage,
    years,
    series,
    deltas,
    boundaries,
    partialMonths,
    spanMonths,
    rateSetChanges,
    monthsOfData: monthSet.size,
    firstMonthLabel: monthLabel(first),
    lastMonthLabel: monthLabel(last),
  };
}
