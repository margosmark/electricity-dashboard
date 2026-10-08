/**
 * Wave O — the money-visualisation logic, pinned against the committed
 * synthetic Oakville-shaped fixture (three 29-day periods whose sums are the
 * audit's published figures: $1,365.03 total · $311.61 delivery · $45.15
 * regulatory · $177.46 HST · −$320.78 rebate · $530.74 / $218.71 / $258.82
 * off/mid/on).
 *
 * The rules these tests exist to keep honest:
 *   • a stack's slices must ADD UP to the bill's own payable figure;
 *   • shares must add to 100% against a denominator that itself adds up;
 *   • the waterfall must land on the same payable figure, never a neighbour;
 *   • a delta table must never print a change against nothing;
 *   • the plan overlay must refuse to model periods it cannot see.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPeriodStacks,
  commodityWindowOf,
  hourCostProfile,
  periodDeltaRows,
  planOverlay,
  shareBreakdown,
  billWaterfall,
} from './moneyViz';
import { billedKwh, billTotals, billWindow, deriveExtraCharges, parseUsageSummaries, type ProcessedPoint, type RateSet } from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const summaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/**
 * One reading a day across a period, totalling `totalKwh` and priced by the
 * window the reading falls in — so the three plans cost three different
 * amounts, exactly as they would on a real meter.
 */
function rowsFor(summaryIndex: number): ProcessedPoint[] {
  const s = summaries[summaryIndex];
  const billed = billedKwh(s) ?? 0;
  const { start, end } = billWindow(s);
  const out: ProcessedPoint[] = [];
  const days = Math.max(1, Math.round((end - start) / 86400));
  for (let day = 0; day < days; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const timestamp = start + day * 86400 + hour * 3600;
      const d = new Date(timestamp * 1000);
      const usage = billed / (days * 24);
      // Classify by the SAME clock hour the bucket uses, or a fixture whose
      // reads start at an odd time would mix windows inside one bucket.
      const h = d.getUTCHours();
      const tou = h < 7 ? 'Off-Peak' : h < 16 ? 'Mid-Peak' : 'On-Peak';
      const ulo =
        h < 7 ? 'Overnight' : h < 16 ? 'Mid-Peak' : h < 21 ? 'On-Peak' : 'Weekend Off-Peak';
      const touRate = tou === 'Off-Peak' ? 9.8 : tou === 'Mid-Peak' ? 15.7 : 20.3;
      const uloRate =
        ulo === 'Overnight' ? 3.9 : ulo === 'Mid-Peak' ? 15.7 : ulo === 'On-Peak' ? 39.1 : 9.8;
      out.push({
        timestamp,
        usage_kwh: usage,
        dateObj: d,
        dayStr: d.toISOString().slice(0, 10),
        hourStr: `${String(h).padStart(2, '0')}:00`,
        touCategory: tou,
        uloCategory: ulo,
        isWinter: false,
        costTOU: (usage * touRate) / 100,
        // Tiered is a flat blend of its two tiers for this fixture — enough to
        // keep the three plans three different numbers.
        costTiered: (usage * 13.0) / 100,
        costULO: (usage * uloRate) / 100,
        activeRateSet: rateSet,
      });
    }
  }
  return out;
}

const allRows = [...rowsFor(0), ...rowsFor(1), ...rowsFor(2)];

describe('buildPeriodStacks', () => {
  const stacks = buildPeriodStacks(summaries, allRows);

  it('builds one stack per billing period, oldest first', () => {
    expect(stacks).toHaveLength(3);
    expect(stacks.map((s) => s.startDate)).toEqual(['2026-05-25', '2026-06-23', '2026-07-22']);
    expect(stacks.map((s) => s.days)).toEqual([29, 29, 29]);
  });

  it('splits the commodity into its own TOU windows', () => {
    const off = stacks.reduce((n, s) => n + s.cost.offPeak, 0);
    const mid = stacks.reduce((n, s) => n + s.cost.midPeak, 0);
    const on = stacks.reduce((n, s) => n + s.cost.onPeak, 0);
    // The fixture's published sums, to the cent.
    expect(off).toBeCloseTo(530.74, 2);
    expect(mid).toBeCloseTo(218.71, 2);
    expect(on).toBeCloseTo(258.82, 2);
    expect(stacks.every((s) => s.cost.commodityOther === 0)).toBe(true);
  });

  it('carries delivery / regulatory / HST / rebate and no stated-total line', () => {
    const sum = (k: 'delivery' | 'regulatory' | 'tax' | 'credit') =>
      stacks.reduce((n, s) => n + s.cost[k], 0);
    expect(sum('delivery')).toBeCloseTo(311.61, 2);
    expect(sum('regulatory')).toBeCloseTo(45.15, 2);
    expect(sum('tax')).toBeCloseTo(177.46, 2);
    expect(sum('credit')).toBeCloseTo(-320.78, 2);
    // The stacked slices must NOT include the stated total (double counting).
    for (const s of stacks) {
      const positive =
        s.cost.offPeak + s.cost.midPeak + s.cost.onPeak + s.cost.commodityOther +
        s.cost.delivery + s.cost.regulatory + s.cost.tax + s.cost.other;
      // Everything positive is exactly the bill's pre-rebate subtotal: the
      // stated total (pre-tax) plus HST, with the stated "Total Electricity
      // Charges" line deliberately NOT stacked — it would double the bar.
      expect(positive).toBeCloseTo(s.totals.preRebate, 2);
      expect(s.totals.total).toBeCloseTo(positive - s.totals.tax, 2);
      expect(positive + s.cost.credit).toBeCloseTo(s.totals.payable, 2);
    }
  });

  it("reads the bill's own per-window usage, and it matches billed kWh", () => {
    const withUsage = stacks.every((s) => s.usage !== null);
    expect(withUsage).toBe(true);
    for (const s of stacks) {
      const kwh = (s.usageTotal ?? 0);
      // buildPeriodStacks only ever builds billed stacks, so `summary` is set
      // (the axis's other kinds live in buildAxisStacks).
      expect(kwh).toBeCloseTo(billedKwh(s.summary!) ?? 0, 3);
      expect(kwh).toBeGreaterThan(0);
      // Off-peak is the biggest window in this fixture.
      expect(s.usage!.offPeak).toBeGreaterThan(s.usage!.onPeak);
    }
  });

  it('reports coverage from the readings, not from the bill', () => {
    expect(stacks.map((s) => Math.round(s.coverage * 100))).toEqual([100, 100, 100]);
    const none = buildPeriodStacks(summaries, []);
    expect(none.every((s) => s.coverage === 0)).toBe(true);
  });
});

describe('commodityWindowOf', () => {
  it('maps the utility’s own wording, and refuses to invent a window', () => {
    expect(commodityWindowOf('Off Peak-Summer')).toBe('offPeak');
    expect(commodityWindowOf('Mid Peak-Summer')).toBe('midPeak');
    expect(commodityWindowOf('On Peak-Summer')).toBe('onPeak');
    // A Tiered bill's line is not a peak line: it must not be coloured as one.
    expect(commodityWindowOf('Tiered Electricity')).toBe('commodityOther');
    expect(commodityWindowOf('Electricity')).toBe('commodityOther');
    // ULO's "Overnight" is not "on peak" (the word boundary is the test).
    expect(commodityWindowOf('Overnight')).toBe('commodityOther');
  });
});

describe('shareBreakdown', () => {
  const stacks = buildPeriodStacks(summaries, allRows);
  const share = shareBreakdown(stacks)!;

  it('answers the community question with this household’s own bill', () => {
    // 311.61 + 45.15 of 1365.03 + 177.46 charged (rebate excluded — it is
    // not a charge, it is money handed back).
    expect(share.nonCommodityPct).toBeCloseTo(23.13, 1);
    expect(share.commodityPct).toBeCloseTo(65.37, 1);
    expect(share.taxPct).toBeCloseTo(11.5, 1);
    expect(share.rebatePct).toBeCloseTo(20.8, 1);
    expect(share.payable).toBeCloseTo(1221.71, 2);
  });

  it('adds the positive shares to exactly 100%', () => {
    const total =
      share.commodityPct + share.deliveryPct + share.regulatoryPct + share.otherPct + share.taxPct;
    expect(total).toBeCloseTo(100, 6);
  });

  it('is null when there is nothing to share', () => {
    expect(shareBreakdown([])).toBeNull();
  });
});

describe('periodDeltaRows', () => {
  const stacks = buildPeriodStacks(summaries, allRows);

  it('labels the first period a baseline and changes only afterwards', () => {
    const table = periodDeltaRows(stacks);
    expect(table.hasComparison).toBe(true);
    expect(table.columns).toHaveLength(3);
    expect(table.rows.find((r) => r.key === 'payable')!.deltas[0]).toBeNull();
    const payable = table.rows.find((r) => r.key === 'payable')!;
    for (let i = 1; i < payable.values.length; i += 1) {
      expect(payable.deltas[i]).toBeCloseTo(payable.values[i] - payable.values[i - 1], 2);
    }
  });

  it('shows only the charge types this file actually has', () => {
    const keys = periodDeltaRows(stacks).rows.map((r) => r.key);
    expect(keys).toContain('offPeak');
    expect(keys).toContain('delivery');
    expect(keys).toContain('credit');
    expect(keys).toContain('total');
    expect(keys).toContain('payable');
    expect(keys).not.toContain('other');
  });

  it('says so, instead of faking a comparison, with a single period', () => {
    const table = periodDeltaRows(buildPeriodStacks(summaries.slice(0, 1), allRows));
    expect(table.hasComparison).toBe(false);
    expect(table.note).toMatch(/Only one billing period/i);
    expect(table.rows.every((r) => r.deltas[0] === null)).toBe(true);
  });
});

describe('hourCostProfile', () => {
  it('prices 24 buckets and lands on the kWh-weighted average', () => {
    const profile = hourCostProfile(allRows, 'TOU');
    expect(profile.ready).toBe(true);
    expect(profile.buckets).toHaveLength(24);
    const totalKwh = profile.buckets.reduce((n, b) => n + b.kwh, 0);
    const totalCost = profile.buckets.reduce((n, b) => n + b.cost, 0);
    expect(profile.averageCents).toBeCloseTo((totalCost / totalKwh) * 100, 6);
    // The fixture prices hours at 9.8 / 15.7 / 20.3¢ by window.
    const cheapest = Math.min(...profile.buckets.filter((b) => b.cents !== null).map((b) => b.cents!));
    const dearest = Math.max(...profile.buckets.filter((b) => b.cents !== null).map((b) => b.cents!));
    expect(cheapest).toBeCloseTo(9.8, 5);
    expect(dearest).toBeCloseTo(20.3, 5);
    expect(dearest).toBeGreaterThan(cheapest);
  });

  it('follows the plan on screen', () => {
    const tou = hourCostProfile(allRows, 'TOU').averageCents!;
    const tiered = hourCostProfile(allRows, 'Tiered').averageCents!;
    const ulo = hourCostProfile(allRows, 'ULO').averageCents!;
    expect(tou).not.toBe(tiered);
    expect(tou).not.toBe(ulo);
  });

  it('refuses to draw an empty window', () => {
    const profile = hourCostProfile([], 'TOU');
    expect(profile.ready).toBe(false);
    expect(profile.reason).toMatch(/No readings in the current window/i);
  });
});

describe('billWaterfall', () => {
  it('adds up to the bill’s own payable figure', () => {
    for (const summary of summaries) {
      const wf = billWaterfall(summary);
      expect(wf.ready).toBe(true);
      expect(wf.amountDue).toBeCloseTo(billTotals(summary).payable, 2);
      const last = wf.steps[wf.steps.length - 1];
      expect(last.kind).toBe('total');
      expect(last.value).toBeCloseTo(billTotals(summary).payable, 2);
    }
  });

  it('restates the utility’s own total, then tax and rebate land on payable', () => {
    const summary = summaries[0];
    const totals = billTotals(summary);
    const wf = billWaterfall(summary);
    const subtotal = wf.steps.find((s) => s.kind === 'subtotal')!;
    expect(subtotal.value).toBeCloseTo(totals.total, 2);
    const tax = wf.steps.find((s) => s.key === 'tax')!;
    expect(tax.base).toBeCloseTo(totals.total, 2);
    expect(tax.running).toBeCloseTo(totals.total + totals.tax, 2);
    const credit = wf.steps.find((s) => s.key === 'credit')!;
    expect(credit.value).toBeCloseTo(Math.abs(totals.credit), 2);
    // A falling step is drawn from its NEW level up to the old one.
    expect(credit.base + credit.value).toBeCloseTo(tax.running, 2);
    expect(credit.running).toBeCloseTo(tax.running + totals.credit, 2);
  });

  it('never draws a negative or floating bar', () => {
    for (const summary of summaries) {
      for (const step of billWaterfall(summary).steps) {
        expect(step.value).toBeGreaterThanOrEqual(0);
        expect(step.base).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('states a gap between the itemized lines and the stated total, not a shrug', () => {
    const summary = structuredClone(summaries[0]);
    // Nudge the stated total 5 bucks away from its own lines.
    const totalLine = summary.items.find((i) => i.note === 'Total Electricity Charges')!;
    totalLine.amount = (totalLine.amount ?? 0) + 5;
    totalLine.rawAmount = Math.round((totalLine.amount ?? 0) * 100000);
    const wf = billWaterfall(summary);
    const gap = wf.steps.find((s) => s.key === 'gap');
    expect(gap).toBeDefined();
    expect(gap!.value).toBeCloseTo(5, 2);
    // …and it still lands on the bill's own payable.
    expect(wf.amountDue).toBeCloseTo(billTotals(summary).payable, 2);
  });
});

describe('planOverlay', () => {
  const charges = deriveExtraCharges(summaries, allRows)!.charges;

  it('models all three plans over the periods it can actually see', () => {
    const overlay = planOverlay(summaries, allRows, charges);
    expect(overlay.ready).toBe(true);
    expect(overlay.covered).toBe(3);
    expect(overlay.lines.map((l) => l.plan).sort()).toEqual(['TOU', 'Tiered', 'ULO']);
    expect(overlay.actual).toBeCloseTo(1221.71, 2);
    // Every line is a full amount due, so they must all be in the same
    // neighbourhood as what was actually paid — not a commodity-only figure.
    for (const line of overlay.lines) {
      expect(line.amount).toBeGreaterThan(500);
      expect(line.amount).toBeLessThan(3000);
    }
    expect(overlay.chargesSource).toBe('bill');
    expect(overlay.rebateRate).toBeCloseTo(-0.235, 3);
    expect(overlay.assumptions.length).toBeGreaterThan(0);
  });

  it('returns the per-period figure the chart plots, next to the total', () => {
    const overlay = planOverlay(summaries, allRows, charges);
    expect(overlay.actualPerPeriod).toBeCloseTo(overlay.actual / overlay.covered, 2);
    for (const line of overlay.lines) {
      expect(line.perPeriod).toBeCloseTo(line.amount / overlay.covered, 2);
      // Same magnitude as a single bar — a whole-span total would be an
      // order of magnitude larger and Recharts would discard the line.
      expect(line.perPeriod).toBeGreaterThan(50);
      expect(line.perPeriod).toBeLessThan(2000);
    }
    expect(overlay.assumptions.some((a) => /PER-PERIOD average/i.test(a))).toBe(true);
  });

  it('prices Tiered with its month-scoped tier-2 threshold, like the plan cards', () => {
    const overlay = planOverlay(summaries, allRows, charges);
    const tiered = overlay.lines.find((l) => l.plan === 'Tiered')!;
    // ~7,900 kWh over three 29-day periods blows past the 600 kWh summer
    // threshold (scaled to the days covered), so most of it bills at tier 2
    // (14.2¢) and Tiered must model ABOVE what the TOU bill actually charged.
    // Summing the per-reading `costTiered` — which `processRawData` fills with
    // tier 1 only — lands ~$120 BELOW it, contradicting the plan cards and
    // Wave P's track record for the same periods.
    expect(tiered.amount).toBeGreaterThan(overlay.actual);
  });

  it('prices each plan off its own commodity cost', () => {
    const overlay = planOverlay(summaries, allRows, charges);
    const byPlan = Object.fromEntries(overlay.lines.map((l) => [l.plan, l.amount]));
    // These readings are priced at TOU rates, so TOU must model closest to
    // the real bill and the others must land somewhere sensible around it.
    expect(Math.abs(byPlan.TOU - overlay.actual)).toBeLessThan(
      Math.abs(byPlan.ULO - overlay.actual) + 200,
    );
    expect(new Set(overlay.lines.map((l) => l.amount)).size).toBe(3);
  });

  it('refuses to model periods the readings do not cover', () => {
    const overlay = planOverlay(summaries, [], charges);
    expect(overlay.ready).toBe(false);
    expect(overlay.covered).toBe(0);
    expect(overlay.reason).toMatch(/would be a guess/i);
  });

  it('refuses when there are no charge rates to model with', () => {
    const overlay = planOverlay(summaries, allRows, null);
    expect(overlay.ready).toBe(false);
    expect(overlay.reason).toMatch(/delivery/i);
  });

  it('has nothing to say about a file with no bills', () => {
    const overlay = planOverlay([], allRows, charges);
    expect(overlay.ready).toBe(false);
    expect(overlay.reason).toMatch(/no billing periods/i);
  });
});
