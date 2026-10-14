import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TAB,
  TABS,
  TAB_IDS,
  TAB_STORAGE_KEY,
  isTabId,
  tabFromHash,
  tabFromStorage,
  tabHash,
} from './tabs';

describe('tabs — the contract', () => {
  it('has exactly the three decision surfaces, overview first', () => {
    expect(TAB_IDS).toEqual(['overview', 'plans', 'money']);
    expect(DEFAULT_TAB).toBe('overview');
    expect(TABS.map((t) => t.id)).toEqual([...TAB_IDS]);
  });

  it('labels every tab (the strip renders icons + labels at 390 px)', () => {
    for (const tab of TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
      expect(tab.title.startsWith(tab.label)).toBe(true);
      expect(tab.description.length).toBeGreaterThan(20);
    }
  });
});

describe('tabHash / tabFromHash', () => {
  it('round-trips every tab', () => {
    for (const id of TAB_IDS) {
      expect(tabFromHash(tabHash(id))).toBe(id);
    }
  });

  it('rejects anything that is not one of ours', () => {
    expect(tabFromHash(null)).toBeNull();
    expect(tabFromHash('')).toBeNull();
    expect(tabFromHash('#')).toBeNull();
    expect(tabFromHash('#section=money')).toBeNull();
    expect(tabFromHash('#tab=')).toBeNull();
    expect(tabFromHash('#tab=bogus')).toBeNull();
    expect(tabFromHash('#tab=OVERVIEW')).toBeNull();
    // A stray hash from some other feature must never hijack the tab strip.
    expect(tabFromHash('#some-anchor')).toBeNull();
  });

  it('tolerates surrounding whitespace but nothing else', () => {
    expect(tabFromHash(' #tab=plans ')).toBe('plans');
    expect(tabFromHash('#tab=usage=extra')).toBeNull();
  });
});

describe('tabFromStorage', () => {
  it('accepts a stored tab', () => {
    expect(tabFromStorage('money')).toBe('money');
  });

  it('degrades to the default instead of poisoning the strip', () => {
    expect(tabFromStorage(null)).toBe(DEFAULT_TAB);
    expect(tabFromStorage('nonsense')).toBe(DEFAULT_TAB);
    expect(tabFromStorage('')).toBe(DEFAULT_TAB);
    expect(tabFromStorage(JSON.stringify({ tab: 'money' }))).toBe(DEFAULT_TAB);
  });
});

describe('isTabId', () => {
  it('is the narrow guard storage and hashes both use', () => {
    expect(isTabId('plans')).toBe(true);
    expect(isTabId('plans ')).toBe(false);
    expect(isTabId(42)).toBe(false);
    expect(isTabId(undefined)).toBe(false);
  });
});

describe('storage key', () => {
  it('is namespaced so it cannot collide with the plan or the readings', () => {
    expect(TAB_STORAGE_KEY).toBe('oeo_active_tab');
  });
});
