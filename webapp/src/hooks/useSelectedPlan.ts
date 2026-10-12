/**
 * Wave H item 2 — the selected plan, persisted.
 *
 * Choosing Tiered/TOU/ULO used to be throwaway component state: come back
 * tomorrow and the app had forgotten, silently re-pricing everything under
 * TOU. This hook makes the choice a stored fact (`selected_plan`) shared by
 * EVERY surface that shows it — the plan switcher, the header chip, the plan
 * cards — because they all subscribe to the same store.
 *
 * It is deliberately a tiny external store rather than context: Dashboard and
 * the page header are different component trees, and `useSyncExternalStore`
 * keeps them in lockstep without prop drilling or a state-lifting refactor.
 *
 * Storage is treated as a hint, never as authority: an unknown stored value
 * (corrupt, from a future plan id) falls back to TOU instead of poisoning
 * every cost calculation downstream.
 */

"use client";

import { useCallback, useSyncExternalStore } from 'react';
import { createStoredStore } from '@/lib/createStoredStore';

// The plan identity itself lives in lib/planIds.ts — one definition, shared by
// the hook, the pure libs and the components. Re-exported here because this
// module has always been where the tree imports them from.
import { DEFAULT_PLAN, PLAN_IDS, PLAN_LABEL, isPlanId, type PlanId } from '@/lib/planIds';

export { DEFAULT_PLAN, PLAN_IDS, PLAN_LABEL, isPlanId };
export type { PlanId };

export const PLAN_STORAGE_KEY = 'selected_plan';

/* --------------------------------------------------------------------------
 * Store: one module-level snapshot + subscriber set (works across tabs too).
 * The mechanics live in createStoredStore — see lib/createStoredStore.ts for
 * what each store must supply and why the server snapshot must be stable.
 * ------------------------------------------------------------------------ */

/** Read the stored plan. Unreadable storage or a bad value => default. */
export function readStoredPlan(): PlanId {
  try {
    const raw = window.localStorage.getItem(PLAN_STORAGE_KEY);
    if (isPlanId(raw)) return raw;
  } catch {
    /* storage blocked (private mode / quota): behave like a first-time user */
  }
  return DEFAULT_PLAN;
}

const store = createStoredStore<PlanId>({
  key: PLAN_STORAGE_KEY,
  read: readStoredPlan,
  persist: (plan) => window.localStorage.setItem(PLAN_STORAGE_KEY, plan),
  serverSnapshot: DEFAULT_PLAN,
});

/**
 * Drop the cached snapshot so the next read goes back to storage.
 * Called when storage is cleared wholesale (emergency reset, tests).
 */
export function resetPlanStore(): void {
  store.reset();
}

/** Write + broadcast. Safe to call when storage is unavailable. */
export function writePlan(plan: PlanId): void {
  store.write(plan);
}

/** The active plan + its setter, shared by every subscriber. */
export function useSelectedPlan(): [PlanId, (plan: PlanId) => void] {
  const plan = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const setPlan = useCallback((next: PlanId) => {
    if (!isPlanId(next)) return;
    writePlan(next);
  }, []);
  return [plan, setPlan];
}
