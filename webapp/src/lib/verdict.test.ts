import { describe, it, expect } from 'vitest';
import { buildVerdict, formatDelta, switchPhrase } from './verdict';

const COSTS = { TOU: 120, Tiered: 100, ULO: 140 };

describe('buildVerdict', () => {
  it('returns null when there is nothing to judge', () => {
    expect(buildVerdict(null, 'TOU', 30)).toBeNull();
  });

  it('names the cheapest plan and the spread between best and worst', () => {
    const v = buildVerdict(COSTS, 'TOU', 30)!;
    expect(v.best).toBe('Tiered');
    expect(v.worst).toBe('ULO');
    expect(v.bestLabel).toBe('Tiered');
    expect(v.spread).toBe(40);
    expect(v.currentCost).toBe(120);
  });

  it('reports the gap the current plan pays over the winner', () => {
    const v = buildVerdict(COSTS, 'TOU', 30)!;
    expect(v.delta).toBeCloseTo(20, 10);
    expect(v.alreadyBest).toBe(false);
    expect(v.deltaPerMonth).toBeCloseTo((20 / 30) * 30.44, 6);
  });

  it('says so when the household is already on the winner', () => {
    const v = buildVerdict(COSTS, 'Tiered', 30)!;
    expect(v.alreadyBest).toBe(true);
    expect(v.delta).toBe(0);
    expect(v.deltaPerMonth).toBe(0);
  });

  it('normalises a short window to a month rather than quoting a 2-day gap', () => {
    const twoDays = buildVerdict(COSTS, 'TOU', 2)!;
    const month = buildVerdict(COSTS, 'TOU', 30)!;
    // Same $20 gap measured over fewer days is a much bigger monthly claim.
    expect(twoDays.deltaPerMonth).toBeCloseTo(20 * 15.22, 4);
    expect(twoDays.deltaPerMonth).toBeGreaterThan(month.deltaPerMonth * 10);
    expect(twoDays.days).toBe(2);
  });

  it('never divides by a zero or nonsense window', () => {
    for (const days of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = buildVerdict(COSTS, 'TOU', days)!;
      expect(v.days).toBe(1);
      expect(Number.isFinite(v.deltaPerMonth)).toBe(true);
    }
  });

  it('keeps ties deterministic (first plan in TOU/Tiered/ULO order wins)', () => {
    const tie = { TOU: 100, Tiered: 100, ULO: 100 };
    expect(buildVerdict(tie, 'ULO', 30)!.best).toBe('TOU');
    expect(buildVerdict(tie, 'ULO', 30)!.worst).toBe('TOU');
  });
});

describe('formatDelta', () => {
  it('always signs the number so a saving never reads as a charge', () => {
    expect(formatDelta(45.1)).toBe('$45.10');
    expect(formatDelta(0)).toBe('$0.00');
    expect(formatDelta(-3)).toBe('$3.00');
  });
});

describe('switchPhrase', () => {
  it('spells out the switch the verdict is recommending', () => {
    const v = buildVerdict(COSTS, 'TOU', 30)!;
    expect(switchPhrase(v, 'TOU')).toBe('Time-of-Use → Tiered');
  });
});
