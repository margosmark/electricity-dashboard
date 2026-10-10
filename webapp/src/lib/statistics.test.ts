/**
 * Wave S — efficiency statistics, test-first.
 *
 * The ¢/kWh numbers are checked against the SYNTHETIC fixture (the owner's
 * own export must never enter the repo — see tests/fixtures/README.md); the
 * same fixture reproduces the three-period money sums the data audit
 * published ($1,365.03 over 8,080 kWh), so the all-time assertion below is
 * the audited arithmetic, not a number made up for the test.
 *
 * The split (usage + delivery + rate ≡ observed, exactly) and the verdict
 * rules are checked on constructed periods, because the interesting behaviour
 * is the RULE, not any one dataset:
 *   • a slope inside its own standard error is flat — no hand-picked band;
 *   • the verdict reads the USAGE component — never the raw slope, and never
 *     the delivery/fixed-charge term (the regression test for the Wave S
 *     follow-through audit: on the owner's real export 96% of the slope the
 *     old two-way split called an improvement was that delivery term);
 *   • the split is additive to floating-point precision;
 *   • too few bills says so instead of guessing.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseUsageSummaries, type RateSet } from './energy';
import {
  TREND_MAX_PERIODS,
  TREND_MIN_PERIODS,
  buildEfficiency,
  directionOf,
  efficiencyPeriods,
  efficiencyTrend,
  fmtBand,
  fmtSigned,
  inViewCentsPerKwh,
  latestRateSet,
  linearFit,
  rateBoundaries,
  rateForUsageNote,
  verdictOf,
  weightedCentsPerKwh,
  type PeriodEfficiency,
} from './statistics';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);
const OAKVILLE = fs.readFileSync(
  path.join(FIXTURES, 'usage-summary-synthetic.xml'),
  'utf8',
);
const summaries = parseUsageSummaries(OAKVILLE);

const rates: RateSet[] = [
  {
    effectiveDate: '2026-01-01',
    tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
  },
];

/** Constructed periods: the rules are what is under test, not the dataset. */
function period(
  i: number,
  cents: number,
  usage: number | null = cents,
  rate: number | null = 0,
  delivery: number | null = 0,
): PeriodEfficiency {
  const month = String((i % 12) + 1).padStart(2, '0');
  return {
    start: Date.UTC(2024, i, 1) / 1000,
    startDate: `2024-${month}-01`,
    endDate: `2024-${month}-28`,
    label: `M${i}`,
    kwh: 1000,
    cost: cents * 10,
    cents,
    usageCents: usage,
    deliveryCents: delivery,
    rateCents: rate,
    unmappedKwh: 0,
    season: 'summer',
  };
}

describe('Wave S 1 — ¢/kWh per closed bill', () => {
  it('prices every bill from Total Electricity Charges ÷ billed kWh', () => {
    const periods = efficiencyPeriods(summaries, rates);
    expect(periods).toHaveLength(3);
    expect(periods.map((p) => p.startDate)).toEqual([
      '2026-05-25',
      '2026-06-23',
      '2026-07-22',
    ]);
    // $497.45/2,650 kWh, $403.58/2,790, $464.00/2,640.
    expect(periods.map((p) => p.cents)).toEqual([
      expect.closeTo(18.7717, 3),
      expect.closeTo(14.4652, 3),
      expect.closeTo(17.5758, 3),
    ]);
    expect(periods.map((p) => p.label)).toEqual(['May 2026', 'Jun 2026', 'Jul 2026']);
  });

  it('keeps the period kWh identical to billedKwh (same measurement lines)', () => {
    const periods = efficiencyPeriods(summaries, rates);
    expect(periods.map((p) => p.kwh)).toEqual([2650, 2790, 2640]);
    expect(periods.reduce((s, p) => s + p.kwh, 0)).toBe(8080);
  });

  it('skips a bill that states no usable usage rather than dividing by zero', () => {
    const broken = [
      {
        ...summaries[0],
        items: summaries[0].items.filter((i) => !/usage$/i.test(i.note.trim())),
      },
    ];
    expect(efficiencyPeriods(broken, rates)).toHaveLength(0);
  });

  it('sorts oldest first even when the file does not', () => {
    const flipped = [...summaries].reverse();
    const periods = efficiencyPeriods(flipped, rates);
    expect(periods.map((p) => p.startDate)).toEqual([
      '2026-05-25',
      '2026-06-23',
      '2026-07-22',
    ]);
  });
});

describe('Wave S 2 — all-time and in-view averages', () => {
  it('weights the all-time average by kWh, not by bill', () => {
    const all = weightedCentsPerKwh(efficiencyPeriods(summaries, rates));
    // 1,365.03 ÷ 8,080 kWh — the audit's own three-period arithmetic.
    expect(all).not.toBeNull();
    expect(all!.bills).toBe(3);
    expect(all!.kwh).toBe(8080);
    expect(all!.cents).toBeCloseTo(16.8939, 3);
    // Unweighted would be (18.77+14.47+17.58)/3 — the weight must move it.
    expect(all!.cents).not.toBeCloseTo((18.7717 + 14.4652 + 17.5758) / 3, 2);
  });

  it('scopes the in-view average to the selection', () => {
    const periods = efficiencyPeriods(summaries, rates);
    const july = inViewCentsPerKwh(periods, { start: '2026-08-01', end: '2026-08-31' });
    expect(july!.bills).toBe(1);
    expect(july!.cents).toBeCloseTo(17.5758, 3);

    const everything = inViewCentsPerKwh(periods, {
      start: '2026-01-01',
      end: '2026-12-31',
    });
    expect(everything!.bills).toBe(3);
    expect(everything!.cents).toBeCloseTo(16.8939, 3);
  });

  it('returns null outside any bills, and null with no view at all', () => {
    const periods = efficiencyPeriods(summaries, rates);
    expect(inViewCentsPerKwh(periods, { start: '2030-01-01', end: '2030-02-01' })).toBeNull();
    expect(inViewCentsPerKwh(periods, null)).toBeNull();
    expect(inViewCentsPerKwh([], { start: '2026-01-01', end: '2026-12-31' })).toBeNull();
  });
});

describe('Wave S 3 — the usage/rate/delivery split', () => {
  it('splits each bill so usage + delivery + rate recombines to observed exactly', () => {
    for (const p of efficiencyPeriods(summaries, rates)) {
      expect(p.usageCents).not.toBeNull();
      expect(p.deliveryCents).not.toBeNull();
      expect(p.rateCents).not.toBeNull();
      expect(p.usageCents! + p.deliveryCents! + p.rateCents!).toBeCloseTo(p.cents, 10);
    }
  });

  it('prices the counterfactual commodity at today’s rates, per category', () => {
    const [first] = efficiencyPeriods(summaries, rates);
    // Usage 1,800 off + 450 mid + 400 on at 9.8 / 15.7 / 20.3 ¢ = $328.25 over
    // 2,650 kWh — the USAGE component alone, delivery not folded in.
    expect(first.usageCents!).toBeCloseTo((328.25 / 2650) * 100, 3);
    // The bill's own non-commodity $114.40 is the DELIVERY component, kept
    // out of the verdict on purpose (the audit's whole finding).
    expect(first.deliveryCents!).toBeCloseTo((114.4 / 2650) * 100, 3);
    // The bill charged $383.05 of commodity — more than today's rates → the
    // rate component is positive (rates rose since), not negative. Same
    // 2.0679¢ the two-way split produced: the residual is untouched.
    expect(first.rateCents!).toBeCloseTo(2.0679, 3);
    expect(first.rateCents!).toBeGreaterThan(0);
  });

  it('voids the split (not the headline) when a usage note cannot be priced', () => {
    const weird = [
      {
        ...summaries[0],
        items: summaries[0].items.map((i) =>
          /off peak-summer usage/i.test(i.note) ? { ...i, note: 'Mystery Block Usage' } : i,
        ),
      },
    ];
    const [p] = efficiencyPeriods(weird, rates);
    expect(p.cents).toBeCloseTo(18.7717, 3);
    expect(p.usageCents).toBeNull();
    expect(p.deliveryCents).toBeNull();
    expect(p.rateCents).toBeNull();
    expect(p.unmappedKwh).toBeGreaterThan(0);
  });

  it('has no split at all without a rate set', () => {
    const [p] = efficiencyPeriods(summaries, null);
    expect(p.cents).toBeCloseTo(18.7717, 3);
    expect(p.usageCents).toBeNull();
    expect(p.deliveryCents).toBeNull();
    expect(p.rateCents).toBeNull();
  });

  it('maps the utility’s own category wording to a rate key', () => {
    const r = rates[0];
    expect(rateForUsageNote('Off Peak-Summer Usage', r)).toBe(9.8);
    expect(rateForUsageNote('Mid Peak-Winter Usage', r)).toBe(15.7);
    expect(rateForUsageNote('On Peak-Summer', r)).toBe(20.3);
    expect(rateForUsageNote('BLOCK 1 - Winter Usage', r)).toBe(12.0);
    expect(rateForUsageNote('BLOCK 2 - Summer Usage', r)).toBe(14.2);
    // ULO's labels contain "off-peak" — they must not land on the TOU key.
    expect(rateForUsageNote('Weekend Off-Peak Usage', r)).toBe(9.8);
    expect(rateForUsageNote('Overnight Usage', r)).toBe(3.9);
    expect(rateForUsageNote('Something We Do Not Know Usage', r)).toBeNull();
  });

  it('takes the newest rate set as "today"', () => {
    expect(latestRateSet([])).toBeNull();
    expect(latestRateSet(null)).toBeNull();
    expect(latestRateSet(rates)!.effectiveDate).toBe('2026-01-01');
    expect(
      latestRateSet([
        { ...rates[0], effectiveDate: '2024-11-01' },
        { ...rates[0], effectiveDate: '2025-11-01' },
      ])!.effectiveDate,
    ).toBe('2025-11-01');
  });
});

describe('Wave S 4 — regression and the no-massage verdict', () => {
  it('fits a straight line exactly', () => {
    const fit = linearFit([10, 9, 8, 7, 6, 5]);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(-1, 10);
    expect(fit!.intercept).toBeCloseTo(10, 10);
    expect(fit!.stderr).toBeCloseTo(0, 10);
  });

  it('refuses to invent a fit from two points', () => {
    expect(linearFit([10, 9])).toBeNull();
    expect(linearFit([])).toBeNull();
  });

  it('calls a slope flat when it sits inside its own standard error', () => {
    // Alternating noise: slope −0.09, stderr 0.14 → not a trend.
    const fit = linearFit([10, 9, 10, 9, 10, 9])!;
    expect(Math.abs(fit.slope)).toBeLessThan(fit.stderr);
    expect(directionOf(fit)).toBe('flat');
    expect(verdictOf(fit)).toBe('stable');
  });

  it('reads the direction, not just the sign', () => {
    expect(directionOf(linearFit([10, 9, 8, 7, 6, 5]))).toBe('down');
    expect(verdictOf(linearFit([5, 6, 7, 8, 9, 10]))).toBe('worsening');
    expect(verdictOf(linearFit([10, 9, 8, 7, 6, 5]))).toBe('improving');
  });

  it('formats slopes with an explicit sign and bands without one', () => {
    expect(fmtSigned(0.21)).toBe('+0.2');
    expect(fmtSigned(-0.157)).toBe('-0.2');
    expect(fmtSigned(-0.04)).toBe('0.0');
    expect(fmtBand(-0.133)).toBe('0.1');
  });
});

describe('Wave S 5 — the trend report', () => {
  it('splits a mixed trend: usage improving, rates rising, delivery flat, net flat', () => {
    // Twelve periods summing to a flat 19¢: usage −0.2¢/period, rate
    // +0.2¢/period, delivery a constant 4¢ that must not move the verdict.
    const periods = Array.from({ length: 12 }, (_, i) =>
      period(i, 19, 16 - 0.2 * i, -1 + 0.2 * i, 4),
    );
    const t = efficiencyTrend(periods, rates);
    expect(t.ready).toBe(true);
    expect(t.windowSize).toBe(12);
    expect(t.windowLabel).toBe('your last 12 bills');
    expect(t.splitAvailable).toBe(true);
    expect(t.usage!.slope).toBeCloseTo(-0.2, 10);
    expect(t.delivery!.slope).toBeCloseTo(0, 10);
    expect(t.rate!.slope).toBeCloseTo(+0.2, 10);
    expect(t.net!.slope).toBeCloseTo(0, 10);
    expect(t.verdict).toBe('improving');
    expect(t.netVerdict).toBe('stable');
    expect(t.rateDirection).toBe('up');
    expect(t.deliveryDirection).toBe('flat');
    expect(t.sentence).toBe(
      'Your usage mix improved (-0.2¢/kWh behavior-driven), but rates rose (+0.2¢/kWh); delivery & fixed charges flat (±0.0¢) — net stable ±0.0¢.',
    );
  });

  it('never credits the user with a rate-driven improvement', () => {
    // Observed falling purely because RATES fell: usage flat, rate down.
    const periods = Array.from({ length: 6 }, (_, i) =>
      period(i, 21 - 0.3 * i, 20, -2 - 0.3 * i, 3),
    );
    const t = efficiencyTrend(periods, rates);
    expect(t.usage!.slope).toBeCloseTo(0, 10);
    expect(t.verdict).toBe('stable');
    expect(t.rateDirection).toBe('down');
    expect(t.sentence).toContain('usage mix is flat');
    expect(t.sentence).toContain('rates fell');
  });

  it('never credits the user with a DELIVERY-driven improvement either', () => {
    // The audit finding, as a rule: observed falling because the fixed charge
    // spread over a summer's worth of kWh — usage flat, delivery collapsing.
    // The old two-way split reported this as "your usage mix improved"; the
    // verdict must now stay on usage and put delivery beside it.
    const periods = Array.from({ length: 12 }, (_, i) =>
      period(i, 16 - 0.25 * i, 12, 0, 4 - 0.25 * i),
    );
    const t = efficiencyTrend(periods, rates);
    expect(t.usage!.slope).toBeCloseTo(0, 10);
    expect(t.delivery!.slope).toBeCloseTo(-0.25, 10);
    expect(t.net!.slope).toBeCloseTo(-0.25, 10);
    expect(t.netVerdict).toBe('improving');
    expect(t.verdict).toBe('stable');
    expect(t.deliveryDirection).toBe('down');
    expect(t.sentence).toContain('usage mix is flat');
    expect(t.sentence).toContain('delivery & fixed charges fell (-0.2¢/kWh)'); // fmtSigned rounds -0.25 → -0.2
  });

  it('caps the window at the newest 12 periods', () => {
    const periods = Array.from({ length: 20 }, (_, i) => period(i, 10 + i * 0.5));
    const t = efficiencyTrend(periods, rates);
    expect(t.points).toHaveLength(20);
    expect(t.windowSize).toBe(TREND_MAX_PERIODS);
    expect(t.window[0].start).toBe(periods[20 - TREND_MAX_PERIODS].start);
    expect(t.window[t.window.length - 1].start).toBe(periods[19].start);
    // 0.5¢/period over the window → worsening, and the fit sees exactly that.
    expect(t.verdict).toBe('worsening');
    expect(t.usage!.slope).toBeCloseTo(0.5, 10);
    expect(t.net!.slope).toBeCloseTo(0.5, 10);
  });

  it('says so instead of guessing when there are too few bills', () => {
    const t = efficiencyTrend([period(0, 16), period(1, 15), period(2, 14)], rates);
    expect(t.ready).toBe(false);
    expect(t.emptyMessage).toMatch(
      new RegExp(`at least ${TREND_MIN_PERIODS} closed bills.*you have 3`),
    );
    expect(t.sentence).toBeNull();

    const none = efficiencyTrend([], rates);
    expect(none.ready).toBe(false);
    expect(none.emptyMessage).toMatch(/upload/i);
  });

  it('still earns a net verdict when the split is off, and says why', () => {
    const periods = Array.from({ length: 6 }, (_, i) =>
      period(i, 10 + i, null, null, null),
    );
    const t = efficiencyTrend(periods, rates);
    expect(t.ready).toBe(true);
    expect(t.splitAvailable).toBe(false);
    expect(t.splitNote).toBeTruthy();
    expect(t.usage).toBeNull();
    expect(t.delivery).toBeNull();
    // Headline falls back to the observed fit — it never invents a split.
    expect(t.verdict).toBe('worsening');
    expect(t.sentence).toContain(t.splitNote as string);
  });

  it('lists the rate changes that fall inside the loaded span', () => {
    const periods = efficiencyPeriods(summaries, rates);
    expect(rateBoundaries(periods, rates)).toEqual([]);

    // The fixture bills run 2026-05-25 → 2026-08-20: the two changes INSIDE
    // that span make the list, the one before the first bill and the one
    // after the last do not (a change needs readings on both sides to have
    // "happened" for this dataset).
    const wide = [
      { ...rates[0], effectiveDate: '2025-11-01' },
      { ...rates[0], effectiveDate: '2026-06-01' },
      { ...rates[0], effectiveDate: '2026-07-01' },
      { ...rates[0], effectiveDate: '2026-08-21' },
    ];
    expect(rateBoundaries(periods, wide)).toEqual([
      '2026-06-01',
      '2026-07-01',
    ]);
    expect(rateBoundaries([], wide)).toEqual([]);
  });
});

describe('Wave S 6 — the whole report', () => {
  it('wires periods + all-time + in-view + trend in one call', () => {
    const report = buildEfficiency({
      summaries,
      rates,
      view: { start: '2026-08-01', end: '2026-08-31' },
    });
    expect(report.periods).toHaveLength(3);
    expect(report.allTime!.cents).toBeCloseTo(16.8939, 3);
    expect(report.inView!.cents).toBeCloseTo(17.5758, 3);
    // Three bills is below the trend floor: the stat stands, the verdict waits.
    expect(report.trend.ready).toBe(false);
    expect(report.trend.emptyMessage).toMatch(/at least 4 closed bills/);
  });

  it('reports nothing but an honest empty state with no bills at all', () => {
    const report = buildEfficiency({ summaries: [], rates: null });
    expect(report.periods).toHaveLength(0);
    expect(report.allTime).toBeNull();
    expect(report.inView).toBeNull();
    expect(report.trend.ready).toBe(false);
    expect(report.trend.emptyMessage).toMatch(/upload/i);
  });
});
