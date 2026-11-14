/**
 * Ingest bound for stored readings — the window the ESPI parser already
 * enforces (`greenbutton/series.ts` MAX_INTERVAL_START_S, same `<= 0 ||
 * >= MAX` rule and rationale) carried by the storage predicates themselves,
 * so an undateable instant never becomes a row: not on save, not through a
 * readings-only JSON import, not on read of a payload an older build
 * persisted, and not through a backup restore (which re-enters via
 * `saveEnergyData`). Closes F1–F4 of t_bcc1b9c6 at the source.
 *
 * The floor is pinned EXCLUSIVE 0: hand-made fixtures legitimately carry
 * `start: 1` (series.ts's own note) and must keep passing, while `0` means
 * "no time stated" — the parser refuses it at series.ts:843 and so does
 * this predicate.
 *
 * RED control: revert the bound in `isDataPoint`/`isGasPoint` and every
 * hostile-shape case below fails (the refused row is accepted) — no hang,
 * the assertion itself is the signal.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  ENERGY_KEY_V2,
  ENERGY_GAS_KEY,
  isDataPoint,
  isGasPoint,
  loadEnergyData,
  loadGasData,
  parseImport,
  saveEnergyData,
} from './storage';
import { MAX_INTERVAL_START_S } from './greenbutton/series';

/**
 * The five shapes `GasSection.outOfRangeStart.test.tsx` pins — every one a
 * finite number whose `new Date(ts * 1000)` is Invalid, both signs.
 */
const HOSTILE_STARTS = [
  1_000_000_000_000_000, // the card's reproducer: year 33 657 588
  -1_000_000_000_000_000, // the negative direction
  8_640_000_000_001, // one second past the +Date edge (8.64e15 ms)
  Number.MAX_SAFE_INTEGER,
  1e308, // finite, and `* 1000` overflows to Infinity
];

/** 2026-01-01T00:00:00Z — squarely inside the window. */
const HEALTHY = 1_767_286_800;

const payload = (points: unknown) =>
  JSON.stringify({ version: 2, uploadedAt: 'now', source: 'test', points });

const gasPayload = (points: unknown) =>
  JSON.stringify({ version: 1, uploadedAt: 'now', source: 'test', points });

beforeEach(() => {
  localStorage.clear();
});

describe('the predicate window (isDataPoint / isGasPoint)', () => {
  it('accepts a real instant and the parser\'s tiny-epoch fixtures', () => {
    expect(isDataPoint({ timestamp: HEALTHY, usage_kwh: 1 })).toBe(true);
    // `start: 1` is what hand-made fixtures carry — the floor must not eat it.
    expect(isDataPoint({ timestamp: 1, usage_kwh: 1 })).toBe(true);
    expect(isGasPoint({ timestamp: 1, duration_s: null, volume_m3: 1 })).toBe(true);
  });

  it('refuses timestamp 0 — "no time stated", not midnight 1970 (series.ts:843)', () => {
    expect(isDataPoint({ timestamp: 0, usage_kwh: 1 })).toBe(false);
    expect(isGasPoint({ timestamp: 0, duration_s: null, volume_m3: 1 })).toBe(false);
  });

  it('refuses AT the parser ceiling and accepts just below it', () => {
    expect(isDataPoint({ timestamp: MAX_INTERVAL_START_S - 1, usage_kwh: 1 })).toBe(true);
    expect(isDataPoint({ timestamp: MAX_INTERVAL_START_S, usage_kwh: 1 })).toBe(false);
    expect(isGasPoint({ timestamp: MAX_INTERVAL_START_S - 1, duration_s: null, volume_m3: 1 })).toBe(true);
    expect(isGasPoint({ timestamp: MAX_INTERVAL_START_S, duration_s: null, volume_m3: 1 })).toBe(false);
  });

  it.each(HOSTILE_STARTS)('refuses undateable instant %s on both commodities', (ts) => {
    expect(isDataPoint({ timestamp: ts, usage_kwh: 1 })).toBe(false);
    expect(isGasPoint({ timestamp: ts, duration_s: null, volume_m3: 1 })).toBe(false);
  });

  it('still refuses the non-finite and wrong-shape rows it always refused', () => {
    expect(isDataPoint({ timestamp: Number.NaN, usage_kwh: 1 })).toBe(false);
    expect(isDataPoint({ timestamp: '2026-01-01', usage_kwh: 1 } as unknown)).toBe(false);
    expect(isDataPoint({ timestamp: HEALTHY, usage_kwh: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isGasPoint({ timestamp: HEALTHY, duration_s: null, volume_m3: -1 })).toBe(false);
  });
});

describe('parseImport refuses undateable readings at ingest', () => {
  it.each(HOSTILE_STARTS)('the readings-only array form carrying %s comes back corrupt', (ts) => {
    const res = parseImport(JSON.stringify([{ timestamp: ts, usage_kwh: 1 }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('corrupt');
  });

  it.each(HOSTILE_STARTS)('the payload form carrying %s comes back corrupt', (ts) => {
    const res = parseImport(payload([{ timestamp: ts, usage_kwh: 1 }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('corrupt');
  });

  it('control: healthy and tiny-epoch imports still parse', () => {
    expect(parseImport(JSON.stringify([{ timestamp: HEALTHY, usage_kwh: 1 }])).ok).toBe(true);
    expect(parseImport(JSON.stringify([{ timestamp: 1, usage_kwh: 1 }])).ok).toBe(true);
    expect(parseImport(payload([{ timestamp: HEALTHY, usage_kwh: 1 }])).ok).toBe(true);
  });
});

describe('a payload already holding one is refused on read — init can never reach the window loop', () => {
  it.each(HOSTILE_STARTS)('stored payload with %s reads corrupt (F1 backstop at ingest)', (ts) => {
    localStorage.setItem(
      ENERGY_KEY_V2,
      payload([{ timestamp: ts, usage_kwh: 1 }, { timestamp: HEALTHY, usage_kwh: 2 }]),
    );
    const res = loadEnergyData();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('corrupt');
  });

  it('control: a healthy stored payload still loads', () => {
    localStorage.setItem(ENERGY_KEY_V2, payload([{ timestamp: HEALTHY, usage_kwh: 2 }]));
    const res = loadEnergyData();
    expect(res.ok).toBe(true);
    expect(res.ok && res.value?.points).toHaveLength(1);
  });

  it.each(HOSTILE_STARTS)('stored GAS payload with %s reads corrupt', (ts) => {
    localStorage.setItem(
      ENERGY_GAS_KEY,
      gasPayload([{ timestamp: ts, duration_s: null, volume_m3: 1 }]),
    );
    const res = loadGasData();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('corrupt');
  });

  it('control: a healthy stored gas payload still loads', () => {
    localStorage.setItem(ENERGY_GAS_KEY, gasPayload([{ timestamp: HEALTHY, duration_s: null, volume_m3: 1 }]));
    const res = loadGasData();
    expect(res.ok && res.value?.points).toHaveLength(1);
  });
});

describe('save refuses undateable rows', () => {
  it.each(HOSTILE_STARTS)('saveEnergyData([%s, healthy]) comes back corrupt', (ts) => {
    const res = saveEnergyData([{ timestamp: ts, usage_kwh: 1 }, { timestamp: HEALTHY, usage_kwh: 2 }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('corrupt');
  });

  it('control: a healthy save persists', () => {
    const res = saveEnergyData([{ timestamp: HEALTHY, usage_kwh: 1 }]);
    expect(res.ok).toBe(true);
    expect(localStorage.getItem(ENERGY_KEY_V2)).toContain(String(HEALTHY));
  });
});