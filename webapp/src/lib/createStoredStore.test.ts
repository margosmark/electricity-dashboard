/**
 * The shared external store. What is worth testing is the two invariants
 * `useSyncExternalStore` cares about and that five hand-copied stores each had
 * to remember:
 *
 *  1. `getServerSnapshot` is referentially STABLE. A fresh object every call
 *     makes React compare-by-identity forever.
 *  2. Reading storage never throws into a render — private mode and quota both
 *     throw, and a throw here takes the tree down.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStoredStore } from './createStoredStore';

beforeEach(() => {
  localStorage.clear();
});

describe('createStoredStore', () => {
  function makeStore(initial = 'a') {
    return createStoredStore<string>({
      key: 'test_key',
      read: () => localStorage.getItem('test_key') ?? initial,
      persist: (v) => localStorage.setItem('test_key', v),
      serverSnapshot: '',
    });
  }

  it('reads through to storage and caches the snapshot', () => {
    const store = makeStore();
    const spy = vi.spyOn(Storage.prototype, 'getItem');
    expect(store.getSnapshot()).toBe('a');
    expect(store.getSnapshot()).toBe('a');
    // Cached — one read, not one per call.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('getServerSnapshot returns the SAME reference every call', () => {
    const store = makeStore();
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    // Never the live value: SSR/hydration must not read this tab's storage.
    store.write('z');
    expect(store.getServerSnapshot()).toBe('');
  });

  it('write persists AND updates the snapshot immediately', () => {
    const store = makeStore();
    store.write('b');
    expect(localStorage.getItem('test_key')).toBe('b');
    expect(store.getSnapshot()).toBe('b');
  });

  it('notifies subscribers on write, and stops after unsubscribe', () => {
    const store = makeStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);

    store.write('c');
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    store.write('d');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset drops the cache so the next read goes back to storage', () => {
    const store = makeStore();
    store.write('e');
    expect(store.getSnapshot()).toBe('e');

    // Another tab (or the emergency reset) changed it underneath us.
    localStorage.setItem('test_key', 'f');
    store.reset();
    expect(store.getSnapshot()).toBe('f');
  });

  it('reset notifies subscribers', () => {
    const store = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(listener).toHaveBeenCalled();
  });

  it('survives storage that throws on read — the render must not die', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const store = makeStore();
    expect(store.getSnapshot()).toBe(''); // falls back to serverSnapshot
    getItem.mockRestore();
  });

  it('survives storage that throws on write, keeping the in-memory value', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const store = makeStore();
    expect(() => store.write('g')).not.toThrow();
    expect(store.getSnapshot()).toBe('g'); // session still honours it
    setItem.mockRestore();
  });
});