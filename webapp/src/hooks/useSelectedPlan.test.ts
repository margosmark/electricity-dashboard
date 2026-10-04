/**
 * Wave H item 2 — the plan choice survives a reload, and every surface that
 * shows it agrees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useSelectedPlan,
  readStoredPlan,
  resetPlanStore,
  PLAN_STORAGE_KEY,
  DEFAULT_PLAN,
  PLAN_LABEL,
  isPlanId,
} from './useSelectedPlan';

// The store caches its snapshot in module scope, so every test starts from
// storage instead of inheriting the previous test's choice.
beforeEach(() => {
  localStorage.clear();
  resetPlanStore();
});

afterEach(() => {
  localStorage.clear();
  resetPlanStore();
});

describe('useSelectedPlan', () => {
  it('starts on the default plan when nothing is stored', () => {
    const { result } = renderHook(() => useSelectedPlan());
    expect(result.current[0]).toBe(DEFAULT_PLAN);
    expect(localStorage.getItem(PLAN_STORAGE_KEY)).toBeNull();
  });

  it('persists a choice so a returning user never re-picks', () => {
    const { result } = renderHook(() => useSelectedPlan());
    act(() => result.current[1]('ULO'));
    expect(result.current[0]).toBe('ULO');
    expect(localStorage.getItem(PLAN_STORAGE_KEY)).toBe('ULO');

    // "Return": a fresh mount reads the stored value back.
    const fresh = renderHook(() => useSelectedPlan());
    expect(fresh.result.current[0]).toBe('ULO');
  });

  it('keeps two independent subscribers (header chip + plan switcher) in sync', () => {
    const header = renderHook(() => useSelectedPlan());
    const switcher = renderHook(() => useSelectedPlan());

    act(() => switcher.result.current[1]('Tiered'));

    expect(header.result.current[0]).toBe('Tiered');
    expect(switcher.result.current[0]).toBe('Tiered');
    expect(header.result.current[0]).toBe(switcher.result.current[0]);
  });

  it('falls back to the default for a corrupt stored value', () => {
    localStorage.setItem(PLAN_STORAGE_KEY, 'FREE_ELECTRICITY');
    expect(readStoredPlan()).toBe(DEFAULT_PLAN);
    const { result } = renderHook(() => useSelectedPlan());
    expect(result.current[0]).toBe(DEFAULT_PLAN);
  });

  it('ignores a non-plan write instead of poisoning cost math', () => {
    const { result } = renderHook(() => useSelectedPlan());
    // @ts-expect-error deliberately wrong type
    act(() => result.current[1]('nonsense'));
    expect(result.current[0]).toBe(DEFAULT_PLAN);
    expect(localStorage.getItem(PLAN_STORAGE_KEY)).toBeNull();
  });

  it('picks up a change made in another tab', () => {
    const { result } = renderHook(() => useSelectedPlan());
    expect(result.current[0]).toBe('TOU');

    act(() => {
      localStorage.setItem(PLAN_STORAGE_KEY, 'ULO');
      window.dispatchEvent(
        new StorageEvent('storage', { key: PLAN_STORAGE_KEY, newValue: 'ULO' }),
      );
    });
    expect(result.current[0]).toBe('ULO');
  });

  it('survives storage being unavailable (private mode)', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    try {
      const { result } = renderHook(() => useSelectedPlan());
      act(() => result.current[1]('Tiered'));
      // In-memory choice still applies for the session.
      expect(result.current[0]).toBe('Tiered');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('PLAN_LABEL / isPlanId', () => {
  it('names every plan the way the switcher does', () => {
    expect(PLAN_LABEL.TOU).toBe('Time-of-Use');
    expect(PLAN_LABEL.Tiered).toBe('Tiered');
    expect(PLAN_LABEL.ULO).toBe('Ultra-Low Overnight');
  });

  it('accepts exactly the three plans', () => {
    expect(isPlanId('TOU')).toBe(true);
    expect(isPlanId('Tiered')).toBe(true);
    expect(isPlanId('ULO')).toBe(true);
    expect(isPlanId('tiered')).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
  });
});
