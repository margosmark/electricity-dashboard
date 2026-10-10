/**
 * Wave S follow-through — the split against the OWNER's real 2-year export.
 *
 * The export itself never enters the repo (tests/fixtures/README.md); this
 * file is inert unless you point it at the file yourself:
 *
 *   WAVE_S_XML=/path/to/export.xml npx vitest run src/lib/statistics.realdata.test.ts
 *
 * Every number asserted here is the one published by the INDEPENDENT Python
 * audit (evidence/wave-s-split-hygiene.py — ElementTree over the raw XML, no
 * webapp code), so a disagreement between the two parsers shows up as a test
 * failure instead of as two parsers agreeing with themselves.
 *
 * What it pins down (kanban t_fee3d256):
 *   • the three components recombine to the observed ¢/kWh exactly;
 *   • bills priced at today's rate set carry a ZERO rate component, and older
 *     bills carry exactly their price delta — an OEB rate change is counted
 *     once and only once;
 *   • the VERDICT reads the usage component, which is flat on this data
 *     (−0.006¢/period inside a 0.033¢ error bar) — the old two-way split
 *     reported "IMPROVING −0.2¢" here off the delivery term alone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

import { parseUsageSummaries, type RateSet } from './energy';
import { buildEfficiency } from './statistics';

const XML = process.env.WAVE_S_XML;
const describeReal = XML ? describe : describe.skip;

/** The two OEB sets inside the billed span, as the deployed app carries them. */
const RATES: RateSet[] = [
  {
    effectiveDate: '2025-11-01',
    tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
  },
  {
    effectiveDate: '2024-11-01',
    tou: { offPeak: 7.6, midPeak: 12.2, onPeak: 15.8 },
    tiered: { tier1: 9.3, tier2: 11.0, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 2.8, weekendOffPeak: 7.6, midPeak: 12.2, onPeak: 28.4 },
  },
];

describeReal('split hygiene on the owner’s real export', () => {
  // Built lazily inside each test: `describe.skip` still evaluates the body,
  // and the export path is undefined in every run not pointed at the file.
  const report = () =>
    buildEfficiency({
      summaries: parseUsageSummaries(fs.readFileSync(XML!, 'utf8')),
      rates: RATES,
      view: null,
    });

  it('carries the 24 closed bills the audit counted', () => {
    const { periods, allTime } = report();
    expect(periods).toHaveLength(24);
    expect(allTime!.bills).toBe(24);
  });

  it('recombines usage + delivery + rate to the observed ¢/kWh exactly', () => {
    for (const p of report().periods) {
      expect(p.usageCents).not.toBeNull();
      expect(p.deliveryCents).not.toBeNull();
      expect(p.rateCents).not.toBeNull();
      expect(p.usageCents! + p.deliveryCents! + p.rateCents!).toBeCloseTo(p.cents, 9);
    }
  });

  it('counts an OEB price change exactly once — the rate component', () => {
    const { periods } = report();
    // Every bill read on/after 2025-11-01 was billed at today's set: zero.
    const after = periods.filter((p) => p.startDate >= '2025-11-01');
    expect(after.length).toBeGreaterThanOrEqual(8);
    for (const p of after) expect(Math.abs(p.rateCents!)).toBeLessThan(0.001);

    // The pre-change bills carry their price delta, and it is NOT zero.
    const before = periods.filter((p) => p.startDate < '2025-11-01');
    expect(before.some((p) => Math.abs(p.rateCents!) > 1)).toBe(true);
    // Aug 2025: billed 7.6/12.2/15.8 against today's 9.8/15.7/20.3 → −2.76¢.
    const aug2025 = periods.find((p) => p.startDate === '2025-08-26')!;
    expect(aug2025.rateCents).toBeCloseTo(-2.761, 2);
  });

  it('reproduces the audit’s three slopes and keeps the verdict on usage', () => {
    const trend = report().trend;
    expect(trend.ready).toBe(true);
    expect(trend.windowSize).toBe(12);
    // net +0.0552, usage −0.0061 (±0.033), delivery −0.1508, rate +0.2122.
    expect(trend.net!.slope).toBeCloseTo(0.0552, 3);
    expect(trend.usage!.slope).toBeCloseTo(-0.0061, 2);
    expect(trend.rate!.slope).toBeCloseTo(0.2122, 2);
    expect(trend.delivery!.slope).toBeCloseTo(-0.1508, 2);
    // The three recombine to the net slope.
    expect(
      trend.usage!.slope + trend.delivery!.slope + trend.rate!.slope,
    ).toBeCloseTo(trend.net!.slope, 3);

    // THE fix: usage is inside its own error bar → stable, and the delivery
    // term that drove the old "IMPROVING −0.2¢" claim is reported beside it.
    expect(trend.verdict).toBe('stable');
    expect(Math.abs(trend.usage!.slope)).toBeLessThanOrEqual(trend.usage!.stderr);
    // 'down' = ¢/kWh falling — the direction the delivery term moved.
    expect(trend.deliveryDirection).toBe('down');
  });
});
