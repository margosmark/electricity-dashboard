/**
 * Wave L — the bill half of a Green Button feed (UsageSummary).
 *
 * The fixture is SYNTHETIC (the owner's own export must never enter the
 * repo — see tests/fixtures/README.md), but it is built to reproduce the
 * numbers the 2026-10-07 data audit published as three-period sums, so the
 * headline assertions below are the audited ones:
 *
 *   • money is hundred-thousandths of a dollar — the ESPI scale — so the
 *     three periods' "Total Electricity Charges" sum to $1,365.03;
 *   • each period is self-consistent: total = commodity + delivery +
 *     regulatory, HST = 13% of it, rebate = -23.5% of it;
 *   • itemKind codes are kept raw and grouping keys off `note` — the
 *     published schemas do not agree on what the codes mean.
 *
 * The real Oakville file is exercised only by the deployed browser check.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BILL_AMOUNT_SCALE,
  PERIOD_MIN_COVERAGE,
  billWindow,
  billedKwh,
  billPeriodLabel,
  billTotals,
  classifyBillLine,
  commodityVerdict,
  currencyLabel,
  chargeDecomposition,
  deriveExtraCharges,
  deliverySplit,
  parseGreenButtonFeed,
  parseUsageSummaries,
  reconcileBillingPeriods,
  type ProcessedPoint,
  type RateSet,
  type UsageSummary,
} from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const OAKVILLE = read('usage-summary-synthetic.xml');
const summaries = parseUsageSummaries(OAKVILLE);

const line = (s: UsageSummary, note: string) => {
  const hit = s.items.find((i) => i.note === note);
  if (!hit) throw new Error(`no line item named ${note} in period ${s.startDate}`);
  return hit;
};

const rateSet: RateSet = {
  effectiveDate: '2023-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** One reading per day across a period, at a fixed total plan cost (and a
 *  fixed kWh per day — Tiered needs real usage to reach its threshold). */
function rowsFor(
  summary: UsageSummary,
  totalCost: number,
  days: number,
  kwhPerDay = 1,
): ProcessedPoint[] {
  const { start } = billWindow(summary);
  const out: ProcessedPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const timestamp = start + i * 86400 + 3600;
    out.push({
      timestamp,
      usage_kwh: kwhPerDay,
      dateObj: new Date(timestamp * 1000),
      dayStr: new Date(timestamp * 1000).toISOString().slice(0, 10),
      hourStr: '01:00',
      touCategory: 'Off-Peak',
      uloCategory: 'Overnight',
      isWinter: false,
      costTOU: totalCost / days,
      costTiered: kwhPerDay * 0.12, // tier 1 only — the field is never summed
      costULO: 0,
      activeRateSet: rateSet,
    });
  }
  return out;
}

/* -------------------------------------------------------------- the file -- */

describe('the real Oakville bill, parsed', () => {
  it('finds all three UsageSummary periods, oldest first', () => {
    expect(summaries).toHaveLength(3);
    expect(summaries.map((s) => s.startDate)).toEqual(['2026-05-25', '2026-06-23', '2026-07-22']);
    expect(summaries.every((s) => s.duration === 2505600)).toBe(true); // 29 days
    expect(summaries.every((s) => s.days === 29)).toBe(true);
    expect(summaries[0].endDate).toBe('2026-06-23');
    expect(summaries[0].source).toBe('UsageSummary');
  });

  it('reads CAD and the money scale the schema defines (÷100,000)', () => {
    expect(summaries[0].currency).toBe(124);
    expect(currencyLabel(summaries[0].currency)).toBe('CAD');
    expect(currencyLabel(840)).toBe('USD');
    expect(currencyLabel(999)).toBe('ISO 999');

    const total = line(summaries[0], 'Total Electricity Charges');
    expect(total.rawAmount).toBe(49745000); // 497.45 × 100,000
    expect(BILL_AMOUNT_SCALE).toBe(100000);
    expect(total.amount).toBeCloseTo(497.45, 6);
  });

  it('keeps every line item with its note verbatim and its raw itemKind', () => {
    expect(summaries[0].items).toHaveLength(21);
    expect(line(summaries[0], 'H.S.T. # 123456789').itemKind).toBe(5);
    expect(line(summaries[0], 'Delivery').itemKind).toBe(4);
    expect(line(summaries[0], 'Ontario Electricity Rebate').itemKind).toBe(8);
    expect(line(summaries[0], 'Off Peak-Summer').itemKind).toBe(10);
    expect(line(summaries[0], 'Off Peak-Summer').amount).toBeCloseTo(195.53, 6);
    expect(line(summaries[0], 'Ontario Electricity Rebate').amount).toBeCloseTo(-116.9, 6);
    // the informational lines carry a measurement instead of an amount
    const offUsage = line(summaries[0], 'Off Peak-Summer Usage');
    expect(offUsage.amount).toBe(0);
    expect(offUsage.measurement?.scaled).toBeCloseTo(1800, 6);
    expect(offUsage.measurement?.uom).toBe(72);
    const days = line(summaries[0], 'Number of days in bill period');
    expect(days.measurement?.scaled).toBe(29);
    expect(days.measurement?.uom).toBe(114);
  });

  it('adds up per period the way the bill does', () => {
    const [p0, p1, p2] = summaries;
    expect(billTotals(p0)).toMatchObject({
      commodity: expect.closeTo(383.05, 2),
      delivery: expect.closeTo(102.78, 2),
      regulatory: expect.closeTo(11.62, 2),
      tax: expect.closeTo(64.67, 2),
      credit: expect.closeTo(-116.9, 2),
      total: expect.closeTo(497.45, 2),
      preRebate: expect.closeTo(562.12, 2),
      payable: expect.closeTo(445.22, 2),
    });
    expect(billTotals(p1).total).toBeCloseTo(403.58, 2);
    expect(billTotals(p1).payable).toBeCloseTo(361.21, 2);
    expect(billTotals(p2).total).toBeCloseTo(464.0, 2);
    expect(billTotals(p2).payable).toBeCloseTo(415.28, 2);
    expect(billTotals(p2).commodity).toBeCloseTo(347.2, 2);
    expect(billTotals(p0).other).toBeCloseTo(0, 6); // nothing fell through
  });

  it('reproduces the audited totals across the three periods', () => {
    const sum = (pick: (s: UsageSummary, note: string) => number, note: string) =>
      summaries.reduce((t, s) => t + pick(s, note), 0);
    const amount = (s: UsageSummary, note: string) => line(s, note).amount ?? 0;

    expect(sum(amount, 'Total Electricity Charges')).toBeCloseTo(1365.03, 2);
    expect(sum(amount, 'Delivery')).toBeCloseTo(311.61, 2);
    expect(sum(amount, 'Ontario Electricity Rebate')).toBeCloseTo(-320.78, 2);
    expect(sum(amount, 'Regulatory Charges')).toBeCloseTo(45.15, 2);
    expect(sum(amount, 'Off Peak-Summer')).toBeCloseTo(530.74, 2);
    expect(sum(amount, 'Mid Peak-Summer')).toBeCloseTo(218.71, 2);
    expect(sum(amount, 'On Peak-Summer')).toBeCloseTo(258.82, 2);
    const hst = (s: UsageSummary) =>
      s.items
        .filter((i) => classifyBillLine(i) === 'tax')
        .reduce((t, i) => t + (i.amount ?? 0), 0);
    expect(summaries.reduce((t, s) => t + hst(s), 0)).toBeCloseTo(177.46, 2);

    // commodity + delivery + regulatory IS "Total Electricity Charges"
    const t = summaries.map(billTotals);
    expect(t[0].commodity + t[0].delivery + t[0].regulatory).toBeCloseTo(t[0].total, 2);
    // HST is 13% of that subtotal — the same base calculateTrueBill taxes
    expect(t[0].tax / t[0].total).toBeCloseTo(0.13, 3);
    expect(t[2].tax / t[2].total).toBeCloseTo(0.13, 3);
  });

  it('reports billed kWh that the interval readings can be checked against', () => {
    expect(billedKwh(summaries[0])).toBeCloseTo(2650, 3);
    expect(billedKwh(summaries[1])).toBeCloseTo(2790, 3);
    expect(billedKwh(summaries[2])).toBeCloseTo(2640, 3);
    // the three TOU "… Usage" lines are the whole billed quantity
    for (const s of summaries) {
      const parts = s.items
        .filter((i) => /usage$/.test(i.note.trim().toLowerCase()))
        .reduce((t, i) => t + (i.measurement?.scaled ?? 0), 0);
      expect(parts).toBeCloseTo(billedKwh(s)!, 6);
    }
    expect(summaries[0].consumption?.scaled).toBeCloseTo(2650, 3);
  });

  it('labels periods the way the audit did', () => {
    expect(billPeriodLabel(summaries[0].start, summaries[0].duration)).toBe('May 25, 2026 – Jun 23');
    expect(billPeriodLabel(summaries[2].start, summaries[2].duration)).toBe('Jul 22, 2026 – Aug 20');
  });

  it('reads the billed window off the meter reads, not off billingPeriod', () => {
    // ESPI's billingPeriod is a coarse 00:00Z stamp; the bill itself carries
    // the reads. Reconciling against the coarse stamp puts half a day of
    // readings either side of what was billed into the comparison.
    const s = summaries[0];
    const window = billWindow(s);
    expect(window.start).not.toBe(s.start);
    expect(window.start).toBe(s.start + 18048); // the file's read time of day
    expect(window.end - window.start).toBe(s.duration);
    expect(Math.round((window.end - window.start) / 86400)).toBe(29);
  });

  it('falls back to billingPeriod when the file states no reads', () => {
    const s = { ...summaries[0], items: summaries[0].items.filter((i) => !/read date/i.test(i.note)) };
    expect(billWindow(s)).toEqual({ start: s.start, end: s.start + s.duration });
  });

  it('rejects a read span that does not describe this period (rate-straddling bill)', () => {
    // Oakville writes the Nov 1 / May 1 season boundary of a straddling bill
    // as a read pair, so "previous → current" spans only the first season
    // block (~7 days) instead of the billed period. Taking that at face value
    // silently truncates every downstream comparison — Wave P found three
    // such bills in the 24-period export, each modeling ~80% low while still
    // reporting "full coverage". Reads win only when their span matches the
    // billed period (within a day); otherwise the coarse stamp is safer.
    const base = summaries[0];
    const prev = base.items.find((i) => /previous read date/i.test(i.note));
    expect(prev).toBeDefined();
    const straddler: UsageSummary = {
      ...base,
      items: base.items.map((i) =>
        /current read date/i.test(i.note) && i.measurement
          ? { ...i, measurement: { ...i.measurement, scaled: (prev?.measurement?.scaled ?? 0) + 7 * 86400 } }
          : i,
      ),
    };
    expect(billWindow(straddler)).toEqual({ start: base.start, end: base.start + base.duration });

    // A day of clock skew on an otherwise-matching span still wins — that is
    // exactly what BILL_WINDOW_TOLERANCE exists for.
    const skewed: UsageSummary = {
      ...base,
      items: base.items.map((i) =>
        /current read date/i.test(i.note) && i.measurement
          ? { ...i, measurement: { ...i.measurement, scaled: i.measurement.scaled + 3600 } }
          : i,
      ),
    };
    const w = billWindow(skewed);
    expect(w.start).toBe(base.start + 18048);
    expect(w.end - w.start).toBe(base.duration + 3600);
  });
});

/* ----------------------------------------------------------- tolerance --- */

describe('other feeds', () => {
  it('reads a bill with no line items at all (Green Button Connect standin)', () => {
    const [only] = parseUsageSummaries(read('utility-espi-prefixed-standin.xml'));
    expect(only).toBeDefined();
    expect(only.items).toHaveLength(0);
    expect(only.billToDate).toBeCloseTo(2.84259, 5); // 284259 ÷ 100000
    expect(currencyLabel(only.currency)).toBe('USD');
    expect(only.consumption?.scaled).toBe(0);
  });

  it('reads ElectricPowerUsageSummary under its schema name too', () => {
    const [only] = parseUsageSummaries(read('green-button-alliance-sample.xml'));
    expect(only).toBeDefined();
    expect(only.source).toBe('ElectricPowerUsageSummary');
    expect(only.billLastPeriod).toBeCloseTo(22.08, 2);
    expect(only.currency).toBe(840);
    expect(only.items).toHaveLength(0);
  });

  it('returns nothing for a feed without bills, and still parses its readings', () => {
    const feed = parseGreenButtonFeed(read('synthetic.xml'));
    expect(feed.summaries).toEqual([]);
    expect(feed.localTime).toBeNull();
    expect(feed.groups.reduce((n, g) => n + g.readings.length, 0)).toBeGreaterThan(0);
  });

  it('picks up the feed clock alongside the bills, in one parse', () => {
    const feed = parseGreenButtonFeed(OAKVILLE);
    expect(feed.summaries).toHaveLength(3);
    expect(feed.localTime).toEqual({
      tzOffset: -18000,
      dstOffset: 3600,
      dstStartRule: '360E2000',
      dstEndRule: 'B40E2000',
    });
    expect(feed.groups.reduce((n, g) => n + g.readings.length, 0)).toBe(0); // readings stripped
  });
});

/* ------------------------------------------------------ classification ---- */

describe('line-item classification keys off the note', () => {
  const item = (note: string, amount: number | null = 10) => ({
    note,
    amount,
    rawAmount: amount === null ? null : amount * BILL_AMOUNT_SCALE,
    itemKind: null,
    unitCost: null,
    measurement: null,
  });

  it('files the wording Oakville actually uses', () => {
    expect(classifyBillLine(item('Total Electricity Charges'))).toBe('total');
    expect(classifyBillLine(item('Delivery'))).toBe('delivery');
    expect(classifyBillLine(item('Distribution'))).toBe('delivery');
    expect(classifyBillLine(item('Regulatory Charges'))).toBe('regulatory');
    expect(classifyBillLine(item('H.S.T. # 123'))).toBe('tax');
    expect(classifyBillLine(item('Ontario Electricity Rebate', -10))).toBe('credit');
    expect(classifyBillLine(item('Off Peak-Summer'))).toBe('commodity');
    expect(classifyBillLine(item('Mid Peak-Summer'))).toBe('commodity');
    expect(classifyBillLine(item('On Peak-Summer'))).toBe('commodity');
    expect(classifyBillLine(item('On Peak-Summer Usage'))).toBe('info');
    expect(classifyBillLine(item('Current Meter Read'))).toBe('info');
    expect(classifyBillLine(item('Amount Due', 0))).toBe('info');
    expect(classifyBillLine(item('Balance Forward', 0))).toBe('info');
    // Wave O: a NON-ZERO "Amount Due" is still the bill's own summary line,
    // not a charge. It used to fall through to `other` (only the zero-amount
    // case reached `info`), which put the whole payable amount into the
    // "Other lines" slice of the money chart — every period's bar roughly
    // doubled on Mark's 24-period export, whose Amount Due lines are all
    // non-zero. `billTotals` reads it back as `amountDue`, which is what its
    // `info` branch has always been there to do.
    expect(classifyBillLine(item('Amount Due', 287.11))).toBe('info');
    expect(classifyBillLine(item('Balance Forward', 12.5))).toBe('info');
  });

  it('never folds an unknown wording into a total we would double-count', () => {
    expect(classifyBillLine(item('Mystery Surcharge'))).toBe('other');
    expect(classifyBillLine(item('Green Footprint Levy'))).toBe('other');
  });
});

/* ----------------------------------------------------------- reconcile ---- */

describe('estimate vs actual, per billing period', () => {
  it('does not pretend to compare when there are no readings', () => {
    const [rec] = reconcileBillingPeriods(summaries, [], 'TOU');
    expect(rec.comparable).toBe(false);
    expect(rec.delta).toBeNull();
    expect(commodityVerdict(rec)).toBe('unknown');
    expect(rec.coverage).toBe(0);
    expect(rec.commodityActual).toBeCloseTo(383.05, 2);
  });

  it('passes when our priced readings land within a dollar of the bill', () => {
    const p2 = summaries[2];
    const billed = billTotals(p2).commodity;
    const rec = reconcileBillingPeriods([p2], rowsFor(p2, billed, p2.days), 'TOU')[0];
    expect(rec.coverage).toBeCloseTo(1, 6);
    expect(rec.comparable).toBe(true);
    expect(rec.delta).toBeCloseTo(0, 6);
    expect(commodityVerdict(rec)).toBe('match');
    expect(rec.rows).toHaveLength(29);
    expect(rec.meteredKwh).toBeCloseTo(29, 6);
  });

  it('flags a rate miss loudly when the estimate is off by more than a dollar', () => {
    const p2 = summaries[2];
    const rec = reconcileBillingPeriods(
      [p2],
      rowsFor(p2, billTotals(p2).commodity + 15, p2.days),
      'TOU',
    )[0];
    expect(rec.delta).toBeCloseTo(15, 6);
    expect(commodityVerdict(rec)).toBe('off');
  });

  it('refuses to compare a half-covered period (missing data is not a rate miss)', () => {
    const p2 = summaries[2];
    const rec = reconcileBillingPeriods([p2], rowsFor(p2, 999.0, 10), 'TOU')[0];
    expect(rec.coverage).toBeLessThan(PERIOD_MIN_COVERAGE);
    expect(rec.comparable).toBe(false);
    expect(rec.delta).toBeNull();
    expect(commodityVerdict(rec)).toBe('unknown');
    expect(rec.commodityEstimate).not.toBeNull(); // we did price it — we just won't compare
  });

  it('prices Tiered with the month-scoped tier-2 threshold, not tier 1', () => {
    // 2,900 kWh over the 2026-07-22 period (10 days in July, 19 in August).
    // Each month's threshold is prorated to the days the readings cover, so
    // most of it bills at tier 2 (14.2¢) — the per-reading `costTiered` field
    // is tier 1 only and would say 2,900 × 12¢ = $348.00.
    const p2 = summaries[2];
    const rows = rowsFor(p2, 0, p2.days, 100);
    const rec = reconcileBillingPeriods([p2], rows, 'Tiered')[0];
    const thJul = 600 * (10 / 30.4);
    const thAug = 600 * (19 / 30.4);
    const expected =
      thJul * 0.12 + (1000 - thJul) * 0.142 + thAug * 0.12 + (1900 - thAug) * 0.142;
    expect(rec.commodityEstimate).toBeCloseTo(expected, 6);
    expect(Math.round(rec.commodityEstimate! * 100) / 100).toBe(399.21);
    expect(rec.commodityEstimate).not.toBeCloseTo(2900 * 0.12, 1);
    expect(rec.meteredKwh).toBeCloseTo(2900, 6);
  });
});

/* ------------------------------------------------------------- prefill ---- */

describe('True Bill inputs derived from the file', () => {
  it('derives the four Wave B fields from the newest period', () => {
    const derived = deriveExtraCharges(summaries)!;
    expect(derived).not.toBeNull();
    expect(derived.source.startDate).toBe('2026-07-22');
    expect(derived.label).toBe('Jul 22, 2026 – Aug 20');
    // delivery fits a real fixed + variable split across the three periods
    expect(derived.fit.mode).toBe('split');
    expect(derived.fit.periods).toBe(3);
    expect(derived.charges.deliveryFlat).toBe('35.88');
    expect(derived.charges.deliveryPerKwh).toBe('0.0252');
    expect(derived.charges.regulatoryPerKwh).toBe('0.0054'); // 14.28 / 2640
    expect(derived.charges.hstPct).toBe('13'); // 60.32 / 464.00
    expect(derived.kwh).toBeCloseTo(2640, 3);
  });

  it('falls back to one blended rate when there are too few periods to fit', () => {
    const derived = deriveExtraCharges(summaries.slice(0, 2))!;
    expect(derived.fit.mode).toBe('blended');
    expect(derived.charges.deliveryFlat).toBe('');
    expect(derived.charges.deliveryPerKwh).toBe('0.0381'); // 106.31 / 2790
  });

  it('derives nothing from a feed with no bill, or a bill with no charges', () => {
    expect(deriveExtraCharges([])).toBeNull();
    expect(deriveExtraCharges(parseUsageSummaries(read('green-button-alliance-sample.xml')))).toBeNull();
  });

  it('reports the delivery split as amortized fixed-vs-variable, or says why not', () => {
    const split = deliverySplit(summaries)!;
    expect(split.mode).toBe('split');
    expect(split.flat).toBe(35.88);
    expect(split.perKwh).toBe(0.0252);
    expect(split.maxResidual).toBeLessThanOrEqual(0.5);
    expect(split.periods).toBe(3);

    const blended = deliverySplit(summaries.slice(0, 1))!;
    expect(blended.mode).toBe('blended');
    expect(blended.flat).toBeNull();
    expect(blended.perKwh).toBeCloseTo(102.78 / 2650, 4);
  });
});

/* ==========================================================================
 * Wave T slice 3 — the fixed-vs-volume decomposition of a bill line.
 *
 * Three outcomes, and the point of the middle one is that it is REACHABLE:
 * a split that misses by more than CHARGE_FIT_MAX_RESIDUAL_SHARE of this
 * period's charge is refused and says so, instead of answering "can I reduce
 * this?" with a number that does not survive the question.
 * ========================================================================== */

/** One period's delivery line, multiplied — a utility that repriced itself. */
function withDeliveryBumped(index: number, by: number): UsageSummary[] {
  return summaries.map((summary, i) =>
    i !== index
      ? summary
      : {
          ...summary,
          items: summary.items.map((item) =>
            /delivery/i.test(item.note)
              ? { ...item, amount: item.amount === null ? null : item.amount * by }
              : item,
          ),
        },
  );
}

describe('chargeDecomposition', () => {
  it('splits delivery into the part owed at zero kWh and the part that is not', () => {
    const d = chargeDecomposition(summaries, [], 'delivery')!;
    expect(d.status).toBe('split');
    expect(d.periods).toBe(3);
    expect(d.amount).toBeCloseTo(billTotals(summaries[summaries.length - 1]).delivery, 6);
    expect(d.kwh).toBeCloseTo(billedKwh(summaries[summaries.length - 1])!, 6);
    // The two halves ARE the amount: nothing is created or lost in the split.
    expect(d.fixed! + d.variable!).toBeCloseTo(d.amount, 2);
    expect(d.fixedShare!).toBeGreaterThan(0);
    expect(d.fixedShare!).toBeLessThan(1);
    expect(d.blendedCentsPerKwh).toBeCloseTo((d.amount / d.kwh) * 100, 2);

    // The sentence the card leads with, in full.
    expect(d.headline).toContain(`Of your $${d.amount.toFixed(2)} delivery this period`);
    expect(d.headline).toContain(`$${d.fixed!.toFixed(2)} is fixed (you'd pay it at 0 kWh)`);
    expect(d.headline).toContain(`$${d.variable!.toFixed(2)} is volume-driven`);
    expect(d.detail).toContain('across 3 billing periods');
  });

  it('refuses the split — and shows its working — when the fit misses by too much', () => {
    const d = chargeDecomposition(withDeliveryBumped(1, 1.5), [], 'delivery')!;
    expect(d.status).toBe('rejected');
    expect(d.headline).toBe('Delivery is not linearly decomposable from this data.');
    // The attempt is still reported: the fit, its worst miss, and the bar.
    expect(d.fit).not.toBeNull();
    expect(d.fit!.residualShare).toBeGreaterThan(0.05);
    expect(d.detail).toContain(`worst miss is $${d.fit!.maxResidual.toFixed(2)}`);
    expect(d.detail).toContain('over the 5% bar');
    expect(d.detail).toContain(d.fit!.worstPeriod!);
    // No fixed/variable numbers are invented — only the blended rate survives.
    expect(d.fixed).toBeNull();
    expect(d.variable).toBeNull();
    expect(d.blendedCentsPerKwh).toBeGreaterThan(0);
  });

  it('says there was nothing to fit when there are too few periods', () => {
    const d = chargeDecomposition(summaries.slice(0, 1), [], 'delivery')!;
    expect(d.status).toBe('unavailable');
    expect(d.periods).toBe(1);
    expect(d.fit).toBeNull();
    expect(d.headline).toBe('Delivery cannot be split into fixed and volume-driven from this data.');
    expect(d.detail).toContain('only 1 billing period');
    expect(d.blendedCentsPerKwh).toBeCloseTo((d.amount / d.kwh) * 100, 2);
  });

  it('gives regulatory the same treatment, under its own name', () => {
    const d = chargeDecomposition(summaries, [], 'regulatory')!;
    expect(d.line).toBe('regulatory');
    expect(d.amount).toBeCloseTo(billTotals(summaries[summaries.length - 1]).regulatory, 6);
    expect(d.headline.startsWith('Regulatory charges')).toBe(true);
    if (d.status === 'split') {
      expect(d.fixed! + d.variable!).toBeCloseTo(d.amount, 2);
    } else {
      expect(d.headline).toContain('not linearly decomposable');
    }
  });

  it('has nothing to say for a file with no bill at all', () => {
    expect(chargeDecomposition([], [], 'delivery')).toBeNull();
    expect(chargeDecomposition(parseUsageSummaries(read('green-button-alliance-sample.xml')), [], 'delivery')).toBeNull();
  });

  it('shares ONE tolerance bar with the per-line note, so the two cannot disagree', () => {
    // A fit that fits is quoted as a split by BOTH the headline card and the
    // delivery line's own note (deliverySplit reads the same function).
    const good = chargeDecomposition(summaries, [], 'delivery')!;
    expect(good.status).toBe('split');
    expect(deliverySplit(summaries)!.mode).toBe('split');
    expect(deliverySplit(summaries)!.flat).toBeCloseTo(good.fixed!, 2);

    // ...and a fit that does not fit is refused by BOTH.
    const bad = chargeDecomposition(withDeliveryBumped(1, 1.5), [], 'delivery')!;
    expect(bad.status).toBe('rejected');
    expect(deliverySplit(withDeliveryBumped(1, 1.5))!.mode).toBe('blended');
  });
});
