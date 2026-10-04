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

export type PlanId = 'TOU' | 'Tiered' | 'ULO';

export const PLAN_IDS: readonly PlanId[] = ['Tiered', 'TOU', 'ULO'];

export const PLAN_STORAGE_KEY = 'selected_plan';

/** Human name for the header chip — matches the switcher labels. */
export const PLAN_LABEL: Record<PlanId, string> = {
  TOU: 'Time-of-Use',
  Tiered: 'Tiered',
  ULO: 'Ultra-Low Overnight',
};

export const DEFAULT_PLAN: PlanId = 'TOU';

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

/* --------------------------------------------------------------------------
 * Store: one module-level snapshot + subscriber set (works across tabs too).
 * ------------------------------------------------------------------------ */

let snapshot: PlanId | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

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

/**
 * Drop the cached snapshot so the next read goes back to storage.
 * Called when storage is cleared wholesale (emergency reset, tests).
 */
export function resetPlanStore(): void {
  snapshot = null;
  emit();
}

/** Write + broadcast. Safe to call when storage is unavailable. */
export function writePlan(plan: PlanId): void {
  snapshot = plan;
  try {
    window.localStorage.setItem(PLAN_STORAGE_KEY, plan);
  } catch {
    /* keep the in-memory value; the session still honours the choice */
  }
  emit();
}

function getSnapshot(): PlanId {
  if (snapshot === null) snapshot = readStoredPlan();
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed the plan: re-read instead of holding a stale one.
  const onStorage = (e: StorageEvent) => {
    if (e.key === PLAN_STORAGE_KEY || e.key === null) {
      snapshot = null;
      emit();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function getServerSnapshot(): PlanId {
  return DEFAULT_PLAN;
}

/** The active plan + its setter, shared by every subscriber. */
export function useSelectedPlan(): [PlanId, (plan: PlanId) => void] {
  const plan = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setPlan = useCallback((next: PlanId) => {
    if (!isPlanId(next)) return;
    writePlan(next);
  }, []);
  return [plan, setPlan];
}
