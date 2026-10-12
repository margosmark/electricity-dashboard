/**
 * The canonical plan identity: ONE definition of the three Ontario rate plans,
 * their canonical English names, and the guards over both.
 *
 * Why this module exists (it used to be declared six times):
 *
 *  - `PlanId` was re-declared verbatim in `hooks/useSelectedPlan.ts`,
 *    `lib/moneyViz.ts`, `lib/estimateLedger.ts`, `lib/shiftVerification.ts`
 *    and `components/ChartView.tsx` (and as `PlanType` in
 *    `lib/planTimeline.ts`). Structurally identical types happen to unify, but
 *    six copies drift.
 *  - Worse, `lib/moneyViz.ts` carried its OWN `PLAN_LABEL`, byte-identical to
 *    the one in `useSelectedPlan.ts`. That copy is what the plan overlay's
 *    legend read, and it is the one `i18n.planLabel()` did NOT translate — so
 *    switching to French still printed "Time-of-Use" on that chart while the
 *    rest of the UI said "Tarification selon l'heure de consommation".
 *
 * This is a plain module (no "use client") so pure lib code can import it
 * without dragging React hooks along; `useSelectedPlan.ts` re-exports the
 * pieces it has always exported so existing importers keep working.
 *
 * The canonical English names are DATA: they are storage values, fingerprints
 * and `data-*` attributes, so they must not move with the locale. Display
 * goes through `i18n.planLabel()`, which owns the OEB French wording.
 */

export type PlanId = 'TOU' | 'Tiered' | 'ULO';

/** Alphabetical — the order the plan switcher and picker render in. */
export const PLAN_IDS: readonly PlanId[] = ['Tiered', 'TOU', 'ULO'];

export const DEFAULT_PLAN: PlanId = 'TOU';

/** Canonical English plan name. Translate for DISPLAY with `planLabel()`. */
export const PLAN_LABEL: Record<PlanId, string> = {
  TOU: 'Time-of-Use',
  Tiered: 'Tiered',
  ULO: 'Ultra-Low Overnight',
};

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}