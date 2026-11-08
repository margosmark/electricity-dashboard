/**
 * Enbridge Gas bill arithmetic and failure modes, test-locked (t_9188de53).
 *
 * Everything here runs against the SYNTHETIC fixture
 * (`tests/fixtures/enbridge-gas-synthetic.xml`, generated from scrubbed data
 * by `scripts/generate-enbridge-gas-fixture.mjs`): the real Extract carries
 * the customer's name, address, account number and meter serial and never
 * enters this repo (AC3). The figures were re-derived from the raw files by
 * the PM acceptance pass (card t_e2898d1b) and the corrected 5-term identity
 * replaces the epic body's 6-term double count (`Gas Service Provider Supply
 * Charge ($)` equals `Gas Supply Charge` in all 10 periods, so summing both
 * fails 0/10).
 *
 * What this file adds on top of `enbridgeGas.test.ts` (periods, sums,
 * identity, volumes, rate lines) and `billMoneyScale.test.ts` /
 * `limits.test.ts` (declared scale, Oakville default, the refusal itself):
 *
 *  (a/c) every dollar in every period is recomputed here from the line's own
 *        raw integer ÷ 1000 (the `powerOfTenMultiplier: -3, uom: 80` the file
 *        declares; rate lines ÷ 10000), so a renderer that fell back to the
 *        ESPI 10^-5 default — $175.76 → $1.7576 — fails every one of these
 *        assertions, not just the two that name a known dollar figure;
 *  (d)   the 3 periods where Amount Due ≠ Total Gas Charges ($13.87 / $5.30 /
 *        $6.18) are pinned as expected feed behavior: exactly three, exact
 *        values, exact dates, zero balances beside them, and the payable
 *        figure stays Amount Due rather than being normalized to the Total;
 *  HST:  13.00% of the four pre-tax lines within ±$0.01, the effective rate
 *        bounded, and the exactly two periods that read 12.99%.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BILL_AMOUNT_SCALE,
  billTotals,
  parseGreenButtonFeed,
  type BillLineItem,
  type UsageSummary,
} from '../energy';

const USAGE_XML = readFileSync(
  join(__dirname, '../../../tests/fixtures/enbridge-gas-synthetic.xml'),
  'utf8',
);
const feed = parseGreenButtonFeed(USAGE_XML);

const line = (s: UsageSummary, note: string): BillLineItem => {
  const hit = s.items.find((i) => i.note === note);
  if (!hit) throw new Error(`no line ${JSON.stringify(note)} in ${s.startDate}`);
  return hit;
};
const amountOf = (s: UsageSummary, note: string): number => {
  const a = line(s, note).amount;
  if (a === null) throw new Error(`line ${JSON.stringify(note)} has no amount`);
  return a;
};
const rawOf = (s: UsageSummary, note: string): number => {
  const a = line(s, note).rawAmount;
  if (a === null) throw new Error(`line ${JSON.stringify(note)} has no raw amount`);
  return a;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

const STARTS = [
  '2025-12-25', '2026-01-27', '2026-02-26', '2026-03-26', '2026-04-28',
  '2026-05-27', '2026-06-24', '2026-07-27', '2026-08-27', '2026-09-25',
];
const DUE = [175.76, 153.06, 117.35, 84.75, 65.45, 132.06, 85.37, 119.04, 93.33, 72.47];
const TOTALS = [161.89, 153.06, 117.35, 84.75, 65.45, 132.06, 80.07, 119.04, 93.33, 66.29];

/** The four pre-tax lines of the corrected 5-term identity. */
const PRETAX = [
  'Gas Supply Charge',
  'Gas Delivery Variable Charge',
  'Gas Cost Adjustment ($)',
  'Customer charge',
] as const;
/** Every money line whose scale the file declares as milli-dollars (uom 80, −3). */
const MONEY_LINES = [
  ...PRETAX,
  'HST ($)',
  'Gas Service Provider Supply Charge ($)',
  'Total Gas Charges ($)',
  'Amount Due',
  'Previous Balance ($)',
  'Payments Received ($)',
  'Balance Forward ($)',
] as const;
/** Rate lines: same money unit, power −4 (¢/m³), never dollars. */
const RATE_LINES = [
  'Gas Supply Rate ¢/m3',
  'Gas Cost Adjustment ¢/m3',
  'Total Gas Supply Rate ¢/m3 (net)',
] as const;

describe('a/c — every dollar recomputed from the raw integer the file sent', () => {
  it('the ESPI default is still 10^-5, and the fixture never rides on it', () => {
    // The trap: 175760 ÷ 100000 = 1.7576 — finite, bound-passing, wrong 100×.
    expect(BILL_AMOUNT_SCALE).toBe(100000);
    expect(175760 / BILL_AMOUNT_SCALE).toBe(1.7576);
  });

  it('every money line and block scalar equals raw ÷ 1000 (declared −3), 10/10', () => {
    for (const s of feed.summaries) {
      for (const note of MONEY_LINES) {
        expect(
          amountOf(s, note),
          `${s.startDate} ${note}`,
        ).toBe(rawOf(s, note) / 1000);
      }
      // Block scalars carry no measurement of their own; the block's priced
      // money lines agree on −3, so they are the same milli-dollar figures.
      expect(s.billLastPeriod).toBe(rawOf(s, 'Amount Due') / 1000);
      expect(s.billToDate).toBe(rawOf(s, 'Amount Due') / 1000);
      expect(s.billLastPeriod).toBe(amountOf(s, 'Amount Due'));
      expect(s.billToDate).toBe(amountOf(s, 'Amount Due'));
    }
  });

  it('a 100×-small Amount Due fails: $175.76 is the figure, $1.76 is not', () => {
    for (const [i, s] of feed.summaries.entries()) {
      expect(amountOf(s, 'Amount Due')).toBe(DUE[i]);
      expect(amountOf(s, 'Amount Due')).not.toBe(rawOf(s, 'Amount Due') / BILL_AMOUNT_SCALE);
      expect(billTotals(s).amountDue).toBe(DUE[i]);
    }
  });

  it('rate lines equal raw ÷ 10000 (declared −4) and are never dollar-shaped', () => {
    for (const s of feed.summaries) {
      for (const note of RATE_LINES) {
        expect(amountOf(s, note), `${s.startDate} ${note}`).toBe(rawOf(s, note) / 10000);
        // A rate on the money scale would read ≥ 15.35 for the −3 lines…
        expect(Math.abs(amountOf(s, note))).toBeLessThan(100);
      }
    }
  });

  it('the 5-term identity holds in dollars as well as raws, 10/10', () => {
    for (const s of feed.summaries) {
      const sum = PRETAX.reduce((acc, note) => acc + amountOf(s, note), 0);
      expect(round2(sum + amountOf(s, 'HST ($)'))).toBe(round2(amountOf(s, 'Total Gas Charges ($)')));
    }
  });
});

describe('d — the 3 periods where Amount Due ≠ Total Gas Charges', () => {
  const gaps = feed.summaries.map((s) =>
    round2(amountOf(s, 'Amount Due') - amountOf(s, 'Total Gas Charges ($)')),
  );

  it('exactly three periods carry a gap: $13.87, $5.30, $6.18 on the audited dates', () => {
    const nonzero = gaps
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g !== 0);
    expect(nonzero.map(({ g }) => g)).toEqual([13.87, 5.3, 6.18]);
    expect(nonzero.map(({ i }) => feed.summaries[i].startDate)).toEqual([
      '2025-12-25',
      '2026-06-24',
      '2026-09-25',
    ]);
    // …and the other seven are equal raw-for-raw, not merely close.
    for (const [i, s] of feed.summaries.entries()) {
      if (gaps[i] === 0) {
        expect(rawOf(s, 'Amount Due')).toBe(rawOf(s, 'Total Gas Charges ($)'));
      } else {
        expect(rawOf(s, 'Amount Due')).not.toBe(rawOf(s, 'Total Gas Charges ($)'));
      }
    }
    expect(round2(gaps.reduce((a, b) => a + b, 0))).toBe(25.35);
  });

  it('is not normalized away: the payable figure stays Amount Due', () => {
    for (const [i, s] of feed.summaries.entries()) {
      const due = amountOf(s, 'Amount Due');
      const total = amountOf(s, 'Total Gas Charges ($)');
      // The gap periods still expose two distinct figures…
      if (gaps[i] !== 0) expect(due).not.toBe(total);
      // …and nothing re-points the bill at the Total.
      expect(billTotals(s).amountDue).toBe(due);
      expect(s.billLastPeriod).toBe(due);
      expect(s.billToDate).toBe(due);
      expect(due).toBe(DUE[i]);
      expect(total).toBe(TOTALS[i]);
    }
    const sumDue = round2(feed.summaries.reduce((a, s) => a + amountOf(s, 'Amount Due'), 0));
    const sumTotal = round2(
      feed.summaries.reduce((a, s) => a + amountOf(s, 'Total Gas Charges ($)'), 0),
    );
    expect(sumDue).toBe(1098.64);
    expect(sumTotal).toBe(1073.29);
    expect(round2(sumDue - sumTotal)).toBe(25.35);
  });

  it('the gap is not balance carryover: Previous Balance / Payments / Balance Forward are $0.00, 10/10', () => {
    for (const s of feed.summaries) {
      for (const note of ['Previous Balance ($)', 'Payments Received ($)', 'Balance Forward ($)']) {
        expect(amountOf(s, note), `${s.startDate} ${note}`).toBe(0);
        expect(rawOf(s, note), `${s.startDate} ${note} raw`).toBe(0);
      }
    }
  });
});

describe('HST — 13.00% of the four pre-tax lines, two periods reading 12.99%', () => {
  const rows = feed.summaries.map((s) => {
    const pretax = PRETAX.reduce((acc, note) => acc + amountOf(s, note), 0);
    const hst = amountOf(s, 'HST ($)');
    return { start: s.startDate, pretax: round2(pretax), hst };
  });

  it('within $0.01 of 13% of the pre-tax sum, 10/10', () => {
    for (const r of rows) {
      expect(Math.abs(r.hst - 0.13 * r.pretax), `${r.start}`).toBeLessThanOrEqual(0.01);
    }
  });

  it('the effective rate sits between 12.98% and 13.01%, 10/10', () => {
    for (const r of rows) {
      const pct = (100 * r.hst) / r.pretax;
      expect(pct, `${r.start} = ${pct}%`).toBeGreaterThanOrEqual(12.98);
      expect(pct, `${r.start} = ${pct}%`).toBeLessThanOrEqual(13.01);
    }
  });

  it('exactly two periods round to 12.99% — 2026-07-27 and 2026-09-25', () => {
    const read1299 = rows
      .map((r) => ({ ...r, pct: (100 * r.hst) / r.pretax }))
      .filter((r) => Math.round(r.pct * 100) / 100 === 12.99)
      .map((r) => r.start);
    expect(read1299).toEqual(['2026-07-27', '2026-09-25']);
  });

  it('locks the audited HST figures per period', () => {
    expect(rows.map((r) => r.hst)).toEqual([18.63, 17.61, 13.5, 9.75, 7.53, 15.19, 9.21, 13.69, 10.74, 7.62]);
    expect(feed.summaries.map((s) => s.startDate)).toEqual(STARTS);
  });
});
