/**
 * Wave P — the plan timeline store.
 *
 * Same contract as useSelectedPlan: a tiny external store over localStorage
 * (`plan_timeline`, sitting right next to `billing_day`) that every surface
 * subscribes to, so the editor, the track record and any future overlay stay
 * in lockstep across component trees and tabs.
 *
 * Writes are validated at the boundary — an entry that fails
 * `isValidPlanTimelineEntry` never reaches storage, which is what lets the
 * reader trust whatever it finds there (see parsePlanTimeline).
 */

"use client";

import { useCallback, useSyncExternalStore } from 'react';

import {
  PLAN_TIMELINE_KEY,
  isValidPlanTimelineEntry,
  newTimelineId,
  parsePlanTimeline,
  type PlanTimelineEntry,
  type PlanType,
} from '@/lib/planTimeline';

/** Stable server snapshot — useSyncExternalStore forbids fresh arrays. */
const EMPTY: PlanTimelineEntry[] = [];

let snapshot: PlanTimelineEntry[] | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Read the stored timeline. Unreadable storage => empty, never a throw. */
export function readStoredTimeline(): PlanTimelineEntry[] {
  try {
    return parsePlanTimeline(window.localStorage.getItem(PLAN_TIMELINE_KEY));
  } catch {
    return [];
  }
}

/** Write + broadcast. Storage failures keep the in-memory value only. */
export function writeStoredTimeline(entries: PlanTimelineEntry[]): void {
  snapshot = entries;
  try {
    window.localStorage.setItem(PLAN_TIMELINE_KEY, JSON.stringify(entries));
  } catch {
    /* quota / private mode: the session still honours the choice */
  }
  emit();
}

/** Drop the cached snapshot (emergency reset, tests). */
export function resetPlanTimelineStore(): void {
  snapshot = null;
  emit();
}

function getSnapshot(): PlanTimelineEntry[] {
  if (snapshot === null) snapshot = readStoredTimeline();
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PLAN_TIMELINE_KEY || e.key === null) {
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

function getServerSnapshot(): PlanTimelineEntry[] {
  return EMPTY;
}

export type NewTimelineEntry = {
  plan: PlanType;
  from: string;
  to: string;
};

export type PlanTimelineApi = {
  /** Add an entry. Returns false (and writes nothing) when it is invalid. */
  add: (input: NewTimelineEntry) => boolean;
  /** Patch an entry. Returns false when the result would be invalid — the
   *  editor shows the error instead of the store ever holding a bad range. */
  update: (id: string, patch: Partial<Pick<PlanTimelineEntry, 'plan' | 'from' | 'to'>>) => boolean;
  remove: (id: string) => void;
};

export function usePlanTimeline(): [PlanTimelineEntry[], PlanTimelineApi] {
  const entries = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const add = useCallback((input: NewTimelineEntry): boolean => {
    const candidate: PlanTimelineEntry = { id: newTimelineId(), ...input };
    if (!isValidPlanTimelineEntry(candidate)) return false;
    writeStoredTimeline([...getSnapshot(), candidate]);
    return true;
  }, []);

  const update = useCallback((id: string, patch: Partial<Pick<PlanTimelineEntry, 'plan' | 'from' | 'to'>>): boolean => {
    const current = getSnapshot();
    const target = current.find((e) => e.id === id);
    if (!target) return false;
    const merged: PlanTimelineEntry = { ...target, ...patch };
    if (!isValidPlanTimelineEntry(merged)) return false;
    writeStoredTimeline(current.map((e) => (e.id === id ? merged : e)));
    return true;
  }, []);

  const remove = useCallback((id: string): void => {
    writeStoredTimeline(getSnapshot().filter((e) => e.id !== id));
  }, []);

  return [entries, { add, update, remove }];
}
