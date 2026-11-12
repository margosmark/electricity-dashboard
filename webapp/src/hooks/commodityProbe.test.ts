/**
 * Commodity isolation acceptance (t_8a9038d6) — both uploads must survive,
 * in EITHER order, across a reload, with overlapping timestamps intact.
 *
 * This file replaced the reproduction probe: on today's main each of these
 * flows wiped the other commodity's dataset (electric→gas left
 * `energy_data_v2` at 0 points; gas→electric replaced every gas bill).
 * The assertions below are the FIXED contract, driven through the real
 * `handleFileUpload` path — not the storage primitives alone, because the
 * defect lived in how the hook routed a parsed feed, not in storage.ts.
 *
 * SYNTHETIC FIXTURES ONLY — tests/fixtures/ (never real utility documents).
 * Run: npx vitest run src/hooks/commodityProbe.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ChangeEvent } from 'react';

import { parseGreenButtonFeed } from '@/lib/energy';
import { enrichGasSummaries, isGasFeed } from '@/lib/gasBillUi';
import {
  ENERGY_GAS_KEY,
  ENERGY_KEY_V2,
  loadEnergyData,
  loadGasData,
} from '@/lib/storage';
import {
  useEnergyData,
  readStoredBillFeed,
  readStoredGasBillFeed,
  USAGE_SUMMARIES_KEY,
  GAS_USAGE_SUMMARIES_KEY,
} from '@/hooks/useDashboard';

const read = (name: string): string =>
  readFileSync(join(__dirname, '../../tests/fixtures', name), 'utf8');

const ELEC_XML = read('green-button-alliance-sample.xml');
const GAS_XML = read('enbridge-gas-synthetic.xml');

const countRows = (gs: { readings: unknown[] }[]): number =>
  gs.reduce((n, g) => n + g.readings.length, 0);

/** Drive one file through the hook's real upload path. */
async function upload(
  result: { current: ReturnType<typeof useEnergyData> },
  xml: string,
  name: string,
): Promise<void> {
  const file = new File([xml], name, { type: 'application/xml' });
  act(() => {
    result.current.handleFileUpload({
      target: { files: [file] },
    } as unknown as ChangeEvent<HTMLInputElement>);
  });
  await waitFor(() => expect(result.current.parsing).toBe(false), { timeout: 10_000 });
}

/** What the browser would hold after a fresh page load. */
type StoredState = {
  electricPoints: number;
  gasPoints: number;
  electricBills: number;
  gasBills: number;
  electricIsGasFeed: boolean;
  gasIsGasFeed: boolean;
};

function storedState(): StoredState {
  const elec = loadEnergyData();
  const gas = loadGasData();
  const bills = readStoredBillFeed();
  const gasBills = readStoredGasBillFeed();
  return {
    electricPoints: elec.ok && elec.value ? elec.value.points.length : -1,
    gasPoints: gas.ok && gas.value ? gas.value.points.length : -1,
    electricBills: bills.summaries.length,
    gasBills: gasBills.summaries.length,
    electricIsGasFeed: isGasFeed(bills.summaries),
    gasIsGasFeed: isGasFeed(gasBills.summaries),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('commodity probe — synthetic fixtures only', () => {
  it('reports the shapes both fixtures parse to', () => {
    const gas = parseGreenButtonFeed(GAS_XML);
    const elec = parseGreenButtonFeed(ELEC_XML);
    const gasVolumeRows = gas.groups.reduce(
      (n, g) => n + (g.series ?? []).reduce((m, s) => m + (s.status === 'volume' ? s.readings.length : 0), 0),
      0,
    );
    expect(countRows(gas.groups)).toBe(0); // no priced kWh in a gas extract
    expect(gasVolumeRows).toBe(5);
    expect(isGasFeed(gas.summaries)).toBe(true);
    expect(countRows(elec.groups)).toBe(216);
    expect(elec.summaries.length).toBeGreaterThan(0);
  });

  it('ORDER electric → gas: both datasets survive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ historicalRates: [] }) }));
    const { result } = renderHook(() => useEnergyData());

    await upload(result, ELEC_XML, 'electric.xml');
    expect(result.current.rawData).toHaveLength(216);
    expect(result.current.commodity).toBe('electricity');

    await upload(result, GAS_XML, 'gas.xml');
    await waitFor(() => expect(result.current.gasData.length).toBeGreaterThan(0));

    const after = storedState();
    // The reproduction was: 0 electric points, bills replaced by gas.
    expect(after.electricPoints).toBe(216);
    expect(after.gasPoints).toBe(5);
    expect(after.electricBills).toBeGreaterThan(0);
    expect(after.electricIsGasFeed).toBe(false); // no gas period on the electric side
    expect(after.gasBills).toBe(10);
    expect(after.gasIsGasFeed).toBe(true);
    // The gas upload opened the section it filled.
    expect(result.current.commodity).toBe('gas');
    // Keys are disjoint and both present.
    expect(localStorage.getItem(ENERGY_KEY_V2)).not.toBeNull();
    expect(localStorage.getItem(ENERGY_GAS_KEY)).not.toBeNull();
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).not.toBeNull();
    expect(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY)).not.toBeNull();
  }, 30_000);

  it('ORDER gas → electric: both datasets survive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ historicalRates: [] }) }));
    const { result } = renderHook(() => useEnergyData());

    await upload(result, GAS_XML, 'gas.xml');
    await waitFor(() => expect(result.current.gasData.length).toBeGreaterThan(0));
    expect(result.current.commodity).toBe('gas');

    await upload(result, ELEC_XML, 'electric.xml');
    await waitFor(() => expect(result.current.rawData.length).toBeGreaterThan(0));

    const after = storedState();
    // The reproduction was: gas bills wiped by the electric replace.
    expect(after.electricPoints).toBe(216);
    expect(after.gasPoints).toBe(5);
    expect(after.electricBills).toBeGreaterThan(0);
    expect(after.electricIsGasFeed).toBe(false);
    expect(after.gasBills).toBe(10);
    expect(after.gasIsGasFeed).toBe(true);
    expect(result.current.commodity).toBe('electricity'); // opened what it filled
  }, 30_000);

  it('a reload (fresh hook) reads BOTH datasets back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ historicalRates: [] }) }));
    const first = renderHook(() => useEnergyData());
    await upload(first.result, ELEC_XML, 'electric.xml');
    await upload(first.result, GAS_XML, 'gas.xml');
    await waitFor(() => expect(first.result.current.gasData.length).toBeGreaterThan(0));

    // Simulated reload: a brand-new hook instance seeded from storage only.
    const second = renderHook(() => useEnergyData());
    await waitFor(() => expect(second.result.current.rawData).toHaveLength(216));
    expect(second.result.current.gasData).toHaveLength(5);
    expect(second.result.current.billFeed.summaries.length).toBeGreaterThan(0);
    expect(second.result.current.gasBillFeed.summaries).toHaveLength(10);
    // The selected section survives the reload too.
    expect(second.result.current.commodity).toBe('gas');
  }, 30_000);

  it('electricity and gas may share a timestamp without deduping each other', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ historicalRates: [] }) }));
    const { result } = renderHook(() => useEnergyData());
    await upload(result, ELEC_XML, 'electric.xml');
    await upload(result, GAS_XML, 'gas.xml');
    await waitFor(() => expect(result.current.gasData.length).toBeGreaterThan(0));

    // Force an overlap: the first gas interval adopts an electric timestamp.
    const elec = loadEnergyData();
    const gas = loadGasData();
    expect(elec.ok).toBe(true);
    expect(gas.ok).toBe(true);
    if (!elec.ok || !gas.ok || !elec.value || !gas.value) return;
    const clashTs = elec.value.points[0].timestamp;
    const clashing = gas.value.points.map((p, i) =>
      i === 0 ? { ...p, timestamp: clashTs } : p,
    );
    const { saveGasData } = await import('@/lib/storage');
    expect(saveGasData(clashing, { source: 'test' }).ok).toBe(true);

    const after = storedState();
    expect(after.electricPoints).toBe(216); // untouched by the gas write
    expect(after.gasPoints).toBe(5);
    // Both lists still hold their own row AT THE SAME timestamp.
    const elecAgain = loadEnergyData();
    const gasAgain = loadGasData();
    if (!elecAgain.ok || !gasAgain.ok || !elecAgain.value || !gasAgain.value) return;
    expect(elecAgain.value.points.some((p) => p.timestamp === clashTs)).toBe(true);
    expect(gasAgain.value.points.some((p) => p.timestamp === clashTs)).toBe(true);
  }, 30_000);
});
