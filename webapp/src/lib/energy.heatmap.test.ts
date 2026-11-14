/**
 * buildHeatmapData must skip rows whose `dateObj` is not a date (F4,
 * t_bcc1b9c6): `grid[NaN]` is `undefined`, so the next line throws
 * `TypeError: Cannot read properties of undefined (reading 'NaN')`.
 *
 * NOT reachable through the app today — `Dashboard.tsx:330` feeds it
 * `filterByDateRange(...)`, which drops undateable rows first — so this is
 * the defensive half of the fix: a caller that forgets the filter still
 * gets a grid instead of a crash, and the skip is pinned by both signs of
 * the undateable instant.
 *
 * RED control: revert the validity skip in `buildHeatmapData` and every
 * hostile-shape case fails with the TypeError (not a RangeError — the
 * defect class here is the un-binned index).
 */
import { describe, expect, it } from 'vitest';
import { buildHeatmapData, processRawData } from './energy';
import type { DataPoint, RateSet } from './energy';

/**
 * The five shapes `GasSection.outOfRangeStart.test.tsx` pins — every one a
 * finite number whose `new Date(ts * 1000)` is Invalid, both signs.
 */
const HOSTILE_STARTS = [
  1_000_000_000_000_000,
  -1_000_000_000_000_000,
  8_640_000_000_001,
  Number.MAX_SAFE_INTEGER,
  1e308,
];

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** One healthy reading (2026-01-01T00:00:00Z) beside the hostile one. */
const HEALTHY: DataPoint = { timestamp: 1_767_286_800, usage_kwh: 2 };

const binned = (rows: ReturnType<typeof processRawData>) =>
  buildHeatmapData(rows).grid.flat().filter((cell) => cell.count > 0);

describe('buildHeatmapData over undateable rows', () => {
  it.each(HOSTILE_STARTS)('skips the %s row instead of throwing', (ts) => {
    const data = buildHeatmapData(processRawData([{ timestamp: ts, usage_kwh: 1 }, HEALTHY], [RATES]));
    // Only the healthy row lands in a cell — one weekday-hour, one reading.
    const cells = data.grid.flat().filter((cell) => cell.count > 0);
    expect(cells).toHaveLength(1);
    expect(cells[0].count).toBe(1);
    expect(cells[0].days).toBe(1);
    expect(Number.isFinite(data.maxAvg)).toBe(true);
    expect(data.maxAvg).toBeGreaterThan(0);
  });

  it('control: a healthy-only dataset bins exactly its own rows', () => {
    const data = buildHeatmapData(processRawData([HEALTHY], [RATES]));
    expect(binned(processRawData([HEALTHY], [RATES]))).toHaveLength(1);
    expect(data.grid.flat().reduce((n, c) => n + c.count, 0)).toBe(1);
  });
});