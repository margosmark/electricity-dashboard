import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ENERGY_KEY_V2,
  LEGACY_ENERGY_KEY,
  BILLING_DAY_KEY,
  loadEnergyData,
  saveEnergyData,
  loadBillingDay,
  saveBillingDay,
  exportEnergyData,
  parseImport,
  resetStoredData,
  listOurStoredKeys,
  type StoredPayload,
} from './storage';
import type { DataPoint } from './energy';

const points: DataPoint[] = Array.from({ length: 48 }, (_, i) => ({
  timestamp: 1704067200 + i * 3600,
  usage_kwh: Number((i * 0.25).toFixed(3)),
}));

function quotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('loadEnergyData: v1 → v2 migration', () => {
  it('migrates the legacy energy_data array into an energy_data_v2 payload', () => {
    localStorage.setItem(LEGACY_ENERGY_KEY, JSON.stringify(points));

    const result = loadEnergyData();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.value).not.toBeNull();
    expect(result.value!.version).toBe(2);
    expect(result.value!.source).toBe('legacy-migration');
    expect(result.value!.points).toEqual(points);

    const written = JSON.parse(localStorage.getItem(ENERGY_KEY_V2)!) as StoredPayload;
    expect(written.version).toBe(2);
    expect(written.points).toHaveLength(48);
    expect(localStorage.getItem(LEGACY_ENERGY_KEY)).toBeNull();
  });

  it('keeps the legacy copy and reports a quota warning when the v2 write fails', () => {
    localStorage.setItem(LEGACY_ENERGY_KEY, JSON.stringify(points));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError();
    });

    const result = loadEnergyData();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.points).toEqual(points);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].kind).toBe('quota');
    expect(result.warnings[0].detail).toMatch(/quota/i);
    // never delete data we failed to re-write
    expect(localStorage.getItem(LEGACY_ENERGY_KEY)).not.toBeNull();
  });

  it('returns ok(null) when nothing has ever been stored', () => {
    const result = loadEnergyData();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
    expect(result.warnings).toEqual([]);
  });
});

describe('loadEnergyData: corrupt paths', () => {
  it('reports corrupt for an unparseable v2 payload', () => {
    localStorage.setItem(ENERGY_KEY_V2, '{"version":2,"points":[');

    const result = loadEnergyData();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('corrupt');
    expect(result.detail).toContain(ENERGY_KEY_V2);
  });

  it('reports corrupt for a v2 payload that fails schema validation', () => {
    localStorage.setItem(
      ENERGY_KEY_V2,
      JSON.stringify({ version: 2, uploadedAt: 'now', source: 'xml-upload', points: [{ timestamp: 'nope', usage_kwh: 1 }] }),
    );

    const result = loadEnergyData();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('corrupt');
  });

  it('reports corrupt for unparseable legacy JSON', () => {
    localStorage.setItem(LEGACY_ENERGY_KEY, 'not json at all');

    const result = loadEnergyData();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('corrupt');
    expect(result.detail).toContain(LEGACY_ENERGY_KEY);
  });
});

describe('saveEnergyData', () => {
  it('surfaces a quota failure and leaves the previously stored payload intact', () => {
    const first = saveEnergyData(points, { source: 'xml-upload' });
    expect(first.ok).toBe(true);

    const before = localStorage.getItem(ENERGY_KEY_V2)!;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError();
    });

    const second = saveEnergyData(points.slice(0, 5), { source: 'xml-upload' });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('quota');
    expect(second.detail).toMatch(/quota/i);
    expect(localStorage.getItem(ENERGY_KEY_V2)).toBe(before);
  });

  it('refuses to store points that do not match the schema', () => {
    const result = saveEnergyData([{ timestamp: 1, usage_kwh: 'x' } as unknown as DataPoint]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('corrupt');
    expect(localStorage.getItem(ENERGY_KEY_V2)).toBeNull();
  });

  it('round-trips through save → load with version, source and every point', () => {
    const saved = saveEnergyData(points, { source: 'xml-upload' });
    expect(saved.ok).toBe(true);

    const loaded = loadEnergyData();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value!.version).toBe(2);
    expect(loaded.value!.source).toBe('xml-upload');
    expect(loaded.value!.points).toEqual(points);
  });
});

describe('export → import round trip', () => {
  it('preserves every point through export, import and re-save', () => {
    const exported = exportEnergyData(points, 'manual-export');
    expect(exported.ok).toBe(true);

    const imported = parseImport(exported.ok ? exported.value : '');
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.points).toEqual(points);

    const saved = saveEnergyData(imported.value.points, {
      source: imported.value.source,
      uploadedAt: imported.value.uploadedAt,
    });
    expect(saved.ok).toBe(true);

    const loaded = loadEnergyData();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value!.points).toEqual(points);
    expect(loaded.value!.points).toHaveLength(48);
  });

  it('rejects malformed import files before anything is stored', () => {
    const notJson = parseImport('definitely not json');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toBe('corrupt');

    const noPoints = parseImport('{"version":2,"uploadedAt":"x","source":"y"}');
    expect(noPoints.ok).toBe(false);
    if (!noPoints.ok) expect(noPoints.reason).toBe('corrupt');

    const badPoints = parseImport('{"version":2,"points":[{"timestamp":"1704067200","usage_kwh":1}]}');
    expect(badPoints.ok).toBe(false);
    if (!badPoints.ok) expect(badPoints.reason).toBe('corrupt');

    expect(localStorage.getItem(ENERGY_KEY_V2)).toBeNull();
  });

  it('accepts a legacy bare-array export', () => {
    const imported = parseImport(JSON.stringify(points));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.points).toEqual(points);
    expect(imported.value.source).toBe('import');
  });
});

describe('billing_day', () => {
  it('persists and reads back the billing day', () => {
    const saved = saveBillingDay(15);
    expect(saved.ok).toBe(true);
    expect(localStorage.getItem(BILLING_DAY_KEY)).toBe('15');

    const loaded = loadBillingDay();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBe(15);
  });

  it('returns ok(null) when unset and corrupt for garbage values', () => {
    const unset = loadBillingDay();
    expect(unset.ok).toBe(true);
    if (unset.ok) expect(unset.value).toBeNull();

    localStorage.setItem(BILLING_DAY_KEY, 'not-a-day');
    const bad = loadBillingDay();
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('corrupt');

    const outOfRange = saveBillingDay(32);
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.reason).toBe('corrupt');
  });
});

describe('scoped reset', () => {
  it('removes only this app’s keys and leaves unrelated keys alone', () => {
    localStorage.setItem(ENERGY_KEY_V2, JSON.stringify({ version: 2, uploadedAt: 'x', source: 'xml-upload', points }));
    localStorage.setItem(LEGACY_ENERGY_KEY, JSON.stringify(points));
    localStorage.setItem(BILLING_DAY_KEY, '7');
    localStorage.setItem('some_other_app', 'keep-me');
    localStorage.setItem('theme', 'dark');

    const listed = listOurStoredKeys();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.sort()).toEqual([BILLING_DAY_KEY, ENERGY_KEY_V2, LEGACY_ENERGY_KEY].sort());

    const result = resetStoredData();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sort()).toEqual([BILLING_DAY_KEY, ENERGY_KEY_V2, LEGACY_ENERGY_KEY].sort());
    expect(localStorage.getItem(ENERGY_KEY_V2)).toBeNull();
    expect(localStorage.getItem(LEGACY_ENERGY_KEY)).toBeNull();
    expect(localStorage.getItem(BILLING_DAY_KEY)).toBeNull();
    expect(localStorage.getItem('some_other_app')).toBe('keep-me');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(localStorage.length).toBe(2);
  });

  it('is a no-op on an empty store (never clears the whole origin)', () => {
    const result = resetStoredData();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});
