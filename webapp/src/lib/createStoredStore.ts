'use client';

/**
 * A tiny module-level external store, shaped for React's
 * `useSyncExternalStore`.
 *
 * This app has five of these (selected plan, plan timeline, active tab,
 * theme, locale) and they were each written out longhand: a module-level
 * snapshot, a `Set` of listeners, an `emit()` that walks them, a
 * `getServerSnapshot` that returns a stable value, and — for the localStorage
 * backed ones — the same `storage` event handler that invalidates the
 * snapshot so another tab's change is picked up. `usePlanTimeline.ts` was
 * effectively a copy of `useSelectedPlan.ts`, comments included.
 *
 * `createStoredStore` implements the localStorage-backed case once. What is
 * left per store is the part that genuinely differs: the key, how to read
 * and write the value, and the stable server snapshot.
 *
 * Two invariants this exists to keep, which every copy had to remember:
 *
 *  1. `getServerSnapshot` MUST return a referentially stable value.
 *     `useSyncExternalStore` compares snapshots by identity and will loop
 *     forever (or warn) if a fresh object comes back every call — hence the
 *     caller supplies a frozen `EMPTY`-style constant rather than `[]`.
 *  2. Reading storage must never throw into a render. Private mode and quota
 *     both throw from `localStorage`, and a throw here takes down the tree,
 *     so `read` is wrapped and falls back to the same default the first
 *     render uses.
 */

export type StoredStore<T> = {
  /** Current value. Cached; re-reads storage only after an invalidation. */
  getSnapshot: () => T;
  /** Register a listener. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Value to render during SSR and hydration — must be stable. */
  getServerSnapshot: () => T;
  /** Write + persist + broadcast. Never throws. */
  write: (value: T) => void;
  /** Drop the cached snapshot so the next read goes back to storage. */
  reset: () => void;
};

export function createStoredStore<T>(options: {
  /** localStorage key this store owns. */
  key: string;
  /** Read + validate the persisted value. Called once per invalidation. */
  read: () => T;
  /** Persist the value. Called inside the try/catch. */
  persist: (value: T) => void;
  /** Stable value for SSR/hydration. Must be a fixed reference. */
  serverSnapshot: T;
}): StoredStore<T> {
  const { key, read, persist, serverSnapshot } = options;

  let snapshot: T | null = null;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const getSnapshot = (): T => {
    if (snapshot === null) {
      try {
        snapshot = read();
      } catch {
        // Storage blocked (private mode / quota) — behave like a first-time
        // user rather than taking the render down.
        snapshot = serverSnapshot;
      }
    }
    return snapshot;
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    // Another tab changed the value: invalidate rather than hold a stale one.
    // `key === null` is a wholesale `localStorage.clear()`.
    const onStorage = (e: StorageEvent): void => {
      if (e.key === key || e.key === null) {
        snapshot = null;
        emit();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  };

  const write = (value: T): void => {
    snapshot = value;
    try {
      persist(value);
    } catch {
      // Quota / private mode: keep the in-memory value, so the session still
      // honours the choice even though it cannot be remembered.
    }
    emit();
  };

  const reset = (): void => {
    snapshot = null;
    emit();
  };

  return { getSnapshot, subscribe, getServerSnapshot: () => serverSnapshot, write, reset };
}