/**
 * Wave R — one verdict, three places.
 *
 * The user's complaint was "the best choice is now buried", so the answer is
 * allowed to appear in more than one spot — but only if every spot computes
 * it the same way. The banner (big, Overview), the chip (persistent, in the
 * toolbar) and the one-line verdict (Plans, where shift advice can move it)
 * all read this function, so they can never disagree about which plan wins or
 * by how much.
 *
 * Everything here is commodity/variable charges, priced the way
 * `calculateComparison` prices the plan cards: the sum over the window on
 * screen. `deltaPerMonth` is that window's gap scaled to 30.44 days — a
 * comparison over a 2-day window is a 2-day measurement, and the caller is
 * expected to say so (the chip's tooltip carries `days`).
 */

import { PLAN_LABEL, type PlanId } from '@/hooks/useSelectedPlan';

export type PlanCosts = { TOU: number; Tiered: number; ULO: number };

export type Verdict = {
  /** Cheapest plan over the window. */
  best: PlanId;
  /** Most expensive plan over the window. */
  worst: PlanId;
  costs: PlanCosts;
  /** What the household pays right now, over the window. */
  currentCost: number;
  /** currentCost − best cost, always ≥ 0 (0 = already on the winner). */
  delta: number;
  /** `delta` scaled to a month over the window's own day span. */
  deltaPerMonth: number;
  /** Whole-dataset window the delta was measured over, in days (≥ 1). */
  days: number;
  /** The selected plan already IS the winner. */
  alreadyBest: boolean;
  /** best − worst: the spread between the best and worst plans. */
  spread: number;
  /** Human label of the winning plan ("Ultra-Low Overnight"). */
  bestLabel: string;
};

const ORDER: readonly PlanId[] = ['TOU', 'Tiered', 'ULO'];
/** Mean calendar month, so "$/mo" is not a 30-day fiction in February. */
const DAYS_PER_MONTH = 30.44;

/**
 * `null` when there is nothing to judge (no rows in the window).
 *
 * `days` is passed in rather than derived so this stays a pure function of
 * numbers the caller already has — and so a caller that cannot state a day
 * span cannot accidentally invent one.
 */
export function buildVerdict(
  costs: PlanCosts | null,
  currentPlan: PlanId,
  days: number,
): Verdict | null {
  if (!costs) return null;

  let best: PlanId = 'TOU';
  let worst: PlanId = 'TOU';
  for (const plan of ORDER) {
    if (costs[plan] < costs[best]) best = plan;
    if (costs[plan] > costs[worst]) worst = plan;
  }

  const safeDays = Number.isFinite(days) && days >= 1 ? days : 1;
  const currentCost = costs[currentPlan];
  const delta = Math.max(0, currentCost - costs[best]);

  return {
    best,
    worst,
    costs,
    currentCost,
    delta,
    deltaPerMonth: (delta / safeDays) * DAYS_PER_MONTH,
    days: safeDays,
    alreadyBest: currentPlan === best,
    spread: costs[worst] - costs[best],
    bestLabel: PLAN_LABEL[best],
  };
}

/** `-$45.10` / `$0.00` — always signed so a saving never reads as a cost. */
export function formatDelta(amount: number): string {
  return `$${Math.abs(amount).toFixed(2)}`;
}

/** "TOU → ULO", the switch the verdict is recommending. */
export function switchPhrase(verdict: Verdict, currentPlan: PlanId): string {
  return `${PLAN_LABEL[currentPlan]} → ${verdict.bestLabel}`;
}
