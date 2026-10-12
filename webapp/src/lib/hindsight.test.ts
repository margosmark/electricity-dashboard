/**
 * Wave V — the HINDSIGHT engine.
 *
 * Everything here runs against readings built by the real `processRawData`
 * (not hand-stamped categories), so the TOU/ULO windows, the Ontario holiday
 * rule and the per-reading rate-set versioning are the app's own — a test
 * that hand-set `touCategory` would agree with itself and prove nothing.
 *
 * The bills are built so that the model reproduces them to the cent (the
 * commodity lines sum to Σ of the readings' own priced cost, and delivery,
 * regulatory, HST and the rebate are laid out the way Oakville lays them out),
 * which is what makes a period *countable* on both levers.
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
import {
  MERGE_LEVEL_RATIO,
  MIN_BLOCK_KWH_PER_HOUR,
  MIN_MOVE_SAVING,
  buildHindsight,
  blockLabel,
  destinationRateCents,
  pickLever,
  scanPeriodBlocks,
} from './hindsight';

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
    consumption: null,
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
        ? [line('Ultra-Low Overnight', Math.round(commodity * 100) / 100)]
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

/** Readings + a matching bill, for one plan. */
function fixture(
  day: string,
  days: number,
  opts: {
    plan: 'TOU' | 'Tiered' | 'ULO';
    season: 'Winter' | 'Summer';
    blockHours?: number[];
    blockKwh?: number;
    baseKwh?: number;
    rates?: RateSet[];
  },
) {
  const rows =
    opts.blockHours && opts.blockHours.length > 0
      ? houseBlock(day, days, opts.blockHours, opts.blockKwh ?? 3, opts.baseKwh ?? 0.4, opts.rates)
      : hourly(day, days, () => opts.baseKwh ?? 0.4, opts.rates);
  const commodity = planCostFor(rows, opts.plan);
  return { rows, summaries: [makeSummary(day, days, bill(opts.plan, commodity, opts.season))] };
}

/* -------------------------------------------------------------------------- *
 * scanPeriodBlocks
 * -------------------------------------------------------------------------- */

describe('scanPeriodBlocks — the recurring routine inside one period', () => {
  it('finds a weekday block, prices it twice, and reports the real difference', () => {
    // 28 days from a Monday: exactly 4 weeks, 20 weekdays.
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const scan = scanPeriodBlocks(rows, 'TOU');

    expect(scan.weeksAvailable).toBe(4);
    expect(scan.flatRate).toBe(false);
    expect(scan.moves).toHaveLength(5); // Mon…Fri, one block each

    const mon = scan.moves.find((m) => m.id === 'mon-7-10');
    expect(mon).toBeDefined();
    // 4 Mondays × 3 hours × 3.4 kWh (3.0 block + 0.4 base) = 40.8 kWh
    expect(mon!.kwh).toBeCloseTo(40.8, 6);
    expect(mon!.weeksSeen).toBe(4);
    expect(mon!.weeksAvailable).toBe(4);
    expect(mon!.consistencyCv).toBeCloseTo(0, 6);
    expect(mon!.destination.key).toBe('offpeak-tou');
    // winter weekday 07:00–10:00 is On-Peak: 20.3¢ paid, 9.8¢ in the target
    expect(mon!.actualRateCents).toBeCloseTo(20.3, 6);
    expect(mon!.destRateCents).toBeCloseTo(9.8, 6);
    expect(mon!.saving).toBeCloseTo((40.8 * (20.3 - 9.8)) / 100, 6);
    expect(mon!.shiftedCost).toBeLessThan(mon!.actualCost);
    expect(mon!.classification.signature).toBe('fixed-schedule');
    expect(mon!.label).toBe(blockLabel(1, 7, 10));
  });

  it('does not glue a small base-load hour onto a big appliance block', () => {
    // Hours 10–11 follow the 07–09 block but carry only the 0.4 kWh/h floor:
    // one 3-hour block, not "07:00–12:00".
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const scan = scanPeriodBlocks(rows, 'TOU');
    expect(scan.moves.map((m) => m.id).sort()).toEqual([
      'fri-7-10',
      'mon-7-10',
      'thu-7-10',
      'tue-7-10',
      'wed-7-10',
    ]);
    for (const m of scan.moves) expect(m.endHour - m.startHour).toBe(3);
    expect(MERGE_LEVEL_RATIO).toBeGreaterThan(0);
  });

  it('ignores the always-on floor — a flat 0.4 kWh/h hour is not a routine to move', () => {
    const rows = hourly('2026-11-02', 28, () => 0.4);
    const scan = scanPeriodBlocks(rows, 'TOU');
    expect(scan.moves).toHaveLength(0);
    expect(MIN_BLOCK_KWH_PER_HOUR).toBe(0.5);
  });

  it('prices a ULO block against ULO overnight, not against a TOU rate', () => {
    // ULO peak window is the weekday 16:00–21:00.
    const rows = houseBlock('2026-11-02', 28, [17, 18, 19, 20], 2.0);
    const scan = scanPeriodBlocks(rows, 'ULO');
    expect(scan.moves.length).toBeGreaterThan(0);
    const mon = scan.moves.find((m) => m.id === 'mon-17-21')!;
    expect(mon).toBeDefined();
    expect(mon.destination.key).toBe('overnight-ulo');
    expect(mon.actualRateCents).toBeCloseTo(RATES_2025.ulo.onPeak, 6);
    expect(mon.destRateCents).toBeCloseTo(RATES_2025.ulo.overnight, 6);
    expect(mon.shiftedCost).toBeLessThan(mon.actualCost);
  });

  it('answers nothing at all for Tiered — and says that is a flat rate', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const scan = scanPeriodBlocks(rows, 'Tiered');
    expect(scan.moves).toHaveLength(0);
    expect(scan.flatRate).toBe(true);
  });

  it('claims nothing when the period is too short to establish a routine', () => {
    const rows = houseBlock('2026-11-02', 14, [7, 8, 9], 3.0);
    const scan = scanPeriodBlocks(rows, 'TOU');
    expect(scan.weeksAvailable).toBe(2);
    expect(scan.moves).toHaveLength(0);
  });

  it('keeps a load that runs every other week out of the answer (recurrence share)', () => {
    // Only the first and third weeks carry the block: 2 of 5 weeks.
    const set = new Set([7, 8, 9]);
    const rows = hourly('2026-11-02', 35, (dt) => {
      const dow = dt.getDay();
      if (dow === 0 || dow === 6) return 0.4;
      const dayIdx = Math.round(
        (new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime() -
          localStart('2026-11-02').getTime()) /
          86400000,
      );
      const weekIdx = Math.floor(dayIdx / 7);
      return 0.4 + (set.has(dt.getHours()) && (weekIdx === 0 || weekIdx === 2) ? 3 : 0);
    });
    const scan = scanPeriodBlocks(rows, 'TOU');
    expect(scan.weeksAvailable).toBe(5);
    expect(scan.moves).toHaveLength(0);
  });

  it('splits a season-straddling block by neither tier nor season — it stays one routine', () => {
    // Oct 19 → Nov 15 straddles Nov 1: the same 07:00–10:00 weekday hours are
    // Mid-Peak under the summer window and On-Peak under the winter one.
    const rows = houseBlock('2026-10-19', 28, [7, 8, 9], 3.0, 0.4, RATE_HISTORY);
    const scan = scanPeriodBlocks(rows, 'TOU');
    const mon = scan.moves.find((m) => m.id === 'mon-7-10');
    expect(mon).toBeDefined();
    expect(mon!.tierMixed).toBe(true);
    expect(mon!.weeksSeen).toBeGreaterThanOrEqual(3);
    // Each week's kWh is priced with the rate set in force on its own day, so
    // the blended rate sits between the old and the new Mid-/On-Peak ones.
    expect(mon!.actualRateCents).toBeGreaterThan(RATES_2025.tou.offPeak);
    expect(mon!.actualRateCents).toBeLessThan(RATES_2026.tou.onPeak);
    expect(mon!.shiftedCost).toBeLessThan(mon!.actualCost);
  });
});

/* -------------------------------------------------------------------------- *
 * buildHindsight — the plan side reuses Wave P, the behaviour side is new
 * -------------------------------------------------------------------------- */

describe('buildHindsight — two levers per closed period', () => {
  it('is additive: the total is the plan miss plus the behaviour miss', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
      blockKwh: 3.0,
    });
    const report = buildHindsight(summaries, rows, []);

    expect(report.planMiss).not.toBeNull();
    expect(report.behaviourMiss).not.toBeNull();
    expect(report.totalMiss).toBeCloseTo((report.planMiss ?? 0) + (report.behaviourMiss ?? 0), 9);
    expect(report.behaviourMiss).toBeGreaterThan(0);
  });

  it('reads the plan side straight off Wave P — never re-prices it', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
    });
    const p = buildSwitchReport(summaries, rows, []);
    const h = buildHindsight(summaries, rows, []);
    expect(h.planMiss).toBe(p.overpaid);
    expect(h.periods[0].switchRow.actual).toBe(p.rows[0].actual);
    expect(h.periods[0].switchRow).toEqual(p.rows[0]);
    expect(h.periods[0].planMiss).toBe(p.rows[0].saving);
    expect(h.periods[0].planBest).toBe(p.rows[0].bestPlan);
  });

  it('the behaviour lever is computed with the plan held FIXED', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
      blockKwh: 3.0,
    });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];
    expect(period.behaviourVerdict).toBe('moveable');
    expect(period.behaviourMiss).toBeCloseTo(
      period.moves.reduce((acc, m) => acc + m.saving, 0),
      9,
    );
    const mon = period.moves.find((m) => m.id === 'mon-7-10')!;
    expect(mon.destination.plan).toBe('TOU');
    expect(mon.destRateCents).toBeCloseTo(RATES_2025.tou.offPeak, 9);
  });

  it('reports Tiered as a REAL zero, not as an unknown', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'Tiered',
      season: 'Winter',
      blockHours: [7, 8, 9],
    });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];
    expect(period.plan).toBe('Tiered');
    expect(period.behaviourVerdict).toBe('flat-rate');
    expect(period.behaviourMiss).toBe(0);
    expect(period.moves).toHaveLength(0);
    expect(period.behaviourReason).toBeTruthy();
    // …and it still counts on the plan lever, so the total is not suppressed.
    expect(h.behaviourMiss).toBe(0);
    expect(h.totalMiss).toBeCloseTo(h.planMiss ?? 0, 9);
  });

  it('claims nothing when there is no recurring block — and invents no number', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      baseKwh: 0.4,
    });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];
    expect(period.behaviourVerdict).toBe('nothing-to-shift');
    expect(period.behaviourMiss).toBe(0);
    expect(period.moves).toHaveLength(0);
    expect(period.behaviourReason).toBeTruthy();
  });

  it('leaves both levers null when the plan cannot be known', () => {
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
    expect(period.behaviourVerdict).toBe('unknown');
    expect(period.behaviourMiss).toBeNull();
    expect(h.totalMiss).toBeNull();
    expect(h.lever).toBe('unknown');
  });

  it('excludes a period the readings do not cover — from BOTH totals', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
    });
    // Only the first 10 days of readings: 36% coverage.
    const partial = rows.filter((r) => r.timestamp < summaries[0].start + 10 * 86400);
    const h = buildHindsight(summaries, partial, []);
    const period = h.periods[0];
    expect(period.counted).toBe(false);
    expect(period.planVerdict).toBe('skipped');
    expect(period.planMiss).toBeNull();
    expect(period.behaviourMiss).toBeNull();
    expect(period.behaviourVerdict).toBe('skipped');
    expect(h.planMiss).toBeNull();
    expect(h.behaviourMiss).toBeNull();
    expect(h.totalMiss).toBeNull();
    expect(h.emptyReason).toBe('nothing-countable');
  });

  it('sums over several periods and ranks the worst first', () => {
    const a = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
      blockKwh: 3.0,
    });
    const b = fixture('2026-12-01', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
      blockKwh: 1.0,
    });
    const h = buildHindsight([...a.summaries, ...b.summaries], [...a.rows, ...b.rows], []);
    expect(h.periods).toHaveLength(2);
    expect(h.behaviourPeriods).toBe(2);
    expect(h.behaviourMiss).toBeCloseTo(
      h.periods.reduce((acc, p) => acc + (p.behaviourMiss ?? 0), 0),
      9,
    );
    // Worst first: the 3 kWh/h house left more on the table than the 1 kWh/h one.
    expect(h.periods[0].kwh).toBeGreaterThan(h.periods[1].kwh);
    expect(h.worstPeriod?.summary.start).toBe(a.summaries[0].start);
    expect(h.shiftableKwh).toBeCloseTo(
      h.moves.reduce((acc, m) => acc + m.kwh, 0),
      9,
    );
    expect(h.moves.length).toBeGreaterThan(0);
    for (const m of h.moves) expect(m.saving).toBeGreaterThan(MIN_MOVE_SAVING);
  });

  it('places a straddling period with the rate set each reading was really on', () => {
    const { rows, summaries } = fixture('2026-10-19', 28, {
      plan: 'TOU',
      season: 'Summer',
      blockHours: [7, 8, 9],
      blockKwh: 3.0,
      rates: RATE_HISTORY,
    });
    const h = buildHindsight(summaries, rows, []);
    const period = h.periods[0];
    expect(period.straddlesSeason).toBe(true);
    const before = rows.find((r) => r.dayStr === '2026-10-20' && r.dateObj.getHours() === 7)!;
    const after = rows.find((r) => r.dayStr === '2026-11-04' && r.dateObj.getHours() === 7)!;
    expect(before.activeRateSet.effectiveDate).toBe('2025-11-01');
    expect(after.activeRateSet.effectiveDate).toBe('2026-11-01');

    // The block's actual cost is exactly the sum of each reading priced with
    // its OWN day's rate set — recomputed here, independently of the engine.
    const move = period.moves.find((m) => m.id === 'tue-7-10')!;
    expect(move).toBeDefined();
    const blockRows = rows.filter(
      (r) => r.dateObj.getDay() === 2 && r.dateObj.getHours() >= 7 && r.dateObj.getHours() < 10,
    );
    const expected = blockRows.reduce((acc, r) => acc + r.costTOU, 0);
    expect(move.actualCost).toBeCloseTo(expected, 9);
    expect(move.kwh).toBeCloseTo(
      blockRows.reduce((acc, r) => acc + r.usage_kwh, 0),
      9,
    );
    // The destination is priced on the same per-reading sets.
    const expectedDest = blockRows.reduce(
      (acc, r) => acc + (r.usage_kwh * r.activeRateSet.tou.offPeak) / 100,
      0,
    );
    expect(move.shiftedCost).toBeCloseTo(expectedDest, 9);
  });

  it('walks a declared timeline when the bill fingerprint is silent', () => {
    const rows = houseBlock('2026-11-02', 28, [7, 8, 9], 3.0);
    const items = [
      line('Monthly Basic Charge', 18.4),
      line('Standard Service Charge', 5.0, 4),
      line('Total Charges', 23.4),
    ];
    const timeline: PlanTimelineEntry[] = [
      { id: 'x', plan: 'TOU', from: '2026-10-01', to: '2026-12-31' },
    ];
    const commodity = planCostFor(rows, 'TOU');
    const summary = makeSummary('2026-11-02', 28, [
      ...items.slice(0, 2),
      line('Off Peak-Winter', Math.round(commodity * 100) / 100),
      line('Delivery', 75.5, 4),
      line('Regulatory', 8.6, 4),
      line('H.S.T. # 123456789', Math.round((commodity + 84.1) * 0.13 * 100) / 100, 5),
      line('Total Electricity Charges', Math.round((commodity + 84.1) * 100) / 100),
    ]);
    // Nothing in the itemized lines fingerprints a plan beyond the single
    // "Off Peak-Winter" line, which does: the timeline only has to agree.
    const h = buildHindsight([summary], rows, timeline);
    expect(h.periods[0].plan).toBe('TOU');
    expect(h.periods[0].origin).toBe('detected');
    expect(h.periods[0].behaviourMiss).not.toBeNull();
  });

  it('returns the empty shape for a file with no bills', () => {
    const h = buildHindsight([], [], []);
    expect(h.periods).toHaveLength(0);
    expect(h.totalMiss).toBeNull();
    expect(h.emptyReason).toBe('no-bills');
    expect(h.note).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- *
 * pickLever
 * -------------------------------------------------------------------------- */

describe('pickLever — which lever actually mattered', () => {
  it('names the bigger lever and calls a near-tie a tie', () => {
    expect(pickLever(300, 100)).toBe('plan');
    expect(pickLever(100, 300)).toBe('behaviour');
    expect(pickLever(100, 100.5)).toBe('neither');
    expect(pickLever(0.2, 0.4)).toBe('neither');
  });

  it('never calls a lever of zero dollars a winner over a real one', () => {
    expect(pickLever(-20, 5)).toBe('behaviour');
    expect(pickLever(-20, 0)).toBe('neither');
    expect(pickLever(0, 5)).toBe('behaviour');
  });

  it('is unknown — not zero — when a side could not be measured', () => {
    expect(pickLever(null, 10)).toBe('unknown');
    expect(pickLever(10, null)).toBe('unknown');
    expect(pickLever(null, null)).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- *
 * Honesty invariants that must hold for every fixture in this file
 * -------------------------------------------------------------------------- */

describe('honesty invariants', () => {
  it('every reported move is strictly cheaper after the shift', () => {
    const cases = [
      fixture('2026-11-02', 28, { plan: 'TOU', season: 'Winter', blockHours: [7, 8, 9], blockKwh: 3 }),
      fixture('2026-07-06', 28, { plan: 'TOU', season: 'Summer', blockHours: [11, 12, 13], blockKwh: 2 }),
      fixture('2026-11-02', 28, { plan: 'ULO', season: 'Winter', blockHours: [17, 18, 19, 20], blockKwh: 2 }),
      fixture('2026-10-19', 28, {
        plan: 'TOU',
        season: 'Summer',
        blockHours: [7, 8, 9],
        blockKwh: 3,
        rates: RATE_HISTORY,
      }),
    ];
    let seen = 0;
    for (const c of cases) {
      const report = buildHindsight(c.summaries, c.rows, []);
      for (const p of report.periods) {
        for (const m of p.moves) {
          seen += 1;
          expect(m.saving).toBeCloseTo(m.actualCost - m.shiftedCost, 9);
          expect(m.shiftedCost).toBeLessThan(m.actualCost);
          expect(m.saving).toBeGreaterThan(MIN_MOVE_SAVING);
          expect(m.weeksSeen).toBeGreaterThanOrEqual(3);
          expect(m.weeksSeen).toBeLessThanOrEqual(m.weeksAvailable);
          expect(m.consistencyCv).toBeLessThanOrEqual(0.4);
          expect(m.kwh).toBeGreaterThan(0);
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('a move never claims a saving on a block that is the destination itself', () => {
    const rows = hourly('2026-11-02', 28, () => 0.4);
    for (const plan of ['TOU', 'ULO', 'Tiered'] as const) {
      const scan = scanPeriodBlocks(rows, plan);
      for (const m of scan.moves) {
        expect(m.destRateCents).toBeLessThan(m.actualRateCents);
      }
    }
  });

  it('mother of all: the same bill priced by the engine twice is stable', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
    });
    const a = buildHindsight(summaries, rows, []);
    const b = buildHindsight(summaries, rows, []);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('destinationRateCents reads the reading’s own rate set', () => {
    const rows = houseBlock('2026-10-19', 28, [7, 8, 9], 3.0, 0.4, RATE_HISTORY);
    const october = rows.find((r) => r.dayStr === '2026-10-20')!;
    const november = rows.find((r) => r.dayStr === '2026-11-04')!;
    expect(destinationRateCents(october, 'offpeak-tou')).toBe(RATES_2025.tou.offPeak);
    expect(destinationRateCents(november, 'offpeak-tou')).toBe(RATES_2026.tou.offPeak);
    expect(destinationRateCents(november, 'overnight-ulo')).toBe(RATES_2026.ulo.overnight);
  });

  it('the bill the model explains is the bill the plan side judges', () => {
    const { rows, summaries } = fixture('2026-11-02', 28, {
      plan: 'TOU',
      season: 'Winter',
      blockHours: [7, 8, 9],
    });
    const totals = billTotals(summaries[0]);
    const h = buildHindsight(summaries, rows, []);
    expect(h.periods[0].switchRow.actual).toBeCloseTo(totals.payable, 6);
    // …and the model reproduces it, which is why the row is countable.
    expect(h.periods[0].counted).toBe(true);
    expect(Math.abs(h.periods[0].switchRow.modelDelta ?? 99)).toBeLessThanOrEqual(1);
  });
});
