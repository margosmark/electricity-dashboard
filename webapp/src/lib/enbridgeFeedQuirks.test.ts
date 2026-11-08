/**
 * Two Enbridge-specific feed quirks (epic t_ace035c5, hazards 2 and 3).
 *
 * A. THE CLOCK. Oakville's `LocalTimeParameters` is what the decoder assumes:
 *    seconds east (`tzOffset: -18000`) plus `DstRuleType` bitmaps
 *    (`dstStartRule: '360E2000'`). Enbridge sends the same element in a
 *    different shape: `tzOffset: -18` (seconds — an 18-second "Ontario" clock)
 *    and `dstStartRule: '69AD1E70'` / `dstEndRule: '6AE6E370'`, which are unix
 *    INSTANTS (1772953200 = 2026-03-08T07:00Z, 1794564976 = 2026-11-01T06:00Z
 *    — the 2026 US transitions) wearing a hex costume. Read as bitmaps they
 *    "decode" to June 26 at minute 61 and June 14 at 14:14:40, and the zone
 *    they build puts every exact-UTC-midnight period stamp a day early
 *    (`zone.dayKey(2026-01-27T00:00Z)` = 2026-01-26). Both values must now
 *    fail sanity and be DROPPED — the documented fallback is the device's own
 *    zone / UTC, and with no clock in hand the period dayKey is the UTC date
 *    the file literally states.
 *
 * B. THE NOTES. `classifyBillLine` was written against Oakville's wording
 *    (`Delivery`, `H.S.T.`, `On Peak-Summer`). Enbridge bills 37 lines in a
 *    gas vocabulary: without signatures, `Total Gas Charges ($)` lands in
 *    `other`, `Customer charge` lands in `other`, the negative `Gas Cost
 *    Adjustment ($)` lands in `credit`, and the `… Rate ¢/m3` lines — unit
 *    prices at powerOfTenMultiplier -4, i.e. 204037 x 10^-4 = 20.4037 CENTS
 *    per m3 — are summed into dollar buckets as if they were $20.40.
 *
 * FIXTURE POLICY: SYNTHETIC only (`tests/fixtures/enbridge-gas-synthetic.xml`,
 * generated from scrubbed data — tests/fixtures/README.md). The real EGD
 * export carries name, home address, account number, meter serial and
 * agreement id; it never enters the repo, a fixture, or an attachment.
 * Every figure below was verified against that real file locally (numbers
 * match the synthetic fixture period for period — it is a faithful stand-in).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  billTotals,
  classifyBillLine,
  decodeDstRule,
  parseGreenButtonFeed,
  resolveZone,
  type BillLineItem,
  type LocalTimeParams,
  type UsageSummary,
} from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const ENBRIDGE = read('enbridge-gas-synthetic.xml');
const OAKVILLE = read('usage-summary-synthetic.xml');

/** The ten billingPeriod stamps, exact UTC midnights, as the file states them. */
const PERIOD_STARTS = [
  '2025-12-25',
  '2026-01-27',
  '2026-02-26',
  '2026-03-26',
  '2026-04-28',
  '2026-05-27',
  '2026-06-24',
  '2026-07-27',
  '2026-08-27',
  '2026-09-25',
];

/** The clock Enbridge stamps in LocalTimeParameters (feed metadata, not PII). */
const ENBRIDGE_CLOCK: LocalTimeParams = {
  tzOffset: -18,
  dstOffset: 3600,
  dstStartRule: '69AD1E70',
  dstEndRule: '6AE6E370',
};

/** `yyyy-MM-dd` of a unix stamp in UTC — what a date-only stamp states. */
const utcDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

const item = (note: string, amount: number | null = 10): BillLineItem => ({
  note,
  amount,
  rawAmount: amount === null ? null : Math.round(amount * 1000),
  itemKind: null,
  unitCost: null,
  measurement: null,
});

const line = (s: UsageSummary, note: string) => {
  const hit = s.items.find((i) => i.note === note);
  if (!hit) throw new Error(`no line item named ${note} in period ${s.startDate}`);
  return hit;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ A ---- */

describe('A. the feed-supplied clock is not the shape the decoder assumes', () => {
  const feed = parseGreenButtonFeed(ENBRIDGE);

  it('drops the whole clock block: an 18-second offset is not a zone', () => {
    // The documented fallback when no trustworthy clock exists: the device's
    // own zone / UTC. -18 s is finite and inside isClockOffset's ±86400 bound,
    // so the bound alone would have believed it.
    expect(feed.localTime).toBeNull();
    expect(resolveZone(feed.localTime)).toBeNull();
    // …and a clock persisted by an earlier import (useDashboard keeps
    // LocalTimeParameters in localStorage and shape-checks only) is refused
    // at resolveZone too, not just at parse time.
    expect(resolveZone(ENBRIDGE_CLOCK)).toBeNull();
  });

  it('drops both unix-instant DST rules — no accepted rule can have minute > 59', () => {
    // The two values the file carries: seconds-in-hour 3696 (minute 61) and
    // 880 (14:14:40) — neither is a transition any timezone regime has.
    expect(decodeDstRule('69AD1E70')).toBeNull();
    expect(decodeDstRule('6AE6E370')).toBeNull();

    // Every field bound the bitmap layout documents, enforced: sweep the
    // seconds-in-hour field across its full 12-bit range for a spread of
    // month/operator/weekday/hour combinations. Whatever survives must be a
    // rule a clock could actually fire: minute ≤ 59 (i.e. secondsInHour ≤ 3599).
    const months = [1, 6, 12];
    const operators = [0, 4, 7];
    const weekdays = [1, 7];
    const hours = [0, 17, 23];
    let accepted = 0;
    for (const month of months) {
      for (const operator of operators) {
        for (const dayOfWeek of weekdays) {
          for (const hour of hours) {
            for (let secondsInHour = 0; secondsInHour < 4096; secondsInHour += 1) {
              const hex = (
                ((month << 28) |
                  (operator << 25) |
                  (1 << 20) |
                  (dayOfWeek << 17) |
                  (hour << 12) |
                  secondsInHour) >>>
                0
              )
                .toString(16)
                .toUpperCase()
                .padStart(8, '0');
              const rule = decodeDstRule(hex);
              if (!rule) continue;
              accepted += 1;
              expect(rule.month).toBeGreaterThanOrEqual(1);
              expect(rule.month).toBeLessThanOrEqual(12);
              expect(rule.hour).toBeLessThanOrEqual(23);
              expect(rule.minute).toBeLessThanOrEqual(59);
              expect(rule.second).toBeLessThanOrEqual(59);
            }
          }
        }
      }
    }
    // The sweep is not vacuous: Oakville's own rules decode in it.
    expect(accepted).toBeGreaterThan(0);
    expect(decodeDstRule('360E2000')).toEqual({
      month: 3,
      operator: 3,
      dayOfMonth: 0,
      dayOfWeek: 7,
      hour: 2,
      minute: 0,
      second: 0,
    });
    expect(decodeDstRule('B40E2000')).toEqual({
      month: 11,
      operator: 2,
      dayOfMonth: 0,
      dayOfWeek: 7,
      hour: 2,
      minute: 0,
      second: 0,
    });
  });

  it('keeps Oakville’s real bitmap path exactly as it was', () => {
    const oakville = parseGreenButtonFeed(OAKVILLE);
    expect(oakville.localTime).toEqual({
      tzOffset: -18000,
      dstOffset: 3600,
      dstStartRule: '360E2000',
      dstEndRule: 'B40E2000',
    });
    const zone = resolveZone(oakville.localTime);
    expect(zone).not.toBeNull();
    // The 2026 transitions the file alone implies: Sun Mar 8 02:00 EST,
    // Sun Nov 1 02:00 EDT — a zone whose dayKey follows EST/EDT, not UTC.
    expect(zone!.transitions(2026)).toEqual({
      start: Date.UTC(2026, 2, 8, 7, 0, 0) / 1000,
      end: Date.UTC(2026, 10, 1, 6, 0, 0) / 1000,
    });
    expect(zone!.dayKey(Date.UTC(2026, 6, 22, 3, 0) / 1000)).toBe('2026-07-21'); // 23:00 EDT
  });

  it('reads every period dayKey as the UTC date in the file', () => {
    expect(feed.summaries).toHaveLength(10);
    expect(feed.summaries.map((s) => s.startDate)).toEqual(PERIOD_STARTS);

    // Exactly what a consumer computes for a period stamp with the feed's
    // clock in hand: the zone's dayKey when there is one, the stamp's own
    // UTC date when there is not. Pre-fix, the -18 s zone answered
    // 2026-01-26 for 2026-01-27T00:00Z (9 of the 10 stamps a day early);
    // with the clock dropped there is nothing left to shift them.
    const zone = resolveZone(feed.localTime);
    for (const s of feed.summaries) {
      const dayKey = zone ? zone.dayKey(s.start) : utcDate(s.start);
      expect(dayKey, `period ${s.startDate}`).toBe(s.startDate);
      expect(utcDate(s.start), `period ${s.startDate}`).toBe(s.startDate);
    }
    expect(utcDate(Date.UTC(2026, 0, 27) / 1000)).toBe('2026-01-27');
  });
});

/* ------------------------------------------------------------------ B ---- */

describe('B. bill-note grouping is Enbridge vocabulary, not Oakville’s', () => {
  it('files every Enbridge note into the right bucket', () => {
    expect(classifyBillLine(item('Gas Supply Charge'))).toBe('commodity');
    expect(classifyBillLine(item('Gas Service Provider Supply Charge ($)'))).toBe('info');
    expect(classifyBillLine(item('Gas Delivery Variable Charge'))).toBe('delivery');
    expect(classifyBillLine(item('Gas Transportation Charge ($)'))).toBe('delivery');
    expect(classifyBillLine(item('Transportation to Enbridge (LVB)'))).toBe('delivery');
    expect(classifyBillLine(item('Customer charge'))).toBe('delivery');
    expect(classifyBillLine(item('Gas Federal Carbon Charge'))).toBe('regulatory');
    expect(classifyBillLine(item('Gas Cost Adjustment ($)', -4.31))).toBe('regulatory');
    expect(classifyBillLine(item('Gas Cost Adjustment ($)', 1.31))).toBe('regulatory');
    expect(classifyBillLine(item('Gas Service Provider Admin Fee ($)'))).toBe('regulatory');
    expect(classifyBillLine(item('HST ($)'))).toBe('tax');
    expect(classifyBillLine(item('Total Gas Charges ($)', 161.89))).toBe('total');
    expect(classifyBillLine(item('Amount Due', 175.76))).toBe('info');
    expect(classifyBillLine(item('Payments Received ($)', 0))).toBe('credit');
  });

  it('keeps every ¢/m3 rate line display-only — a price, never a dollar', () => {
    // 204037 with powerOfTenMultiplier -4 = 20.4037 cents per m3. Dollar
    // lines are x 10^-3, so a rate that reaches a bucket is summed 10,000
    // times wrong AND unitless.
    expect(classifyBillLine(item('Gas Supply Rate ¢/m3', 20.4037))).toBe('info');
    expect(classifyBillLine(item('Total Gas Supply Rate ¢/m3 (net)', 19.2334))).toBe('info');
    expect(classifyBillLine(item('Gas Cost Adjustment ¢/m3', -1.1703))).toBe('info');

    const feed = parseGreenButtonFeed(ENBRIDGE);
    const p1 = feed.summaries[0];
    expect(line(p1, 'Gas Supply Rate ¢/m3').amount).toBeCloseTo(20.4037, 4);
    expect(line(p1, 'Gas Supply Rate ¢/m3').rawAmount).toBe(204037);
  });

  it('bucket totals match the feed — the canonical 5-term identity, 10/10', () => {
    // supply + delivery-variable + GCA + customer + HST = Total Gas Charges,
    // to the cent, on every period (AC8). Bucketed here as
    // commodity + delivery + regulatory + tax — with `Gas Service Provider
    // Supply Charge ($)` display-only, because it restates `Gas Supply
    // Charge` byte-for-byte in all ten periods: counting it too is the
    // superseded 6-term double count (246.63 vs 161.89 in P1), which must
    // appear in no test and no UI.
    const expected = [
      { commodity: 84.74, delivery: 62.83, regulatory: -4.31, tax: 18.63, total: 161.89, due: 175.76 },
      { commodity: 79.17, delivery: 60.82, regulatory: -4.54, tax: 17.61, total: 153.06, due: 153.06 },
      { commodity: 55.09, delivery: 51.92, regulatory: -3.16, tax: 13.5, total: 117.35, due: 117.35 },
      { commodity: 32.22, delivery: 44.16, regulatory: -1.38, tax: 9.75, total: 84.75, due: 84.75 },
      { commodity: 19.93, delivery: 38.76, regulatory: -0.77, tax: 7.53, total: 65.45, due: 65.45 },
      { commodity: 61.57, delivery: 57.68, regulatory: -2.38, tax: 15.19, total: 132.06, due: 132.06 },
      { commodity: 26.71, delivery: 42.84, regulatory: 1.31, tax: 9.21, total: 80.07, due: 85.37 },
      { commodity: 48.06, delivery: 53.71, regulatory: 3.58, tax: 13.69, total: 119.04, due: 119.04 },
      { commodity: 33.5, delivery: 46.6, regulatory: 2.49, tax: 10.74, total: 93.33, due: 93.33 },
      { commodity: 17.45, delivery: 38.71, regulatory: 2.51, tax: 7.62, total: 66.29, due: 72.47 },
    ];

    const feed = parseGreenButtonFeed(ENBRIDGE);
    expect(feed.summaries).toHaveLength(expected.length);
    let sumTotal = 0;
    let sumDue = 0;

    feed.summaries.forEach((s, i) => {
      const want = expected[i];
      expect(s.startDate).toBe(PERIOD_STARTS[i]);
      const t = billTotals(s);
      expect(t.commodity, `${s.startDate} commodity`).toBeCloseTo(want.commodity, 5);
      expect(t.delivery, `${s.startDate} delivery`).toBeCloseTo(want.delivery, 5);
      expect(t.regulatory, `${s.startDate} regulatory`).toBeCloseTo(want.regulatory, 5);
      expect(t.tax, `${s.startDate} tax`).toBeCloseTo(want.tax, 5);
      expect(t.credit, `${s.startDate} credit`).toBe(0);
      expect(t.other, `${s.startDate} other`).toBe(0);
      expect(t.total, `${s.startDate} total`).toBeCloseTo(want.total, 5);
      expect(t.amountDue, `${s.startDate} amountDue`).toBeCloseTo(want.due, 5);

      // The identity the feed itself satisfies, 10/10 to the cent.
      expect(r2(t.commodity + t.delivery + t.regulatory + t.tax), `${s.startDate} identity`)
        .toBe(r2(want.total));

      // The provider-supply restatement never reaches a bucket: commodity is
      // `Gas Supply Charge` exactly, not twice it.
      expect(t.commodity, `${s.startDate} supply once`).toBeCloseTo(
        line(s, 'Gas Supply Charge').amount!, 5,
      );

      // Rate lines are the only ¢/m3 amounts in the file, and none of them
      // is inside any bucket (the identity above would not close otherwise).
      expect(r2(t.commodity + t.delivery + t.regulatory + t.tax + t.credit + t.other))
        .toBe(r2(want.total));

      sumTotal += t.total;
      sumDue += t.amountDue!;
    });

    // The feed's own headline sums (AC6/AC7), recomputed from bucket totals.
    expect(r2(sumTotal)).toBe(1073.29);
    expect(r2(sumDue)).toBe(1098.64);
  });

  it('leaves Oakville’s wording where it was', () => {
    expect(classifyBillLine(item('Total Electricity Charges', 1365.03))).toBe('total');
    expect(classifyBillLine(item('Delivery'))).toBe('delivery');
    expect(classifyBillLine(item('Regulatory Charges'))).toBe('regulatory');
    expect(classifyBillLine(item('H.S.T. # 123'))).toBe('tax');
    expect(classifyBillLine(item('Ontario Electricity Rebate', -23.5))).toBe('credit');
    expect(classifyBillLine(item('On Peak-Summer'))).toBe('commodity');
    expect(classifyBillLine(item('Off Peak-Summer Usage'))).toBe('info');
    expect(classifyBillLine(item('Mystery Surcharge'))).toBe('other');
  });
});
