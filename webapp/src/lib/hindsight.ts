/**
 * Wave V — HINDSIGHT: "what would another PLAN have cost", per closed billing
 * period, from the readings that were actually metered.
 *
 * SCOPE (Mark's clarification, and this module's whole contract): the
 * comparison is the SAME metered readings, at the SAME timestamps and the
 * SAME quantities, repriced across TOU / Tiered / ULO for the period's own
 * bill window with the rate set that was really in force on each reading's
 * day. Nothing here models a change in behaviour: no load shifting, no
 * appliance moves, no hypothetical usage, no behaviour "savings", and no
 * combined plan+behaviour total. The forward-looking What-If / EV tools are
 * separate surfaces and stay separate; they are never merged into this number.
 *
 * Wave P answers the question — for each period, what the same readings would
 * have cost on the other two plans — and this module REUSES that answer row
 * for row (`buildSwitchReport`): it reads `saving`, `bestPlan`, `modeled`, the
 * $1 model check and the coverage skip, and never re-prices an alternative of
 * its own. What Hindsight adds is the historical audit framing: one row per
 * closed bill, the season the bill was judged under, whether the bill straddles
 * a rate-season flip, and Wave P's own honesty gates carried through unchanged.
 *
 * Three honesty rules, each pinned by a test:
 *  - Nothing is claimed about a period whose model cannot reproduce its own
 *    bill, or whose readings do not cover it: those rows carry Wave P's own
 *    reason and enter NO total.
 *  - An unknown plan claims nothing at all — there is no "staying on" to
 *    compare against; the modeled reference is what the switch row already
 *    carries.
 *  - The total is Wave P's own over-paid figure, read off its report, so this
 *    panel and the switch track record above it can never disagree.
 */

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
import { seasonForDay, type Season } from './season';
// Wave U — every user-visible sentence is built from the catalog at call time.
import { fmtMoney, t } from '@/i18n';

/* -------------------------------------------------------------------------- *
 * Constants (exported: tests and the UI both read them)
 * -------------------------------------------------------------------------- */

/** Below half a dollar for the whole period a difference is noise, not money. */
export const MIN_SAVING = 0.5;

/* -------------------------------------------------------------------------- *
 * Types
 * -------------------------------------------------------------------------- */

export type HindsightPlanVerdict =
  | 'overpaid'
  | 'best'
  | 'untrusted'
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

  /** What staying on the billed plan cost, against the same readings repriced. */
  planVerdict: HindsightPlanVerdict;
  /** actual − cheapest alternative; null unless this period is countable. */
  planMiss: number | null;
  /** Read off `switchRow.bestPlan`; the alternatives' own numbers are rendered
   *  straight off the switch row. */
  planBest: PlanType | null;
  /** A difference that exists but is excluded from the total, with the reason. */
  planExcluded: number | null;
  planReason: string | null;
  /** True when this period's number entered the total. */
  counted: boolean;
};

export type HindsightReport = {
  /** Every bill period, worst-first (see `buildHindsight`). */
  periods: HindsightPeriod[];
  /** Wave P's number, period-billing-axis aligned: Σ over counted periods. */
  planMiss: number | null;
  /** Periods whose number entered the total. */
  planPeriods: number;
  /** Periods with no countable comparison at all. */
  uncounted: number;
  /** kWh of readings inside the periods that entered the total. */
  auditedKwh: number;
  /** The period that left the most on the table; null when nothing did. */
  worstPeriod: HindsightPeriod | null;
  /** One sentence describing the picture; empty-state aware. */
  note: string;
  emptyReason: 'no-bills' | 'nothing-countable' | null;
};

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
 * Build the hindsight report: every bill period, the same readings repriced
 * across the three plans.
 *
 * The numbers are Wave P's `buildSwitchReport` output, row for row — this
 * module reads `switchRow.saving` / `bestPlan` / `modeled` and never re-prices
 * an alternative.
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
    } else if (row.saving > MIN_SAVING) {
      planVerdict = 'overpaid';
      planMiss = row.saving;
    } else {
      planVerdict = 'best';
      planMiss = row.saving;
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
      counted: row.counted,
    };
  });

  const countedPeriods = periods.filter((p) => p.planMiss !== null);

  // Wave P's own total, read off its report so the two surfaces can never
  // disagree about what staying on the plan cost.
  const planMiss = switchReport.overpaid;

  const worstPeriod =
    [...periods].sort(
      (a, b) =>
        (b.planMiss ?? -Infinity) - (a.planMiss ?? -Infinity) ||
        b.kwh - a.kwh ||
        b.summary.start - a.summary.start,
    )[0] ?? null;

  const planWorth = fmtMoney(Math.max(0, planMiss ?? 0));

  const emptyReason: HindsightReport['emptyReason'] =
    summaries.length === 0
      ? 'no-bills'
      : planMiss === null
        ? 'nothing-countable'
        : null;

  const note =
    summaries.length === 0
      ? t('hindsight.noteEmpty')
      : planMiss === null
        ? t('hindsight.noteNothingCountable', { total: switchReport.rows.length })
        : t('hindsight.noteReady', { periods: switchReport.rows.length, plan: planWorth });

  return {
    periods: [...periods].sort(
      (a, b) =>
        (b.planMiss ?? -Infinity) - (a.planMiss ?? -Infinity) ||
        b.kwh - a.kwh ||
        b.summary.start - a.summary.start,
    ),
    planMiss,
    planPeriods: countedPeriods.length,
    uncounted: periods.filter((p) => p.planMiss === null).length,
    auditedKwh: countedPeriods.reduce((acc, p) => acc + p.kwh, 0),
    worstPeriod,
    note,
    emptyReason,
  };
}

export const EMPTY_HINDSIGHT: HindsightReport = {
  periods: [],
  planMiss: null,
  planPeriods: 0,
  uncounted: 0,
  auditedKwh: 0,
  worstPeriod: null,
  note: t('hindsight.noteEmpty'),
  emptyReason: 'no-bills',
};
