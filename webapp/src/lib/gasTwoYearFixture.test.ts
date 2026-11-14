/**
 * The two-year gas fixture's contract (t_a2343a2f) — the file the monthly /
 * year-over-year / money e2e smokes import, pinned through the REAL parser:
 *
 *  1. shape: 24 monthly UsageSummary blocks, 2025-01-25 → 2026-12-25, all
 *     recognised as gas, all stating a billed volume and an Amount Due;
 *  2. money identity: supply + delivery + regulatory + HST == Total Gas
 *     Charges == Amount Due for every period (the fixture is internally
 *     consistent, so the app never has to invent a figure to render it);
 *  3. the builder sees what the e2e asserts: billed source, 24 monthly
 *     rows, a READY year-over-year (24-month span) with both years whole.
 *
 * Command: `npx vitest run src/lib/gasTwoYearFixture.test.ts`
 *
 * FIXTURE POLICY: SYNTHETIC only (generate-enbridge-gas-twoyear-fixture.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyBillLine, parseGreenButtonFeed, type BillLineClass, type UsageSummary } from './energy';
import { enrichGasSummaries, gasMoney, gasVolume, isGasSummary } from './gasBillUi';
import { buildGasMonthly, buildGasYearOverYear } from './gasMonthly';
import { extractGasPoints } from './commodity';

const XML = readFileSync(
  join(__dirname, '../../tests/fixtures/enbridge-gas-twoyear-synthetic.xml'),
  'utf8',
);

const FEED = parseGreenButtonFeed(XML);
const SUMMARIES = enrichGasSummaries(FEED);

const bucketSum = (s: UsageSummary, classes: readonly BillLineClass[]): number =>
  s.items
    .filter((i) => i.amount !== null && classes.includes(classifyBillLine(i)))
    .reduce((a, i) => a + (i.amount as number), 0);

describe('enbridge-gas-twoyear-synthetic.xml — fixture contract', () => {
  it('parses to 24 gas periods spanning 2025-01-25 → 2026-12-25', () => {
    expect(SUMMARIES).toHaveLength(24);
    expect(SUMMARIES.every(isGasSummary)).toBe(true);
    expect(SUMMARIES[0].startDate).toBe('2025-01-25');
    expect(SUMMARIES[23].startDate).toBe('2026-12-25');
    // One period per month, in order — the monthly table's 24 rows.
    const keys = SUMMARIES.map((s) => s.startDate.slice(0, 7));
    expect(new Set(keys).size).toBe(24);
    expect(keys[0]).toBe('2025-01');
    expect(keys[11]).toBe('2025-12');
    expect(keys[12]).toBe('2026-01');
    expect(keys[23]).toBe('2026-12');
  });

  it('every period states a billed volume and an Amount Due', () => {
    for (const s of SUMMARIES) {
      expect(gasVolume(s).billed, `${s.startDate} billed volume`).toBeGreaterThan(0);
      expect(gasMoney(s).amountDue, `${s.startDate} Amount Due`).toBeGreaterThan(0);
      expect(gasMoney(s).delta, `${s.startDate} delta`).toBe(0);
    }
  });

  it('money identity holds 24/24: charge lines == Total == Amount Due', () => {
    for (const s of SUMMARIES) {
      const buckets = bucketSum(s, ['commodity', 'delivery', 'regulatory', 'tax']);
      const m = gasMoney(s);
      expect(m.total, `${s.startDate} Total`).not.toBeNull();
      expect(buckets, `${s.startDate} 5-term identity`).toBeCloseTo(m.total as number, 2);
      expect(m.amountDue, `${s.startDate} Amount Due == Total`).toBeCloseTo(
        m.total as number,
        2,
      );
    }
  });

  it('carries one metered reading per period: 24 gas points, 24 rows, READY YoY', () => {
    // The import gate needs ≥1 IntervalReading; a real interval-enabled
    // extract carries one metered volume per period — so with points the
    // declared chart source is `interval`, and the billed columns still sit
    // beside it in the table.
    const points = extractGasPoints(FEED.groups);
    expect(points).toHaveLength(24);
    const monthly = buildGasMonthly(points, SUMMARIES);
    expect(monthly.source).toBe('interval');
    expect(monthly.rows).toHaveLength(24);
    expect(monthly.rows.every((r) => r.intervalM3 !== null)).toBe(true);
    expect(monthly.hasPaid).toBe(true);

    const yoy = buildGasYearOverYear(monthly);
    expect(yoy.ready).toBe(true);
    expect(yoy.spanMonths).toBe(24);
    expect(yoy.monthsOfData).toBe(24);
    expect(yoy.series.map((s) => s.year)).toEqual([2025, 2026]);
    // 2026 vs 2025 delta row with twelve comparable months.
    expect(yoy.deltas).toHaveLength(1);
    expect(yoy.deltas[0].pct.every((p) => p !== null)).toBe(true);
    // Whole years: every month present, first bill starts on the 25th →
    // 2025's edge month is partial; 2026 ends in 2027 → fully covered.
    expect(yoy.yearTotals.map((t) => [t.year, t.months])).toEqual([
      [2025, 12],
      [2026, 12],
    ]);
    expect(yoy.partialMonths).toContain('2025-01');
    expect(yoy.partialMonths).not.toContain('2026-12');
  });
});
