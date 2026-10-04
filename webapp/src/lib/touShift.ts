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

/** What the household has to DO for the saving to land — surfaced as a chip. */
export type Effort = 'no-plan-switch' | 'plan-switch-required';

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
  /** Derived from the selected plan + this option's destination plan. */
  effort: Effort;
  /** What has to be true for the saving to materialize — shown verbatim. */
  assumption: string;
};

/** Which recurring window a block came from (the two are disjoint by definition). */
export type ShiftTier = 'on-peak' | 'mid-peak';

export type BlockSignature = 'fixed-schedule' | 'hvac-like' | 'unidentified';

export type BlockClassification = {
  signature: BlockSignature;
  /** Shown on the block — hedged wording, never a claim we can't support. */
  label: string;
  /** The evidence behind the label, in the card's own words. */
  detail: string;
};

export type BlockClassificationInput = {
  startHour: number;
  /** Exclusive end hour (12→15 covers 12:00, 13:00, 14:00). */
  endHour: number;
  /** Weeks of the last LOOKBACK_WEEKS the block showed up in. */
  weeksSeen: number;
  /** Coefficient of variation of the hourly means INSIDE the block (flatness). */
  intraBlockCv: number;
  /** Coefficient of variation of the block's weekly totals (year-to-year steadiness). */
  consistencyCv: number;
};

export type ConfidenceLevel = 'very-consistent' | 'somewhat' | 'irregular';

export type ConfidenceBadge = {
  level: ConfidenceLevel;
  /** Shown on the chip: "Very consistent" / "Somewhat" / "Irregular". */
  label: string;
  /** The numbers behind the chip. */
  detail: string;
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
  /** Coefficient of variation of the hourly means inside the block (flatness evidence). */
  intraBlockCv: number;
  /** What this block costs today under the user's plan, cents/kWh. */
  baselineRateCents: number;
  /** On-Peak (primary) or TOU Mid-Peak (lower tier). */
  tier: ShiftTier;
  /** What the block looks like, or an honest "can't tell". */
  classification: BlockClassification;
  /** Recurrence confidence chip, from consistencyCv + weeksSeen. */
  confidence: ConfidenceBadge;
  /** Positive-savings options only, ranked desc by monthlySavings. */
  options: ShiftOption[];
  bestMonthlySavings: number;
};

export type TouShiftEmptyReason =
  | 'no-data'
  | 'insufficient-history'
  | 'no-recurring-onpeak';

export type TouShiftAnalysis = {
  /** On-Peak (primary) tier first, then TOU Mid-Peak (lower tier); each ranked desc by bestMonthlySavings. */
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

// ---------------------------------------------------------------------------
// Wave E — user-centric signals: what IS this block, how sure are we, and is
// there one answer for the whole household? All pure, all fixture-tested.
// ---------------------------------------------------------------------------

/** Flat enough hour-to-hour to call the volume "similar". */
export const FIXED_MAX_INTRABLOCK_CV = 0.2;
/** Steady enough week-to-week to call it a schedule (not weather). */
export const FIXED_MAX_WEEK_CV = 0.25;
/** "Same weekday window most weeks" = at least 4 of the last 5. */
export const FIXED_MIN_WEEKS = 4;
export const FIXED_MIN_SPAN_HOURS = 3;
/** HVAC-like needs a BROAD span: 1–3h tells us nothing about the whole house. */
export const HVAC_MIN_SPAN_HOURS = 4;
/** Broad = spans the daytime (start not before 10:00, end not after 21:00). */
export const DAYTIME_START_HOUR = 10;
export const DAYTIME_END_HOUR = 21;

function pct(cv: number): string {
  return `${Math.round(cv * 100)}%`;
}

/**
 * Classify a recurring block by what a person could actually recognize.
 *
 * Two signatures only, then an honest fallback — we never name an appliance we
 * can't see:
 *
 * 1. **fixed-schedule load** — a bounded ≥3h window, flat across its hours and
 *    steady week to week, in the same slot ≥4 of the last 5 weeks. That is what
 *    an EV timer / appliance cycle looks like in interval data.
 * 2. **HVAC-like whole-house load** — a broad daytime span that fails one of
 *    those steadiness tests (it ramps through the day, or its weekly total
 *    swings with the weather).
 * 3. **Unidentified weekday routine** — everything else, labelled as what we
 *    could not identify.
 */
export function classifyBlock(input: BlockClassificationInput): BlockClassification {
  const { startHour, endHour, weeksSeen, intraBlockCv, consistencyCv } = input;
  const span = Math.max(0, endHour - startHour);
  const flatAcrossHours = intraBlockCv <= FIXED_MAX_INTRABLOCK_CV;
  const steadyAcrossWeeks = consistencyCv <= FIXED_MAX_WEEK_CV;
  const sameWindowMostWeeks = weeksSeen >= FIXED_MIN_WEEKS;

  if (span >= FIXED_MIN_SPAN_HOURS && flatAcrossHours && steadyAcrossWeeks && sameWindowMostWeeks) {
    return {
      signature: 'fixed-schedule',
      label: 'Looks like a fixed-schedule load (EV timer / appliance cycle)',
      detail: `${span}h in the same slot ${weeksSeen}/5 weeks, flat across every hour (±${pct(intraBlockCv)})`,
    };
  }

  const daytime = startHour >= DAYTIME_START_HOUR && endHour <= DAYTIME_END_HOUR;
  if (span >= HVAC_MIN_SPAN_HOURS && daytime && (!flatAcrossHours || !steadyAcrossWeeks)) {
    return {
      signature: 'hvac-like',
      label: 'Looks like HVAC-like whole-house load',
      detail: `${span}h daytime span, ${flatAcrossHours ? `weekly total moves ±${pct(consistencyCv)}` : `ramps ±${pct(intraBlockCv)} across the day`} — tracks the day, not a timer`,
    };
  }

  return {
    signature: 'unidentified',
    label: 'Unidentified weekday routine',
    detail: `${span}h window, ±${pct(consistencyCv)} week to week — too short or too unsteady to call`,
  };
}

export const VERY_CONSISTENT_MAX_CV = 0.15;

/**
 * Confidence chip from stats the analysis already computes:
 * "Very consistent" needs BOTH a tight weekly CV and all 5 weeks present.
 */
export function confidenceBadge(cv: number, weeksSeen: number): ConfidenceBadge {
  if (cv < VERY_CONSISTENT_MAX_CV && weeksSeen >= LOOKBACK_WEEKS) {
    return {
      level: 'very-consistent',
      label: 'Very consistent',
      detail: `steady all ${LOOKBACK_WEEKS} weeks (±${pct(cv)} week to week)`,
    };
  }
  if (cv < CONSISTENCY_MAX_CV) {
    return {
      level: 'somewhat',
      label: 'Somewhat',
      detail: `present ${weeksSeen}/${LOOKBACK_WEEKS} weeks, ±${pct(cv)} week to week`,
    };
  }
  return {
    level: 'irregular',
    label: 'Irregular',
    detail: `swings ±${pct(cv)} week to week — treat as a rough estimate`,
  };
}

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  'very-consistent': 0,
  somewhat: 1,
  irregular: 2,
};

/** The least confident badge of a group (what a headline must stand behind). */
export function worstConfidence(badges: ConfidenceBadge[]): ConfidenceBadge {
  return badges.reduce((worst, b) => (CONFIDENCE_RANK[b.level] > CONFIDENCE_RANK[worst.level] ? b : worst), badges[0]);
}

/** Share of total savings a single target must carry before we collapse. */
export const DOMINANT_TARGET_SHARE = 0.5;

export type ShiftHeadline = {
  /** The dominant destination. */
  target: ShiftTarget;
  /** Option label for that target, e.g. "Overnight (ULO 23:00–07:00)". */
  optionLabel: string;
  /** e.g. "weekday daytime routine". */
  routine: string;
  /** The one sentence the household should read first. */
  headline: string;
  /** Dollars/month carried by the dominant group (only its blocks). */
  savings: number;
  /** Blocks whose best target is the dominant one. */
  blockCount: number;
  /** All blocks. */
  totalCount: number;
  /** blockGroup savings / totalMonthlySavings. */
  share: number;
  /** Worst badge across EVERY supporting block (the headline owns the claim). */
  confidence: ConfidenceBadge;
  assumption: string;
  effort: Effort;
};

function routineLabel(blocks: ShiftBlock[]): string {
  const weekend = (b: ShiftBlock) => b.weekday === 0 || b.weekday === 6;
  if (blocks.every(weekend)) return 'weekend routine';
  const daytime = blocks.every(
    (b) => b.startHour >= DAYTIME_START_HOUR && b.endHour <= DAYTIME_END_HOUR,
  );
  return daytime ? 'weekday daytime routine' : 'weekday routine';
}

function headlineSentence(target: ShiftTarget, routine: string, savings: number): string {
  const money = `~$${savings.toFixed(2)}/mo`;
  if (target === 'overnight_ulo') return `Switch to ULO and move your ${routine} → ${money}`;
  if (target === 'weekend') return `Move your ${routine} to cheaper weekend hours → ${money}`;
  return `Shift your ${routine} to off-peak hours → ${money}`;
}

/**
 * When one destination carries the majority of the money, say it once instead
 * of repeating it on every card: one headline, blocks demoted to evidence.
 *
 * Returns null when no target owns >50% of the savings (a tie is not a
 * consensus) or when there is no money on the table at all.
 */
export function collapseHeadline(
  blocks: ShiftBlock[],
  totalMonthlySavings: number,
): ShiftHeadline | null {
  if (blocks.length === 0 || totalMonthlySavings <= 0) return null;

  const groups = new Map<ShiftTarget, ShiftBlock[]>();
  for (const block of blocks) {
    const target = block.options[0]?.target;
    if (!target) continue;
    const list = groups.get(target);
    if (list) list.push(block);
    else groups.set(target, [block]);
  }

  let dominant: { target: ShiftTarget; list: ShiftBlock[]; savings: number } | null = null;
  for (const [target, list] of groups) {
    const savings = list.reduce((acc, b) => acc + b.bestMonthlySavings, 0);
    if (!dominant || savings > dominant.savings) dominant = { target, list, savings };
  }
  if (!dominant) return null;

  const share = dominant.savings / totalMonthlySavings;
  if (share <= DOMINANT_TARGET_SHARE) return null;

  const source = dominant.list[0];
  const option = source.options.find((o) => o.target === dominant!.target) ?? source.options[0];
  const routine = routineLabel(dominant.list);

  return {
    target: dominant.target,
    optionLabel: option.label,
    routine,
    headline: headlineSentence(dominant.target, routine, dominant.savings),
    savings: dominant.savings,
    blockCount: dominant.list.length,
    totalCount: blocks.length,
    share,
    confidence: worstConfidence(blocks.map((b) => b.confidence)),
    assumption: option.assumption,
    effort: option.effort,
  };
}

/**
 * Baseline rate for a block under the user's CURRENT plan (cents/kWh).
 *
 * - TOU: the block was selected because categorizeTOU says On-Peak — priced at
 *   On-Peak. A lower-tier (TOU Mid-Peak) block is priced at `tou.midPeak`, the
 *   rate the household actually pays for those hours.
 * - ULO: priced per the readings' actual ULO category (the same wall-clock
 *   hours can be Mid-Peak under ULO — e.g. a summer 11:00 On-Peak TOU hour
 *   is ULO Mid-Peak until 16:00). Never the TOU rate: we only ever claim
 *   savings against a rate the user really pays.
 * - Tiered: flat tier-1 rate, so time-shifting alone saves nothing until a
 *   plan change accompanies it (the options below state their assumptions).
 */
function baselineRateCents(
  plan: 'TOU' | 'Tiered' | 'ULO',
  blockReadings: ProcessedPoint[],
  rates: RateSet,
  tier: ShiftTier,
): number {
  if (plan === 'Tiered') return rates.tiered.tier1;
  if (plan === 'TOU' && tier === 'mid-peak') return rates.tou.midPeak;
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

/**
 * The three honest destinations, priced against the baseline, each carrying
 * its own `effort` chip and an assumption that matches the chip.
 *
 * `effort` answers "do I have to change plan?": the weekend and same-day
 * off-peak windows only exist on TOU (and weekend off-peak on ULO), so a
 * Tiered or a mismatched-plan household is told a switch is required instead
 * of being handed a "no plan switch" promise it can't keep.
 */
function buildOptions(
  baselineCents: number,
  rates: RateSet,
  plan: 'TOU' | 'Tiered' | 'ULO',
): Omit<ShiftOption, 'monthlySavings'>[] {
  const weekendRate = plan === 'ULO' ? rates.ulo.weekendOffPeak : rates.tou.offPeak;
  const candidates: Omit<ShiftOption, 'monthlySavings' | 'savingsCentsPerKwh'>[] = [
    {
      target: 'overnight_ulo',
      label: 'Overnight (ULO 23:00–07:00)',
      destRateCents: rates.ulo.overnight,
      effort: plan === 'ULO' ? 'no-plan-switch' : 'plan-switch-required',
      assumption:
        plan === 'ULO'
          ? 'You are already on ULO — move the load into 23:00–07:00.'
          : 'Requires switching to the ULO plan and moving the load into 23:00–07:00.',
    },
    {
      target: 'weekend',
      label: 'Weekend off-peak',
      destRateCents: weekendRate,
      effort: plan === 'Tiered' ? 'plan-switch-required' : 'no-plan-switch',
      assumption:
        plan === 'Tiered'
          ? 'Move the activity to any weekend hour — requires switching to TOU or ULO, tiered has no off-peak window.'
          : plan === 'ULO'
            ? 'Move the activity to any weekend hour — weekend off-peak on ULO, no plan switch.'
            : 'Move the activity to any weekend hour — off-peak on TOU, no plan switch.',
    },
    {
      target: 'offpeak_tou',
      label: 'Off-peak same day (19:00–07:00)',
      destRateCents: rates.tou.offPeak,
      effort: plan === 'TOU' ? 'no-plan-switch' : 'plan-switch-required',
      assumption:
        plan === 'TOU'
          ? 'Shift the load later the same day — off-peak hours on TOU, no plan switch.'
          : 'Shift the load later the same day — the TOU off-peak window 19:00–07:00, requires switching to TOU.',
    },
  ];

  return candidates
    .map((c) => ({ ...c, savingsCentsPerKwh: baselineCents - c.destRateCents }))
    .filter((o) => o.savingsCentsPerKwh > 0);
}

/**
 * Analyze loaded hourly data for recurring On-Peak blocks (primary tier) and
 * recurring TOU Mid-Peak blocks (lower tier) and rank shift opportunities by
 * monthly dollar impact.
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

  // --- Bucket by (tier, weekday, hour, weekIndex).
  // cellKey -> weekIndex -> kWh (summed defensively if data isn't strictly hourly)
  const cells = new Map<string, Map<number, number>>();
  const weekIndexSet = new Set<number>();
  const cellMeta = new Map<string, { tier: ShiftTier; weekday: number; hour: number; readings: ProcessedPoint[] }>();

  for (const r of inWindow) {
    // Math.round (not floor): local Monday-to-Monday deltas can be ±1h around
    // DST transitions; rounding keeps the week index stable across them.
    const weekIdx = Math.round(
      (startOfWeekLike(r.dateObj).getTime() - windowStart.getTime()) / (7 * 24 * 3600 * 1000),
    );
    if (weekIdx < 0 || weekIdx >= LOOKBACK_WEEKS) continue;
    weekIndexSet.add(weekIdx);

    // Two windows feed the analysis: TOU On-Peak (primary tier) and TOU
    // Mid-Peak (a LOWER tier — cheaper to move, still real money). Off-Peak
    // hours have nothing to shift OUT of, so they never qualify. Across a
    // season boundary (summer↔winter windows shift), the off-peak weeks of a
    // borderline hour drop out honestly instead of being counted as recurring
    // load.
    const tier: ShiftTier | null =
      r.touCategory === 'On-Peak' ? 'on-peak' : r.touCategory === 'Mid-Peak' ? 'mid-peak' : null;
    if (!tier) continue;

    const weekday = r.dateObj.getDay();
    const hour = r.dateObj.getHours();
    const key = `${tier}:${weekday}:${hour}`;
    let byWeek = cells.get(key);
    if (!byWeek) { byWeek = new Map(); cells.set(key, byWeek); }
    byWeek.set(weekIdx, (byWeek.get(weekIdx) || 0) + r.usage_kwh);

    let meta = cellMeta.get(key);
    if (!meta) { meta = { tier, weekday, hour, readings: [] }; cellMeta.set(key, meta); }
    meta.readings.push(r);
  }

  const dataWeeks = weekIndexSet.size;
  if (dataWeeks < MIN_WEEKS_PRESENT) return empty('insufficient-history', dataWeeks);

  // --- Qualifying cells: On-Peak + recurring >= MIN_WEEKS_PRESENT + consistent.
  type QualifiedCell = {
    tier: ShiftTier;
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

    qualified.push({ tier: meta.tier, weekday: meta.weekday, hour: meta.hour, weeksPresent, meanKwh: mean, cv, readings: meta.readings });
  }

  if (qualified.length === 0) return empty('no-recurring-onpeak', dataWeeks);

  // --- Merge consecutive hours of the SAME tier on the same weekday into
  // blocks (a Mid-Peak run never fuses with a neighbouring On-Peak hour).
  const tierRank = (t: ShiftTier) => (t === 'on-peak' ? 0 : 1);
  qualified.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.weekday - b.weekday || a.hour - b.hour);
  const blocks: ShiftBlock[] = [];
  let run: QualifiedCell[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const tier = run[0].tier;
    const weekday = run[0].weekday;
    const startHour = run[0].hour;
    const endHour = run[run.length - 1].hour + 1;
    const avgWeeklyKwh = run.reduce((acc, c) => acc + c.meanKwh, 0);
    const weeksSeen = Math.min(...run.map((c) => c.weeksPresent));
    const cv = Math.max(...run.map((c) => c.cv));
    const readings = run.flatMap((c) => c.readings);
    const baselineRate = baselineRateCents(plan, readings, rates!, tier);

    // Flatness of the hourly curve inside this block (single hour = trivially flat).
    const hourlyMeans = run.map((c) => c.meanKwh);
    const hourlyMean = hourlyMeans.reduce((a, b) => a + b, 0) / hourlyMeans.length;
    const hourlyVariance =
      hourlyMeans.reduce((acc, v) => acc + (v - hourlyMean) * (v - hourlyMean), 0) / hourlyMeans.length;
    const intraBlockCv = hourlyMean > 0 ? Math.sqrt(hourlyVariance) / hourlyMean : 0;

    const options = buildOptions(baselineRate, rates!, plan)
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
        intraBlockCv,
        baselineRateCents: baselineRate,
        tier,
        classification: classifyBlock({ startHour, endHour, weeksSeen, intraBlockCv, consistencyCv: cv }),
        confidence: confidenceBadge(cv, weeksSeen),
        options,
        bestMonthlySavings: options[0].monthlySavings,
      });
    }
    run = [];
  };

  for (const cell of qualified) {
    const prev = run[run.length - 1];
    if (prev && cell.tier === prev.tier && cell.weekday === prev.weekday && cell.hour === prev.hour + 1) {
      run.push(cell);
    } else {
      flushRun();
      run = [cell];
    }
  }
  flushRun();

  // Primary tier first (On-Peak), then the Mid-Peak lower tier — each ranked
  // by monthly dollar impact.
  blocks.sort(
    (a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      b.bestMonthlySavings - a.bestMonthlySavings ||
      a.id.localeCompare(b.id),
  );

  return {
    blocks,
    totalMonthlySavings: blocks.reduce((acc, b) => acc + b.bestMonthlySavings, 0),
    dataWeeks,
    emptyReason: blocks.length === 0 ? 'no-recurring-onpeak' : null,
  };
}
