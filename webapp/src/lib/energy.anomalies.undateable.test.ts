/**
 * detectAnomalies must skip rows whose `dateObj` is not a date (F-QA2,
 * t_ab279a1b): the first loop indexes `dayStats` with `d.dateObj.getDay()`,
 * which is `NaN` for an undateable instant, `dayStats[NaN]` is `undefined`,
 * and the next line throws
 * `TypeError: Cannot read properties of undefined (reading 'sum')`.
 *
 * This is NOT the F4 situation. `buildHeatmapData` is fed
 * `filterByDateRange(...)`, which drops undateable rows first; BOTH dashboards
 * pass UNFILTERED `processedData` as this function's first argument
 * (`Dashboard.tsx:319`, `classic/Dashboard.tsx:299`), so one ingest-bound
 * regression throws on init in both surfaces (error boundary, not a hang).
 *
 * Unreachable at 8c4d767 — every writer of a row funnels through the ingest
 * bound `0 < ts < MAX_INTERVAL_START_S`, which is strictly stronger than
 * dateability. This file is the defensive half of the fix, pinned by both
 * signs of the undateable instant (the five shapes
 * `GasSection.outOfRangeStart.test.tsx` pins).
 *
 * RED control: delete the `Number.isNaN(d.dateObj.getTime())` skip in
 * detectAnomalies' `processedData` loop (`src/lib/energy.ts`) and every
 * hostile-shape case below fails with
 * `TypeError: Cannot read properties of undefined (reading 'sum')` at
 * `energy.ts:1720` — the `dayStats[dOW].sum` line, at its pristine line
 * number — filed by vitest under *Unhandled Errors*. Restore the skip and the
 * file is green again.
 *
 * The SECOND loop (`filteredData` → `dailyTotals`) is keyed by `d.dayStr`,
 * which for an undateable row is the string `"NaN-NaN-NaN"`, so it cannot
 * throw. It carries the same skip for consistency, and the
 * `filteredData`-side case below pins that loop's CONTRACT — that an undateable
 * row never becomes a spike. That case is green with or without the second
 * line, deliberately: today its safety is incidental (`expectedAvgs[NaN]` is
 * `undefined`, and `undefined > 0` is false, so the bucket can never pass the
 * `exp > 0` gate), and a spike carrying an Invalid Date would throw
 * `RangeError: Invalid time value` downstream at `AccountTriggers.tsx:63`
 * (`worst.date.toISOString()`), which both dashboards mount on init.
 */
import { describe, expect, it } from 'vitest';
import { detectAnomalies, processRawData } from './energy';
import type { DataPoint, ProcessedPoint, RateSet } from './energy';

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

/**
 * Fourteen normal days at 5 kWh (two full weeks — every weekday represented,
 * so `expectedAvgs` is 5 for ALL seven in ANY local timezone) plus one 50 kWh
 * day at noon: exactly one spike, and no healthy day near the 1.5× gate.
 */
const DAY0 = 1_704_067_200; // 2024-01-01T00:00:00Z
const NORMAL: DataPoint[] = Array.from({ length: 14 }, (_, i) => ({
  timestamp: DAY0 + i * 86_400,
  usage_kwh: 5,
}));
const SPIKE: DataPoint = { timestamp: DAY0 + 14 * 86_400 + 43_200, usage_kwh: 50 };
const BASE: DataPoint[] = [...NORMAL, SPIKE];

const processed = (rows: DataPoint[]): ProcessedPoint[] => processRawData(rows, [RATES]);

describe('detectAnomalies over undateable rows', () => {
  it.each(HOSTILE_STARTS)(
    'skips the %s row in processedData instead of throwing',
    (ts) => {
      const hostile: DataPoint = { timestamp: ts, usage_kwh: 1 };
      const rows = processed([hostile, ...BASE]);
      const anomalies = detectAnomalies(rows, rows);
      // The hostile row is invisible: output is identical to the healthy-only
      // run — exactly the one real spike — and the date it reports is a real
      // date (not an Invalid Date handed to `AccountTriggers` /
      // `fmtWeekdayDate`).
      expect(anomalies).toEqual(detectAnomalies(processed(BASE), processed(BASE)));
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].usage).toBe(50);
      expect(Number.isFinite(anomalies[0].date.getTime())).toBe(true);
    },
  );

  it.each(HOSTILE_STARTS)(
    'never lets the %s row in filteredData become a spike',
    (ts) => {
      const hostile: DataPoint = { timestamp: ts, usage_kwh: 1 };
      const clean = processed(BASE);
      const withHostile = processed([hostile, ...BASE]);
      // Same first argument, hostile row only on the dailyTotals side: the
      // output must be byte-identical to the healthy-only run — a row with no
      // calendar day has no day to bin, and none of its output may reach the
      // anomalies card.
      const expected = detectAnomalies(clean, clean);
      const actual = detectAnomalies(clean, withHostile);
      expect(actual).toEqual(expected);
      expect(actual).toHaveLength(1);
      expect(actual[0].date.getTime()).toBeGreaterThan(0);
    },
  );

  it('control: the healthy-only dataset reports exactly its one spike', () => {
    const clean = processed(BASE);
    const anomalies = detectAnomalies(clean, clean);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].usage).toBe(50);
    // `expectedAvgs` averages the WHOLE series, spike day included: the
    // three Mondays (two normals at 5 + this day at 50) sum 60 over 3
    // distinct dayStrs = 20, so 50 clears the 1.5× gate with diffPct 150.
    expect(anomalies[0].expected).toBe(20);
    expect(anomalies[0].diffPct).toBe(150);
  });
});
