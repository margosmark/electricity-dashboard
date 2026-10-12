/**
 * Shift verification — the weekly "did moving laundry actually help?" check.
 *
 * Compares the LAST 7 full days of loaded data against the PRIOR 7 on two
 * numbers a household already understands: what share of their energy landed
 * off-peak, and what it cost. Wave E tells them what to move; this tells them
 * whether the move showed up.
 *
 * Everything is anchored to the NEWEST reading (never `Date.now()`), so a
 * historical export and a unit test behave identically. Windows are built
 * from FULL days only — a half-recorded last day would otherwise make the
 * recent week look artificially cheap.
 */

import { addDays, format } from 'date-fns';
// Wave U — the weekly before/after verdict speaks the active language.
import { fmtMoney, fmtNumber, fmtPercent, fmtDay, t } from '@/i18n';
import { planCostFor, type ProcessedPoint } from './energy';
import type { PlanId } from './planIds';

/** Days in each window. */
export const WINDOW_DAYS = 7;
/** A window needs at least this many recorded days before we compare it. */
export const MIN_DAYS_PER_WINDOW = 5;
/** Share movement below this (percentage points) is noise, not a shift. */
export const MEANINGFUL_SHARE_PTS = 1;
/** Cost movement below this (dollars per week) is noise, not a shift. */
export const MEANINGFUL_COST = 0.5;
/** How far back we look for a full day to anchor the windows on. */
export const MAX_ANCHOR_BACKTRACK_DAYS = 7;

export type VerificationWindow = {
  start: string;
  end: string;
  /** Distinct calendar days with at least one reading. */
  days: number;
  totalKwh: number;
  totalCost: number;
  /** totalCost scaled to a full 7-day week (windows are not always 7 days). */
  weeklyCost: number;
  kwhPerDay: number;
  /** null when the plan has no off-peak window at all (Tiered). */
  offPeakKwh: number | null;
  offPeakShare: number | null;
};

export type ShiftVerdict =
  | 'improved'
  | 'worse'
  | 'diverged'
  | 'no-change'
  | 'no-offpeak';

export type ShiftVerification = {
  ready: boolean;
  emptyReason: 'no-data' | 'insufficient-history' | null;
  plan: PlanId;
  /** How the off-peak window is named on screen; null for Tiered. */
  offPeakLabel: string | null;
  /** Full day the recent window ends on (inclusive). */
  anchorDay: string;
  recent: VerificationWindow | null;
  prior: VerificationWindow | null;
  /** recent − prior, in percentage points. null when there is no off-peak. */
  shareDeltaPts: number | null;
  /** prior weekly cost − recent weekly cost; positive = cheaper this week. */
  costDelta: number;
  verdict: ShiftVerdict;
  headline: string;
  detail: string;
  caveat: string;
};

const CAVEAT_KEY = 'verify.caveat';

/** What a plan calls the cheap hours (null = it has none). */
export function offPeakLabelFor(plan: PlanId): string | null {
  if (plan === 'TOU') return t('verify.offPeakTou');
  if (plan === 'ULO') return t('verify.offPeakUlo');
  return null;
}

function isOffPeak(r: ProcessedPoint, plan: PlanId): boolean {
  if (plan === 'TOU') return r.touCategory === 'Off-Peak';
  if (plan === 'ULO') return r.uloCategory === 'Overnight' || r.uloCategory === 'Weekend Off-Peak';
  return false;
}

type DayStat = {
  day: string;
  kwh: number;
  offPeakKwh: number;
  readings: number;
  /** The day's own readings, so a window can be priced AS A WINDOW. */
  rows: ProcessedPoint[];
};

function buildDays(rows: ProcessedPoint[], plan: PlanId): Map<string, DayStat> {
  const days = new Map<string, DayStat>();
  for (const r of rows) {
    let d = days.get(r.dayStr);
    if (!d) {
      d = { day: r.dayStr, kwh: 0, offPeakKwh: 0, readings: 0, rows: [] };
      days.set(r.dayStr, d);
    }
    d.kwh += r.usage_kwh;
    if (isOffPeak(r, plan)) d.offPeakKwh += r.usage_kwh;
    d.rows.push(r);
    d.readings += 1;
  }
  return days;
}

/**
 * Anchor day: the newest day that is COMPLETE relative to the dataset's own
 * typical day. A feed exported at 11:00 today would otherwise make "the last
 * 7 days" seven-sixths of a week.
 */
export function pickAnchorDay(days: Map<string, DayStat>): string {
  const sorted = Array.from(days.keys()).sort();
  const newest = sorted[sorted.length - 1];
  const counts = sorted.map((k) => days.get(k)!.readings).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  const minFull = Math.max(1, Math.round(median));
  if (days.get(newest)!.readings >= minFull) return newest;

  const newestDate = new Date(newest + 'T00:00:00');
  for (let i = 1; i <= MAX_ANCHOR_BACKTRACK_DAYS; i++) {
    const key = format(addDays(newestDate, -i), 'yyyy-MM-dd');
    const stat = days.get(key);
    if (stat && stat.readings >= minFull) return key;
  }
  return newest;
}

function windowStats(
  days: Map<string, DayStat>,
  start: string,
  end: string,
  plan: PlanId,
): VerificationWindow {
  let n = 0;
  let kwh = 0;
  let offPeakKwh = 0;
  const inWindow: ProcessedPoint[] = [];
  for (const d of days.values()) {
    if (d.day < start || d.day > end) continue;
    n += 1;
    kwh += d.kwh;
    offPeakKwh += d.offPeakKwh;
    inWindow.push(...d.rows);
  }
  // Priced as a window: on Tiered the per-reading cost is tier 1 only, and a
  // week over the (day-prorated) threshold is not a tier-1 week.
  const cost = planCostFor(inWindow, plan);
  const hasOffPeak = plan !== 'Tiered';
  return {
    start,
    end,
    days: n,
    totalKwh: kwh,
    totalCost: cost,
    weeklyCost: n > 0 ? (cost / n) * WINDOW_DAYS : 0,
    kwhPerDay: n > 0 ? kwh / n : 0,
    offPeakKwh: hasOffPeak ? offPeakKwh : null,
    offPeakShare: hasOffPeak && kwh > 0 ? offPeakKwh / kwh : hasOffPeak ? 0 : null,
  };
}

function dayRange(start: string, days: number): { start: string; end: string } {
  const s = new Date(start + 'T00:00:00');
  const e = addDays(s, days - 1);
  return { start, end: format(e, 'yyyy-MM-dd') };
}

function shortDate(iso: string): string {
  return fmtDay(iso);
}

function pct(share: number): string {
  return fmtPercent(share * 100, 1);
}

function money(v: number): string {
  return fmtMoney(Math.abs(v));
}

export function analyzeShiftVerification(
  rows: ProcessedPoint[],
  plan: PlanId,
): ShiftVerification {
  const base = {
    ready: false,
    emptyReason: null as ShiftVerification['emptyReason'],
    plan,
    offPeakLabel: offPeakLabelFor(plan),
    anchorDay: '',
    recent: null as VerificationWindow | null,
    prior: null as VerificationWindow | null,
    shareDeltaPts: null as number | null,
    costDelta: 0,
    verdict: 'no-change' as ShiftVerdict,
    headline: '',
    detail: '',
    caveat: t(CAVEAT_KEY),
  };

  if (rows.length === 0) {
    return {
      ...base,
      emptyReason: 'no-data',
      headline: t('verify.emptyNoData'),
      detail: t('verify.emptyNoDataDetail'),
    };
  }

  const days = buildDays(rows, plan);
  const anchor = pickAnchorDay(days);

  const recentRange = dayRange(format(addDays(new Date(anchor + 'T00:00:00'), -(WINDOW_DAYS - 1)), 'yyyy-MM-dd'), WINDOW_DAYS);
  const priorStart = format(addDays(new Date(anchor + 'T00:00:00'), -(WINDOW_DAYS * 2 - 1)), 'yyyy-MM-dd');
  const priorRange = dayRange(priorStart, WINDOW_DAYS);

  const recent = windowStats(days, recentRange.start, recentRange.end, plan);
  const prior = windowStats(days, priorRange.start, priorRange.end, plan);

  if (recent.days < MIN_DAYS_PER_WINDOW || prior.days < MIN_DAYS_PER_WINDOW) {
    return {
      ...base,
      anchorDay: anchor,
      recent,
      prior,
      emptyReason: 'insufficient-history',
      headline: t('verify.emptyShort'),
      detail: t('verify.emptyShortDetail', {
        min: MIN_DAYS_PER_WINDOW,
        recent: recent.days,
        prior: prior.days,
      }),
    };
  }

  const shareDeltaPts =
    recent.offPeakShare !== null && prior.offPeakShare !== null
      ? (recent.offPeakShare - prior.offPeakShare) * 100
      : null;
  const costDelta = prior.weeklyCost - recent.weeklyCost;

  const windowLine = (label: string, w: VerificationWindow) =>
    `${label} (${shortDate(w.start)} – ${shortDate(w.end)}): ` +
    (w.offPeakShare !== null ? `${pct(w.offPeakShare)} ${t('verify.offPeakWord')} · ` : '') +
    t('verify.windowTail', {
      cost: fmtMoney(w.totalCost),
      kwh: fmtNumber(w.totalKwh, 1),
      count: w.days,
      days: w.days,
    });

  // Tiered charges one flat rate per kWh: moving hours cannot show up here,
  // and claiming a verdict from it would be a lie.
  if (plan === 'Tiered') {
    return {
      ...base,
      ready: true,
      anchorDay: anchor,
      recent,
      prior,
      costDelta,
      verdict: 'no-offpeak',
      headline: t('verify.tieredHeadline'),
      detail: `${windowLine(t('verify.last7'), recent)}. ${windowLine(t('verify.prior7'), prior)}. ${t('verify.tieredDetail')}`,
    };
  }

  const shareUp = shareDeltaPts !== null && shareDeltaPts >= MEANINGFUL_SHARE_PTS;
  const shareDown = shareDeltaPts !== null && shareDeltaPts <= -MEANINGFUL_SHARE_PTS;
  const cheaper = costDelta >= MEANINGFUL_COST;
  const dearer = costDelta <= -MEANINGFUL_COST;

  let verdict: ShiftVerdict;
  let headline: string;
  const pts = shareDeltaPts === null ? 0 : Math.abs(shareDeltaPts);

  if (shareUp && !dearer) {
    verdict = 'improved';
    headline = t(cheaper ? 'verify.improvedBetter' : 'verify.improvedFlat', {
      pts: fmtNumber(pts),
      cost: money(costDelta),
    });
  } else if (shareDown && !cheaper) {
    verdict = 'worse';
    headline = t('verify.worse', { pts: fmtNumber(pts), cost: money(costDelta) });
  } else if (shareUp && dearer) {
    verdict = 'diverged';
    headline = t('verify.divergedCost', { pts: fmtNumber(pts), cost: money(costDelta) });
  } else if (shareDown && cheaper) {
    verdict = 'diverged';
    headline = t('verify.divergedShare', { pts: fmtNumber(pts), cost: money(costDelta) });
  } else {
    verdict = 'no-change';
    headline = t('verify.noChange');
  }

  const deltaLine =
    shareDeltaPts === null
      ? ''
      : ` ${t('verify.deltaLine', {
          shareSign: shareDeltaPts >= 0 ? '+' : '−',
          share: fmtNumber(Math.abs(shareDeltaPts), 1),
          costSign: costDelta >= 0 ? '+' : '−',
          cost: money(costDelta),
        })}`;

  return {
    ...base,
    ready: true,
    anchorDay: anchor,
    recent,
    prior,
    shareDeltaPts,
    costDelta,
    verdict,
    headline,
    detail: `${windowLine(t('verify.last7'), recent)}. ${windowLine(t('verify.prior7'), prior)}.${deltaLine}`,
    caveat: t(CAVEAT_KEY),
  };
}
