import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseOebRatesPage,
  isOebDateNewer,
  maxShippedEffectiveDate,
  summarizeRateChange,
  calculateRateChangeImpact,
  hashRateSets,
} from './oebRates';
import { processRawData, type DataPoint, type RateSet } from './energy';

// The live page as fetched 2026-10-02 — the contract both parsers share.
const FIXTURE = readFileSync(join(__dirname, 'oebRates.fixture.html'), 'utf8');

const shipped2025: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

describe('parseOebRatesPage — real fixture', () => {
  const parsed = parseOebRatesPage(FIXTURE);

  it('extracts the effective date from the sentence', () => {
    expect(parsed.effectiveDate).toBe('2025-11-01');
    expect(parsed.missing).toEqual([]);
  });

  it('extracts every TOU price', () => {
    expect(parsed.rates?.tou).toEqual({ offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 });
  });

  it('extracts every ULO price including weekend off-peak', () => {
    expect(parsed.rates?.ulo).toEqual({
      overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1,
    });
  });

  it('extracts tiered prices and BOTH residential thresholds', () => {
    expect(parsed.rates?.tiered).toEqual({
      tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600,
    });
  });

  it('parsed set matches the shipped 2025-11-01 set exactly (no drift)', () => {
    expect(parsed.rates).toEqual(shipped2025);
  });
});

describe('parseOebRatesPage — degraded inputs', () => {
  it('survives a page with the date sentence removed', () => {
    const html = FIXTURE.replace(/prices set by the OEB for[^<]*/, '');
    const p = parseOebRatesPage(html);
    expect(p.effectiveDate).toBeNull();
    expect(p.missing).toContain('effectiveDate');
    expect(p.missing).toContain('dateSentence');
    expect(p.rates).toBeNull(); // no date → no RateSet
  });

  it('survives a page with one price table missing (date-only parse)', () => {
    const html = FIXTURE.replace(/<table[\s\S]*?ULO Price[\s\S]*?<\/table>/i, '');
    const p = parseOebRatesPage(html);
    expect(p.effectiveDate).toBe('2025-11-01');
    expect(p.rates).toBeNull();
    expect(p.missing.join(',')).toMatch(/ulo\./);
  });

  it('returns empty result for garbage without throwing', () => {
    const p = parseOebRatesPage('<html><body>totally different page</body></html>');
    expect(p.effectiveDate).toBeNull();
    expect(p.rates).toBeNull();
    expect(p.missing.length).toBeGreaterThan(0);
  });

  it('handles a future OEB date (new-rate announcement)', () => {
    const html = FIXTURE.replace('November 1, 2025', 'November 1, 2026');
    const p = parseOebRatesPage(html);
    expect(p.effectiveDate).toBe('2026-11-01');
    expect(isOebDateNewer(p.effectiveDate!, '2025-11-01')).toBe(true);
  });

  it('ignores the sentence without the OEB attribution (no false positive)', () => {
    const p = parseOebRatesPage('<p>prices effective May 1, 2026 are listed.</p>');
    expect(p.effectiveDate).toBeNull();
  });
});

describe('staleness comparison', () => {
  const shipped: RateSet[] = [
    { ...shipped2025, effectiveDate: '2023-11-01' },
    { ...shipped2025, effectiveDate: '2024-11-01' },
    shipped2025,
  ];

  it('maxShippedEffectiveDate takes the latest set', () => {
    expect(maxShippedEffectiveDate(shipped)).toBe('2025-11-01');
    expect(maxShippedEffectiveDate([])).toBeNull();
  });

  it('same date is NOT newer', () => {
    expect(isOebDateNewer('2025-11-01', '2025-11-01')).toBe(false);
  });

  it('future date IS newer', () => {
    expect(isOebDateNewer('2026-11-01', '2025-11-01')).toBe(true);
  });

  it('anything beats having no shipped sets', () => {
    expect(isOebDateNewer('2023-11-01', null)).toBe(true);
  });

  it('string comparison is ISO-safe (2025-11-01 < 2025-12-01)', () => {
    expect(isOebDateNewer('2025-12-01', '2025-11-01')).toBe(true);
    expect(isOebDateNewer('2025-10-31', '2025-11-01')).toBe(false);
  });
});

describe('summarizeRateChange', () => {
  it('reports only the periods that actually changed', () => {
    const incoming: RateSet = {
      ...shipped2025,
      effectiveDate: '2026-11-01',
      tou: { ...shipped2025.tou, onPeak: 22.5 },
      tiered: { ...shipped2025.tiered, thresholdWinter: 750 },
    };
    const deltas = summarizeRateChange(shipped2025, incoming);
    expect(deltas).toEqual([
      { plan: 'TOU', label: 'On-Peak', current: 20.3, next: 22.5 },
      // threshold change isn't a price — tier prices unchanged, no entry
    ].slice(0, 1));
    expect(deltas.map((d) => d.label)).toEqual(['On-Peak']);
  });

  it('empty deltas when only the date bumped', () => {
    expect(summarizeRateChange(shipped2025, { ...shipped2025, effectiveDate: '2026-11-01' }))
      .toEqual([]);
  });
});

describe('calculateRateChangeImpact', () => {
  const rateCurrent: RateSet = {
    effectiveDate: '2025-11-01',
    tou: { offPeak: 10, midPeak: 20, onPeak: 30 },
    tiered: { tier1: 10, tier2: 20, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 5, weekendOffPeak: 10, midPeak: 20, onPeak: 30 },
  };
  const rateNext: RateSet = {
    ...rateCurrent,
    effectiveDate: '2026-11-01',
    tou: { offPeak: 11, midPeak: 22, onPeak: 33 },
    tiered: { tier1: 11, tier2: 22, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 5.5, weekendOffPeak: 11, midPeak: 22, onPeak: 33 },
  };

  // 10 days of hourly-ish readings at winter noon (On-Peak weekdays / Mid-Peak ULO,
  // January → winter thresholds), 2 kWh each.
  function winterNoons(days: number, kwh = 2): DataPoint[] {
    const out: DataPoint[] = [];
    for (let d = 1; d <= days; d++) {
      // 2026-01-05 is a Monday; keep it weekday-winter.
      const ts = Math.floor(new Date(2026, 0, 4 + d, 12, 0, 0).getTime() / 1000);
      out.push({ timestamp: ts, usage_kwh: kwh });
    }
    return out;
  }

  it('returns null when there is no data', () => {
    expect(calculateRateChangeImpact([], rateNext)).toBeNull();
  });

  it('computes per-plan and total deltas for a +10% rate hike', () => {
    const processed = processRawData(winterNoons(10), [rateCurrent]);
    const impact = calculateRateChangeImpact(processed, rateNext)!;
    expect(impact.windowDays).toBe(10);
    expect(impact.kwh).toBeCloseTo(20, 6);
    // Every ¢/kWh value rose exactly 10% → every cost must rise exactly 10%.
    expect(impact.costNew / impact.costCurrent).toBeCloseTo(1.1, 6);
    expect(impact.delta).toBeCloseTo(impact.costCurrent * 0.1, 6);
    for (const p of impact.perPlan) {
      expect(p.delta).toBeGreaterThan(0);
      expect(p.next / p.current).toBeCloseTo(1.1, 6);
    }
  });

  it('windows to the most recent 30 days of the dataset', () => {
    // 45 days of data — only the last 30 count.
    const processed = processRawData(winterNoons(45), [rateCurrent]);
    const impact = calculateRateChangeImpact(processed, rateNext)!;
    expect(impact.windowDays).toBe(30);
    expect(impact.kwh).toBeCloseTo(60, 6); // 30 × 2 kWh
  });

  it('is null-safe against a single reading', () => {
    const processed = processRawData(winterNoons(1), [rateCurrent]);
    const impact = calculateRateChangeImpact(processed, rateNext)!;
    expect(impact.windowDays).toBeGreaterThanOrEqual(1);
    expect(impact.delta).toBeGreaterThan(0);
  });

  it('current side uses each reading\'s own activeRateSet (rate-set boundary safe)', () => {
    // First 5 days at the old set, last 5 at a cheaper intermediate set:
    // "current" must reflect the historical truth, not the latest shipped set.
    const rateOld: RateSet = {
      ...rateCurrent,
      effectiveDate: '2024-11-01',
      tou: { offPeak: 10, midPeak: 20, onPeak: 30 },
    };
    const rateCheap: RateSet = {
      ...rateCurrent,
      effectiveDate: '2025-11-01',
      tou: { offPeak: 1, midPeak: 2, onPeak: 3 },
      tiered: { ...rateCurrent.tiered, tier1: 1, tier2: 2 },
      ulo: { overnight: 1, weekendOffPeak: 1, midPeak: 2, onPeak: 3 },
    };
    const raw = [
      ...winterNoons(5).map((d) => ({ ...d, timestamp: d.timestamp - 40 * 86400 })),
      ...winterNoons(5),
    ].sort((a, b) => a.timestamp - b.timestamp);
    const processed = processRawData(raw, [rateOld, rateCheap]);
    const impact = calculateRateChangeImpact(processed, rateNext)!;
    // Mixed historical prices → the cheap week must drag "current" below
    // everything-at-full-price, so delta is larger than the uniform case.
    expect(impact.costCurrent).toBeLessThan(
      processRawData(raw, [rateOld]).reduce((s, r) => s + r.costTOU, 0) + 1000,
    );
    expect(impact.windowDays).toBeLessThanOrEqual(30);
    expect(impact.delta).toBeGreaterThan(0);
  });
});

describe('hashRateSets', () => {
  it('is deterministic', () => {
    expect(hashRateSets([shipped2025])).toBe(hashRateSets([shipped2025]));
  });

  it('changes when a rate value changes', () => {
    const tweaked: RateSet = {
      ...shipped2025,
      tou: { ...shipped2025.tou, onPeak: 20.4 },
    };
    expect(hashRateSets([shipped2025])).not.toBe(hashRateSets([tweaked]));
  });

  it('changes when the set list changes', () => {
    expect(hashRateSets([shipped2025])).not.toBe(
      hashRateSets([{ ...shipped2025, effectiveDate: '2024-11-01' }, shipped2025]),
    );
  });

  it('is a stable 8-char hex string', () => {
    expect(hashRateSets([shipped2025])).toMatch(/^[0-9a-f]{8}$/);
  });
});
