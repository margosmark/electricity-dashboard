/**
 * The money scale a bill declares for itself (t_54d7dfdc).
 *
 * ESPI's Currency default is hundred-thousandths of a dollar, and Oakville
 * Hydro's money lines carry no `<measurement>` of their own, so
 * `BILL_AMOUNT_SCALE` is all they need: $497.45 arrives as 49745000. Enbridge
 * Gas restates the scale on every money line —
 * `measurement { powerOfTenMultiplier: -3, uom: 80 (money) }` with NO
 * `<value>`, because the number is the `<amount>` — so its $175.76 Amount Due
 * arrives as 175760, and dividing that by 100000 rendered every Enbridge bill
 * 100× small ($1.76) while every figure still passed `assertBillDollars`,
 * which can only bound the too-large direction: a $1.76 figure is a figure a
 * bill CAN hold, so no per-figure magnitude check can object to it.
 *
 * What pins the too-small direction is the file itself — the power of ten it
 * declares, cross-checked at parse time by `assertDeclaredBillScale`
 * (greenbutton/limits.ts) and asserted absolutely below through the app's own
 * funnel. The Enbridge block is SYNTHETIC, element-for-element from the
 * patterns in the real Extract; real XML never enters this repo (see
 * tests/fixtures/README.md).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BILL_AMOUNT_SCALE,
  billTotals,
  parseUsageSummaries,
  type UsageSummary,
} from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const PERIOD =
  '<espi:billingPeriod><espi:duration>2764800</espi:duration><espi:start>1766620800</espi:start></espi:billingPeriod>';

/** A feed with one UsageSummary built from `fields` — the house pattern for a
 *  synthetic bill (usageSummary.test.ts does the same). */
const summary = (fields: string) =>
  `<?xml version="1.0"?><feed><entry><content><espi:UsageSummary>${PERIOD}${fields}</espi:UsageSummary></content></entry></feed>`;

/** One `costAdditionalDetailLastPeriod`, in Enbridge's element order. */
const line = (fields: string) => `<espi:costAdditionalDetailLastPeriod>${fields}</espi:costAdditionalDetailLastPeriod>`;

/** Enbridge's money measurement: a power of ten, a unit of money, and NO
 *  `<value>` — the number lives in `<amount>`. */
const money = (power: number) =>
  `<espi:measurement><espi:powerOfTenMultiplier>${power}</espi:powerOfTenMultiplier><espi:uom>80</espi:uom></espi:measurement>`;

const one = (xml: string): UsageSummary => {
  const [bill] = parseUsageSummaries(xml);
  if (!bill) throw new Error('no bill parsed');
  return bill;
};

const item = (bill: UsageSummary, note: string) => {
  const hit = bill.items.find((i) => i.note === note);
  if (!hit) throw new Error(`no line item named ${note}`);
  return hit;
};

/* ------------------------------------------------ Enbridge: declared scale -- */

const ENBRIDGE = summary(
  // block scalars: no measurement of their own, raw integers in milli-dollars
  '<espi:billLastPeriod>175760</espi:billLastPeriod>' +
    '<espi:billToDate>175760</espi:billToDate>' +
    '<espi:costAdditionalLastPeriod>0</espi:costAdditionalLastPeriod>' +
    line(`<espi:amount>175760</espi:amount><espi:note>Amount Due</espi:note>${money(-3)}<espi:itemKind>10</espi:itemKind>`) +
    line(
      '<espi:note>Due Date</espi:note><espi:measurement><espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier>' +
        '<espi:uom>27</espi:uom><espi:value>1771286400</espi:value></espi:measurement><espi:itemKind>10</espi:itemKind>',
    ) +
    line(`<espi:amount>18630</espi:amount><espi:note>HST ($)</espi:note>${money(-3)}<espi:itemKind>5</espi:itemKind>`) +
    line(`<espi:amount>84740</espi:amount><espi:note>Gas Supply Charge</espi:note>${money(-3)}<espi:itemKind>3</espi:itemKind>`) +
    line(
      `<espi:amount>34130</espi:amount><espi:note>Gas Delivery Variable Charge</espi:note>${money(-3)}<espi:itemKind>2</espi:itemKind>`,
    ) +
    line(
      `<espi:amount>161890</espi:amount><espi:note>Total Gas Charges ($)</espi:note>${money(-3)}<espi:itemKind>10</espi:itemKind>`,
    ) +
    // the rate lines: same money uom, but 10^-4 and the unit in the note
    line(`<espi:amount>204037</espi:amount><espi:note>Gas Supply Rate ¢/m3</espi:note>${money(-4)}<espi:itemKind>10</espi:itemKind>`) +
    line(
      '<espi:note>Usage (unadjusted)</espi:note><espi:measurement><espi:powerOfTenMultiplier>-3</espi:powerOfTenMultiplier>' +
        '<espi:uom>167</espi:uom><espi:value>426569</espi:value></espi:measurement><espi:itemKind>10</espi:itemKind>',
    ) +
    '<espi:currency>124</espi:currency>',
);

describe('a bill that restates its own money scale (Enbridge Gas)', () => {
  const bill = one(ENBRIDGE);

  it('renders every money line at the power of ten the file declares', () => {
    expect(item(bill, 'Amount Due').rawAmount).toBe(175760); // verbatim, always
    expect(item(bill, 'Amount Due').amount).toBe(175.76);
    expect(item(bill, 'HST ($)').amount).toBe(18.63);
    expect(item(bill, 'Gas Supply Charge').amount).toBe(84.74);
    expect(item(bill, 'Gas Delivery Variable Charge').amount).toBe(34.13);
    expect(item(bill, 'Total Gas Charges ($)').amount).toBe(161.89);
    // …and none of it is the default: 175760 ÷ 100000 would be 1.7576.
    expect(BILL_AMOUNT_SCALE).toBe(100000);
  });

  it('reads the block scalars off the lines’ scale: Amount Due = billLastPeriod = billToDate', () => {
    expect(bill.billLastPeriod).toBe(175.76);
    expect(bill.billToDate).toBe(175.76);
    expect(bill.billLastPeriod).toBe(item(bill, 'Amount Due').amount);
    expect(bill.billToDate).toBe(item(bill, 'Amount Due').amount);
    expect(bill.costAdditionalLastPeriod).toBe(0);
    expect(bill.currency).toBe(124);
    // the payable figure the bill panel shows comes from the same line
    expect(billTotals(bill).amountDue).toBe(175.76);
  });

  it('keeps a ¢/m³ rate line on its own −4 scale, and out of the block’s scale', () => {
    expect(item(bill, 'Gas Supply Rate ¢/m3').amount).toBeCloseTo(20.4037, 10);
    // The block's scalars above are milli-dollars, so the rate line's −4
    // (a minority of the priced lines) did not become the bill's scale.
    expect(bill.billLastPeriod).toBe(175.76);
  });

  it('leaves the value-less money measurement off `measurement` — the scale is read from the raw node', () => {
    // `parseMeasurement` needs a `<value>` to build a quantity; a money line
    // has none, because the number IS the amount. The scale survives anyway.
    expect(item(bill, 'Amount Due').measurement).toBeNull();
    // Informational lines, which do carry a value, still parse as quantities.
    expect(item(bill, 'Due Date').measurement?.uom).toBe(27);
    expect(item(bill, 'Due Date').amount).toBeNull();
    expect(item(bill, 'Usage (unadjusted)').measurement?.scaled).toBeCloseTo(426.569, 6);
  });
});

/* --------------------------------------------- Oakville: the ESPI default -- */

const OAKVILLE_CHARGE = 49745000; // $497.45 at hundred-thousandths

const oakvilleLine = (fields: string) =>
  summary(`<espi:billLastPeriod>0</espi:billLastPeriod><espi:billToDate>0</espi:billToDate>` + line(fields));

describe('a bill that declares no scale (Oakville Hydro)', () => {
  it('keeps hundred-thousandths for every figure, line and scalar alike', () => {
    const oakville = parseUsageSummaries(read('usage-summary-synthetic.xml'));
    const total = oakville
      .map((b) => item(b, 'Total Electricity Charges'))
      .map((i) => i.amount ?? 0);
    expect(total[0]).toBe(497.45);
    expect(total.reduce((t, n) => t + n, 0)).toBeCloseTo(1365.03, 2);
    // A block with no line items at all declares no scale either — its scalar
    // still lands on the ESPI default (284259 ÷ 100000).
    const [standin] = parseUsageSummaries(read('utility-espi-prefixed-standin.xml'));
    expect(standin.billToDate).toBeCloseTo(2.84259, 5);
  });

  it('does not let a NON-money measurement rescale the money beside it', () => {
    // A charge that also carries its own usage: the measurement names Wh, so
    // it is about the consumption, not about how `amount` is written.
    const withUsage = one(
      oakvilleLine(
        `<espi:amount>${OAKVILLE_CHARGE}</espi:amount><espi:note>Delivery</espi:note>` +
          '<espi:measurement><espi:powerOfTenMultiplier>-3</espi:powerOfTenMultiplier>' +
          '<espi:uom>72</espi:uom><espi:value>450000</espi:value></espi:measurement>',
      ),
    );
    expect(item(withUsage, 'Delivery').amount).toBe(497.45);

    // Same unit, still no `<value>`: the gate is the unit, not the value.
    const usageWithoutValue = one(
      oakvilleLine(
        `<espi:amount>${OAKVILLE_CHARGE}</espi:amount><espi:note>Delivery</espi:note>` +
          '<espi:measurement><espi:powerOfTenMultiplier>-3</espi:powerOfTenMultiplier><espi:uom>72</espi:uom></espi:measurement>',
      ),
    );
    expect(item(usageWithoutValue, 'Delivery').amount).toBe(497.45);
  });

  it('ignores a measurement that names money but no power of ten', () => {
    // A unit and no exponent declares nothing to scale by: the default stands.
    const noPower = one(
      oakvilleLine(
        `<espi:amount>${OAKVILLE_CHARGE}</espi:amount><espi:note>Delivery</espi:note>` +
          '<espi:measurement><espi:uom>80</espi:uom></espi:measurement>',
      ),
    );
    expect(item(noPower, 'Delivery').amount).toBe(497.45);
  });

  it('honours a power of ten that names no unit at all', () => {
    // The one case where presence alone decides: with no unit stated, the
    // exponent can only be about the figure on the line.
    const unitless = one(
      oakvilleLine(
        `<espi:amount>${OAKVILLE_CHARGE}</espi:amount><espi:note>Delivery</espi:note>` +
          '<espi:measurement><espi:powerOfTenMultiplier>-3</espi:powerOfTenMultiplier></espi:measurement>',
      ),
    );
    expect(item(unitless, 'Delivery').amount).toBe(49745);
    expect(item(unitless, 'Delivery').rawAmount).toBe(OAKVILLE_CHARGE);
  });
});
