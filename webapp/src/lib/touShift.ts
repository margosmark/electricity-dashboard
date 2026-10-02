/**
 * ToU-shift optimizer — replaces the old Streamlit "% shift" slider with
 * concrete, ranked recommendations.
 *
 * Idea: a household routine that lands in the On-Peak window every week at a
 * consistent volume is *shiftable* money. We find those recurring blocks in
 * the last 5 weeks of loaded data, price each block against honest move
 * targets, and rank by monthly dollar impact.
 *
 * All math is pure and deterministic (no `Date.now()`): the analysis window is
 * anchored to the NEWEST reading in the data, so historical datasets and unit
 * tests behave identically.
 */

import { startOfWeek } from 'date-fns';
import {
  type ProcessedPoint,
  type RateSet,
  getUloRateKey,
} from './energy';

/** Monday-start week (matches getFilteredForZoom's weekly buckets). */
function startOfWeekLike(d: Date): Date {
  return startOfWeek(d, { weekStartsOn: 1 });
}

/** A cell must appear in >= this many of the last 5 weeks to count as recurring. */
export const MIN_WEEKS_PRESENT = 3;
/** Lookback window in weeks (spec: ">=3 of last 5 weeks"). */
export const LOOKBACK_WEEKS = 5;
/** Max coefficient of variation (stddev/mean) for a cell's kWh to be "consistent". */
export const CONSISTENCY_MAX_CV = 0.4;
/** Below this mean a cell is noise, not a shiftable load. */
export const MIN_MEAN_KWH = 0.05;

const WEEKS_PER_MONTH = 52 / 12;

export type ShiftTarget = 'overnight_ulo' | 'weekend' | 'offpeak_tou';

export type ShiftOption = {
  target: ShiftTarget;
  /** Human label shown in the card, e.g. "Overnight (ULO)". */
  label: string;
  /** Destination rate in cents/kWh from the CURRENT rate set. */
  destRateCents: number;
  /** baseline − destination, cents/kWh (always > 0; non-positive options are dropped). */
  savingsCentsPerKwh: number;
  /** Estimated dollars saved per month if this block moves. */
  monthlySavings: number;
  /** What has to be true for the saving to materialize — shown verbatim. */
  assumption: string;
};

export type ShiftBlock = {
  /** Stable id, e.g. "mon-12-14". */
  id: string;
  /** 0 = Sunday … 6 = Saturday (Date.getDay()). */
  weekday: number;
  startHour: number;
  /** Exclusive, like Array.slice: block 12→14 covers 12:00 and 13:00. */
  endHour: number;
  /** "Mon 12:00–14:00" */
  label: string;
  /** Mean kWh for the whole block in a week where it shows up. */
  avgWeeklyKwh: number;
  /** Of the last LOOKBACK_WEEKS weeks, how many contained this block. */
  weeksSeen: number;
  /** Coefficient of variation across observed weeks (consistency evidence). */
  consistencyCv: number;
  /** What this block costs today under the user's plan, cents/kWh. */
  baselineRateCents: number;
  /** Positive-savings options only, ranked desc by monthlySavings. */
  options: ShiftOption[];
  bestMonthlySavings: number;
};

export type TouShiftEmptyReason =
  | 'no-data'
  | 'insufficient-history'
  | 'no-recurring-onpeak';

export type TouShiftAnalysis = {
  /** Ranked desc by bestMonthlySavings. */
  blocks: ShiftBlock[];
  /** Sum of bestMonthlySavings across blocks — honest upper bound per month. */
  totalMonthlySavings: number;
  /** Weeks of loaded data inside the lookback window (<= LOOKBACK_WEEKS). */
  dataWeeks: number;
  emptyReason: TouShiftEmptyReason | null;
};

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(h: number): string {
  return String(h).padStart(2, '0');
}

function blockLabel(weekday: number, startHour: number, endHour: number): string {
  return `${WEEKDAY_SHORT[weekday]} ${pad2(startHour)}:00–${pad2(endHour)}:00`;
}

/**
 * Baseline rate for a block under the user's CURRENT plan (cents/kWh).
 *
 * - TOU: the block was selected because categorizeTOU says On-Peak.
 * - ULO: priced per the readings' actual ULO category (the same wall-clock
 *   hours can be Mid-Peak under ULO — e.g. a summer 11:00 On-Peak TOU hour
 *   is ULO Mid-Peak until 16:00).
 * - Tiered: flat tier-1 rate, so time-shifting alone saves nothing until a
 *   plan change accompanies it (the options below state their assumptions).
 */
function baselineRateCents(
  plan: 'TOU' | 'Tiered' | 'ULO',
  blockReadings: ProcessedPoint[],
  rates: RateSet,
): number {
  if (plan === 'Tiered') return rates.tiered.tier1;
  if (plan === 'ULO') {
    // All readings in a block share weekday+hour; take the most common ULO category.
    const counts = new Map<string, number>();
    for (const r of blockReadings) {
      counts.set(r.uloCategory, (counts.get(r.uloCategory) || 0) + 1);
    }
    let best = 'Mid-Peak';
    let bestN = -1;
    for (const [cat, n] of counts) {
      if (n > bestN) { best = cat; bestN = n; }
    }
    return rates.ulo[getUloRateKey(best)];
  }
  return rates.tou.onPeak;
}

function buildOptions(baselineCents: number, rates: RateSet): Omit<ShiftOption, 'monthlySavings'>[] {
  const candidates: Omit<ShiftOption, 'monthlySavings' | 'savingsCentsPerKwh'>[] = [
    {
      target: 'overnight_ulo',
      label: 'Overnight (ULO 23:00–07:00)',
      destRateCents: rates.ulo.overnight,
      assumption: 'Requires switching to the ULO plan and moving the load into 23:00–07:00.',
    },
    {
      target: 'weekend',
      label: 'Weekend off-peak',
      destRateCents: rates.tou.offPeak,
      assumption: 'Move the activity to any weekend hour — off-peak on TOU, no plan switch.',
    },
    {
      target: 'offpeak_tou',
      label: 'Off-peak same day (19:00–07:00)',
      destRateCents: rates.tou.offPeak,
      assumption: 'Shift the load later the same day — off-peak hours on TOU, no plan switch.',
    },
  ];

  return candidates
    .map((c) => ({ ...c, savingsCentsPerKwh: baselineCents - c.destRateCents }))
    .filter((o) => o.savingsCentsPerKwh > 0);
}

/**
 * Analyze loaded hourly data for recurring On-Peak blocks and rank shift
 * opportunities by monthly dollar impact.
 *
 * @param processedData full loaded dataset (not view-filtered — recurrence
 *   needs the whole recent history, independent of the chart's date scope)
 * @param plan           the user's currently selected plan (baseline pricing)
 * @param rates          current RateSet (recommendations are forward-looking)
 */
export function analyzeTouShifts(
  processedData: ProcessedPoint[],
  plan: 'TOU' | 'Tiered' | 'ULO',
  rates: RateSet | null,
): TouShiftAnalysis {
  const empty = (reason: TouShiftEmptyReason, dataWeeks = 0): TouShiftAnalysis => ({
    blocks: [],
    totalMonthlySavings: 0,
    dataWeeks,
    emptyReason: reason,
  });

  if (processedData.length === 0) return empty('no-data');
  if (!rates) return empty('no-data');

  // --- Window: LOOKBACK_WEEKS Monday-start weeks ending at the newest reading.
  let newest = processedData[0];
  for (const d of processedData) if (d.timestamp > newest.timestamp) newest = d;
  const newestWeek = startOfWeekLike(newest.dateObj);
  const windowStart = new Date(newestWeek);
  windowStart.setDate(windowStart.getDate() - (LOOKBACK_WEEKS - 1) * 7);

  const inWindow = processedData.filter((d) => d.dateObj >= windowStart && d.dateObj <= newest.dateObj);
  if (inWindow.length === 0) return empty('no-data');

  // --- Bucket by (weekday, hour, weekIndex).
  // cellKey -> weekIndex -> kWh (summed defensively if data isn't strictly hourly)
  const cells = new Map<string, Map<number, number>>();
  const weekIndexSet = new Set<number>();
  const cellMeta = new Map<string, { weekday: number; hour: number; readings: ProcessedPoint[] }>();

  for (const r of inWindow) {
    // Math.round (not floor): local Monday-to-Monday deltas can be ±1h around
    // DST transitions; rounding keeps the week index stable across them.
    const weekIdx = Math.round(
      (startOfWeekLike(r.dateObj).getTime() - windowStart.getTime()) / (7 * 24 * 3600 * 1000),
    );
    if (weekIdx < 0 || weekIdx >= LOOKBACK_WEEKS) continue;
    weekIndexSet.add(weekIdx);

    // Only On-Peak readings feed the analysis (selection criterion per spec).
    // Across a season boundary (summer↔winter On-Peak windows shift), the
    // off-peak weeks of a borderline hour drop out honestly instead of being
    // counted as recurring On-Peak load.
    if (r.touCategory !== 'On-Peak') continue;

    const weekday = r.dateObj.getDay();
    const hour = r.dateObj.getHours();
    const key = `${weekday}:${hour}`;
    let byWeek = cells.get(key);
    if (!byWeek) { byWeek = new Map(); cells.set(key, byWeek); }
    byWeek.set(weekIdx, (byWeek.get(weekIdx) || 0) + r.usage_kwh);

    let meta = cellMeta.get(key);
    if (!meta) { meta = { weekday, hour, readings: [] }; cellMeta.set(key, meta); }
    meta.readings.push(r);
  }

  const dataWeeks = weekIndexSet.size;
  if (dataWeeks < MIN_WEEKS_PRESENT) return empty('insufficient-history', dataWeeks);

  // --- Qualifying cells: On-Peak + recurring >= MIN_WEEKS_PRESENT + consistent.
  type QualifiedCell = {
    weekday: number;
    hour: number;
    weeksPresent: number;
    meanKwh: number;
    cv: number;
    readings: ProcessedPoint[];
  };
  const qualified: QualifiedCell[] = [];

  for (const [key, byWeek] of cells) {
    const meta = cellMeta.get(key)!;

    const weeksPresent = byWeek.size;
    if (weeksPresent < MIN_WEEKS_PRESENT) continue;

    const values = Array.from(byWeek.values()).filter((v) => v > 0);
    if (values.length < MIN_WEEKS_PRESENT) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean < MIN_MEAN_KWH) continue;
    const variance =
      values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv > CONSISTENCY_MAX_CV) continue;

    qualified.push({ weekday: meta.weekday, hour: meta.hour, weeksPresent, meanKwh: mean, cv, readings: meta.readings });
  }

  if (qualified.length === 0) return empty('no-recurring-onpeak', dataWeeks);

  // --- Merge consecutive hours on the same weekday into blocks.
  qualified.sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  const blocks: ShiftBlock[] = [];
  let run: QualifiedCell[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const weekday = run[0].weekday;
    const startHour = run[0].hour;
    const endHour = run[run.length - 1].hour + 1;
    const avgWeeklyKwh = run.reduce((acc, c) => acc + c.meanKwh, 0);
    const weeksSeen = Math.min(...run.map((c) => c.weeksPresent));
    const cv = Math.max(...run.map((c) => c.cv));
    const readings = run.flatMap((c) => c.readings);
    const baselineRate = baselineRateCents(plan, readings, rates!);

    const options = buildOptions(baselineRate, rates!)
      .map((o) => ({
        ...o,
        monthlySavings:
          (o.savingsCentsPerKwh / 100) * avgWeeklyKwh * WEEKS_PER_MONTH,
      }))
      .filter((o) => o.monthlySavings > 0.005) // dust below half a cent/month is noise
      .sort((a, b) => b.monthlySavings - a.monthlySavings);

    if (options.length > 0) {
      blocks.push({
        id: `${WEEKDAY_SHORT[weekday].toLowerCase()}-${startHour}-${endHour}`,
        weekday,
        startHour,
        endHour,
        label: blockLabel(weekday, startHour, endHour),
        avgWeeklyKwh,
        weeksSeen,
        consistencyCv: cv,
        baselineRateCents: baselineRate,
        options,
        bestMonthlySavings: options[0].monthlySavings,
      });
    }
    run = [];
  };

  for (const cell of qualified) {
    if (run.length > 0 && cell.weekday === run[run.length - 1].weekday && cell.hour === run[run.length - 1].hour + 1) {
      run.push(cell);
    } else {
      flushRun();
      run = [cell];
    }
  }
  flushRun();

  blocks.sort((a, b) => b.bestMonthlySavings - a.bestMonthlySavings || a.id.localeCompare(b.id));

  return {
    blocks,
    totalMonthlySavings: blocks.reduce((acc, b) => acc + b.bestMonthlySavings, 0),
    dataWeeks,
    emptyReason: blocks.length === 0 ? 'no-recurring-onpeak' : null,
  };
}
