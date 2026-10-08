/**
 * The estimate ledger — the self-improving half of the open period.
 *
 * When this app shows "unbilled since Aug 20: $58.40 estimated", that number
 * is a claim about a bill that does not exist yet. This module keeps the
 * claim so the app can SCORE IT: when a later export finally bills the window,
 * the ledger compares what it said against what the utility actually charged
 * and produces an accuracy figure — no user input, no re-typing, and no way
 * to quietly forget a prediction that missed.
 *
 * Two rules make the comparison honest:
 *
 *  1. The record stores a RATE ($/kWh) alongside the total, because the bill
 *     that closes a window may cover only part of it (a 76-day open tail is
 *     closed by ~29-day bills one at a time). Both sides are then prorated by
 *     the same share of the window instead of comparing a half-window bill
 *     against a whole-window guess.
 *  2. A window only closes once the bills cover ≥90% of it. Below that the
 *     proration error would dominate the answer, and an accuracy figure built
 *     on a quarter of a window would be noise dressed up as a score.
 *
 * Everything here is pure and serializable: the caller owns localStorage (see
 * hooks/useEstimateLedger), so this file can be tested without a DOM.
 */

import { billPeriodLabel, billTotals, type UsageSummary } from './energy';

export const ESTIMATE_LEDGER_KEY = 'open_estimate_ledger';

/** Share of a record's window the bills must cover before it can close. */
export const CLOSE_COVERAGE = 0.9;

/** Below this, a bill's own span is only partly inside the window. */
export const PARTIAL_BILL = 0.9;

export type PlanId = 'TOU' | 'Tiered' | 'ULO';

/** What this browser told the user, and when. */
export type OpenEstimateRecord = {
  /** Window start (unix seconds) — records are upserted by this key, so a
   *  growing tail updates in place instead of stacking new claims. */
  windowStart: number;
  /** Window end (unix seconds); grows as new readings arrive. */
  windowEnd: number;
  plan: PlanId;
  /** Estimated commodity for the whole window, dollars. */
  estimated: number;
  /** Metered kWh the estimate was built from. */
  meteredKwh: number;
  /** estimated ÷ meteredKwh, dollars per kWh — the claim actually scored. */
  ratePerKwh: number;
};

/**
 * Deliberately has no timestamps. Everything in this module is a DERIVATION
 * of (what this browser recorded, today's claim, the bills it now holds), and
 * a derivation the app computes while rendering must not read the clock — the
 * React compiler rightly refuses `Date.now()` in render, and a wall-clock
 * field would add nothing the window itself does not already say (it starts
 * and ends on known dates).
 */

/** One settled comparison: our claim, their bill, the score. */
export type EstimateCheck = {
  windowStart: number;
  windowEnd: number;
  plan: PlanId;
  /** What we said the covered part would cost. */
  estimated: number;
  /** What the utility charged for the same part (commodity lines only). */
  actual: number;
  /** estimated − actual. */
  delta: number;
  /**
   * 100 − relative error, in percent, floored at 0. Null when the bill states
   * no commodity at all (nothing to score against).
   */
  accuracy: number | null;
  /** The bill's own period label, for the sentence the panel prints. */
  label: string;
  /** True when a bill only partly sits inside the window (prorated figure). */
  partial: boolean;
  /** Share of the record's window the closing bills covered, 0–1. */
  coverage: number;
};

export type EstimateLedger = {
  open: OpenEstimateRecord[];
  closed: EstimateCheck[];
};

export const EMPTY_LEDGER: EstimateLedger = { open: [], closed: [] };

/**
 * Read a stored ledger, dropping anything malformed. A corrupt or partially
 * written ledger must never break the money panel: the worst case is losing
 * the history and starting over.
 */
export function readLedger(raw: string | null | undefined): EstimateLedger {
  if (!raw) return EMPTY_LEDGER;
  try {
    const parsed = JSON.parse(raw) as Partial<EstimateLedger> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY_LEDGER;
    const open = Array.isArray(parsed.open)
      ? parsed.open.filter(isRecord).map(normalizeRecord)
      : [];
    const closed = Array.isArray(parsed.closed)
      ? parsed.closed.filter(isCheck).map(normalizeCheck)
      : [];
    return { open, closed };
  } catch {
    return EMPTY_LEDGER;
  }
}

export function serializeLedger(ledger: EstimateLedger): string {
  return JSON.stringify(ledger);
}

function isRecord(v: unknown): v is OpenEstimateRecord {
  const r = v as OpenEstimateRecord | null;
  return (
    !!r &&
    typeof r.windowStart === 'number' &&
    typeof r.windowEnd === 'number' &&
    typeof r.estimated === 'number' &&
    Number.isFinite(r.estimated)
  );
}

function isCheck(v: unknown): v is EstimateCheck {
  const c = v as EstimateCheck | null;
  return !!c && typeof c.windowStart === 'number' && typeof c.actual === 'number';
}

function normalizeRecord(r: OpenEstimateRecord): OpenEstimateRecord {
  return {
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    plan: r.plan ?? 'TOU',
    estimated: r.estimated,
    meteredKwh: typeof r.meteredKwh === 'number' ? r.meteredKwh : 0,
    ratePerKwh:
      typeof r.ratePerKwh === 'number' && r.ratePerKwh > 0
        ? r.ratePerKwh
        : r.meteredKwh > 0
          ? r.estimated / r.meteredKwh
          : 0,
  };
}

function normalizeCheck(c: EstimateCheck): EstimateCheck {
  return {
    ...c,
    plan: c.plan ?? 'TOU',
    accuracy: typeof c.accuracy === 'number' ? c.accuracy : null,
    partial: !!c.partial,
    coverage: typeof c.coverage === 'number' ? c.coverage : 0,
  };
}

/**
 * Put today's claim into the ledger (upserting by window start).
 *
 * Revising the estimate for a window that is still open is NOT a new claim:
 * the same window grows as readings arrive, so the record keeps its
 * the window keeps one claim — the newest numbers for those days.
 */
export function recordOpenEstimate(
  ledger: EstimateLedger,
  claim: {
    windowStart: number;
    windowEnd: number;
    plan: PlanId;
    estimated: number;
    meteredKwh: number;
  },
): EstimateLedger {
  if (!(claim.estimated > 0) || !(claim.windowEnd > claim.windowStart)) return ledger;
  const existing = ledger.open.find((r) => r.windowStart === claim.windowStart);
  // Re-recording an unchanged claim returns the SAME object: the panel's
  // effect runs on every render, and a fresh identity each time would loop.
  if (
    existing &&
    existing.windowEnd === claim.windowEnd &&
    existing.estimated === claim.estimated &&
    existing.plan === claim.plan
  ) {
    return ledger;
  }
  const next: OpenEstimateRecord = {
    windowStart: claim.windowStart,
    windowEnd: claim.windowEnd,
    plan: claim.plan,
    estimated: claim.estimated,
    meteredKwh: claim.meteredKwh,
    ratePerKwh: claim.meteredKwh > 0 ? claim.estimated / claim.meteredKwh : 0,
  };
  return {
    ...ledger,
    open: [...ledger.open.filter((r) => r.windowStart !== claim.windowStart), next].sort(
      (a, b) => a.windowStart - b.windowStart,
    ),
  };
}

/**
 * Settle every open claim the bills now cover, and return the ledger with
 * those claims moved into `closed`.
 *
 * Proration, stated once: a claim for a window of W seconds says the whole
 * window costs `estimated`; the bills cover C of those seconds, so the claim
 * for the covered part is `estimated × C/W`. On the other side, each bill's
 * own commodity charge is scaled by how much of IT sits inside the window.
 * Both sides therefore describe exactly the same slice of time.
 */
export function closeEstimates(
  ledger: EstimateLedger,
  summaries: UsageSummary[],
): EstimateLedger {
  if (ledger.open.length === 0 || summaries.length === 0) return ledger;

  const stillOpen: OpenEstimateRecord[] = [];
  const closed = [...ledger.closed];
  const byStart = new Map(closed.map((c) => [c.windowStart, c]));
  let settled = 0;

  for (const record of ledger.open) {
    const span = record.windowEnd - record.windowStart;
    if (span <= 0) continue;

    let covered = 0;
    let actual = 0;
    let partial = false;
    const labels: string[] = [];

    for (const summary of summaries) {
      const billStart = summary.start;
      const billEnd = summary.start + summary.duration;
      const overlap = Math.min(billEnd, record.windowEnd) - Math.max(billStart, record.windowStart);
      if (overlap <= 0) continue;
      const billSpan = Math.max(1, billEnd - billStart);
      const billShare = overlap / billSpan;
      covered += overlap;
      actual += billTotals(summary).commodity * billShare;
      if (billShare < PARTIAL_BILL) partial = true;
      if (billShare >= PARTIAL_BILL) labels.push(billPeriodLabel(summary.start, summary.duration));
    }

    const coverage = covered / span;
    if (coverage < CLOSE_COVERAGE) {
      stillOpen.push(record);
      continue;
    }

    const estimated = record.estimated * Math.min(1, coverage);
    const delta = estimated - actual;
    const accuracy =
      actual > 0 ? Math.max(0, (1 - Math.abs(delta) / Math.abs(actual)) * 100) : null;

    settled += 1;
    byStart.set(record.windowStart, {
      windowStart: record.windowStart,
      windowEnd: record.windowEnd,
      plan: record.plan,
      estimated,
      actual,
      delta,
      accuracy,
      label:
        labels[0] ??
        billPeriodLabel(record.windowStart, record.windowEnd - record.windowStart),
      partial,
      coverage,
    });
  }

  // Nothing settled ⇒ hand back the SAME object (see recordOpenEstimate):
  // an effect that recomputes on every render must be able to converge.
  if (settled === 0) return ledger;

  return {
    open: stillOpen,
    closed: [...byStart.values()].sort((a, b) => a.windowStart - b.windowStart),
  };
}

export type AccuracySummary = {
  /** How many claims have been settled so far. */
  settled: number;
  /** Mean of the settled accuracy figures, or null with fewer than one. */
  meanAccuracy: number | null;
  /** True when every settled claim landed within $1 of the bill. */
  allWithinDollar: boolean;
};

/** The panel's headline: how well this app has been guessing. */
export function accuracySummary(closed: EstimateCheck[]): AccuracySummary {
  const scored = closed.filter((c) => c.accuracy !== null);
  if (scored.length === 0) {
    return { settled: closed.length, meanAccuracy: null, allWithinDollar: false };
  }
  const mean = scored.reduce((n, c) => n + (c.accuracy as number), 0) / scored.length;
  return {
    settled: scored.length,
    meanAccuracy: Math.round(mean * 10) / 10,
    allWithinDollar: closed.every((c) => Math.abs(c.delta) <= 1),
  };
}
