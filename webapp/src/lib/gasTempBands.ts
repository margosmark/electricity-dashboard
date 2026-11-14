/**
 * Gas usage vs outdoor temperature (t_909aa5fa) — the gas twin of
 * `lib/tempBands.ts` (Wave T), pure functions only: no I/O, no storage keys,
 * no money, no energy conversion.
 *
 * THE QUESTION: does the household's gas volume track the cold? Gas is a
 * heating fuel in Ontario, so unlike electricity — whose Wave T card leaves
 * the cold half FLAT and climbs only in the heat — the expected shape here is
 * the mirror image: heavy in the coldest bands, a flat baseline (water
 * heating, cooking) once it is mild. The card draws that shape from the
 * user's own meter instead of asserting it.
 *
 * WHAT IS BINNED, AND WHY IT IS NOT HOURS. Electricity is published per
 * hour, so Wave T bins hours. Gas volume is published per INTERVAL — Enbridge
 * daily readings (86 400 s) and billing-period blocks (2 419 200–2 851 200 s)
 * alike — and the feed never states a per-hour volume. Splitting a 33-day
 * block across hourly temperatures would FABRICATE per-hour numbers the file
 * never said, so the binning unit here is the interval itself:
 *
 *   • an interval's temperature is the MEAN of the outdoor temperatures of
 *     the hours it covers (same `tempAtC` clock as Wave T — absolute UTC
 *     hours, so an EDT reading meets that hour's temperature);
 *   • that mean decides which of the SAME SEVEN `TEMP_BANDS` the interval
 *     lands in — the fixed bins are imported from `lib/tempBands.ts`, never
 *     re-declared, so gas and electricity can be read against one legend;
 *   • the headline per band is `m³/day` = the band's total volume ÷ the total
 *     days its intervals cover (a 33-day block contributes 33 days, a daily
 *     reading 1) — a daily RATE, because raw per-interval totals would let a
 *     month-long block dwarf thirty daily readings that together say the
 *     same thing.
 *
 * TWO SOURCES, ONE SHAPE, DECLARED ONCE (same rule as `lib/gasMonthly.ts`):
 * stored interval readings when the import carries any usable one, else each
 * bill's OWN stated volume (`gasVolume(s).billed`, never a rate × m³), else
 * none. The billed fallback is the common Enbridge bill-only export: it can
 * only speak at BILL-PERIOD granularity, and the UI says so — no hidden
 * interpolation onto days the file never described. A bill that states no
 * volume is counted (`volumelessBills`) and left out, never guessed; a
 * reading with no stated interval length cannot be divided into days, so it
 * is counted (`skippedReadings`) and left out too.
 *
 * HONESTY CONTRACT: hours without a temperature are counted, never averaged
 * away — `matchedHours / totalHours` is the coverage number the card's
 * footer prints, so a partial weather fetch is visibly partial. Every figure
 * in the report is volume (m³), days, hours or °C: there is no money field
 * and no energy field anywhere in this module (source-scanned in
 * `GasTempBandCard.test.tsx`).
 *
 * WHAT A HOSTILE FILE MAY COST (t_edef78d7): a candidate's span is the file's
 * own word, so the report never walks it hour by hour — `hours` is counted in
 * closed form and the temperature series is indexed once into prefix sums,
 * making a build O(intervals + series hours) instead of O(Σ duration hours).
 * 1e15 s of billing period and 200 000 × 366-day readings both build inside
 * the fixed budget the tests pin, and NOTHING is dropped to buy that: no
 * interval is skipped, subsampled or averaged away, so the drop counters keep
 * meaning exactly what they meant (a refusal at import time — a bill period
 * past `MAX_BILL_PERIOD_SECONDS` — is `greenbutton/limits.ts`'s, before any
 * of this runs).
 */

import type { GasPoint } from './storage';
import type { UsageSummary } from './energy';
import { gasVolume, isGasSummary } from './gasBillUi';
import type { HourlyTemps } from './openMeteo';
import { TEMP_BANDS, bandIndexOf, type TempBandDef } from './tempBands';

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

/** Which volume series the temperature bands are built from. */
export type GasTempSource = 'interval' | 'billed' | 'none';

/** One binable unit: a stored reading or a bill's own stated period. */
type GasTempCandidate = {
  /** Epoch seconds of the interval/period start. */
  start: number;
  /** Interval length in seconds (> 0, stated by the feed). */
  duration_s: number;
  /** Volume in m³ for the whole interval (reading's own, or the bill's stated figure). */
  m3: number;
};

/** One band's numbers. */
export type GasTempBandRow = {
  band: TempBandDef;
  /** Intervals in this band that had at least one temperature. */
  intervals: number;
  /** Days those intervals cover (duration ÷ 86 400, summed). */
  days: number;
  /** Volume those intervals carried, in m³. */
  m3: number;
  /** The headline: m³ per day, i.e. the band's total volume over its total days. */
  meanM3PerDay: number;
  /** Share of the MATCHED volume — where the m³ actually sits. */
  shareOfM3: number;
  /** Mean outdoor temperature of the band's intervals, weighted by covered hours. */
  meanTempC: number;
  /** Temperature-covered hours behind this band. */
  hours: number;
};

export type GasTempBandReport = {
  /** The declared source (interval readings, else stated bill volumes, else none). */
  source: GasTempSource;
  rows: GasTempBandRow[];
  /** Intervals that had both a volume and at least one temperature. */
  matchedIntervals: number;
  /** Intervals with a usable volume and duration at all. */
  totalIntervals: number;
  /** Hours of those intervals the temperature series covers. */
  matchedHours: number;
  /** Hours the intervals span in total. */
  totalHours: number;
  /** matchedHours / totalHours — the card's honesty number. */
  coverage: number;
  /** Volume behind the matched intervals (the denominator of every share). */
  totalM3: number;
  /** The band whose mean m³/day is highest. */
  peakBandId: string | null;
  /** Stored readings dropped because the feed states no usable interval (counted, never guessed). */
  skippedReadings: number;
  /** Bills dropped because the bill states no volume (counted, never priced). */
  volumelessBills: number;
};

/** A stored reading that can be binned: finite instants and a stated length. */
function usablePoint(p: GasPoint): boolean {
  return (
    Number.isFinite(p.timestamp) &&
    Number.isFinite(p.duration_s) &&
    (p.duration_s as number) > 0 &&
    Number.isFinite(p.volume_m3)
  );
}

/** A bill that can be binned: its own period and its own stated volume. */
function usableBill(s: UsageSummary): GasTempCandidate | null {
  if (!isGasSummary(s)) return null;
  if (!Number.isFinite(s.start) || !Number.isFinite(s.duration) || s.duration <= 0) return null;
  const m3 = gasVolume(s).billed;
  if (m3 === null || !Number.isFinite(m3)) return null;
  return { start: s.start, duration_s: s.duration, m3 };
}

function pointCandidate(p: GasPoint): GasTempCandidate {
  return { start: p.timestamp, duration_s: p.duration_s as number, m3: p.volume_m3 };
}

/**
 * The import's declared band source — the SAME precedence `buildGasMonthly`
 * charts by: any usable stored reading wins, else any bill that states a
 * volume, else none. Exported so the temp fetch's span (`gasTempSpanRows`)
 * and the report can never disagree about which series is in play.
 */
export function gasTempSource(
  points: readonly GasPoint[],
  summaries: readonly UsageSummary[],
): GasTempSource {
  for (const p of points) if (usablePoint(p)) return 'interval';
  for (const s of summaries) if (usableBill(s)) return 'billed';
  return 'none';
}

/**
 * Every instant the chosen source touches — the start AND the end of each
 * interval — as the `{ timestamp }` rows `useHourlyTemps`/`spanOfRows`
 * consume. Both edges matter: a span ending at the last bill's START would
 * leave that period's temperature series clipped to its first hour, and its
 * mean temperature would be one hour pretending to be a month.
 */
export function gasTempSpanRows(
  points: readonly GasPoint[],
  summaries: readonly UsageSummary[],
): { timestamp: number }[] {
  const source = gasTempSource(points, summaries);
  const rows: { timestamp: number }[] = [];
  if (source === 'interval') {
    for (const p of points) {
      if (!usablePoint(p)) continue;
      rows.push({ timestamp: p.timestamp }, { timestamp: p.timestamp + (p.duration_s as number) });
    }
  } else if (source === 'billed') {
    for (const s of summaries) {
      const c = usableBill(s);
      if (!c) continue;
      rows.push({ timestamp: c.start }, { timestamp: c.start + c.duration_s });
    }
  }
  return rows;
}

/** The declared source's binable units, plus the honest drop counters. */
function candidatesFor(
  points: readonly GasPoint[],
  summaries: readonly UsageSummary[],
  source: GasTempSource,
): { candidates: GasTempCandidate[]; skippedReadings: number; volumelessBills: number } {
  const candidates: GasTempCandidate[] = [];
  let skippedReadings = 0;
  let volumelessBills = 0;

  if (source === 'interval') {
    for (const p of points) {
      if (usablePoint(p)) candidates.push(pointCandidate(p));
      else skippedReadings += 1;
    }
  } else {
    // `billed` or `none`: every stored reading exists but none is bandable
    // (that is WHY this source is not `interval`), so they are all counted
    // as left out — the card's note must not read "no metered readings"
    // over a pile of undividable ones. Bills that state no volume count in
    // both cases, so a bill-only import with no stated volumes can say
    // exactly what it is missing.
    skippedReadings += points.length;
    for (const s of summaries) {
      if (!isGasSummary(s)) continue;
      const c = usableBill(s);
      if (c) {
        if (source === 'billed') candidates.push(c);
      } else {
        volumelessBills += 1;
      }
    }
  }
  return { candidates, skippedReadings, volumelessBills };
}

/**
 * The temperature series as prefix sums, so one interval's covered hours and
 * covered °C are an O(1) subtraction instead of a walk of its own hours.
 *
 * WHY (t_edef78d7, F1 of t_3bfd4c3e). `intervalMeanTempC` used to run one
 * iteration per HOUR of every candidate, and a candidate's hours are whatever
 * the file said: 1e12 s of billing period measured 1 327 ms, 1e13 s 17 299 ms,
 * 1e15 s projected to ~29 minutes of main thread — and the document caps still
 * let 200 000 × 366-day readings through at 8 302 ms, because the caps bound
 * COUNTS, never the span each count carries. The walk is gone: a report now
 * costs O(series hours + intervals), and both counts are already bounded (the
 * series is what was fetched, the intervals by `MAX_ENTRIES`/`MAX_READINGS`).
 *
 * WHAT IS UNCHANGED. Every number the walk produced: `counts`/`sums` are the
 * walk's own running totals sliced at the interval's first and last covered
 * hour, and `hours` is the walk's iteration count in closed form. The one
 * difference is float rounding — two nearby large sums subtract — which lands
 * an order of magnitude below the `toBeCloseTo(..., 9)` the band means are
 * pinned at, and `gasTempBands.test.ts` checks the whole report against a
 * straight re-walk of the same hours to keep it honest.
 */
type TempIndex = {
  /** Hour index of `values[0]` — the series' own `startHour`. */
  startHour: number;
  /** `counts[i]` = hours in `[0, i)` that carry a temperature. */
  counts: number[];
  /** `sums[i]` = Σ of the °C in `[0, i)` that carry one. */
  sums: number[];
};

/** Prefix sums over the series, or null when there is no series to index. */
function tempIndexOf(temps: HourlyTemps | null | undefined): TempIndex | null {
  if (!temps || temps.values.length === 0) return null;
  const n = temps.values.length;
  // `fill(0)`, not a bare `new Array(n + 1)`: index 0 is the empty prefix and
  // must READ as 0. Left as a hole it reads `undefined`, and `x - undefined`
  // is NaN — which silently means "no temperature" for every interval that
  // starts at the series' first hour (the common case), i.e. a report that
  // bands nothing while claiming coverage 0. Caught by the existing suite the
  // moment it ran; the prefix is only correct if every slot is written.
  const counts = new Array<number>(n + 1).fill(0);
  const sums = new Array<number>(n + 1).fill(0);
  let covered = 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = temps.values[i];
    // `!== null`, exactly the test the walk applied per hour: a hole is a hole.
    if (v !== null) {
      covered += 1;
      sum += v;
    }
    counts[i + 1] = covered;
    sums[i + 1] = sum;
  }
  return { startHour: temps.startHour, counts, sums };
}

/** Mean °C over the hours `[start, start+duration)` the series covers. */
function intervalMeanTempC(
  index: TempIndex | null,
  start: number,
  duration_s: number,
): { mean: number | null; hours: number; covered: number } {
  const firstHour = Math.floor(start / SECONDS_PER_HOUR);
  const lastHour = Math.floor((start + duration_s - 1) / SECONDS_PER_HOUR);
  // The walk's own iteration count, in closed form. `duration_s > 0` for every
  // candidate, so lastHour >= firstHour holds for anything finite — and a
  // sub-second duration, where the old loop ran zero times, still reads 0 here.
  const hours = lastHour >= firstHour ? lastHour - firstHour + 1 : 0;
  // Nothing to look up: no series (offline, blocked, failed fetch — the same
  // state as zero coverage, never 0 °C), or no hour of this interval inside it.
  if (index === null || hours === 0) return { mean: null, hours, covered: 0 };
  const lo = Math.max(firstHour, index.startHour);
  const hi = Math.min(lastHour, index.startHour + index.counts.length - 2);
  if (hi < lo) return { mean: null, hours, covered: 0 };
  const from = lo - index.startHour;
  const to = hi - index.startHour + 1;
  const covered = index.counts[to] - index.counts[from];
  const sum = index.sums[to] - index.sums[from];
  return { mean: covered > 0 ? sum / covered : null, hours, covered };
}

/**
 * Bin every usable interval of the import by the mean outdoor temperature of
 * that interval's own hours.
 *
 * Intervals with no temperature at all are counted (they inflate
 * `totalHours`/`totalIntervals` and keep `coverage` honest) and never
 * averaged away. `temps === null` — offline, blocked, a failed fetch — is the
 * same state as zero coverage, not a state that invents 0 °C.
 */
export function buildGasTempBandReport(
  points: readonly GasPoint[],
  summaries: readonly UsageSummary[],
  temps: HourlyTemps | null | undefined,
): GasTempBandReport {
  const source = gasTempSource(points, summaries);
  const { candidates, skippedReadings, volumelessBills } = candidatesFor(points, summaries, source);
  // Built ONCE for the whole report: every candidate reads it, and the series
  // is the only thing here whose size is not already a document count. Named
  // `tempIndex`, never `index` — the loop below binds its own `index` (the band
  // a mean falls in), and shadowing it here would read that binding's TDZ.
  const tempIndex = tempIndexOf(temps);

  const acc = TEMP_BANDS.map(() => ({
    intervals: 0,
    days: 0,
    m3: 0,
    hours: 0,
    tempHourSum: 0,
  }));
  let matchedIntervals = 0;
  let matchedHours = 0;
  let totalHours = 0;
  let totalM3 = 0;

  for (const c of candidates) {
    const { mean, hours, covered } = intervalMeanTempC(tempIndex, c.start, c.duration_s);
    totalHours += hours;
    if (mean === null) continue;
    const index = bandIndexOf(mean);
    if (index === null) continue;
    matchedIntervals += 1;
    matchedHours += covered;
    totalM3 += c.m3;
    const a = acc[index];
    a.intervals += 1;
    a.days += c.duration_s / SECONDS_PER_DAY;
    a.m3 += c.m3;
    a.hours += covered;
    a.tempHourSum += mean * covered;
  }

  const rows: GasTempBandRow[] = TEMP_BANDS.map((band, i) => {
    const a = acc[i];
    return {
      band,
      intervals: a.intervals,
      days: a.days,
      m3: a.m3,
      meanM3PerDay: a.days > 0 ? a.m3 / a.days : 0,
      shareOfM3: totalM3 > 0 ? a.m3 / totalM3 : 0,
      meanTempC: a.hours > 0 ? a.tempHourSum / a.hours : 0,
      hours: a.hours,
    };
  });

  let peakBandId: string | null = null;
  let peak = -Infinity;
  for (const row of rows) {
    if (row.intervals > 0 && row.meanM3PerDay > peak) {
      peak = row.meanM3PerDay;
      peakBandId = row.band.id;
    }
  }

  const totalIntervals = candidates.length;
  return {
    source,
    rows,
    matchedIntervals,
    totalIntervals,
    matchedHours,
    totalHours,
    coverage: totalHours > 0 ? matchedHours / totalHours : 0,
    totalM3,
    peakBandId,
    skippedReadings,
    volumelessBills,
  };
}

/** True when the import has nothing to say (no volume, or nothing matched). */
export function gasTempBandEmpty(report: GasTempBandReport): boolean {
  return report.totalIntervals === 0 || report.matchedIntervals === 0;
}
