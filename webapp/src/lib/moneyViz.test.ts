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
  COST_SLICE_META,
  buildPeriodStacks,
  commodityWindowOf,
  hourCostProfile,
  periodDeltaRows,
  planOverlay,
  shareBreakdown,
  billWaterfall,
} from './moneyViz';
import {
  billedKwh,
  billTotals,
  billWindow,
  deriveExtraCharges,
  parseUsageSummaries,
  type BillLineItem,
  type ProcessedPoint,
  type RateSet,
  type UsageSummary,
} from './energy';

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

  it('maps a Tiered bill to its own tier, spacing variants and all', () => {
    // The real 24-period export writes BOTH spacings inside one bill:
    // "BLOCK 1 - Winter" and "BLOCK 1- Summer". Same signature, same tier.
    expect(commodityWindowOf('BLOCK 1 - Winter')).toBe('tier1');
    expect(commodityWindowOf('BLOCK 1- Summer')).toBe('tier1');
    expect(commodityWindowOf('BLOCK 2 - Summer')).toBe('tier2');
    expect(commodityWindowOf('Tier 1')).toBe('tier1');
    expect(commodityWindowOf('Tier 2')).toBe('tier2');
    // …and it must not see a tier where the note names none. "Tiered" has no
    // block number, "Tier 25" is not tier 1, and a peak line that happens to
    // mention a tier is still a peak line.
    expect(commodityWindowOf('Tiered Electricity')).toBe('commodityOther');
    expect(commodityWindowOf('Block 10')).toBe('commodityOther');
    expect(commodityWindowOf('Off Peak-Summer')).toBe('offPeak');
    // The usage lines carry the same notes — the split is for MONEY; the kWh
    // side folds them back (see usageKeyOf below).
    expect(commodityWindowOf('BLOCK 1 - Winter Usage')).toBe('tier1');
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

/* ==========================================================================
 * Tiered periods — the commodity split into Tier 1 / Tier 2
 * ========================================================================== */

/**
 * A line the way an Oakville TIERED bill carries it: a priced BLOCK line, or
 * a BLOCK "… Usage" measurement line (uom 72 = kWh). Money is in dollars
 * already; `rawAmount` is what the file would have sent.
 */
const tline = (
  note: string,
  dollars: number | null = null,
  kwh: number | null = null,
): BillLineItem => ({
  note,
  amount: dollars,
  rawAmount: dollars === null ? null : Math.round(dollars * 100000),
  itemKind: 10,
  unitCost: null,
  measurement:
    kwh === null
      ? null
      : { scaled: kwh, value: Math.round(kwh * 1e6), powerOfTenMultiplier: -6, uom: 72 },
});

/** A UsageSummary with no read-date lines, so billWindow = billingPeriod. */
function tieredSummary(startDate: string, days: number, items: BillLineItem[]): UsageSummary {
  const start = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
  const duration = days * 86400;
  const end = new Date((start + duration) * 1000);
  return {
    source: 'UsageSummary',
    start,
    duration,
    startDate,
    endDate: end.toISOString().slice(0, 10),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null, volume: null,
    items,
  };
}

/**
 * The three Tiered shapes the real 24-period export bills with, inlined the
 * way planTimeline.test.ts inlines the BLOCK notes (the export itself never
 * enters this repo). Every figure is the bill's OWN note → amount pair, and
 * each checks out as rate × kWh:
 *
 *   9.3¢ × 631     = $58.68   BLOCK 1- Summer   (Sep 2025)
 *  11.0¢ × 828.6   = $91.14   BLOCK 2 - Summer  (Sep 2025)
 *  12.0¢ × 762     = $91.44   BLOCK 1 - Winter  (Oct 2025)
 *   9.3¢ × 98      =  $9.11   BLOCK 1- Summer   (Oct 2025, same bill)
 *  11.0¢ × 58.8    =  $6.47   BLOCK 2 - Summer  (Oct 2025, same bill)
 *
 * so BLOCK 1 is the CHEAP tier and BLOCK 2 the dear one — the mapping is
 * rate-verified, not a convention anybody has to remember.
 */
const NOV_2024 = tieredSummary('2024-11-25', 29, [
  tline('BLOCK 1 - Winter', 85.69),
  tline('BLOCK 1 - Winter Usage', 0, 921.4),
  tline('Delivery', 47.31),
  tline('H.S.T. # 869177972', 17.4),
]);

const SEP_2025 = tieredSummary('2025-09-25', 32, [
  tline('BLOCK 1- Summer', 58.68),
  tline('BLOCK 2 - Summer', 91.14),
  tline('BLOCK 1- Summer Usage', 0, 631),
  tline('BLOCK 2 - Summer Usage', 0, 828.6),
  tline('Delivery', 60.06),
]);

const OCT_2025 = tieredSummary('2025-10-27', 29, [
  tline('BLOCK 2 - Summer', 6.47),
  tline('BLOCK 1 - Winter', 91.44),
  tline('BLOCK 1- Summer', 9.11),
  // The odd one out: a wording that names no block number. It must land in
  // `commodityOther`, never be guessed into whichever tier is closest.
  tline('Tiered Electricity', 3.5),
  tline('BLOCK 1 - Winter Usage', 0, 762),
  tline('BLOCK 1- Summer Usage', 0, 98),
  tline('BLOCK 2 - Summer Usage', 0, 58.8),
  tline('Delivery', 57.81),
]);

describe('Tiered periods — Tier 1 / Tier 2, not one undifferentiated pile', () => {
  const stacks = buildPeriodStacks([NOV_2024, SEP_2025, OCT_2025], []);

  it('puts every BLOCK line in its own tier, spacing variants and all', () => {
    expect(stacks[0].cost.tier1).toBeCloseTo(85.69, 2);
    expect(stacks[0].cost.tier2).toBe(0);
    expect(stacks[1].cost.tier1).toBeCloseTo(58.68, 2);
    expect(stacks[1].cost.tier2).toBeCloseTo(91.14, 2);
    // Both BLOCK 1 lines of the Oct bill are tier 1 — 91.44 + 9.11. Dropping
    // the summer one would silently lose $9.11 of the bill's own commodity.
    expect(stacks[2].cost.tier1).toBeCloseTo(100.55, 2);
    expect(stacks[2].cost.tier2).toBeCloseTo(6.47, 2);
    expect(stacks[2].cost.commodityOther).toBeCloseTo(3.5, 2);
    expect(stacks.every((s) => s.cost.offPeak + s.cost.midPeak + s.cost.onPeak === 0)).toBe(true);
  });

  it('still adds up to the bill’s own commodity, to the cent', () => {
    // The invariant Wave O exists for: the split must be a SPLIT, not a
    // reinterpretation. Tiers + the leftovers = exactly what billTotals says
    // the electricity itself cost, for every period.
    for (const s of stacks) {
      const commodity =
        s.cost.offPeak + s.cost.midPeak + s.cost.onPeak +
        s.cost.tier1 + s.cost.tier2 + s.cost.commodityOther;
      expect(commodity).toBeCloseTo(billTotals(s.summary!).commodity, 2);
      expect(commodity).toBeGreaterThan(0);
    }
  });

  it('keeps the kWh stack on its four windows — tier usage folds into commodity', () => {
    expect(stacks[1].usage).not.toBeNull();
    expect(stacks[1].usage!.commodityOther).toBeCloseTo(631 + 828.6, 3);
    expect(stacks[1].usageTotal).toBeCloseTo(1459.6, 3);
    expect(stacks[1].usage!.offPeak).toBe(0);
    // The tier split is about MONEY; the billed kWh total is unchanged.
    expect(stacks[1].usageTotal).toBeCloseTo(billedKwh(SEP_2025) ?? 0, 3);
  });

  it('names the two rows the way the table prints them', () => {
    expect(COST_SLICE_META.tier1.label).toBe('Tier 1');
    expect(COST_SLICE_META.tier2.label).toBe('Tier 2');
    expect(COST_SLICE_META.tier1.color).not.toBe(COST_SLICE_META.tier2.color);
  });

  it('keeps sharing the bill honestly with tiers in the denominator', () => {
    const share = shareBreakdown(stacks)!;
    const total =
      share.commodityPct + share.deliveryPct + share.regulatoryPct + share.otherPct + share.taxPct;
    expect(total).toBeCloseTo(100, 6);
    // Commodity is the electricity itself: every BLOCK dollar is in here.
    expect(share.commodityPct).toBeGreaterThan(50);
  });
});

describe('periodDeltaRows — Tiered periods next to a TOU one', () => {
  // summaries[0] of the committed fixture is TOU: its columns carry no tier
  // money at all, which is exactly the shape Mark's mixed file has — TOU
  // periods keep their off/mid/on-peak rows, and the tier rows read zero
  // there (the component turns a zero tier cell into a dash).
  const stacks = buildPeriodStacks([summaries[0], SEP_2025, OCT_2025], []);
  const table = periodDeltaRows(stacks);
  const tier1 = table.rows.find((r) => r.key === 'tier1');
  const tier2 = table.rows.find((r) => r.key === 'tier2');

  it('gives the delta table a Tier 1 and a Tier 2 row', () => {
    expect(tier1).toBeDefined();
    expect(tier2).toBeDefined();
    expect(tier1!.label).toBe('Tier 1');
    expect(tier2!.label).toBe('Tier 2');
    // …and the odd-wording bucket survives as its own row when a file has one.
    expect(table.rows.map((r) => r.key)).toContain('commodityOther');
  });

  it('prints each Tiered period’s own figures and leaves the TOU one at zero', () => {
    // Zero, not a missing row: the UI renders a zero tier cell as a dash, so
    // a TOU column can never claim "you were charged nothing on tier 1" and a
    // Tiered column still shows the real dollars.
    expect(tier1!.values).toEqual([0, 58.68, 100.55]);
    expect(tier2!.values).toEqual([0, 91.14, 6.47]);
    expect(tier1!.deltas[0]).toBeNull();
    expect(tier1!.deltas[1]).toBeCloseTo(58.68, 2);
    expect(tier2!.deltas[1]).toBeCloseTo(91.14, 2);
    // Tier 1 after Sep: both BLOCK 1 lines of the Oct bill, 100.55 − 58.68.
    expect(tier1!.deltas[2]).toBeCloseTo(41.87, 2);
    expect(tier2!.deltas[2]).toBeCloseTo(-84.67, 2);
  });

  it('does not lose a cent of a Tiered period’s commodity in the split', () => {
    const other = table.rows.find((r) => r.key === 'commodityOther')!;
    const commodity = (i: number) => tier1!.values[i] + tier2!.values[i] + other.values[i];
    // Sep 2025: the two BLOCK lines ARE the whole commodity.
    expect(commodity(1)).toBeCloseTo(58.68 + 91.14, 2);
    // Oct 2025: both BLOCK 1 lines + BLOCK 2 + the odd wording, which is the
    // bill's own commodity figure — dropping the summer BLOCK 1 line (a
    // plausible-looking shortcut) would be $9.11 short of it.
    expect(commodity(2)).toBeCloseTo(91.44 + 9.11 + 6.47 + 3.5, 2);
    expect(commodity(2)).toBeCloseTo(billTotals(OCT_2025).commodity, 2);
  });
});
