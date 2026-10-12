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

/** ms in a day. Named here so the literals stop multiplying across files. */
export const MS_PER_DAY = 86_400_000;

/** True for a well-formed `yyyy-MM-dd` key. */
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY.test(value);
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