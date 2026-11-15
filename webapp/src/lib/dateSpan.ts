/**
 * Day-span arithmetic for `yyyy-MM-dd` day keys and unix timestamps.
 *
 * These were written out longhand in five places, and two of those were a
 * VERBATIM copy of each other (`Dashboard.tsx`'s `totalDays` and
 * `OverviewPanel.tsx`'s), comments included — free to drift apart silently.
 *
 * The subtlety worth stating once, because it is why there is a module at
 * all: a `yyyy-MM-dd` key carries NO timezone, so reading it back through a
 * local `Date` makes the answer depend on the machine's zone and on whether a
 * DST boundary falls inside the span. Everything here is either pure calendar
 * maths on the parts, or UTC arithmetic on an epoch — never "midnight local,
 * then count days".
 */

import { t } from '@/i18n';

/** ms in a day. Named here so the literals stop multiplying across files. */
export const MS_PER_DAY = 86_400_000;

/**
 * What a `yyyy-MM-dd` day key READS as, when it names a day.
 *
 * A row or a bill stamped by an undateable instant formats its day key as
 * `NaN-NaN-NaN` (see `dayKeyDate` below): truthy, structural, and useful —
 * it keeps two hostile periods from colliding on one string as React keys —
 * but garbage the moment it is PRINTED. Display sites route through here so
 * the user sees the app's own localized `axis.unavailableDate` marker instead,
 * while every structural consumer (keys, testids, `dateWindowOf`, sorting)
 * keeps reading the raw value. A well-formed key comes back byte-identical.
 */
export function dayKeyLabel(key: string | null | undefined): string {
  return dayKeyDate(key) ? (key as string) : t('axis.unavailableDate');
}

/** True for a well-formed `yyyy-MM-dd` key. */
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY.test(value);
}

/**
 * The local date a `yyyy-MM-dd` day key names, or null when it names none.
 *
 * A row whose instant is undateable formats its day key as `NaN-NaN-NaN`
 * (t_bcc1b9c6) — truthy, but no date — and handing that to a formatter
 * throws `RangeError: Invalid time value`. Every stored-key → Date path
 * asks here first and degrades to its own fallback instead of parsing
 * blind; same guard shape as `daysBetweenDayKeys` above and
 * `dataFreshness` in lib/freshness.ts.
 */
export function dayKeyDate(key: string | null | undefined): Date | null {
  if (typeof key !== 'string') return null;
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Inclusive day count between two `yyyy-MM-dd` keys: the 1st to the 1st is
 * 1 day, the 1st to the 31st is 31. Always ≥ 1, so it is safe to divide by.
 */
export function daysBetweenDayKeys(from: string, to: string): number {
  const a = DAY_KEY.exec(from);
  const b = DAY_KEY.exec(to);
  if (!a || !b) return 1;
  const fromUtc = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const toUtc = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.max(1, Math.round((toUtc - fromUtc) / MS_PER_DAY) + 1);
}

/** Days in a month, 1-indexed (`1` = January). Proleptic Gregorian, no tz. */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}