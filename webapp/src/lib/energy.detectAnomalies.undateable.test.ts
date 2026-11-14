/**
 * F-QA2 (QA gate t_b7d99f51): `detectAnomalies` walks UNFILTERED
 * `processedData` from BOTH dashboards (`Dashboard.tsx` and
 * `classic/Dashboard.tsx`), so an undateable row reaches
 * `dayStats[d.dateObj.getDay()]` → `dayStats[NaN]` → undefined and the next
 * line throws `TypeError: Cannot read properties of undefined (reading
 * 'sum')`. Unlike `buildHeatmapData` (fed `filterByDateRange(...)` output),
 * this caller has no upstream filter — the F4 one-line skip
 * (`t_bcc1b9c6`) applies verbatim.
 *
 * Unreachable while the ingest bound holds (`isInInstantWindow`,
 * `storage.ts`: `0 < ts < MAX_INTERVAL_START_S`): no stored row can be
 * undateable. QA measured it real under the bound-reverted control as 5
 * uncaught exceptions (t_b7d99f51), so the skip is the defensive half for
 * any caller that bypasses the bound.
 *
 * Run: `npx vitest run src/lib/energy.detectAnomalies.undateable.test.ts`
 */
import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { detectAnomalies, type ProcessedPoint, type RateSet } from './energy';

const sampleRateSet: RateSet = {
  effectiveDate: '2023-01-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.4, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
};

/** A dateable `ProcessedPoint`, shaped exactly like `energy.test.ts`'s. */
function point(timestamp: number, usage_kwh: number): ProcessedPoint {
  const dateObj = new Date(timestamp * 1000);
  return {
    timestamp,
    usage_kwh,
    dateObj,
    dayStr: format(dateObj, 'yyyy-MM-dd'),
    hourStr: format(dateObj, 'HH:mm'),
    touCategory: 'Off-Peak',
    uloCategory: 'Overnight',
    isWinter: false,
    costTOU: 0,
    costTiered: 0,
    costULO: 0,
    activeRateSet: sampleRateSet,
  };
}

/**
 * The shape an undateable row has when it slips past the ingest bound: a
 * finite timestamp whose Date is Invalid, and the day key `utcDayKey`
 * stamps for it. Constructed directly (never through `format()`, which
 * would itself throw `RangeError` on the Invalid Date).
 */
function undateablePoint(timestamp: number, usage_kwh: number): ProcessedPoint {
  return { ...point(timestamp, usage_kwh), dateObj: new Date(NaN), dayStr: 'NaN-NaN-NaN' };
}

describe('detectAnomalies over a row whose instant is not a date (F-QA2)', () => {
  it('skips the undateable row instead of throwing on dayStats[NaN]', () => {
    const normal = Array.from({ length: 10 }, (_, i) => point(1704067200 + i * 86_400, 5.0));
    const spike = point(1_704_960_000, 50.0);
    const bad = undateablePoint(1704067200, 1.0);

    // RED control (measured t_b7d99f51): without the skip this line throws
    // `TypeError: Cannot read properties of undefined (reading 'sum')` —
    // `dayStats[NaN]` is undefined. The dateable rows must still be judged:
    // the spike is an anomaly with or without the hostile row present.
    const anomalies = detectAnomalies([...normal, spike, bad], [...normal, spike]);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0].usage).toBe(50.0);
  });

  it('a dataset of ONLY undateable rows returns [] rather than throwing', () => {
    const all = [0, 1, 2].map((i) => undateablePoint(1704067200 + i * 86_400, 5.0));
    expect(detectAnomalies(all, all)).toEqual([]);
  });
});
