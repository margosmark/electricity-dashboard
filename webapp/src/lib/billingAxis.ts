/**
 * The BILLING AXIS — the app's timeline, taken from the file's OWN
 * `UsageSummary.billingPeriod` entries instead of synthetic calendar rules.
 *
 * Everything here is pure and synchronous: it takes the bills Wave L already
 * parsed and the readings the app already prices, and returns an ordered list
 * of periods the UI can walk. Nothing fetches, nothing stores, nothing
 * guesses a figure the file does not state.
 *
 * What the axis is made of:
 *
 *   • `billed`  — one period per UsageSummary, de-duped across exports. Two
 *                 files that describe the same bill (identical, or one written
 *                 with slightly different read dates) collapse into ONE
 *                 period; the richer bill wins, because the file with more
 *                 line items is the one that can actually be itemized.
 *   • `gap`     — a hole between two billed periods. The utility issued no
 *                 bill we hold for those days, so the timeline says "unknown
 *                 period" rather than pretending the days do not exist or
 *                 that they cost $0.
 *   • `open`    — everything after the last billed period: readings the
 *                 utility has NOT billed yet. Its money is an ESTIMATE of the
 *                 commodity charge only — delivery, regulatory and HST for
 *                 that window are not real until a bill issues, and this app
 *                 does not invent them.
 *   • `derived` — the fallback. A file with no UsageSummary (older or smaller
 *                 exports) still needs a timeline, so periods are cut on the
 *                 user's billing-day setting exactly the way the app did
 *                 before this module existed.
 *
 * The windows here are the `billingPeriod` stamps (start + duration), which is
 * what the axis follows. Money for a billed period is still reconciled
 * against `billWindow` (the meter reads) — that distinction is Wave L's and
 * it stays: the axis decides ORDER, LABELS and the date windows the scope
 * buttons open; the reads decide WHICH readings were billed.
 */

import { billPeriodLabel, billWindow, getBillingPeriod, type UsageSummary } from './energy';
// Wave U — the axis's captions come from the locale catalog at call time.
import { getLocale, t } from '@/i18n';

/** A reading row for axis purposes: only the instant (and its day) matter. */
export type AxisRow = { timestamp: number; dayStr?: string };

/**
 * How far apart two `billingPeriod` stamps may sit before the space between
 * them is a real hole. Real Oakville periods abut to the day (Jul 22 → Aug
 * 20), and a day of clock skew between two exports is not a gap — two days is.
 */
export const AXIS_GAP_TOLERANCE_S = 2 * 86400;

const DAY_S = 86400;

export type AxisPeriodKind = 'billed' | 'gap' | 'open' | 'derived';

/**
 * Edge cases the axis refuses to smooth over, flagged in the DATA so every
 * panel can print them instead of averaging them away:
 *   `short` — under 25 days (a prorated bill; flat charges cover fewer days,
 *             so a per-month figure scaled naively would overstate it);
 *   `long`  — over 40 days (bills this long are usually part estimate: the
 *             utility billed a period it could not fully read yet).
 */
export type AxisPeriodFlag = 'short' | 'long';

export type AxisPeriod = {
  /** Stable identity: `<kind>:<start>`. React keys and navigation both use it. */
  key: string;
  kind: AxisPeriodKind;
  /** Window start, unix seconds (inclusive). */
  start: number;
  /** Window end, unix seconds (exclusive). */
  end: number;
  duration: number;
  /** Whole days in the window (≥ 1). */
  days: number;
  /** `yyyy-MM-dd` of the first day in the window. */
  startDate: string;
  /** `yyyy-MM-dd` of the LAST day this period accounts for (inclusive). */
  endDate: string;
  /** "Jul 22, 2026 – Aug 20" — the label every bill panel already prints. */
  label: string;
  /** Short axis label: "Jul 22, 2026". */
  shortLabel: string;
  /** The bill this period came from (billed periods only). */
  summary: UsageSummary | null;
  /**
   * True when the money for this period is OUR OWN estimate, never a bill.
   * Only the open period is estimated; a gap has no money at all.
   */
  estimated: boolean;
  /** Edge-case flags, or null for an ordinary 25–40 day period. */
  flag: AxisPeriodFlag | null;
  /** Distinct reading days inside the window ÷ window days. */
  coverage: number;
  /** Readings inside the window. */
  rows: AxisRow[];
};

export type BillingAxis = {
  /** Every period, oldest first — the timeline itself. */
  periods: AxisPeriod[];
  /** The billed periods alone (what money panels may treat as fact). */
  billed: AxisPeriod[];
  /** Honest holes between billed periods. */
  gaps: AxisPeriod[];
  /** The unbilled tail, or null when the file's readings stop at a bill. */
  open: AxisPeriod | null;
  /** True when there were no UsageSummary blocks and billing-day periods were cut instead. */
  usedFallback: boolean;
  /** Overlapping duplicate bills collapsed into one period. */
  droppedDuplicates: number;
  /** One honest sentence about how this axis was built. */
  note: string;
};

export const EMPTY_AXIS: BillingAxis = {
  periods: [],
  billed: [],
  gaps: [],
  open: null,
  usedFallback: false,
  droppedDuplicates: 0,
  note: t('axis.emptyNote'),
};

const p2 = (n: number) => String(n).padStart(2, '0');

/** `yyyy-MM-dd` of a unix stamp in UTC — how a billingPeriod stamp reads. */
function stampDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** `yyyy-MM-dd` of a unix stamp in the browser's day — how a billing-day cut reads. */
function localDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * Collapse bills that describe the SAME period, which is what importing two
 * exports of overlapping ranges produces.
 *
 * `unionBillFeeds` already de-dupes on an identical `start`, so this catches
 * the case it cannot see: two files that stamp the same bill a day apart
 * (different read dates, different export jobs). Sorted by start, any period
 * that overlaps the one already kept is the same bill wearing another stamp —
 * the richer copy wins and the loser is counted, so the UI can say how many
 * duplicates were folded in rather than silently shrinking the list.
 */
export function dedupeBillPeriods(summaries: UsageSummary[]): {
  kept: UsageSummary[];
  dropped: number;
} {
  const sorted = [...summaries].sort((a, b) => a.start - b.start || b.duration - a.duration);
  const kept: UsageSummary[] = [];
  let dropped = 0;

  for (const candidate of sorted) {
    const prev = kept[kept.length - 1];
    const overlaps = prev !== undefined && candidate.start < prev.start + prev.duration;
    if (!overlaps) {
      kept.push(candidate);
      continue;
    }
    const prevRicher =
      prev.items.length > candidate.items.length ||
      (prev.items.length === candidate.items.length && prev.duration >= candidate.duration);
    if (prevRicher) {
      dropped += 1;
    } else {
      kept[kept.length - 1] = candidate;
      dropped += 1;
    }
  }
  return { kept, dropped };
}

function dayKeyOfRow(r: AxisRow): string {
  return r.dayStr ?? localDayKey(r.timestamp);
}

/** Rows whose timestamp falls in [start, end), plus the window's coverage. */
function coverageOf(
  rows: AxisRow[],
  start: number,
  end: number,
): { rows: AxisRow[]; coverage: number } {
  const inside = rows.filter((r) => r.timestamp >= start && r.timestamp < end);
  const days = Math.max(1, Math.round((end - start) / DAY_S));
  const seen = new Set(inside.map(dayKeyOfRow));
  return { rows: inside, coverage: Math.min(1, seen.size / days) };
}

/**
 * The instant a billed period's window actually ends for the purpose of
 * "what has NOT been billed yet": the later of the `billingPeriod` stamp and
 * the meter reads Wave L prefers. Using the reads alone would strand a few
 * billed hours into the open bucket and count them twice; using the stamp
 * alone would leave billed readings sitting in the unbilled tail.
 */
function billedThroughOf(summary: UsageSummary): number {
  const window = billWindow(summary);
  return Math.max(summary.start + summary.duration, window.end);
}

type PeriodLabels = { label: string; shortLabel: string; startDate: string; endDate: string };

function makePeriod(
  kind: AxisPeriodKind,
  start: number,
  end: number,
  summary: UsageSummary | null,
  rows: AxisRow[],
  labels: PeriodLabels,
  estimated: boolean,
): AxisPeriod {
  const days = Math.max(1, Math.round((end - start) / DAY_S));
  const { coverage, rows: inside } = coverageOf(rows, start, end);
  return {
    key: `${kind}:${start}`,
    kind,
    start,
    end,
    duration: Math.max(0, end - start),
    days,
    startDate: labels.startDate,
    endDate: labels.endDate,
    label: labels.label,
    shortLabel: labels.shortLabel,
    summary,
    estimated,
    flag: days < 25 ? 'short' : days > 40 ? 'long' : null,
    coverage,
    rows: inside,
  };
}

function billedPeriodOf(summary: UsageSummary, rows: AxisRow[]): AxisPeriod {
  const start = summary.start;
  const end = summary.start + summary.duration;
  // The same label ActualBillPanel and the money stacks print — one
  // vocabulary for every period the app draws.
  const label = billPeriodLabel(summary.start, summary.duration);
  return makePeriod(
    'billed',
    start,
    end,
    summary,
    rows,
    {
      label,
      shortLabel: label.split(' – ')[0],
      startDate: stampDayKey(start),
      // The label's own end day: the reads land ON the read date, so that is
      // the last day the period accounts for (Aug 20 for a Jul 22 → Aug 20
      // stamp) and the date window the scope buttons open matches the label.
      endDate: stampDayKey(Math.max(end, billedThroughOf(summary))),
    },
    false,
  );
}

/**
 * Periods cut on the user's billing day — the timeline the app had before the
 * file's own periods were used, kept as the fallback for exports that carry no
 * UsageSummary at all. They tile contiguously from the billing day, exactly
 * like `getBillingPeriod`, and never claim money.
 */
function derivedPeriods(rows: AxisRow[], billingDay: number): AxisPeriod[] {
  if (rows.length === 0) return [];
  let first = rows[0].timestamp;
  let last = rows[0].timestamp;
  for (const r of rows) {
    if (r.timestamp < first) first = r.timestamp;
    if (r.timestamp > last) last = r.timestamp;
  }

  const out: AxisPeriod[] = [];
  // Anchor on the last reading (never in the future) and walk back until the
  // whole reading span is covered; the loop is bounded by `guard`.
  let cursor = getBillingPeriod(new Date(last * 1000), billingDay);
  let guard = 0;
  while (cursor.start.getTime() / 1000 > first && guard < 1200) {
    const start = Math.floor(cursor.start.getTime() / 1000);
    // getBillingPeriod's `end` is the last DAY inclusive; axis windows are
    // half-open, so this period ends the following midnight.
    const end = Math.floor(
      new Date(
        cursor.end.getFullYear(),
        cursor.end.getMonth(),
        cursor.end.getDate() + 1,
      ).getTime() / 1000,
    );
    const startDate = localDayKey(start);
    const endDate = localDayKey(end - 1);
    out.unshift(
      makePeriod(
        'derived',
        start,
        end,
        null,
        rows,
        {
          label: `${startDate} – ${endDate} (your billing day, no bill in this file)`,
          shortLabel: startDate,
          startDate,
          endDate,
        },
        false,
      ),
    );
    cursor = getBillingPeriod(new Date(cursor.start.getTime() - DAY_S * 1000), billingDay);
    guard += 1;
  }
  return out;
}

/**
 * The unbilled tail: readings after the last anchored period, grouped into
 * their own pseudo-period. Returns null when there are none — including the
 * honest case where an export's LAST reading predates the last bill's end
 * (then everything the file holds has already been billed).
 */
function openPeriod(anchors: AxisPeriod[], rows: AxisRow[]): AxisPeriod | null {
  if (anchors.length === 0 || rows.length === 0) return null;
  const last = anchors[anchors.length - 1];
  const start = last.summary ? Math.max(last.end, billedThroughOf(last.summary)) : last.end;
  const tail = rows.filter((r) => r.timestamp >= start);
  if (tail.length === 0) return null;
  let maxTs = tail[0].timestamp;
  for (const r of tail) if (r.timestamp > maxTs) maxTs = r.timestamp;
  // Round the tail out to the end of its last day: a period labelled "through
  // Oct 6" must cover Oct 6, not stop at 14:00.
  const end = Math.ceil((maxTs + 1) / DAY_S) * DAY_S;
  if (end <= start) return null;
  const startDate = stampDayKey(start);
  const endDate = stampDayKey(end - 1);
  return makePeriod(
    'open',
    start,
    end,
    null,
    rows,
    {
      // `end - start - 1` so the label's own end day is the LAST DAY HELD,
      // not the exclusive boundary one day past the newest reading.
      label: t('axis.openLabel', { label: billPeriodLabel(start, end - start - 1) }),
      shortLabel: t('axis.openShort', { date: startDate }),
      startDate,
      endDate,
    },
    true,
  );
}

export type BillingAxisOptions = {
  /** Bills from every loaded export, any order, possibly overlapping. */
  summaries?: UsageSummary[];
  /** Every priced reading (or at least every row with a timestamp). */
  rows?: AxisRow[];
  /** Billing day (1–31) — only used when there are no bills at all. */
  billingDay?: number;
};

/**
 * Build the axis.
 *
 * Order of operations, and why:
 *  1. de-dupe the bills — two exports of overlapping ranges must not put the
 *     same period on the timeline twice;
 *  2. cut a `gap` wherever two kept periods are more than
 *     {@link AXIS_GAP_TOLERANCE_S} apart — an unexplained hole stays visible;
 *  3. fall back to billing-day periods when the file states no bills;
 *  4. append the `open` period for readings past the last billed end, but
 *     only when such readings exist (an export whose last reading predates
 *     the last bill gets NO open bucket — there is nothing unbilled to show).
 */
export function buildBillingAxis(options: BillingAxisOptions): BillingAxis {
  const summaries = options.summaries ?? [];
  const rows = options.rows ?? [];
  const billingDay = options.billingDay ?? 1;

  if (summaries.length === 0) {
    const derived = derivedPeriods(rows, billingDay);
    const open = openPeriod(derived, rows);
    const periods = open ? [...derived, open] : derived;
    return {
      periods,
      billed: [],
      gaps: [],
      open,
      usedFallback: derived.length > 0,
      droppedDuplicates: 0,
      note:
        derived.length === 0
          ? t('axis.emptyNote')
          : t('axis.derivedNote', { day: billingDayLabel(billingDay) }),
    };
  }

  const { kept, dropped } = dedupeBillPeriods(summaries);
  const billed = kept.map((s) => billedPeriodOf(s, rows));

  const gaps: AxisPeriod[] = [];
  for (let i = 1; i < billed.length; i += 1) {
    const prev = billed[i - 1];
    const next = billed[i];
    if (next.start - prev.end > AXIS_GAP_TOLERANCE_S) {
      const start = prev.end;
      const end = next.start;
      const startDate = stampDayKey(start);
      const endDate = stampDayKey(end - 1);
      gaps.push(
        makePeriod(
          'gap',
          start,
          end,
          null,
          rows,
          {
            label: t('axis.gapLabel', { start: startDate, end: endDate }),
            shortLabel: startDate,
            startDate,
            endDate,
          },
          false,
        ),
      );
    }
  }

  const open = openPeriod(billed, rows);
  const periods = [...billed, ...gaps];
  if (open) periods.push(open);
  periods.sort((a, b) => a.start - b.start);

  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(t('axis.duplicates', { count: dropped }));
  }
  if (gaps.length > 0) {
    notes.push(t('axis.gapsNote', { count: gaps.length }));
  }
  if (open) {
    notes.push(t('axis.openNote', { days: open.days }));
  }
  notes.push(t('axis.billedNote', { count: billed.length }));

  return {
    periods,
    billed,
    gaps,
    open,
    usedFallback: false,
    droppedDuplicates: dropped,
    note: notes.join(' '),
  };
}

function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
}

/**
 * Wave U — "the 15th" in English, plain "15" in French (French ordinals are
 * not spelled into dates: "le 15"). The catalog interpolates whatever this
 * returns after its own "the"/"le".
 */
function billingDayLabel(n: number): string {
  return getLocale() === 'fr' ? String(n) : `${n}${ordinalSuffix(n)}`;
}

/** The period containing `ts`, or null. Windows are half-open [start, end). */
export function periodAt(axis: BillingAxis, ts: number): AxisPeriod | null {
  for (const p of axis.periods) {
    if (ts >= p.start && ts < p.end) return p;
  }
  return null;
}

/**
 * The neighbouring period for the view's prev/next controls. Returns null at
 * the ends of the timeline — the caller clamps instead of wrapping, because
 * a window that silently jumps from your oldest bill to your newest one is
 * worse than a button that does nothing.
 */
export function stepPeriod(
  axis: BillingAxis,
  from: number,
  dir: 'prev' | 'next',
): AxisPeriod | null {
  const index = axis.periods.findIndex((p) => from >= p.start && from < p.end);
  if (index === -1) {
    if (dir === 'next') return axis.periods.find((p) => p.start >= from) ?? null;
    return [...axis.periods].reverse().find((p) => p.end <= from) ?? null;
  }
  const target = dir === 'next' ? index + 1 : index - 1;
  return axis.periods[target] ?? null;
}

/** The date window a period turns into: both days inclusive. */
export function dateWindowOf(period: AxisPeriod): { start: string; end: string } {
  return { start: period.startDate, end: period.endDate };
}
