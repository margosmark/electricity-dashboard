/**
 * Wave G item 1 — backup round-trip through the app's own hook.
 *
 * These tests exercise the real localStorage (jsdom), not a stub: the whole
 * point of the feature is that an Export → Import cycle reproduces the exact
 * keys the app boots from.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useEnergyData } from './useDashboard';
import { BACKUP_SCHEMA, parseBackup, serializeBackup, buildBackupDocument } from '@/lib/backup';
import type { DataPoint } from '@/lib/energy';
import { loadEnergyData, saveEnergyData, saveBillingDay } from '@/lib/storage';

const rows: DataPoint[] = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.25 },
  { timestamp: 1767225600, usage_kwh: 0.75 },
];

function seedStorage(overrides: { billingDay?: string; extraCharges?: string } = {}) {
  saveEnergyData(rows);
  saveBillingDay(Number(overrides.billingDay ?? '5'));
  localStorage.setItem(
    'extra_charges',
    overrides.extraCharges ??
      JSON.stringify({ deliveryPerKwh: '0.05', deliveryFlat: '12.50', regulatoryPerKwh: '0.0015', hstPct: '13' }),
  );
}

async function renderLoaded(onBackupApplied = vi.fn()) {
  const hook = renderHook(() => useEnergyData({ onBackupApplied }));
  await waitFor(() => expect(hook.result.current.rawData.length).toBe(rows.length));
  return { ...hook, onBackupApplied };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ historicalRates: [] }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('useEnergyData — export', () => {
  it('produces a versioned document that parses back to the stored rows', async () => {
    seedStorage();
    const { result, unmount } = await renderLoaded();
    let out: ReturnType<NonNullable<typeof result.current.exportBackup>>;
    act(() => {
      out = result.current.exportBackup()!;
    });
    unmount();

    expect(out!).not.toBeNull();
    const parsed = parseBackup(out!.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schema).toBe(BACKUP_SCHEMA);
    expect(parsed.value.payload.energy_data).toEqual(rows);
    expect(parsed.value.payload.billing_day).toBe(5);
    expect(parsed.value.payload.extra_charges.deliveryFlat).toBe('12.50');
    expect(out!.filename).toMatch(/^energy-backup_\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('returns null when there is nothing to export', async () => {
    const onBackupApplied = vi.fn();
    const hook = renderHook(() => useEnergyData({ onBackupApplied }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.rawData).toHaveLength(0);
    act(() => {
      expect(hook.result.current.exportBackup()).toBeNull();
    });
    expect(onBackupApplied).not.toHaveBeenCalled();
  });
});

describe('useEnergyData — import', () => {
  it('restores every key the app boots from and signals the caller', async () => {
    seedStorage();
    const { result, onBackupApplied } = await renderLoaded();

    // Wipe the profile the way a cleared browser would, then restore.
    localStorage.clear();
    const fresh: DataPoint[] = [{ timestamp: 1, usage_kwh: 9.9 }];
    const doc = buildBackupDocument({
      energyData: fresh,
      billingDay: 12,
      extraCharges: { deliveryPerKwh: '', deliveryFlat: '', regulatoryPerKwh: '', hstPct: '13' },
      exportedAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    const file = new File([serializeBackup(doc)], 'energy-backup_2026-10-02.json', {
      type: 'application/json',
    });

    let res: Awaited<ReturnType<NonNullable<typeof result.current.importBackupFile>>>;
    await act(async () => {
      res = await result.current.importBackupFile(file);
    });

    expect(res!).toEqual({ ok: true, filename: 'energy-backup_2026-10-02.json' });
    // The readings land under the versioned key — read them the way the
    // dashboard does on its next boot.
    const restored = loadEnergyData();
    expect(restored.ok && restored.value?.points).toEqual(fresh);
    expect(localStorage.getItem('energy_data')).toBeNull();
    expect(localStorage.getItem('billing_day')).toBe('12');
    expect(JSON.parse(localStorage.getItem('extra_charges')!)).toEqual({
      deliveryPerKwh: '',
      deliveryFlat: '',
      regulatoryPerKwh: '',
      hstPct: '13',
    });
    expect(onBackupApplied).toHaveBeenCalledTimes(1);
  });

  it('leaves storage untouched and reports the reason when the file is bad', async () => {
    seedStorage();
    const { result, onBackupApplied } = await renderLoaded();
    const before = {
      energy_data: localStorage.getItem('energy_data'),
      billing_day: localStorage.getItem('billing_day'),
      extra_charges: localStorage.getItem('extra_charges'),
    };

    const file = new File(['{"schema":"ontario-energy-optimizer.backup","version":99,"payload":{}}'], 'bad.json', {
      type: 'application/json',
    });
    let res: Awaited<ReturnType<NonNullable<typeof result.current.importBackupFile>>>;
    await act(async () => {
      res = await result.current.importBackupFile(file);
    });

    expect(res!.ok).toBe(false);
    expect(res!.error).toMatch(/newer version/i);
    expect(localStorage.getItem('energy_data')).toBe(before.energy_data);
    expect(localStorage.getItem('billing_day')).toBe(before.billing_day);
    expect(localStorage.getItem('extra_charges')).toBe(before.extra_charges);
    expect(onBackupApplied).not.toHaveBeenCalled();
  });
});

/* ==========================================================================
 * v3 — the gas dataset rides the backup too (t_578268b7):
 * gas-only export, dual-commodity export, and an old (gas-less) backup
 * restoring without touching what the gas keys hold.
 * ========================================================================== */

const GAS_STRING = JSON.stringify({
  version: 1,
  uploadedAt: '2026-11-01T00:00:00.000Z',
  source: 'gas-upload',
  points: [
    { timestamp: 1704067200, duration_s: 3600, volume_m3: 1.5 },
    { timestamp: 1704070800, duration_s: 3600, volume_m3: 0.75 },
  ],
});
const GAS_SUMMARIES_STRING = JSON.stringify([
  { source: 'UsageSummary', start: 1704067200, duration: 2592000, items: [], volume: null },
]);
const GAS_CLOCK_STRING = JSON.stringify({
  tzOffset: -18000,
  dstOffset: 3600,
  dstStartRule: null,
  dstEndRule: null,
});

function seedGas() {
  localStorage.setItem('energy_gas_v2', GAS_STRING);
  localStorage.setItem('gas_usage_summaries', GAS_SUMMARIES_STRING);
  localStorage.setItem('gas_local_time_parameters', GAS_CLOCK_STRING);
}

async function renderEmpty(onBackupApplied = vi.fn()) {
  const hook = renderHook(() => useEnergyData({ onBackupApplied }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { ...hook, onBackupApplied };
}

describe('useEnergyData — gas backup (t_578268b7)', () => {
  it('exports a gas-only browser instead of reporting nothing to back up', async () => {
    seedGas();
    const { result } = await renderEmpty();
    expect(result.current.rawData).toHaveLength(0);

    let out: ReturnType<NonNullable<typeof result.current.exportBackup>>;
    act(() => {
      out = result.current.exportBackup()!;
    });
    expect(out!).not.toBeNull();

    const parsed = parseBackup(out!.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.payload.energy_data).toEqual([]);
    expect(parsed.value.payload.gas_data).toEqual(JSON.parse(GAS_STRING));
    expect(parsed.value.payload.gas_usage_summaries).toHaveLength(1);
    expect(parsed.value.payload.gas_local_time_parameters).toEqual(JSON.parse(GAS_CLOCK_STRING));
    expect(out!.filename).toMatch(/^energy-backup_\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('a gas-only export → restore on a fresh browser reproduces all three gas keys byte for byte', async () => {
    seedGas();
    const { result, onBackupApplied } = await renderEmpty();
    let out: ReturnType<NonNullable<typeof result.current.exportBackup>>;
    act(() => {
      out = result.current.exportBackup()!;
    });

    // The cleared profile a fresh browser starts from.
    localStorage.clear();

    const file = new File([out!.text], out!.filename, { type: 'application/json' });
    let res: Awaited<ReturnType<NonNullable<typeof result.current.importBackupFile>>>;
    await act(async () => {
      res = await result.current.importBackupFile(file);
    });

    expect(res!).toEqual({ ok: true, filename: out!.filename });
    expect(localStorage.getItem('energy_gas_v2')).toBe(GAS_STRING);
    expect(localStorage.getItem('gas_usage_summaries')).toBe(GAS_SUMMARIES_STRING);
    expect(localStorage.getItem('gas_local_time_parameters')).toBe(GAS_CLOCK_STRING);
    // No empty electric dataset is invented for a gas-only profile.
    expect(localStorage.getItem('energy_data_v2')).toBeNull();
    expect(localStorage.getItem('energy_data')).toBeNull();
    expect(onBackupApplied).toHaveBeenCalledTimes(1);
  });

  it('a dual-commodity export → restore puts both halves back (gas byte for byte)', async () => {
    seedStorage();
    seedGas();
    const { result, onBackupApplied } = await renderLoaded();

    let out: ReturnType<NonNullable<typeof result.current.exportBackup>>;
    act(() => {
      out = result.current.exportBackup()!;
    });
    expect(out!).not.toBeNull();

    localStorage.clear();
    const file = new File([out!.text], out!.filename, { type: 'application/json' });
    let res: Awaited<ReturnType<NonNullable<typeof result.current.importBackupFile>>>;
    await act(async () => {
      res = await result.current.importBackupFile(file);
    });
    expect(res!.ok).toBe(true);

    // Gas: byte-identical to what the exporting browser stored.
    expect(localStorage.getItem('energy_gas_v2')).toBe(GAS_STRING);
    expect(localStorage.getItem('gas_usage_summaries')).toBe(GAS_SUMMARIES_STRING);
    expect(localStorage.getItem('gas_local_time_parameters')).toBe(GAS_CLOCK_STRING);
    // Electric: restored exactly as it was before this feature existed.
    const restored = loadEnergyData();
    expect(restored.ok && restored.value?.points).toEqual(rows);
    expect(localStorage.getItem('billing_day')).toBe('5');
    expect(onBackupApplied).toHaveBeenCalledTimes(1);
  });

  it('restoring an OLD (v2, gas-less) backup leaves existing gas data alone', async () => {
    seedStorage();
    seedGas();
    const { result, onBackupApplied } = await renderLoaded();
    const gasBefore = [
      localStorage.getItem('energy_gas_v2'),
      localStorage.getItem('gas_usage_summaries'),
      localStorage.getItem('gas_local_time_parameters'),
    ];

    // What a pre-v3 build exported: stamped version 2, no gas section in it.
    const oldDoc = {
      ...buildBackupDocument({
        energyData: [{ timestamp: 1, usage_kwh: 9.9 }],
        billingDay: 12,
        exportedAt: new Date('2026-10-02T12:00:00.000Z'),
      }),
      version: 2,
    };
    const file = new File([serializeBackup(oldDoc)], 'energy-backup_old.json', {
      type: 'application/json',
    });
    let res: Awaited<ReturnType<NonNullable<typeof result.current.importBackupFile>>>;
    await act(async () => {
      res = await result.current.importBackupFile(file);
    });
    expect(res!.ok).toBe(true);

    // The gas dataset is not deleted, not rewritten, not touched.
    expect([
      localStorage.getItem('energy_gas_v2'),
      localStorage.getItem('gas_usage_summaries'),
      localStorage.getItem('gas_local_time_parameters'),
    ]).toEqual(gasBefore);
    // …and the old file's own electric half still restores.
    const oldEnergy = loadEnergyData();
    expect(oldEnergy.ok && oldEnergy.value?.points).toEqual([{ timestamp: 1, usage_kwh: 9.9 }]);
    expect(localStorage.getItem('billing_day')).toBe('12');
    expect(onBackupApplied).toHaveBeenCalledTimes(1);
  });

  it('a lone gas clock is not a dataset — export still reports nothing to back up', async () => {
    localStorage.setItem('gas_local_time_parameters', GAS_CLOCK_STRING);
    const { result } = await renderEmpty();
    act(() => {
      expect(result.current.exportBackup()).toBeNull();
    });
  });
});
