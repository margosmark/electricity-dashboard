/**
 * Wave P — the plan-type timeline, per-period modeling, and the switch
 * track record.
 *
 * Detection runs against the committed Oakville-shaped fixture (all three
 * periods are TOU) plus inline line-item sets for the shapes that fixture
 * does not carry: the Tiered "BLOCK 1 - Winter" / "BLOCK 1- Summer"
 * fingerprints (different spacing, same signature — taken from the real
 * 24-period export's audit), ULO's period names, and honest unknowns.
 *
 * The real 24-period export never enters this repo (privacy rule): its
 * fingerprints are reproduced here as inline notes, and the file itself is
 * exercised only by the deployed browser check (evidence/wave-p-verify.cjs),
 * which pins its sha256 before use.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  billTotals,
  parseUsageSummaries,
  processRawData,
  type BillLineItem,
  type DataPoint,
  type ProcessedPoint,
  type RateSet,
  type UsageSummary,
} from './energy';
import {
  PLAN_TIMELINE_KEY,
  assignPeriodPlan,
  buildSwitchReport,
  declarationFor,
  detectPlanType,
  isIsoDay,
  isValidPlanTimelineEntry,
  modelPeriod,
  parsePlanTimeline,
  type PlanTimelineEntry,
} from './planTimeline';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const OAKVILLE = fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8');
const fixtureSummaries = parseUsageSummaries(OAKVILLE);

/** A charge line as the file would carry it (dollars already scaled). */
const line = (note: string, dollars: number | null = null, kind: number | null = 10): BillLineItem => ({
  note,
  amount: dollars,
  rawAmount: dollars === null ? null : Math.round(dollars * 100000),
  itemKind: kind,
  unitCost: null,
  measurement: null,
});

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** A UsageSummary with no read-date lines, so billWindow = billingPeriod. */
function makeSummary(startDate: string, days: number, items: BillLineItem[]): UsageSummary {
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
    consumption: null,
    items,
  };
}

type RowOpts = {
  usage?: number;
  costTOU?: number;
  costULO?: number;
  isWinter?: boolean;
  rates?: RateSet;
};

/** One reading a day across `days` days starting at `startDay` (UTC days). */
function makeRows(startDay: string, days: number, opts: RowOpts = {}): ProcessedPoint[] {
  const start = Math.floor(Date.parse(`${startDay}T00:00:00Z`) / 1000);
  const rates = opts.rates ?? rateSet;
  const out: ProcessedPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const timestamp = start + i * 86400 + 3600;
    const dateObj = new Date(timestamp * 1000);
    out.push({
      timestamp,
      usage_kwh: opts.usage ?? 0,
      dateObj,
      dayStr: dateObj.toISOString().slice(0, 10),
      hourStr: '01:00',
      touCategory: 'Off-Peak',
      uloCategory: 'Overnight',
      isWinter: opts.isWinter ?? false,
      costTOU: opts.costTOU ?? 0,
      costULO: opts.costULO ?? 0,
      costTiered: 0,
      activeRateSet: rates,
    });
  }
  return out;
}

const entry = (plan: PlanTimelineEntry['plan'], from: string, to: string): PlanTimelineEntry => ({
  id: `${plan}-${from}`,
  plan,
  from,
  to,
});

/* ====================================================== detection ======== */

describe('detectPlanType — fingerprinting the plan off the charge lines', () => {
  it('detects TOU on every period of the committed Oakville-shaped fixture', () => {
    expect(fixtureSummaries).toHaveLength(3);
    for (const summary of fixtureSummaries) {
      const d = detectPlanType(summary.items);
      expect(d.plan).toBe('TOU');
      expect(d.reason).toBeNull();
      expect(d.evidence).toContain('Off Peak-Summer');
    }
  });

  it('detects Tiered from BLOCK lines, tolerating the real file’s spacing variants', () => {
    const winter = detectPlanType([
      line('BLOCK 1 - Winter', 85.69),
      line('BLOCK 2 - Winter', 12.31, 4),
      line('Delivery', 60.06, 4),
      line('Regulatory', 5.12, 4),
      line('H.S.T. # 123456789', 19.71, 5),
      line('Ontario Electricity Rebate', -19.86, 8),
      line('Total Electricity Charges', 150.87),
      line('Amount Due', 289.91),
    ]);
    expect(winter.plan).toBe('Tiered');
    expect(winter.candidates).toEqual(['Tiered']);
    expect(winter.evidence).toContain('BLOCK 1 - Winter');
    expect(winter.evidence).toContain('BLOCK 2 - Winter');

    // the same signature without the space before the dash — "BLOCK 1- Summer"
    const summer = detectPlanType([line('BLOCK 1- Summer', 91.14), line('Delivery', 60.06, 4)]);
    expect(summer.plan).toBe('Tiered');
    expect(summer.evidence).toContain('BLOCK 1- Summer');
  });

  it('detects ULO even when its bill also carries Mid-Peak/On-Peak wording', () => {
    const d = detectPlanType([
      line('Ultra-Low Overnight', 45.1),
      line('Weekend Off-Peak', 12.0),
      line('Mid-Peak', 8.0),
      line('On-Peak', 6.0),
      line('Delivery', 30.0, 4),
      line('Total Electricity Charges', 101.1),
    ]);
    expect(d.plan).toBe('ULO');
    // the peak lines DID match TOU's pattern — ULO wins by documented precedence
    expect(d.candidates).toContain('TOU');
    expect(d.candidates).toContain('ULO');
    expect(d.evidence).toContain('Ultra-Low Overnight');
    expect(d.evidence).toContain('Weekend Off-Peak');
  });

  it('detects ULO from the Overnight/Weekday wording alone', () => {
    const d = detectPlanType([line('Overnight Usage', 9.9), line('Weekday', 4.2)]);
    expect(d.plan).toBe('ULO');
  });

  it('says unknown — with the reason — when the wording matches no schema', () => {
    const d = detectPlanType([
      line('Monthly Basic Charge', 10.0),
      line('Standard Service Charge', 5.0),
    ]);
    expect(d.plan).toBe('unknown');
    expect(d.evidence).toEqual([]);
    expect(d.reason).toMatch(/no recognizable plan lines/);
  });

  it('says unknown when two plan signatures collide in one bill', () => {
    const d = detectPlanType([line('Off Peak-Summer', 93.61), line('BLOCK 1 - Winter', 85.69)]);
    expect(d.plan).toBe('unknown');
    expect(d.candidates).toEqual(['TOU', 'Tiered']);
    expect(d.reason).toMatch(/mixed plan signatures/);
    expect(d.evidence).toContain('Off Peak-Summer');
    expect(d.evidence).toContain('BLOCK 1 - Winter');
  });

  it('never takes totals, taxes, delivery or the rebate as plan evidence', () => {
    const d = detectPlanType([
      line('Delivery', 60.06, 4),
      line('Regulatory', 5.12, 4),
      line('H.S.T. # 123456789', 19.71, 5),
      line('Ontario Electricity Rebate', -19.86, 8),
      line('Total Electricity Charges', 150.87),
    ]);
    expect(d.plan).toBe('unknown');
    expect(d.evidence).toEqual([]);
  });

  it('handles an empty bill without pretending', () => {
    expect(detectPlanType([]).plan).toBe('unknown');
  });
});

/* ======================================================= timeline ======== */

describe('plan timeline — user declarations', () => {
  it('accepts only real calendar days', () => {
    expect(isIsoDay('2024-11-25')).toBe(true);
    expect(isIsoDay('2024-02-30')).toBe(false);
    expect(isIsoDay('11/25/2024')).toBe(false);
    expect(isIsoDay(20241125)).toBe(false);
    expect(isIsoDay('')).toBe(false);
  });

  it('validates entries as a whole (plan + dates + order)', () => {
    expect(isValidPlanTimelineEntry(entry('Tiered', '2024-11-25', '2025-03-24'))).toBe(true);
    expect(isValidPlanTimelineEntry(entry('Tiered', '2025-03-24', '2024-11-25'))).toBe(false);
    expect(isValidPlanTimelineEntry({ id: 'x', plan: 'Solar', from: '2024-01-01', to: '2024-02-01' })).toBe(false);
    expect(isValidPlanTimelineEntry({ plan: 'TOU', from: '2024-01-01', to: '2024-02-01' })).toBe(false);
  });

  it('drops corrupt storage instead of poisoning it', () => {
    expect(parsePlanTimeline(null)).toEqual([]);
    expect(parsePlanTimeline('not json')).toEqual([]);
    expect(parsePlanTimeline('{"a":1}')).toEqual([]);
    const mixed = JSON.stringify([
      entry('Tiered', '2024-11-25', '2025-03-24'),
      { id: 'bad', plan: 'Tiered', from: '2025-13-01', to: '2025-03-24' },
      'nope',
    ]);
    expect(parsePlanTimeline(mixed)).toHaveLength(1);
  });

  it('resolves the widest overlap, ties going to the later switch', () => {
    const a = entry('Tiered', '2024-11-25', '2025-03-24');
    // full cover
    expect(declarationFor([a], '2024-12-01', '2024-12-31')?.id).toBe(a.id);
    // no cover at all
    expect(declarationFor([a], '2026-01-01', '2026-01-31')).toBeNull();
    // two partial covers: the wider overlap wins (10 days vs 20)
    const c = entry('ULO', '2024-11-01', '2024-11-10');
    const d = entry('TOU', '2024-11-11', '2024-11-30');
    expect(declarationFor([c, d], '2024-11-01', '2024-11-30')?.id).toBe(d.id);
    // equal overlap (6 days each): the later start wins
    const f = entry('TOU', '2024-10-10', '2024-10-15');
    const e = entry('ULO', '2024-10-15', '2024-10-20');
    expect(declarationFor([f, e], '2024-10-10', '2024-10-20')?.id).toBe(e.id);
  });

  it('lets a confident detection win over a declaration, and flags the conflict', () => {
    const detection = detectPlanType(fixtureSummaries[0].items);
    const win = { start: '2026-05-25', end: '2026-06-23' };

    const agreeing = assignPeriodPlan(detection, [], win);
    expect(agreeing.plan).toBe('TOU');
    expect(agreeing.origin).toBe('detected');
    expect(agreeing.conflict).toBe(false);

    const fighting = assignPeriodPlan(detection, [entry('Tiered', '2026-05-01', '2026-06-30')], win);
    expect(fighting.plan).toBe('TOU');
    expect(fighting.origin).toBe('detected');
    expect(fighting.conflict).toBe(true);
    expect(fighting.declared?.plan).toBe('Tiered');
  });

  it('falls back to the declaration when the lines say nothing', () => {
    const unknown = detectPlanType([line('Monthly Basic Charge', 10)]);
    const win = { start: '2024-12-01', end: '2024-12-31' };
    expect(assignPeriodPlan(unknown, [], win).origin).toBe('unknown');
    const declared = assignPeriodPlan(unknown, [entry('Tiered', '2024-11-25', '2025-03-24')], win);
    expect(declared.plan).toBe('Tiered');
    expect(declared.origin).toBe('declared');
    expect(declared.conflict).toBe(false);
  });
});

/* ======================================================= modeling ======== */

describe('modelPeriod — the same readings under each plan', () => {
  // self-consistent like the fixture: commodity 325.00 + delivery 75.50 +
  // regulatory 8.60 = total 409.10 · HST 13% · rebate −23.5% of the total
  const BILL_ITEMS = [
    line('Off Peak-Summer', 177.78),
    line('Mid Peak-Summer', 70.94),
    line('On Peak-Summer', 76.28),
    line('Delivery', 75.5, 4),
    line('Regulatory', 8.6, 4),
    line('H.S.T. # 123456789', 53.18, 5),
    line('Ontario Electricity Rebate', -96.14, 8),
    line('Total Electricity Charges', 409.1),
  ];

  it('reconstructs the bill exactly when repriced under the plan it was billed on', () => {
    const summary = makeSummary('2026-06-01', 29, BILL_ITEMS);
    const totals = billTotals(summary);
    // readings whose TOU cost equals the billed commodity to the cent
    const rows = makeRows('2026-06-01', 29, {
      usage: 90,
      costTOU: totals.commodity / 29,
      costULO: totals.commodity / 29 / 3,
    });
    const model = modelPeriod(summary, rows);
    expect(model.comparable).toBe(true);
    expect(model.payable.TOU).toBeCloseTo(totals.payable, 6);
    expect(model.payable.ULO).toBeLessThan(model.payable.TOU);
  });

  it('does not answer for a period the readings do not cover', () => {
    const summary = makeSummary('2026-06-01', 29, BILL_ITEMS);
    const half = makeRows('2026-06-01', 14, { usage: 90, costTOU: 10 });
    const model = modelPeriod(summary, half);
    expect(model.comparable).toBe(false);
    expect(model.coverage).toBeCloseTo(14 / 29, 4);
    expect(model.rows).toHaveLength(14);
  });

  it('prices tiered with the month-bucket threshold the plan cards use', () => {
    const summary = makeSummary('2026-06-01', 29, [line('BLOCK 1 - Summer', 100)]);
    // 29 days of readings in ONE calendar month: 1000 kWh total vs a summer
    // threshold of 600 kWh prorated by days/30.4
    const rows = makeRows('2026-06-01', 29, { usage: 1000 / 29, isWinter: false });
    const model = modelPeriod(summary, rows);
    const th = 600 * (29 / 30.4);
    const expected = (th * 12.0) / 100 + ((1000 - th) * 14.2) / 100;
    expect(model.commodity.Tiered).toBeCloseTo(expected, 6);
    expect(model.commodity.Tiered).toBeGreaterThan((1000 * 12.0) / 100);
  });

  it('reprices historical periods with the rate set in force back then', () => {
    const old: RateSet = { ...rateSet, effectiveDate: '2023-11-01', tou: { ...rateSet.tou, offPeak: 100 } };
    const recent: RateSet = { ...rateSet, effectiveDate: '2025-11-01' };
    const points: DataPoint[] = [{ timestamp: Date.parse('2024-07-01T06:00:00Z') / 1000, usage_kwh: 10 }];
    const rows = processRawData(points, [recent, old]);
    expect(rows[0].activeRateSet.effectiveDate).toBe('2023-11-01');
    const summary = makeSummary('2024-07-01', 1, [line('Off Peak-Summer', 10)]);
    const model = modelPeriod(summary, rows);
    expect(model.commodity.TOU).toBeCloseTo(10 * (100 / 100), 6);
  });
});

/* ========================================================= report ======== */

describe('buildSwitchReport — the audited switch track record', () => {
  const touSummary = makeSummary('2026-06-01', 29, [
    line('Off Peak-Summer', 177.78),
    line('Mid Peak-Summer', 70.94),
    line('On Peak-Summer', 76.28),
    line('Delivery', 75.5, 4),
    line('Regulatory', 8.6, 4),
    line('H.S.T. # 123456789', 53.18, 5),
    line('Ontario Electricity Rebate', -96.14, 8),
    line('Total Electricity Charges', 409.1),
  ]);
  const unknownSummary = makeSummary('2026-07-01', 29, [
    line('Monthly Basic Charge', 10),
    line('Delivery', 20, 4),
    line('Total Electricity Charges', 30),
  ]);
  const noReadingsSummary = makeSummary('2026-08-01', 29, [
    line('Off Peak-Summer', 50),
    line('Total Electricity Charges', 50),
  ]);

  const totals = billTotals(touSummary);
  const juneRows = makeRows('2026-06-01', 29, {
    usage: 90,
    costTOU: totals.commodity / 29,
    costULO: totals.commodity / 29 / 4,
  });
  const julyRows = makeRows('2026-07-01', 29, { usage: 90, costTOU: 1, costULO: 0.5 });
  const rows = [...juneRows, ...julyRows];

  it('builds one row per period and only counts what it could model', () => {
    const report = buildSwitchReport([touSummary, unknownSummary, noReadingsSummary], rows, []);
    expect(report.rows).toHaveLength(3);
    expect(report.known).toBe(2); // June (TOU) + August (TOU, but no readings)
    expect(report.modeled).toBe(1); // only June has a known plan AND coverage
    expect(report.skipped).toBe(1); // August has no readings in this browser

    const tou = report.rows[0];
    expect(tou.plan).toBe('TOU');
    expect(tou.origin).toBe('detected');
    expect(tou.actual).toBeCloseTo(totals.payable, 6);
    // alternatives = the two plans you were NOT on, labelled modeled downstream
    expect(tou.bestPlan).toBe('ULO');
    expect(tou.saving).toBeCloseTo(totals.payable - (tou.modeled?.ULO ?? 0), 6);
    expect(tou.saving).toBeGreaterThan(0);
    // the model's own error bar: it reprices the billed plan to ~the bill
    expect(Math.abs(tou.modelDelta ?? 99)).toBeLessThan(1);

    const unknown = report.rows[1];
    expect(unknown.plan).toBe('unknown');
    expect(unknown.origin).toBe('unknown');
    expect(unknown.modeled).not.toBeNull();
    expect(unknown.saving).toBeNull(); // no actual plan ⇒ no saving claimed

    const skipped = report.rows[2];
    expect(skipped.skipped).toMatch(/no readings/);
    expect(skipped.modeled).toBeNull();
  });

  it('nets the over-payment by plan — the "stayed on X" total', () => {
    const report = buildSwitchReport([touSummary], rows, []);
    expect(report.overpaid).not.toBeNull();
    expect(report.overpaid).toBeCloseTo(report.rows[0].saving ?? -1, 6);
    expect(report.byPlan).toHaveLength(1);
    expect(report.byPlan[0].plan).toBe('TOU');
    expect(report.byPlan[0].periods).toBe(1);
    expect(report.byPlan[0].overpaid).toBeCloseTo(report.overpaid ?? -1, 6);
    expect(report.callouts.map((c) => c.summary.startDate)).toEqual(['2026-06-01']);
  });

  it('shows — but never counts — a row whose model cannot reproduce its bill', () => {
    // Deliberately wrong commodity pricing: the reconstruction misses the
    // bill by ~$110, so the saving is displayed with its delta and kept out
    // of every total (a model that cannot explain what you paid must not
    // invent what you would have paid).
    const badRows = makeRows('2026-06-01', 29, {
      usage: 90,
      costTOU: (totals.commodity - 100) / 29, // $100 short of the bill
      costULO: totals.commodity / 29 / 4,
    });
    const report = buildSwitchReport([touSummary], badRows, []);
    const row = report.rows[0];
    expect(row.saving).not.toBeNull(); // still shown
    expect(row.counted).toBe(false);
    expect(row.excluded).toMatch(/away from what Oakville actually charged/);
    expect(report.modeled).toBe(1);
    expect(report.counted).toBe(0);
    expect(report.untrusted).toBe(1);
    expect(report.overpaid).toBeNull(); // nothing trustworthy to total
    expect(report.byPlan).toEqual([]);
    expect(report.callouts).toEqual([]);

    // …and the trusted twin of the same period IS counted.
    const good = buildSwitchReport([touSummary], rows, []);
    expect(good.rows[0].counted).toBe(true);
    expect(good.rows[0].excluded).toBeNull();
    expect(good.counted).toBe(1);
    expect(good.overpaid).not.toBeNull();
  });

  it('returns null overpaid (not zero) when nothing could be modeled', () => {
    const report = buildSwitchReport([noReadingsSummary], [], []);
    expect(report.overpaid).toBeNull();
    expect(report.byPlan).toEqual([]);
    expect(report.callouts).toEqual([]);
  });

  it('keeps a user declaration in the row when the lines say nothing', () => {
    const report = buildSwitchReport(
      [unknownSummary],
      makeRows('2026-07-01', 29, { usage: 90, costTOU: 1, costULO: 0.5 }),
      [entry('Tiered', '2026-06-15', '2026-07-31')],
    );
    const row = report.rows[0];
    expect(row.plan).toBe('Tiered');
    expect(row.origin).toBe('declared');
    expect(row.saving).not.toBeNull();
    expect(report.known).toBe(1);
  });

  it('surfaces a declaration that contradicts the bill instead of hiding it', () => {
    const report = buildSwitchReport(
      [touSummary],
      rows,
      [entry('Tiered', '2026-06-01', '2026-06-30')],
    );
    const row = report.rows[0];
    expect(row.plan).toBe('TOU'); // evidence wins
    expect(row.origin).toBe('detected');
    expect(row.conflict).toBe(true);
  });
});

/* ============================================ storage round trip ========= */

describe('storage', () => {
  it('round-trips a valid entry through the storage key contract', () => {
    const e = entry('Tiered', '2024-11-25', '2025-03-24');
    expect(PLAN_TIMELINE_KEY).toBe('plan_timeline');
    expect(parsePlanTimeline(JSON.stringify([e]))).toEqual([e]);
  });
});
