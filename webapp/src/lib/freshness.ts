/**
 * Wave H item 5 — "Data as of {date}".
 *
 * The most common support question a usage chart gets is "why is my chart
 * empty at the end?", and the answer is almost always that the export itself
 * stopped days or weeks ago. So the newest reading is surfaced as a first-
 * class fact next to the totals strip, with the age in words and an explicit
 * STALE flag once the gap is big enough that the chart's trailing edge is
 * going to look wrong.
 *
 * Pure and date-injected so the boundary (7 days) is unit-tested rather than
 * discovered by staring at a screenshot.
 */

/** After this many days with no new reading, say so loudly. */
export const STALE_AFTER_DAYS = 7;

export type Freshness = {
  /** `yyyy-MM-dd` of the newest reading loaded. */
  lastDate: string;
  /** Whole days between `lastDate` and `now`, clamped at 0 (future skew). */
  ageDays: number;
  /** True once the gap is wide enough to explain a "chart looks empty" report. */
  stale: boolean;
  /** Human age: "today" / "3 days ago" / "1 month ago" / "2 years ago". */
  relative: string;
};

/** Parse a `yyyy-MM-dd` as LOCAL midnight (no UTC off-by-one on the age). */
import { t } from '@/i18n';


function startOfDay(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return Number.NaN;
  return new Date(y, m - 1, d).getTime();
}

/**
 * How old the newest reading is, in the user's words.
 *
 * Wave U: the words come from the locale catalog (`freshness.*`, with
 * `_one`/`_other` variants so French pluralizes by its own rules). Called at
 * render time, so a language switch re-ages the data in the new language.
 */
export function relativeAge(ageDays: number): string {
  if (ageDays <= 0) return t('freshness.today');
  if (ageDays < 30) return t('freshness.days', { count: ageDays });
  if (ageDays < 365) return t('freshness.months', { count: Math.round(ageDays / 30) });
  return t('freshness.years', { count: Math.round(ageDays / 365) });
}

/**
 * @param lastDate newest reading, `yyyy-MM-dd`
 * @param now      injected clock (the app passes `new Date()`)
 */
export function dataFreshness(lastDate: string, now: Date): Freshness {
  const last = startOfDay(lastDate);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (Number.isNaN(last)) {
    return { lastDate, ageDays: 0, stale: false, relative: 'unknown' };
  }
  const ageDays = Math.max(0, Math.round((today - last) / 86_400_000));
  return {
    lastDate,
    ageDays,
    stale: ageDays > STALE_AFTER_DAYS,
    relative: relativeAge(ageDays),
  };
}
