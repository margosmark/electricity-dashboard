/**
 * Wave V — HINDSIGHT: "what SHOULD I have done", per closed billing period.
 *
 * Wave P answers half of it: for each period, what the same readings would
 * have cost on the other two PLANS (reused here verbatim — this module never
 * re-prices an alternative). This module answers the other half, which is
 * orthogonal to the first: what the same household could have DONE, holding
 * the plan fixed.
 *
 * The behavioural counterfactual is built out of the meter, not out of a
 * habit we imagined:
 *
 *  1. Inside one billing period, find the recurring blocks — the same weekday
 *     and hours, most of the weeks the period spans, steady in volume (the
 *     same evidence rule Wave E's shift optimizer uses: >= 3 weeks, CV <= 0.4).
 *  2. Price that block twice, on the SAME readings and the SAME rate set:
 *     what it actually cost at the hours it ran, and what the same kWh costs
 *     in that plan's own cheap window (TOU off-peak / ULO overnight), each
 *     reading priced with the rate set in force on its own day — so a period
 *     straddling Nov 1 prices each side of the boundary at the rate that was
 *     really in force.
 *  3. The saving is the difference. It is a counterfactual, and the copy says
 *     so ("IF your Wed 16:00–18:00 block had run in the off-peak window") —
 *     never "you would have done this", never advice.
 *
 * Three honesty rules this module holds to:
 *  - Nothing is claimed about a period whose model cannot reproduce its own
 *    bill, or whose readings do not cover it: those rows carry Wave P's own
 *    reason and are excluded from every total (same gate as the plan side).
 *  - Tiered is a REAL zero, not a missing value: the hour does not change the
 *    price on a flat rate, so no block can save anything by moving. The
 *    period says "0 — the only lever here is the plan", it does not say
 *    "unknown" and it does not invent a number.
 *  - The plan lever and the behaviour lever are reported separately and summed
 *    only as the sum of two disjoint levers. They are never merged into one
 *    "you could have saved" figure, because they answer different questions.
 */

import { startOfWeek } from 'date-fns';

import {
  type ProcessedPoint,
  type UsageSummary,
} from './energy';
import {
  buildSwitchReport,
  type PlanType,
  type SwitchPeriodRow,
  type SwitchReport,
} from './planTimeline';
import type { PlanTimelineEntry } from './planTimeline';
import {
  MIN_MEAN_KWH,
  MIN_WEEKS_PRESENT,
  CONSISTENCY_MAX_CV,
  classifyBlock,
  confidenceBadge,
  type BlockClassification,
  type ConfidenceBadge,
  type ShiftTier,
} from './touShift';
import { seasonForDay, type Season } from './season';
// Wave U — every user-visible sentence is built from the catalog at call time.
import { fmtMoney, t } from '@/i18n';

/* -------------------------------------------------------------------------- *
 * Constants (exported: tests and the UI both read them)
 * -------------------------------------------------------------------------- */

/**
 * A block must be seen in at least this share of the weeks the period spans.
 * Wave E's rule is "3 of the last 5 weeks"; a billing period is 4-13 weeks
 * long, and a fixed count would call a load that ran three times in thirteen
 * weeks "recurring". Pairing the count with a share keeps both true.
 */
export const MIN_WEEK_SHARE = 0.5;

/** Below half a dollar for the whole period a block is noise, not money. */
export const MIN_MOVE_SAVING = 0.5;

/**
 * A block's hourly mean must reach this to be a load you could move. Below it
 * the hours are the household's always-on floor (fridge, standby, the router),
 * which is real money in the peak window but is not moveable — reporting it as
 * a "move" would be advice nobody can follow.
 */
export const MIN_BLOCK_KWH_PER_HOUR = 0.5;

/**
 * Adjacent hours merge only while their means stay within this factor of each
 * other. Without it a three-hour appliance cycle glues itself to every cheap
 * baseline hour next door and the card ends up saying "move Wed 07:00–19:00",
 * which is neither one routine nor a claim we can defend.
 */
export const MERGE_LEVEL_RATIO = 0.35;

/** Two levers within a dollar of each other are a tie, not a winner. */
export const LEVER_TIE_TOLERANCE = 1;

/* -------------------------------------------------------------------------- *
 * Types
 * -------------------------------------------------------------------------- */

/** Which cheap window the counterfactual moves the block into. */
export type HindsightDestinationKey = 'offpeak-tou' | 'overnight-ulo';

export type HindsightDestination = {
  key: HindsightDestinationKey;
  /** e.g. "Off-peak 19:00–07:00" — the window the block would have run in. */
  label: string;
  /** Plan the destination belongs to (it is always the period's own plan). */
  plan: PlanType;
};

/** One recurring block inside one billing period, priced both ways. */
export type HindsightMove = {
  /** Stable id, e.g. "wed-16-18". */
  id: string;
  /** 0 = Sunday … 6 = Saturday (Date.getDay()). */
  weekday: number;
  startHour: number;
  /** Exclusive, like Array.slice: 16→18 covers 16:00 and 17:00. */
  endHour: number;
  /** "Wed 16:00–18:00", built from the active locale's day names. */
  label: string;
  /** kWh this block ran in the period (summed over every occurrence). */
  kwh: number;
  /** Weeks of the period this block showed up in. */
  weeksSeen: number;
  /** Weeks the period spans (the honest denominator). */
  weeksAvailable: number;
  /** Coefficient of variation of the block's weekly kWh. */
  consistencyCv: number;
  /** On-Peak, or the cheaper Mid-Peak tier (both worth moving). */
  tier: ShiftTier;
  /** True when the block's own hours changed tier inside this period (a
   *  season flip) — the aggregate rate is then a real blend of the two. */
  tierMixed: boolean;
  classification: BlockClassification;
  confidence: ConfidenceBadge;
  /** Blended rate the block actually paid, ¢/kWh (real readings). */
  actualRateCents: number;
  /** Destination rate under the SAME plan, ¢/kWh (that day's rate set). */
  destRateCents: number;
  /** What the block cost at the hours it really ran. */
  actualCost: number;
  /** What the same kWh costs in the destination window. */
  shiftedCost: number;
  /** actualCost − shiftedCost, always > MIN_MOVE_SAVING when present. */
  saving: number;
  destination: HindsightDestination;
};

export type HindsightPlanVerdict =
  | 'overpaid'
  | 'best'
  | 'untrusted'
  | 'unknown'
  | 'skipped';

export type HindsightBehaviourVerdict =
  | 'moveable'
  | 'nothing-to-shift'
  | 'flat-rate'
  | 'unknown'
  | 'skipped';

export type HindsightPeriod = {
  summary: UsageSummary;
  /** "May 25 – Jun 23, 2026" — the bill's own period label. */
  label: string;
  plan: PlanType | 'unknown';
  origin: SwitchPeriodRow['origin'];
  conflict: boolean;
  /** Season of the period's first billed day. */
  season: Season;
  /** True when the period's readings span both rate seasons (Nov 1 / May 1). */
  straddlesSeason: boolean;
  /** kWh of readings inside the period. */
  kwh: number;
  /** Wave P's own row — the alternatives are NOT recomputed here. */
  switchRow: SwitchPeriodRow;

  /* --- lever 1: the plan ------------------------------------------------ */
  planVerdict: HindsightPlanVerdict;
  /** actual − cheapest alternative; null unless the plan side is countable. */
  planMiss: number | null;
  /** Invested here as `switchRow.bestPlan`; the alternatives' own numbers are
   *  rendered straight off the switch row. */
  planBest: PlanType | null;
  /** A saving that exists but is excluded from the total, with the reason. */
  planExcluded: number | null;
  planReason: string | null;

  /* --- lever 2: the behaviour ------------------------------------------- */
  behaviourVerdict: HindsightBehaviourVerdict;
  /** Σ of the move savings; 0 on Tiered (a real zero), null when unknown. */
  behaviourMiss: number | null;
  /** Ranked desc by saving. */
  moves: HindsightMove[];
  behaviourReason: string | null;

  /** The best single move in this period, if any. */
  topMove: HindsightMove | null;
  /** planMiss + behaviourMiss, each treated as 0 when its side is unknown. */
  missTotal: number;
  /** True when BOTH levers for this period are trustworthy enough to sum. */
  counted: boolean;
};

export type HindsightLever = 'plan' | 'behaviour' | 'neither' | 'unknown';

export type HindsightReport = {
  /** Every bill period, worst-first (see `buildHindsight`). */
  periods: HindsightPeriod[];
  /** Wave P's number, period-billing-axis aligned: Σ over counted periods. */
  planMiss: number | null;
  /** Σ of the behavioural savings over the periods they are countable in. */
  behaviourMiss: number | null;
  /** planMiss + behaviourMiss — two disjoint levers, never merged elsewhere. */
  totalMiss: number | null;
  /** Periods whose plan side entered the total. */
  planPeriods: number;
  /** Periods whose behaviour side entered the total. */
  behaviourPeriods: number;
  /** Periods with no countable lever at all. */
  uncounted: number;
  /** kWh that ran inside a recurring block and could have moved. */
  shiftableKwh: number;
  /** Every move across counted periods, ranked desc by saving. */
  moves: HindsightMove[];
  /** The period that left the most on the table; null when nothing did. */
  worstPeriod: HindsightPeriod | null;
  /** Which lever actually mattered on this data. */
  lever: HindsightLever;
  /** One sentence naming the lever and the numbers behind it. */
  leverNote: string;
  /** One sentence describing the picture; empty-state aware. */
  note: string;
  emptyReason: 'no-bills' | 'nothing-countable' | null;
};

/* -------------------------------------------------------------------------- *
 * Block detection inside one billing period
 * -------------------------------------------------------------------------- */

/** Which category field decides "this hour is expensive" for this plan. */
function categoryFor(plan: PlanType, r: ProcessedPoint): string {
  return plan === 'ULO' ? r.uloCategory : r.touCategory;
}

/** Monday-start week key (ms at local Monday 00:00) — a Map key, not arithmetic. */
function weekKey(d: Date): number {
  return startOfWeek(d, { weekStartsOn: 1 }).getTime();
}

const WEEKDAY_KEY = ['hindsight.day0', 'hindsight.day1', 'hindsight.day2', 'hindsight.day3', 'hindsight.day4', 'hindsight.day5', 'hindsight.day6'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "Wed 16:00–18:00" in the active locale. */
export function blockLabel(weekday: number, startHour: number, endHour: number): string {
  return `${t(WEEKDAY_KEY[weekday])} ${pad2(startHour)}:00–${pad2(endHour)}:00`;
}

/** The cheap window a plan's counterfactual moves a block into. */
function destinationFor(plan: PlanType): HindsightDestination | null {
  if (plan === 'TOU') {
    return { key: 'offpeak-tou', label: t('hindsight.destOffPeakTou'), plan };
  }
  if (plan === 'ULO') {
    return { key: 'overnight-ulo', label: t('hindsight.destOvernightUlo'), plan };
  }
  return null; // Tiered: the hour does not change the price.
}

export function destinationRateCents(r: ProcessedPoint, key: HindsightDestinationKey): number {
  return key === 'overnight-ulo' ? r.activeRateSet.ulo.overnight : r.activeRateSet.tou.offPeak;
}

export type PeriodBlockScan = {
  /** Ranked desc by saving. Empty for Tiered (that is a real zero, not "none"). */
  moves: HindsightMove[];
  /** Weeks the period spans. */
  weeksAvailable: number;
  /** Distinct weeks the period's own readings cover (<= weeksAvailable). */
  weeksWithData: number;
  /** True when the plan has no shiftable window at all (Tiered). */
  flatRate: boolean;
};

/**
 * Find the recurring blocks inside ONE period's readings and price the
 * counterfactual for each, under the period's own plan.
 *
 * The period is its own analysis window (unlike Wave E's forward-looking
 * optimizer, which looks at the newest 5 weeks of the whole file): a
 * historical audit has to judge the period on the period's own evidence.
 */
export function scanPeriodBlocks(rows: ProcessedPoint[], plan: PlanType): PeriodBlockScan {
  const weekKeys = new Set<number>();
  for (const r of rows) weekKeys.add(weekKey(r.dateObj));
  const weeksAvailable = weekKeys.size;
  const weeksWithData = weeksAvailable;

  if (plan === 'Tiered') {
    return { moves: [], weeksAvailable, weeksWithData, flatRate: true };
  }

  const destination = destinationFor(plan);
  if (!destination) return { moves: [], weeksAvailable, weeksWithData, flatRate: true };

  // cellKey -> weekKey -> kWh (summed defensively if the data is not 1-hourly)
  //
  // Cells are keyed by (weekday, hour) and NOT by tier: across a season flip
  // the same wall-clock hour changes tier (a summer 07:00 is Mid-Peak, the
  // winter 07:00 is On-Peak), and keying by tier would split one real routine
  // into two cells that each fail the recurrence bar — silently reporting "$0,
  // nothing to shift" for the boundary bills. The kWh we price are the
  // expensive occurrences (On-/Mid-Peak under THIS plan); every reading is
  // still priced with the rate set in force on its own day.
  type Cell = {
    weekday: number;
    hour: number;
    byWeek: Map<number, number>;
    readings: ProcessedPoint[];
    onPeak: number;
    midPeak: number;
  };
  const cells = new Map<string, Cell>();

  for (const r of rows) {
    const category = categoryFor(plan, r);
    // Off-peak / overnight hours (and ULO's weekend window) have nothing to
    // move OUT of: they already are the cheap window we move things into.
    if (category !== 'On-Peak' && category !== 'Mid-Peak') continue;

    const weekday = r.dateObj.getDay();
    const hour = r.dateObj.getHours();
    const key = `${weekday}:${hour}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { weekday, hour, byWeek: new Map(), readings: [], onPeak: 0, midPeak: 0 };
      cells.set(key, cell);
    }
    const wk = weekKey(r.dateObj);
    cell.byWeek.set(wk, (cell.byWeek.get(wk) || 0) + r.usage_kwh);
    cell.readings.push(r);
    if (category === 'On-Peak') cell.onPeak += 1;
    else cell.midPeak += 1;
  }

  type Qualified = Cell & { meanKwh: number; cv: number; tier: ShiftTier; tierMixed: boolean };
  const qualified: Qualified[] = [];

  for (const cell of cells.values()) {
    const weeksPresent = cell.byWeek.size;
    if (weeksPresent < MIN_WEEKS_PRESENT) continue;
    if (weeksAvailable > 0 && weeksPresent / weeksAvailable < MIN_WEEK_SHARE) continue;

    const values = Array.from(cell.byWeek.values()).filter((v) => v > 0);
    if (values.length < MIN_WEEKS_PRESENT) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean < MIN_MEAN_KWH) continue;
    if (mean < MIN_BLOCK_KWH_PER_HOUR) continue; // the always-on floor
    const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv > CONSISTENCY_MAX_CV) continue;

    const tier: ShiftTier = cell.onPeak >= cell.midPeak ? 'on-peak' : 'mid-peak';
    qualified.push({
      ...cell,
      meanKwh: mean,
      cv,
      tier,
      tierMixed: cell.onPeak > 0 && cell.midPeak > 0,
    });
  }

  if (qualified.length === 0) {
    return { moves: [], weeksAvailable, weeksWithData, flatRate: false };
  }

  // Merge consecutive HOURS of the same weekday into one block. Tier is not
  // part of the merge key for the same reason it is not part of the cell key:
  // the block is the routine, and a season flip inside the period must not
  // cut it in two.
  const tierRank = (tier: ShiftTier) => (tier === 'on-peak' ? 0 : 1);
  qualified.sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier) || a.weekday - b.weekday || a.hour - b.hour,
  );

  const moves: HindsightMove[] = [];
  let run: Qualified[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const weekday = run[0].weekday;
    const startHour = run[0].hour;
    const endHour = run[run.length - 1].hour + 1;
    const readings = run.flatMap((c) => c.readings);
    const kwh = readings.reduce((acc, r) => acc + r.usage_kwh, 0);
    // `run` is consecutive HOURS of one weekday (it resets on any gap, weekday
    // change or shape change) — at most 24 entries by construction.
    // eslint-disable-next-line no-restricted-syntax -- bounded: ≤ 24 consecutive hours
    const weeksSeen = Math.min(...run.map((c) => c.byWeek.size));
    // eslint-disable-next-line no-restricted-syntax -- bounded: ≤ 24 consecutive hours
    const consistencyCv = Math.max(...run.map((c) => c.cv));
    const onPeak = run.reduce((acc, c) => acc + c.onPeak, 0);
    const midPeak = run.reduce((acc, c) => acc + c.midPeak, 0);
    const tier: ShiftTier = onPeak >= midPeak ? 'on-peak' : 'mid-peak';
    const tierMixed = onPeak > 0 && midPeak > 0;

    const hourlyMeans = run.map((c) => c.meanKwh);
    const hourlyMean = hourlyMeans.reduce((a, b) => a + b, 0) / hourlyMeans.length;
    const hourlyVar =
      hourlyMeans.reduce((acc, v) => acc + (v - hourlyMean) * (v - hourlyMean), 0) /
      hourlyMeans.length;
    const intraBlockCv = hourlyMean > 0 ? Math.sqrt(hourlyVar) / hourlyMean : 0;

    // The SAME readings priced twice: at the hours they ran (the real cost),
    // and in the destination window at that day's rates.
    let actualCost = 0;
    let shiftedCost = 0;
    for (const r of readings) {
      actualCost += plan === 'ULO' ? r.costULO : r.costTOU;
      shiftedCost += (r.usage_kwh * destinationRateCents(r, destination.key)) / 100;
    }
    const saving = actualCost - shiftedCost;

    if (saving > MIN_MOVE_SAVING && kwh > 0) {
      moves.push({
        id: `${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][weekday]}-${startHour}-${endHour}`,
        weekday,
        startHour,
        endHour,
        label: blockLabel(weekday, startHour, endHour),
        kwh,
        weeksSeen,
        weeksAvailable,
        consistencyCv,
        tier,
        tierMixed,
        classification: classifyBlock({
          startHour,
          endHour,
          weeksSeen,
          intraBlockCv,
          consistencyCv,
        }),
        confidence: confidenceBadge(consistencyCv, weeksSeen),
        actualRateCents: kwh > 0 ? (actualCost / kwh) * 100 : 0,
        destRateCents: kwh > 0 ? (shiftedCost / kwh) * 100 : 0,
        actualCost,
        shiftedCost,
        saving,
        destination,
      });
    }
    run = [];
  };

  for (const cell of qualified) {
    const prev = run[run.length - 1];
    const comparable =
      prev !== undefined &&
      Math.min(prev.meanKwh, cell.meanKwh) / Math.max(prev.meanKwh, cell.meanKwh) >=
        MERGE_LEVEL_RATIO;
    if (prev && cell.weekday === prev.weekday && cell.hour === prev.hour + 1 && comparable) {
      run.push(cell);
    } else {
      flush();
      run = [cell];
    }
  }
  flush();

  moves.sort((a, b) => b.saving - a.saving || a.id.localeCompare(b.id));
  return { moves, weeksAvailable, weeksWithData, flatRate: false };
}

/* -------------------------------------------------------------------------- *
 * The report
 * -------------------------------------------------------------------------- */

/** True when the period's readings fall on both sides of a rate-season flip. */
function straddlesSeason(rows: ProcessedPoint[]): boolean {
  let winter = false;
  let summer = false;
  for (const r of rows) {
    const s = seasonForDay(r.dayStr);
    if (s === 'winter') winter = true;
    else summer = true;
    if (winter && summer) return true;
  }
  return false;
}

/**
 * Build the hindsight report: every bill period judged on BOTH levers.
 *
 * The plan side is Wave P's `buildSwitchReport` output, row for row — this
 * module reads `switchRow.saving` / `bestPlan` / `modeled` and never re-prices
 * an alternative. The behaviour side is computed here from the same readings
 * and the same trust gate.
 *
 * Periods come back worst-first: by money left on the table (descending), then
 * by consumption (so a big period outranks a small one that left the same
 * dollars), then newest first.
 */
export function buildHindsight(
  summaries: UsageSummary[],
  allRows: ProcessedPoint[],
  timeline: PlanTimelineEntry[] = [],
): HindsightReport {
  const switchReport: SwitchReport = buildSwitchReport(summaries, allRows, timeline);

  const periods: HindsightPeriod[] = switchReport.rows.map((row) => {
    const rows = allRows.filter(
      (r) => r.timestamp >= row.summary.start && r.timestamp < row.summary.start + row.summary.duration,
    );
    const kwh = rows.reduce((acc, r) => acc + r.usage_kwh, 0);

    /* ---- lever 1: the plan (reused, never recomputed) ------------------ */
    let planVerdict: HindsightPlanVerdict;
    let planMiss: number | null = null;
    let planExcluded: number | null = null;
    let planReason: string | null = null;
    if (row.skipped !== null) {
      planVerdict = 'skipped';
      planReason = row.skipped;
    } else if (row.plan === 'unknown') {
      planVerdict = 'unknown';
      planReason = t('hindsight.planUnknownNote');
    } else if (row.saving === null) {
      planVerdict = 'unknown';
      planReason = t('hindsight.planUnknownNote');
    } else if (!row.counted) {
      planVerdict = 'untrusted';
      planExcluded = row.saving;
      planReason = row.excluded;
    } else if (row.saving > MIN_MOVE_SAVING) {
      planVerdict = 'overpaid';
      planMiss = row.saving;
    } else {
      planVerdict = 'best';
      planMiss = row.saving;
    }

    /* ---- lever 2: the behaviour --------------------------------------- */
    let behaviourVerdict: HindsightBehaviourVerdict;
    let behaviourMiss: number | null = null;
    let behaviourReason: string | null = null;
    let moves: HindsightMove[] = [];

    if (row.skipped !== null) {
      behaviourVerdict = 'skipped';
      behaviourReason = row.skipped;
    } else if (row.plan === 'unknown') {
      behaviourVerdict = 'unknown';
      behaviourReason = t('hindsight.behaviourUnknownNote');
    } else if (!row.counted) {
      // The model cannot reproduce this bill, so its block costs are not
      // trustworthy either. The moves are still shown (they are real rate
      // applications on real readings) but they stay out of the total.
      const scan = scanPeriodBlocks(rows, row.plan);
      moves = scan.moves;
      behaviourVerdict = scan.flatRate ? 'flat-rate' : moves.length > 0 ? 'moveable' : 'nothing-to-shift';
      behaviourReason = t('hindsight.behaviourUntrustedNote');
    } else if (row.plan === 'Tiered') {
      // A REAL zero: within a tier the price per kWh does not depend on the
      // hour, and a same-day shift never changes the month's volume — so no
      // block can save anything by moving. Reported as 0, not as "unknown".
      behaviourVerdict = 'flat-rate';
      behaviourMiss = 0;
      behaviourReason = t('hindsight.flatRateNote');
    } else {
      const scan = scanPeriodBlocks(rows, row.plan);
      if (scan.weeksAvailable < MIN_WEEKS_PRESENT) {
        // Fewer weeks in the period than the recurrence rule needs: we cannot
        // establish a routine at all, and we say that instead of guessing.
        behaviourVerdict = 'nothing-to-shift';
        behaviourMiss = 0;
        behaviourReason = t('hindsight.tooFewWeeksNote', {
          count: scan.weeksAvailable,
          weeks: scan.weeksAvailable,
        });
      } else if (scan.moves.length > 0) {
        moves = scan.moves;
        behaviourVerdict = 'moveable';
        behaviourMiss = moves.reduce((acc, m) => acc + m.saving, 0);
      } else {
        behaviourVerdict = 'nothing-to-shift';
        behaviourMiss = 0;
        behaviourReason = t('hindsight.nothingToShiftNote');
      }
    }

    return {
      summary: row.summary,
      label: row.label,
      plan: row.plan,
      origin: row.origin,
      conflict: row.conflict,
      season: seasonForDay(row.summary.startDate),
      straddlesSeason: straddlesSeason(rows),
      kwh,
      switchRow: row,
      planVerdict,
      planMiss,
      planBest: row.bestPlan,
      planExcluded,
      planReason,
      behaviourVerdict,
      behaviourMiss,
      moves,
      behaviourReason,
      topMove: moves[0] ?? null,
      missTotal: (planMiss ?? 0) + (behaviourMiss ?? 0),
      counted: row.counted,
    };
  });

  const planPeriods = periods.filter((p) => p.planMiss !== null);
  const behaviourPeriods = periods.filter((p) => p.behaviourMiss !== null);

  // Wave P's own total, read off its report so the two surfaces can never
  // disagree about what staying on the plan cost.
  const planMiss = switchReport.overpaid;
  const behaviourMiss =
    behaviourPeriods.length > 0
      ? behaviourPeriods.reduce((acc, p) => acc + (p.behaviourMiss ?? 0), 0)
      : null;
  const totalMiss = planMiss !== null && behaviourMiss !== null ? planMiss + behaviourMiss : null;

  const moves = periods
    .filter((p) => p.counted)
    .flatMap((p) => p.moves)
    .sort((a, b) => b.saving - a.saving || a.id.localeCompare(b.id));

  const worstPeriod =
    [...periods].sort(
      (a, b) =>
        b.missTotal - a.missTotal || b.kwh - a.kwh || b.summary.start - a.summary.start,
    )[0] ?? null;

  const lever = pickLever(planMiss, behaviourMiss);
  // The sentence names what each lever was WORTH, so a plan side that came out
  // negative (the alternatives would have cost more) reads as $0.00 on the
  // plan lever rather than as a confusing "against -$251.89".
  const planWorth = fmtMoney(Math.max(0, planMiss ?? 0));
  const behaviourWorth = fmtMoney(Math.max(0, behaviourMiss ?? 0));
  const leverNote =
    lever === 'unknown'
      ? t('hindsight.leverUnknown')
      : lever === 'neither'
        ? t('hindsight.leverNeither')
        : lever === 'plan'
          ? t('hindsight.leverPlan', { plan: planWorth, behaviour: behaviourWorth })
          : t('hindsight.leverBehaviour', { plan: planWorth, behaviour: behaviourWorth });

  const emptyReason: HindsightReport['emptyReason'] =
    summaries.length === 0
      ? 'no-bills'
      : totalMiss === null
        ? 'nothing-countable'
        : null;

  const note =
    summaries.length === 0
      ? t('hindsight.noteEmpty')
      : totalMiss === null
        ? t('hindsight.noteNothingCountable', { total: switchReport.rows.length })
        : t('hindsight.noteReady', {
            periods: switchReport.rows.length,
            plan: planWorth,
            behaviour: behaviourWorth,
          });

  return {
    periods: [...periods].sort(
      (a, b) => b.missTotal - a.missTotal || b.kwh - a.kwh || b.summary.start - a.summary.start,
    ),
    planMiss,
    behaviourMiss,
    totalMiss,
    planPeriods: planPeriods.length,
    behaviourPeriods: behaviourPeriods.length,
    uncounted: periods.filter((p) => p.planMiss === null && p.behaviourMiss === null).length,
    shiftableKwh: moves.reduce((acc, m) => acc + m.kwh, 0),
    moves,
    worstPeriod,
    lever,
    leverNote,
    note,
    emptyReason,
  };
}

/**
 * Which lever mattered: `null` for either side means it could not be measured,
 * which is not the same as zero.
 */
export function pickLever(
  planMiss: number | null,
  behaviourMiss: number | null,
): HindsightLever {
  if (planMiss === null || behaviourMiss === null) return 'unknown';
  const plan = Math.max(0, planMiss);
  const behaviour = Math.max(0, behaviourMiss);
  if (Math.abs(plan - behaviour) <= LEVER_TIE_TOLERANCE) return 'neither';
  return plan > behaviour ? 'plan' : 'behaviour';
}

export const EMPTY_HINDSIGHT: HindsightReport = {
  periods: [],
  planMiss: null,
  behaviourMiss: null,
  totalMiss: null,
  planPeriods: 0,
  behaviourPeriods: 0,
  uncounted: 0,
  shiftableKwh: 0,
  moves: [],
  worstPeriod: null,
  lever: 'unknown',
  leverNote: t('hindsight.leverUnknown'),
  note: t('hindsight.noteEmpty'),
  emptyReason: 'no-bills',
};
