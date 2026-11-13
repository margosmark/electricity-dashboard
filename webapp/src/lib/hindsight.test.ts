/**
 * Wave V (corrected) — the HINDSIGHT engine: what another PLAN would have cost
 * for a closed bill, on the SAME metered readings.
 *
 * Two things this file is deliberately strict about:
 *
 *  1. Everything runs against readings built by the real `processRawData` (not
 *     hand-stamped categories), so the TOU/ULO windows, the Ontario holiday
 *     rule and the per-reading rate-set versioning are the app's own — a test
 *     that hand-set `touCategory` would agree with itself and prove nothing.
 *  2. It pins the SCOPE, not just the numbers: the report carries no behaviour,
 *     load-shift or hypothetical-usage surface at all, and every repriced
 *     figure is recomputed here independently from the same readings at their
 *     own timestamps and quantities.
 *
 * The real 2-year and 3-month exports never enter this repo (privacy rule):
 * they are exercised by the deployed browser check, which pins their sha256
 * before use.
 */

import { describe, it, expect } from 'vitest';

import {
  billTotals,
  planCostFor,
  processRawData,
  type BillLineItem,
  type DataPoint,
  type ProcessedPoint,
  type RateSet,
  type UsageSummary,
} from './energy';
import { buildSwitchReport, type PlanTimelineEntry } from './planTimeline';
import { MIN_SAVING, buildHindsight } from './hindsight';

/* -------------------------------------------------------------------------- *
 * Rates — the app's own three shipped sets
 * -------------------------------------------------------------------------- */

const RATES_2024: RateSet = {
  effectiveDate: '2024-11-01',
  tou: { offPeak: 7.6, midPeak: 12.2, onPeak: 15.8 },
  tiered: { tier1: 9.3, tier2: 11.0, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 2.8, weekendOffPeak: 7.6, midPeak: 12.2, onPeak: 28.4 },
};
const RATES_2025: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};
/** A deliberately different set so a season flip has something to flip TO. */
const RATES_2026: RateSet = {
  effectiveDate: '2026-11-01',
  tou: { offPeak: 10.5, midPeak: 16.8, onPeak: 21.7 },
  tiered: { tier1: 12.6, tier2: 14.9, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 4.2, weekendOffPeak: 10.5, midPeak: 16.8, onPeak: 41.0 },
};

const RATE_HISTORY = [RATES_2026, RATES_2025, RATES_2024];

/* -------------------------------------------------------------------------- *
 * Builders
 * -------------------------------------------------------------------------- */

const line = (note: string, dollars: number | null = null, kind: number | null = 10): BillLineItem => ({
  note,
  amount: dollars,
  rawAmount: dollars === null ? null : Math.round(dollars * 100000),
  itemKind: kind,
  unitCost: null,
  measurement: null,
});

function localStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0);
}

function dayString(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** A UsageSummary with no read-date lines, so billWindow = billingPeriod. */
function makeSummary(day: string, days: number, items: BillLineItem[]): UsageSummary {
  const startDt = localStart(day);
  const start = Math.floor(startDt.getTime() / 1000);
  const duration = days * 86400;
  const end = new Date((start + duration) * 1000);
  return {
    source: 'UsageSummary',
    start,
    duration,
    startDate: day,
    endDate: dayString(end),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null, volume: null,
    items,
  };
}

/** Hourly readings in LOCAL time — the wall clock the classifier reads. */
function hourly(
  day: string,
  days: number,
  kwhAt: (dt: Date) => number,
  rates: RateSet[] = [RATES_2025],
): ProcessedPoint[] {
  const start = localStart(day);
  const raw: DataPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    for (let h = 0; h < 24; h += 1) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, h, 0, 0);
      raw.push({ timestamp: Math.floor(dt.getTime() / 1000), usage_kwh: kwhAt(dt) });
    }
  }
  return processRawData(raw, rates);
}

/**
 * A bill whose commodity lines carry exactly `commodity`, laid out the way
 * Oakville lays one out: delivery + regulatory + HST 13% − rebate 23.5%.
 * The plan argument picks the charge-line fingerprint.
 */
function bill(plan: 'TOU' | 'Tiered' | 'ULO', commodity: number, season: 'Winter' | 'Summer'): BillLineItem[] {
  const delivery = 75.5;
  const regulatory = 8.6;
  const total = commodity + delivery + regulatory;
  const hst = Math.round(total * 0.13 * 100) / 100;
  const rebate = -Math.round(total * 0.235 * 100) / 100;
  const commodityLines: BillLineItem[] =
    plan === 'TOU'
      ? [
          // Two lines (off/on) so the fingerprint is as realistic as the fixture's
          line(`Off Peak-${season}`, Math.round(commodity * 0.45 * 100) / 100),
          line(`On Peak-${season}`, Math.round(commodity * 0.55 * 100) / 100),
        ]
      : plan === 'ULO'
        ? // The overnight line still has to classify as COMMODITY (the app's
          // own classifier keys off the note): "Ultra-Low Overnight" alone
          // lands in `other`, which would make the model check fail for a
          // reason that has nothing to do with the plan comparison.
          [line('Overnight Off-Peak', Math.round(commodity * 100) / 100)]
        : [line(`BLOCK 1 - ${season}`, Math.round(commodity * 100) / 100)];
  // The two TOU lines are rounded to the cent: give the last one the remainder
  // so the commodity sums to the readings' own cost exactly.
  if (plan === 'TOU') {
    const first = commodityLines[0].amount ?? 0;
    commodityLines[1] = line(
      `On Peak-${season}`,
      Math.round((commodity - first) * 100) / 100,
    );
  }
  return [
    ...commodityLines,
    line('Delivery', delivery, 4),
    line('Regulatory', regulatory, 4),
    line('H.S.T. # 123456789', hst, 5),
    line('Ontario Electricity Rebate', rebate, 8),
    line('Total Electricity Charges', Math.round(total * 100) / 100),
  ];
}

/**
 * A bill that states money and a commodity charge but fingerprints NO plan:
 * "Energy Charge" classifies as commodity (so the period is modelable) while
 * matching none of the plan patterns — the declared timeline is then the only
 * thing that can name the plan.
 */
function silentBill(commodity: number): BillLineItem[] {
  const delivery = 75.5;
  const regulatory = 8.6;
  const total = commodity + delivery + regulatory;
  return [
    line('Energy Charge', Math.round(commodity * 100) / 100),
    line('Delivery', delivery, 4),
    line('Regulatory', regulatory, 4),
    line('H.S.T. # 123456789', Math.round(total * 0.13 * 100) / 100, 5),
    line('Ontario Electricity Rebate', -Math.round(total * 0.235 * 100) / 100, 8),
    line('Total Electricity Charges', Math.round(total * 100) / 100),
  ];
}

/** A house with a base load plus a weekday block in the given hours. */
function houseBlock(
  day: string,
  days: number,
  blockHours: number[],
  blockKwh: number,
  baseKwh = 0.4,
  rates: RateSet[] = [RATES_2025],
) {
  const set = new Set(blockHours);
  return hourly(
    day,
    days,
    (dt) => {
      const dow = dt.getDay();
      const weekday = dow !== 0 && dow !== 6;
      return baseKwh + (weekday && set.has(dt.getHours()) ? blockKwh : 0);
    },
    rates,
  );
}

/** Readings that only ever run overnight, 00:00–06:00 (an off-peak shape). */
function overnightLoad(day: string, days: number, kwh = 3.0, rates: RateSet[] = [RATES_2025]) {
  return hourly(day, days, (dt) => (dt.getHours() < 6 ? kwh : 0), rates);
}

/** Readings + a matching bill, for one plan. */
function fixture(
  day: string,
  days: number,
  opts: {
    plan: 'TOU' | 'Tiered' | 'ULO';
    season: 'Winter' | 'Summer';
    rows?: ProcessedPoint[];
    commodityDelta?: number;
    rates?: RateSet[];
  },
) {
  const rows = opts.rows ?? hourly(day, days, () => 0.4, opts.rates);
  const commodity = planCostFor(rows, opts.plan) + (opts.commodityDelta ?? 0);
  return { rows, summaries: [makeSummary(day, days, bill(opts.plan, commodity, opts.season))] };
}

/** Independent recompute of a period's payable per plan, straight off the
 *  readings: the SAME rows, each priced with its own `activeRateSet`. */
function repricedPayable(summary: UsageSummary, rows: ProcessedPoint[]) {
  const inPeriod = rows.filter(
    (r) => r.timestamp >= summary.start && r.timestamp < summary.start + summary.duration,
  );
  const totals = billTotals(summary);
  const commodity = {
    TOU: inPeriod.reduce((acc, r) => acc + r.costTOU, 0),
    ULO: inPeriod.reduce((acc, r) => acc + r.costULO, 0),
    Tiered: planCostFor(inPeriod, 'Tiered'),
  };
  const hstRate = totals.total > 0 ? totals.tax / totals.total : 0.13;
  const creditRate = totals.total > 0 ? totals.credit / totals.total : 0;
  const nonCommodity = totals.total - totals.commodity;
  const payable = {} as Record<'TOU' | 'Tiered' | 'ULO', number>;
  for (const plan of ['TOU', 'Tiered', 'ULO'] as const) {
    const modeled = nonCommodity + commodity[plan];
    payable[plan] = modeled + modeled * hstRate + modeled * creditRate;
  }
  return { payable, commodity, kwh: inPeriod.reduce((acc, r) => acc + r.usage_kwh, 0) };
}

/* -------------------------------------------------------------------------- *
 * Scope: this module compares plans, and nothing else
 * -------------------------------------------------------------------------- */

describe('hindsight scope — plans only, on unchanged actual usage', () => {
  it('exposes no behaviour / load-shift / hypothetical surface', async () => {
    const mod = await import('./hindsight');
    const removed = [
      'scanPeriodBlocks',
      'pickLever',
      'blockLabel',
      'destinationRateCents',
      'MIN_MOVE_SAVING',
      'MIN_BLOCK_KWH_PER_HOUR',
      'MIN_WEEK_SHARE',
      'MERGE_LEVEL_RATIO',
      'LEVER_TIE_TOLERANCE',
      'EMPTY_HINDSIGHT_BEHAVIOUR',
    ];
    for (const name of removed) expect(name in mod, name).toBe(false);
    // …and the surface that replaced them is exactly the plan surface.
    for (const name of ['buildHindsight', 'MIN_SAVING', 'EMPTY_HINDSIGHT']) {
      expect(name in mod, name).toBe(true);
    }
  });

  it('carries no behaviour field anywhere in the report', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', rows });
    const report = buildHindsight(summaries, rows, []);

    expect(Object.keys(report).sort()).toEqual([
      'auditedKwh',
      'emptyReason',
      'note',
      'periods',
      'planMiss',
      'planPeriods',
      'uncounted',
      'worstPeriod',
    ]);
    expect(Object.keys(report.periods[0]).sort()).toEqual([
      'conflict',
      'counted',
      'kwh',
      'label',
      'origin',
      'plan',
      'planBest',
      'planExcluded',
      'planMiss',
      'planReason',
      'planVerdict',
      'season',
      'straddlesSeason',
      'summary',
      'switchRow',
    ]);
    // A deep sweep: no nested number is called a behaviour / shift / lever.
    expect(JSON.stringify(report)).not.toMatch(/behaviour|shiftable|moves|lever/i);
  });

  it('reports the period kWh as metered — the quantity never changes', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', rows });
    const report = buildHindsight(summaries, rows, []);
    const inPeriod = rows.filter(
      (r) => r.timestamp >= summaries[0].start && r.timestamp < summaries[0].start + summaries[0].duration,
    );
    expect(report.periods[0].kwh).toBeCloseTo(
      inPeriod.reduce((acc, r) => acc + r.usage_kwh, 0),
      9,
    );
    expect(report.auditedKwh).toBeCloseTo(report.periods[0].kwh, 9);
  });
});

/* -------------------------------------------------------------------------- *
 * The plan comparison, recomputed independently
 * -------------------------------------------------------------------------- */

describe('buildHindsight — the same readings repriced across the three plans', () => {
  it('reads the plan side straight off Wave P — never re-prices it', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', rows });
    const p = buildSwitchReport(summaries, rows, []);
    const h = buildHindsight(summaries, rows, []);

    expect(h.planMiss).toBe(p.overpaid);
    expect(h.periods[0].switchRow).toEqual(p.rows[0]);
    expect(h.periods[0].planMiss).toBe(p.rows[0].saving);
    expect(h.periods[0].planBest).toBe(p.rows[0].bestPlan);
    expect(h.periods[0].planVerdict).toBe('overpaid');
    expect(h.periods[0].counted).toBe(true);
    expect(h.planPeriods).toBe(1);
  });

  it('prices all three plans on the same rows, at each reading’s own rates', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', rows });
    const h = buildHindsight(summaries, rows, []);
    const row = h.periods[0].switchRow;
    const expected = repricedPayable(summaries[0], rows);

    expect(row.modeled).not.toBeNull();
    for (const plan of ['TOU', 'Tiered', 'ULO'] as const) {
      expect(row.modeled![plan]).toBeCloseTo(expected.payable[plan], 6);
    }
    // The plan actually billed reproduces the bill it explains (the $1 check),
    // which is exactly why this row is countable.
    expect(Math.abs((row.modelDelta ?? 99))).toBeLessThanOrEqual(1);
    // Every alternative is priced off MORE OF THE SAME ROWS, not a different
    // schedule: ULO's own commodity can only be the rows priced at ULO rates.
    expect(expected.commodity.ULO).toBeGreaterThan(0);
    expect(expected.kwh).toBeCloseTo(h.periods[0].kwh, 9);
  });

  it('says "already the cheapest" when the alternatives cost more', () => {
    // Usage only in the 00:00–06:00 window, billed on ULO: nothing else can be
    // cheaper on the same kWh, so the verdict is a real zero-or-better.
    const rows = overnightLoad('2026-11-02', 28, 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'ULO', season: 'Winter', rows });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];

    expect(period.plan).toBe('ULO');
    expect(period.planVerdict).toBe('best');
    expect(period.planMiss).toBeLessThanOrEqual(MIN_SAVING);
    expect(h.planMiss).toBeLessThanOrEqual(MIN_SAVING);
    expect(MIN_SAVING).toBe(0.5);
  });

  it('names the cheapest alternative when the billed plan was not it', () => {
    // Same off-peak-only shape, billed on the FLAT plan: TOU/ULO both price
    // those hours below tier 1, so Tiered is the expensive one.
    const rows = overnightLoad('2026-11-02', 28, 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'Tiered', season: 'Winter', rows });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];

    expect(period.plan).toBe('Tiered');
    expect(period.planVerdict).toBe('overpaid');
    expect(period.planMiss).toBeGreaterThan(MIN_SAVING);
    expect(period.planBest).toBe('ULO'); // the overnight plan wins on overnight kWh
    expect(h.planMiss).toBeCloseTo(period.planMiss ?? 0, 9);
  });

  it('judges a season-straddling bill with the rate set each reading was on', () => {
    // Oct 19 → Nov 15 straddles Nov 1: one period, two real rate sets.
    const rows = houseBlock('2026-10-19', 28, [7, 8, 9], 3.0, 0.4, RATE_HISTORY);
    const { summaries } = fixture('2026-10-19', 28, { plan: 'TOU', season: 'Summer', rows });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];

    expect(period.straddlesSeason).toBe(true);
    expect(period.season).toBe('summer'); // the season the bill's first day was in
    const before = rows.find((r) => r.dayStr === '2026-10-20' && r.dateObj.getHours() === 7)!;
    const after = rows.find((r) => r.dayStr === '2026-11-04' && r.dateObj.getHours() === 7)!;
    expect(before.activeRateSet.effectiveDate).toBe('2025-11-01');
    expect(after.activeRateSet.effectiveDate).toBe('2026-11-01');

    // The three repriced plans equal an independent sum over the SAME rows,
    // each reading at its own day's rates — so the two halves of the period
    // really are priced on the two rate sets.
    const expected = repricedPayable(summaries[0], rows);
    for (const plan of ['TOU', 'Tiered', 'ULO'] as const) {
      expect(period.switchRow.modeled![plan]).toBeCloseTo(expected.payable[plan], 6);
    }
    expect(period.planMiss).toBe(period.switchRow.saving);
    expect(period.counted).toBe(true);
  });

  it('walks a declared timeline when the bill fingerprint is silent', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const timeline: PlanTimelineEntry[] = [
      { id: 'x', plan: 'TOU', from: '2026-10-01', to: '2026-12-31' },
    ];
    // "Energy Charge" classifies as COMMODITY (so the period really is
    // modelable) while fingerprinting no plan at all — the timeline is then
    // the only thing that can name the plan.
    const commodity = planCostFor(rows, 'TOU');
    const summary = makeSummary('2026-11-02', 28, silentBill(commodity));
    const p = buildSwitchReport([summary], rows, []);
    expect(p.rows[0].plan).toBe('unknown'); // silent without the timeline

    const h = buildHindsight([summary], rows, timeline);
    expect(h.periods[0].plan).toBe('TOU');
    expect(h.periods[0].origin).toBe('declared');
    expect(h.periods[0].counted).toBe(true);
    expect(h.periods[0].planMiss).toBe(h.periods[0].switchRow.saving);
  });
});

/* -------------------------------------------------------------------------- *
 * The honest refusals
 * -------------------------------------------------------------------------- */

describe('buildHindsight — nothing is claimed without evidence', () => {
  it('claims nothing at all when the plan cannot be known', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const items = [
      line('Monthly Basic Charge', 18.4),
      line('Standard Service Charge', 5.0, 4),
      line('Total Electricity Charges', 23.4),
    ];
    const h = buildHindsight([makeSummary('2026-11-02', 28, items)], rows, []);
    const period = h.periods[0];

    expect(period.plan).toBe('unknown');
    expect(period.planVerdict).toBe('unknown');
    expect(period.planMiss).toBeNull();
    expect(period.planBest).toBeNull();
    expect(period.planReason).toBeTruthy();
    // …while the modeled reference the switch row carries stays available.
    expect(period.switchRow.modeled).not.toBeNull();
    expect(h.planMiss).toBeNull();
    expect(h.planPeriods).toBe(0);
    expect(h.uncounted).toBe(1);
    expect(h.emptyReason).toBe('nothing-countable');
  });

  it('excludes a period the readings do not cover — with its reason', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', rows });
    const partial = rows.filter((r) => r.timestamp < summaries[0].start + 10 * 86400);
    const h = buildHindsight(summaries, partial, []);
    const period = h.periods[0];

    expect(period.counted).toBe(false);
    expect(period.planVerdict).toBe('skipped');
    expect(period.planReason).toBeTruthy();
    expect(period.planMiss).toBeNull();
    expect(h.planMiss).toBeNull();
    expect(h.auditedKwh).toBe(0);
    expect(h.emptyReason).toBe('nothing-countable');
  });

  it('shows but does not count a period whose model cannot reproduce its bill', () => {
    // The bill overstates the commodity by $40: the re-priced actual plan
    // misses it by far more than the $1 the model check allows.
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      rows,
      commodityDelta: 40,
    });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];

    expect(period.counted).toBe(false);
    expect(period.planVerdict).toBe('untrusted');
    expect(period.planMiss).toBeNull();
    expect(period.planExcluded).not.toBeNull();
    expect(period.planReason).toBeTruthy();
    expect(h.planMiss).toBeNull();
    expect(h.periods[0].switchRow.saving).not.toBeNull(); // a number exists…
    expect(h.emptyReason).toBe('nothing-countable'); // …it just enters no total
  });

  it('sums only the countable periods, worst-first, and reports their kWh', () => {
    // Same shape, two volumes: the over-payment scales with the kWh, so the
    // bigger period really does leave more on the table.
    const bigRows = overnightLoad('2026-11-02', 28, 3.0);
    const smallRows = overnightLoad('2026-12-01', 28, 1.0);
    const big = fixture('2026-11-02', 28, { plan: 'Tiered', season: 'Winter', rows: bigRows });
    const small = fixture('2026-12-01', 28, { plan: 'Tiered', season: 'Winter', rows: smallRows });
    const unknownRows = overnightLoad('2027-01-04', 28, 3.0);
    const unknownSummary = makeSummary('2027-01-04', 28, [
      line('Monthly Basic Charge', 18.4),
      line('Standard Service Charge', 5.0, 4),
      line('Total Electricity Charges', 23.4),
    ]);

    const h = buildHindsight(
      [...big.summaries, ...small.summaries, unknownSummary],
      [...big.rows, ...small.rows, ...unknownRows],
      [],
    );

    expect(h.periods).toHaveLength(3);
    expect(h.planPeriods).toBe(2);
    expect(h.uncounted).toBe(1);
    expect(h.planMiss).toBeCloseTo(
      h.periods.reduce((acc, p) => acc + (p.planMiss ?? 0), 0),
      9,
    );
    expect(h.periods[0].planVerdict).toBe('overpaid');
    expect(h.periods[0].kwh).toBeGreaterThan(h.periods[1].kwh);
    // Worst-first is a real ordering, not a fixture coincidence: every
    // countable figure is >= the one after it, and the nulls sink to the end.
    const counted = h.periods.filter((p) => p.planMiss !== null).map((p) => p.planMiss as number);
    expect(counted).toEqual([...counted].sort((a, b) => b - a));
    expect(h.periods[2].planMiss).toBeNull();
    expect(h.worstPeriod?.summary.start).toBe(big.summaries[0].start);
    expect(h.auditedKwh).toBeCloseTo(
      h.periods.filter((p) => p.planMiss !== null).reduce((acc, p) => acc + p.kwh, 0),
      9,
    );
  });

  it('returns the empty shape for a file with no bills', () => {
    const h = buildHindsight([], [], []);
    expect(h.periods).toHaveLength(0);
    expect(h.planMiss).toBeNull();
    expect(h.emptyReason).toBe('no-bills');
    expect(h.note).toBeTruthy();
  });

  it('is deterministic — the same bill priced twice is stable', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', rows });
    expect(JSON.stringify(buildHindsight(summaries, rows, []))).toBe(
      JSON.stringify(buildHindsight(summaries, rows, [])),
    );
  });

  it('the bill the model explains is the bill the panel judges', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const { summaries } = fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', rows });
    const totals = billTotals(summaries[0]);
    const h = buildHindsight(summaries, rows, []);
    expect(h.periods[0].switchRow.actual).toBeCloseTo(totals.payable, 6);
    expect(h.periods[0].counted).toBe(true);
    expect(Math.abs(h.periods[0].switchRow.modelDelta ?? 99)).toBeLessThanOrEqual(1);
  });
});
