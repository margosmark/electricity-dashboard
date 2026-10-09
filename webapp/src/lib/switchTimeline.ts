/**
 * Wave R — the switch track record as one picture.
 *
 * Wave P's answer is a table: one row per billing period, what it was billed
 * under, what the alternatives would have cost. Accurate, and it reads like
 * homework. This flips the same rows into a horizontal timeline — a segment
 * per period, tinted with the plan that period was actually on, with a delta
 * bubble at every point where the plan changed — so "three TOU periods, then
 * you moved to ULO and stopped over-paying" is visible in a glance instead of
 * summed by eye.
 *
 * It is built from `buildSwitchReport` (Wave P's own function), not from a
 * second derivation: the timeline and the table can therefore never disagree
 * about what a period's plan was or what its saving was. A period whose
 * model could not reproduce its bill keeps its segment and loses its bubble —
 * an untrusted saving is never drawn as a fact.
 */

import { format } from 'date-fns';
import type { PlanType, SwitchPeriodRow, SwitchReport } from './planTimeline';

export type SwitchSegment = {
  key: string;
  label: string;
  plan: PlanType | 'unknown';
  /** First day of the period (`yyyy-MM-dd`). */
  start: string;
  last: string;
  days: number;
  /** Share of the whole timeline this segment occupies (0..1). */
  share: number;
  origin: SwitchPeriodRow['origin'];
  /** The saving Wave P computed for this period — null when not countable. */
  saving: number | null;
  counted: boolean;
  /** Why the saving is shown but not trusted, or why nothing was modeled. */
  reason: string | null;
  /** The plan the PREVIOUS segment was on (null on the first segment). */
  previousPlan: PlanType | 'unknown' | null;
  /** True when this segment is the one a switch landed on. */
  isSwitch: boolean;
};

export type SwitchPoint = {
  /** Index of the segment the switch landed on. */
  index: number;
  from: PlanType;
  to: PlanType;
  /** `yyyy-MM-dd` of the boundary between the two periods. */
  day: string;
  /** Saving for the period after the switch; null when untrusted. */
  saving: number | null;
  counted: boolean;
};

export type SwitchTimeline = {
  segments: SwitchSegment[];
  switchPoints: SwitchPoint[];
  /** Σ days across every segment (including holes between periods). */
  totalDays: number;
  /** Segments with a known plan. */
  known: number;
  /** Real plan changes (both sides known and different). */
  switches: number;
  /** One sentence: what this picture is showing. */
  note: string;
};

export const EMPTY_SWITCH_TIMELINE: SwitchTimeline = {
  segments: [],
  switchPoints: [],
  totalDays: 0,
  known: 0,
  switches: 0,
  note: 'No billing periods yet — upload an export with bills to draw the switch history.',
};

const MS_PER_DAY = 86_400;

function daysBetween(start: number, end: number): number {
  return Math.max(1, Math.round((end - start) / MS_PER_DAY));
}

/**
 * Build the timeline from Wave P's report.
 *
 * Holes between two periods are emitted as their own `unknown` segment: the
 * utility issued no bill we hold for those days, and a timeline that joins
 * them up would be asserting a plan nobody billed.
 */
export function buildSwitchTimeline(report: SwitchReport): SwitchTimeline {
  const rows = [...report.rows].sort((a, b) => a.summary.start - b.summary.start);
  if (rows.length === 0) return EMPTY_SWITCH_TIMELINE;

  type Draft = {
    key: string;
    label: string;
    plan: PlanType | 'unknown';
    start: string;
    last: string;
    startTs: number;
    endTs: number;
    days: number;
    origin: SwitchPeriodRow['origin'];
    saving: number | null;
    counted: boolean;
    reason: string | null;
    previousPlan: PlanType | 'unknown' | null;
    isSwitch: boolean;
  };

  const drafts: Draft[] = [];
  let previousEnd: number | null = null;
  let previousPlan: PlanType | 'unknown' | null = null;

  for (const row of rows) {
    const startTs = row.summary.start;
    const endTs = startTs + row.summary.duration;

    if (previousEnd !== null && startTs - previousEnd > 2 * MS_PER_DAY) {
      const days = daysBetween(previousEnd, startTs);
      drafts.push({
        key: `gap:${previousEnd}`,
        label: 'Unknown period',
        plan: 'unknown',
        start: format(new Date(previousEnd * 1000), 'yyyy-MM-dd'),
        last: format(new Date(startTs * 1000), 'yyyy-MM-dd'),
        startTs: previousEnd,
        endTs: startTs,
        days,
        origin: 'unknown',
        saving: null,
        counted: false,
        reason: 'No bill we hold covers these days.',
        previousPlan,
        isSwitch: false,
      });
    }

    const knownBefore = previousPlan !== null && previousPlan !== 'unknown';
    const knownNow = row.plan !== 'unknown';
    const isSwitch = Boolean(knownBefore && knownNow && previousPlan !== row.plan);

    drafts.push({
      key: `period:${startTs}`,
      label: row.label,
      plan: row.plan,
      start: row.summary.startDate,
      last: row.summary.endDate,
      startTs,
      endTs,
      days: daysBetween(startTs, endTs),
      origin: row.origin,
      saving: row.saving,
      counted: row.counted,
      reason: row.excluded ?? row.skipped,
      previousPlan,
      isSwitch,
    });

    previousEnd = endTs;
    previousPlan = row.plan;
  }

  const totalDays = drafts.reduce((sum, d) => sum + d.days, 0) || 1;
  const segments: SwitchSegment[] = drafts.map((d) => ({
    key: d.key,
    label: d.label,
    plan: d.plan,
    start: d.start,
    last: d.last,
    days: d.days,
    share: d.days / totalDays,
    origin: d.origin,
    saving: d.saving,
    counted: d.counted,
    reason: d.reason,
    previousPlan: d.previousPlan,
    isSwitch: d.isSwitch,
  }));

  const switchPoints: SwitchPoint[] = segments.flatMap((segment, index) => {
    if (
      !segment.isSwitch ||
      segment.plan === 'unknown' ||
      segment.previousPlan === null ||
      segment.previousPlan === 'unknown'
    ) {
      return [];
    }
    return [
      {
        index,
        from: segment.previousPlan,
        to: segment.plan,
        day: segment.start,
        saving: segment.saving,
        counted: segment.counted,
      },
    ];
  });

  const known = segments.filter((s) => s.plan !== 'unknown').length;

  return {
    segments,
    switchPoints,
    totalDays,
    known,
    switches: switchPoints.length,
    note:
      switchPoints.length === 0
        ? `${known} billing period${known === 1 ? '' : 's'}, all on the same plan — no switch to score yet.`
        : `${switchPoints.length} plan switch${switchPoints.length === 1 ? '' : 'es'} across ${known} billing periods.`,
  };
}
