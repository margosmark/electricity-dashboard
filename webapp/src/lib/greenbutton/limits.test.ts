/**
 * The document budget — what an UNTRUSTED Green Button file may cost.
 *
 * Run: `npx vitest run src/lib/greenbutton/limits.test.ts`
 *
 * The two crashes already fixed (a spread `entries.push(...asArray(k))` that
 * blew the stack at 125 487 siblings, and a finite-but-absurd reading that
 * summed every total to `Infinity`) bounded what a single ELEMENT may do.
 * This file pins what the DOCUMENT may do: bytes, nesting, aggregate entry
 * count, aggregate reading count, and the money/clock figures a bill states.
 *
 * Every refusal assertion goes through the app's own entry point
 * (`parseGreenButtonUsagePoints` / `parseGreenButtonFeed`), because a bound
 * that is only reachable from a unit test is not a bound.
 *
 * MEASURED, this tree, node v22.23.3, vitest/jsdom (t_2961ce14):
 *   300 000 entries / 50.1 MB … 9 697 ms   (unguarded)
 *   900 000 entries / 150.2 MB … 27 633 ms (unguarded)
 *   400 000 readings / 54.9 MB … 9 802 ms  (unguarded)
 * The largest real export this repo has measured is 6 424 909 bytes with 759
 * entries, 17 539 readings and 7 levels of nesting, so the caps below sit one
 * to two orders of magnitude above real data and far below those numbers.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_BILL_DOLLARS,
  MAX_BILL_LINES,
  MAX_BILL_LINES_PER_PERIOD,
  MAX_BILL_MEASUREMENT,
  MAX_BILL_PERIODS,
  MAX_BILL_PERIOD_SECONDS,
  MAX_CLOCK_OFFSET_S,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH,
  MAX_ENTRIES,
  MAX_READINGS,
  MAX_UNIT_PRICE_DOLLARS,
  assertBillDollars,
  assertBillLinesPerPeriod,
  assertBillMeasurement,
  assertBillPeriodSeconds,
  assertDeclaredBillScale,
  assertDocumentBudget,
  assertUnitPrice,
  budgetRefusal,
  inspectDocument,
  isClockOffset,
  isGreenButtonRefusal,
  measureDocument,
  type DocumentStats,
} from './limits';
import {
  BILL_AMOUNT_SCALE,
  parseGreenButtonFeed,
  parseGreenButtonUsagePoints,
  parseUsageSummaries,
} from '@/lib/energy';
import { diagnoseGreenButtonDocument } from '@/lib/parseDiagnostic';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stats(o: Partial<DocumentStats>): DocumentStats {
  return { bytes: 0, depth: 0, entries: 0, readings: 0, billPeriods: 0, billLines: 0, ...o };
}

/** The refusal a document produces through the app's own funnel, or null. */
function refusalOf(xml: string) {
  try {
    parseGreenButtonUsagePoints(xml);
    return null;
  } catch (e) {
    if (isGreenButtonRefusal(e)) return e;
    throw e;
  }
}

const FEED = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">\n${body}\n</feed>`;

describe('measureDocument — one pass over the raw text', () => {
  it('counts entries and readings through namespace prefixes', () => {
    const { entries, readings } = measureDocument(
      FEED(
        '<entry><content><espi:IntervalReading><espi:value>1</espi:value></espi:IntervalReading></content></entry>' +
          '<espi:entry/>' +
          '<espi:IntervalReading/>',
      ),
    );
    expect(entries).toBe(2);
    expect(readings).toBe(2);
  });

  it('counts markup that is NOT an element as nothing at all', () => {
    // A comment and a CDATA section full of element-looking text: the parser
    // sees text there, so the budget must too.
    const { entries, readings } = measureDocument(
      FEED(
        '<!-- <entry><IntervalReading/></entry> -->' +
          '<content><![CDATA[<entry/><entry/><IntervalReading/>]]></content>',
      ),
    );
    expect(entries).toBe(0);
    expect(readings).toBe(0);
  });

  it('reports the deepest nesting, and a `>` inside an attribute does not lie about it', () => {
    const deep = measureDocument(FEED('<a><b><c><d/></c></b></a>'));
    expect(deep.depth).toBe(4); // feed > a > b > c — `<d/>` is self-closing, so it nests nothing
    const withHref = measureDocument(FEED('<entry><link rel="self" href="x>y"/></entry>'));
    expect(withHref.depth).toBe(2); // feed > entry, and the `>` in the href closed nothing early
    expect(withHref.entries).toBe(1);
  });

  it('counts bill blocks and bill lines, wherever they appear', () => {
    // The F1 shape (t_96e1cda0): bill blocks parked OUTSIDE every <entry>,
    // where the entry and reading counts never see them.
    const { billPeriods, billLines, entries } = measureDocument(
      FEED(
        '<espi:UsageSummary/>' +
          '<espi:ElectricPowerUsageSummary/>' +
          '<UsageSummary><costAdditionalDetailLastPeriod/></UsageSummary>' +
          '<costAdditionalDetailLastPeriod/>' +
          '<espi:entry/>',
      ),
    );
    expect(billPeriods).toBe(3);
    expect(billLines).toBe(2);
    expect(entries).toBe(1);
  });

  it('counts bill blocks and lines inside markup as nothing at all', () => {
    const { billPeriods, billLines } = measureDocument(
      FEED(
        '<!-- <UsageSummary><costAdditionalDetailLastPeriod/></UsageSummary> -->' +
          '<content><![CDATA[<UsageSummary/><costAdditionalDetailLastPeriod/>]]></content>',
      ),
    );
    expect(billPeriods).toBe(0);
    expect(billLines).toBe(0);
  });

  it('counts bytes as the length of the text it was handed', () => {
    expect(measureDocument('').bytes).toBe(0);
    expect(measureDocument('<feed/>').bytes).toBe(7);
  });
});

describe('budgetRefusal — the edges, dimension by dimension', () => {
  it('accepts the ceiling itself and refuses one past it', () => {
    expect(budgetRefusal(stats({ bytes: MAX_DOCUMENT_BYTES }))).toBeNull();
    expect(budgetRefusal(stats({ bytes: MAX_DOCUMENT_BYTES + 1 }))?.dim).toBe('bytes');
    expect(budgetRefusal(stats({ depth: MAX_DOCUMENT_DEPTH }))).toBeNull();
    expect(budgetRefusal(stats({ depth: MAX_DOCUMENT_DEPTH + 1 }))?.dim).toBe('depth');
    expect(budgetRefusal(stats({ entries: MAX_ENTRIES }))).toBeNull();
    expect(budgetRefusal(stats({ entries: MAX_ENTRIES + 1 }))?.dim).toBe('entries');
    expect(budgetRefusal(stats({ readings: MAX_READINGS }))).toBeNull();
    expect(budgetRefusal(stats({ readings: MAX_READINGS + 1 }))?.dim).toBe('readings');
    expect(budgetRefusal(stats({ billPeriods: MAX_BILL_PERIODS }))).toBeNull();
    expect(budgetRefusal(stats({ billPeriods: MAX_BILL_PERIODS + 1 }))?.dim).toBe('billPeriods');
    expect(budgetRefusal(stats({ billLines: MAX_BILL_LINES }))).toBeNull();
    expect(budgetRefusal(stats({ billLines: MAX_BILL_LINES + 1 }))?.dim).toBe('billLines');
  });

  it('names the biggest dimension first, and carries the numbers it judged', () => {
    const both = budgetRefusal(stats({ bytes: MAX_DOCUMENT_BYTES + 10, entries: 5 }));
    expect(both?.dim).toBe('bytes');
    expect(both?.measured).toBe(MAX_DOCUMENT_BYTES + 10);
    expect(both?.limit).toBe(MAX_DOCUMENT_BYTES);
    expect(both?.detail).toContain(String(MAX_DOCUMENT_BYTES + 10));
    expect(both?.detail).toMatch(/Nothing from this file was imported/);
  });

  it('says nothing at all about a document inside the budget', () => {
    expect(budgetRefusal(measureDocument(FEED('<entry/>')))).toBeNull();
  });
});

describe('a hostile document is refused through the app, before it is parsed', () => {
  /**
   * The shape the sibling card measured as the slow one: entries spread over
   * MANY parents, so the per-parent sibling fix helps not at all. 50.1 MB /
   * 300 000 entries took 9 697 ms unguarded; the byte ceiling is judged from
   * `text.length` alone, so the refusal must be immediate.
   */
  it('refuses a 50 MB entry explosion on its byte count, without parsing it', () => {
    let body = '';
    for (let p = 0; p < 3000; p++) {
      body += '<feed>';
      for (let i = 0; i < 100; i++) {
        body +=
          '<entry><content><espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1</espi:value></espi:IntervalReading></content></entry>';
      }
      body += '</feed>';
    }
    const xml = `<?xml version="1.0"?><root>${body}</root>`;
    expect(xml.length).toBeGreaterThan(MAX_DOCUMENT_BYTES);

    const started = Date.now();
    const refusal = refusalOf(xml);
    const elapsed = Date.now() - started;

    expect(refusal?.code).toBe('budget');
    expect(refusal?.dim).toBe('bytes');
    expect(refusal?.measured).toBe(xml.length);
    // Unguarded this document costs ~9.7 s of parsing; the byte ceiling is
    // judged from `text.length` before the scan, so the refusal is immediate
    // (three orders of magnitude of headroom — no stopwatch reading).
    expect(elapsed).toBeLessThan(1000);
    // The copy a caller renders, asserted once: a refusal is shown as itself.
    expect(refusal?.headline).toBeTruthy();
    expect(refusal?.hints.length).toBeGreaterThan(0);
  }, 120_000);

  it('refuses an entry count that is small in bytes but huge in aggregate', () => {
    // 200 001 empty entries: 1.6 MB — comfortably inside the byte ceiling, so
    // only the aggregate count can catch it. These are exactly the elements
    // that cost a traversal each (`collectEntries`, then one walk per entry).
    const xml = FEED('<entry/>'.repeat(MAX_ENTRIES + 1));
    expect(xml.length).toBeLessThan(MAX_DOCUMENT_BYTES);

    const refusal = refusalOf(xml);
    expect(refusal?.dim).toBe('entries');
    expect(refusal?.measured).toBe(MAX_ENTRIES + 1);
  }, 120_000);

  it('refuses an aggregate reading count no single document can price', () => {
    const xml = FEED('<IntervalReading/>'.repeat(MAX_READINGS + 1));
    expect(xml.length).toBeLessThan(MAX_DOCUMENT_BYTES);

    const refusal = refusalOf(xml);
    expect(refusal?.dim).toBe('readings');
    expect(refusal?.measured).toBe(MAX_READINGS + 1);
  }, 120_000);

  it('refuses a nesting bomb with the app\'s own sentence, not the library\'s', () => {
    // fast-xml-parser stops at 100 nested tags with "Maximum nested tags
    // exceeded"; the budget is stated below that, so the user reads this app's
    // diagnostic instead of a parser string.
    const xml = `<r>${'<a>'.repeat(1000)}${'</a>'.repeat(1000)}</r>`;
    expect(() => parseGreenButtonUsagePoints(xml)).toThrow(/nests XML elements/);

    const refusal = refusalOf(xml);
    expect(refusal?.code).toBe('budget');
    expect(refusal?.dim).toBe('depth');
    expect(refusal?.detail).not.toMatch(/Maximum nested tags/);
    expect(refusal?.detail).toMatch(/Nothing from this file was imported/);
  }, 60_000);

  it('keeps a legitimate feed importable, and says nothing about its budget', () => {
    // The control: without it, "every document is refused" would pass too.
    let body = '';
    for (let i = 0; i < 200; i++) {
      body += `<entry><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${1704067200 + i * 3600}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:start>${1704067200 + i * 3600}</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry>`;
    }
    const xml = FEED(body);
    const groups = parseGreenButtonUsagePoints(xml);
    expect(groups.reduce((n, g) => n + g.readings.length, 0)).toBe(200);
    expect(assertDocumentBudget(xml).entries).toBe(200);
  }, 60_000);

  /**
   * The guard runs on EVERY import, so its own cost is part of the contract:
   * a real 2.4-year export is 6.4 MB, and the scan is one pass of indexOf.
   * Measured ~90 ms for the real file; the bound below is deliberately loose
   * (a slow CI box must not turn a performance pin into a flake).
   */
  it('walks a real-sized feed cheaply', () => {
    const row =
      '<entry><content><espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></content></entry>';
    const xml = FEED(row.repeat(100_000));
    expect(xml.length).toBeGreaterThan(6_000_000);

    const started = Date.now();
    const { stats: s, refusal } = inspectDocument(xml);
    const elapsed = Date.now() - started;

    expect(refusal).toBeNull();
    expect(s.entries).toBe(100_000);
    expect(s.readings).toBe(100_000);
    expect(elapsed).toBeLessThan(3000);
  }, 120_000);
});

/* ==========================================================================
 * The bill half of the budget — periods and line items (sec F1, t_96e1cda0)
 * ==========================================================================
 *
 * The four dims above bound `<entry>` and `<IntervalReading`; the measured
 * hostile shape (t_96e1cda0) rode in on the half they never counted: 11 747
 * `<UsageSummary>` blocks OUTSIDE every `<entry>` (admitted: entries counted
 * = 1) parsed to 11 748 rendered periods, and ONE bill with 20 000 line
 * items rendered 1 613 ms / 80 063 DOM nodes. The pre-parse scan now counts
 * both, and the per-bill line ceiling is judged where the period is known.
 */

describe('the bill budget — periods and line items are counted too', () => {
  const SUMMARY = (fields: string) =>
    '<entry><content><espi:UsageSummary><espi:billingPeriod><espi:start>1704067200</espi:start>' +
    '<espi:duration>2678400</espi:duration></espi:billingPeriod>' +
    fields +
    '</espi:UsageSummary></content></entry>';
  const LINE =
    '<espi:costAdditionalDetailLastPeriod><espi:amount>100</espi:amount><espi:note>Delivery</espi:note></espi:costAdditionalDetailLastPeriod>';

  it('refuses 1 201 bill blocks parked outside every <entry>, before the parse', () => {
    // The F1 shape: tiny in bytes (15 KB), invisible to the entry and
    // reading counts, 1 201 rendered cards if it ever reached the panel.
    const xml = FEED('<espi:UsageSummary/>'.repeat(MAX_BILL_PERIODS + 1));
    expect(xml.length).toBeLessThan(MAX_DOCUMENT_BYTES);

    // The scan refuses it BEFORE the parser is handed the text.
    expect(inspectDocument(xml).refusal?.dim).toBe('billPeriods');

    const refusal = refusalOf(xml);
    expect(refusal?.code).toBe('budget');
    expect(refusal?.dim).toBe('billPeriods');
    expect(refusal?.measured).toBe(MAX_BILL_PERIODS + 1);
    expect(refusal?.limit).toBe(MAX_BILL_PERIODS);
    expect(refusal?.detail).toMatch(/billing-period blocks/);
    expect(refusal?.detail).toMatch(/Nothing from this file was imported/);
    expect(refusal?.headline).toBeTruthy();
  }, 120_000);

  it('refuses a document past the document-wide line allowance, before the parse', () => {
    const xml = FEED('<costAdditionalDetailLastPeriod/>'.repeat(MAX_BILL_LINES + 1));
    expect(xml.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    expect(inspectDocument(xml).refusal?.dim).toBe('billLines');

    const refusal = refusalOf(xml);
    expect(refusal?.code).toBe('budget');
    expect(refusal?.dim).toBe('billLines');
    expect(refusal?.measured).toBe(MAX_BILL_LINES + 1);
    expect(refusal?.limit).toBe(MAX_BILL_LINES);
  }, 120_000);

  it('refuses ONE period holding more lines than a bill may carry', () => {
    // This document passes every pre-parse dimension (1 block, 501 lines),
    // so it is the per-bill half that stops it — the flat scan cannot tell
    // which period the lines belong to, and 501 in ONE card is the render
    // cost the dim exists to bound.
    const xml = FEED(SUMMARY(LINE.repeat(MAX_BILL_LINES_PER_PERIOD + 1)));
    expect(inspectDocument(xml).refusal).toBeNull();

    const refusal = refusalOf(xml);
    expect(refusal?.code).toBe('budget');
    expect(refusal?.dim).toBe('billLinesPerPeriod');
    expect(refusal?.measured).toBe(MAX_BILL_LINES_PER_PERIOD + 1);
    expect(refusal?.limit).toBe(MAX_BILL_LINES_PER_PERIOD);
    expect(refusal?.detail).toMatch(/One billing period/);
    expect(refusal?.detail).toMatch(/Nothing from this file was imported/);
  }, 120_000);

  it('keeps a period AT the line ceiling importable, and judges only the count', () => {
    expect(() => assertBillLinesPerPeriod(MAX_BILL_LINES_PER_PERIOD)).not.toThrow();
    try {
      assertBillLinesPerPeriod(MAX_BILL_LINES_PER_PERIOD + 1);
      throw new Error('unreachable');
    } catch (e) {
      expect(isGreenButtonRefusal(e)).toBe(true);
      if (!isGreenButtonRefusal(e)) throw e;
      expect(e.code).toBe('budget');
      expect(e.measured).toBe(MAX_BILL_LINES_PER_PERIOD + 1);
      expect(e.limit).toBe(MAX_BILL_LINES_PER_PERIOD);
    }

    const xml = FEED(SUMMARY(LINE.repeat(MAX_BILL_LINES_PER_PERIOD)));
    const feed = parseGreenButtonFeed(xml);
    expect(feed.summaries).toHaveLength(1);
    expect(feed.summaries[0].items).toHaveLength(MAX_BILL_LINES_PER_PERIOD);
    expect(assertDocumentBudget(xml).billPeriods).toBe(1);
    expect(assertDocumentBudget(xml).billLines).toBe(MAX_BILL_LINES_PER_PERIOD);
  }, 60_000);

  it('keeps the real fixtures inside every bill dimension — the control', () => {
    // Without this, "refuse everything" would pass every assertion above.
    const fixtures = (name: string) => readFileSync(join(__dirname, `../../../tests/fixtures/${name}`), 'utf8');

    const gas = assertDocumentBudget(fixtures('enbridge-gas-synthetic.xml'));
    expect(gas.billPeriods).toBe(10); // the real Enbridge feed's 10 periods
    expect(gas.billLines).toBe(370); // …and its 37 lines per period
    expect(gas.billPeriods).toBeLessThanOrEqual(MAX_BILL_PERIODS);
    const gasFeed = parseGreenButtonFeed(fixtures('enbridge-gas-synthetic.xml'));
    expect(gasFeed.summaries).toHaveLength(10);
    for (const s of gasFeed.summaries) {
      expect(s.items.length).toBeLessThanOrEqual(MAX_BILL_LINES_PER_PERIOD);
    }

    const oakville = assertDocumentBudget(fixtures('usage-summary-synthetic.xml'));
    expect(oakville.billPeriods).toBe(3);
    expect(oakville.billLines).toBe(63);
    expect(parseGreenButtonFeed(fixtures('usage-summary-synthetic.xml')).summaries).toHaveLength(3);
  }, 60_000);
});

describe('the diagnostics explain a refusal instead of guessing', () => {
  const depthBomb = `<r>${'<a>'.repeat(1000)}${'</a>'.repeat(1000)}</r>`;

  it('reports the depth bomb as a budget refusal, not "no Green Button data"', () => {
    const diag = diagnoseGreenButtonDocument(depthBomb, 0);
    expect(diag.ok).toBe(false);
    if (diag.ok) throw new Error('unreachable');
    // The old path validated this document happily and then said "No Green
    // Button data found in this file.", which names the wrong problem.
    expect(diag.headline).not.toMatch(/No Green Button data/);
    expect(diag.detail).toMatch(/nests XML elements/);
    expect(diag.hints.length).toBeGreaterThan(0);
  });

  it('still reports an ordinary document normally', () => {
    const good = diagnoseGreenButtonDocument(
      FEED(
        '<entry><content><espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></content></entry>',
      ),
      1,
    );
    expect(good.ok).toBe(true);
    const empty = diagnoseGreenButtonDocument('<?xml version="1.0"?><feed/>', 0);
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('unreachable');
    expect(empty.headline).toMatch(/No Green Button data/);
  });
});

describe('the numeric bounds — a figure no bill can hold is refused', () => {
  it('bounds money by magnitude, so a credit still passes', () => {
    expect(() => assertBillDollars('amount', MAX_BILL_DOLLARS)).not.toThrow();
    expect(() => assertBillDollars('amount', -MAX_BILL_DOLLARS)).not.toThrow();
    expect(() => assertBillDollars('amount', MAX_BILL_DOLLARS + 0.01)).toThrow(/no bill can hold/);
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, 1e303]) {
      expect(() => assertBillDollars('amount', bad), `value=${bad}`).toThrow(
        /Nothing from this file was imported/,
      );
    }
  });

  it('bounds a unit price, a quantity and a clock offset', () => {
    expect(() => assertUnitPrice('unitCost', MAX_UNIT_PRICE_DOLLARS)).not.toThrow();
    expect(() => assertUnitPrice('unitCost', MAX_UNIT_PRICE_DOLLARS + 1)).toThrow(/no bill/);
    expect(() => assertBillMeasurement('measurement', MAX_BILL_MEASUREMENT)).not.toThrow();
    expect(() => assertBillMeasurement('measurement', 1e308)).toThrow(/no meter/);
    expect(() => assertBillMeasurement('measurement', Number.POSITIVE_INFINITY)).toThrow(/no meter/);

    expect(isClockOffset(-18000)).toBe(true);
    expect(isClockOffset(MAX_CLOCK_OFFSET_S)).toBe(true);
    expect(isClockOffset(-MAX_CLOCK_OFFSET_S)).toBe(true);
    expect(isClockOffset(MAX_CLOCK_OFFSET_S + 1)).toBe(false);
    expect(isClockOffset(1e308)).toBe(false);
    expect(isClockOffset(Number.NaN)).toBe(false);
  });

  it('carries the numbers, not just the prose, on the refusal', () => {
    try {
      assertBillDollars('billLastPeriod', 1e303);
      throw new Error('unreachable');
    } catch (e) {
      expect(isGreenButtonRefusal(e)).toBe(true);
      if (!isGreenButtonRefusal(e)) throw e;
      expect(e.code).toBe('bill-figure');
      expect(e.measured).toBe(1e303);
      expect(e.limit).toBe(MAX_BILL_DOLLARS);
    }
  });

  it('never lets the budget guard be reached by a bill refusal, or the reverse', () => {
    // Two different layers: the budget is pre-parse and its code says so.
    const refusal = refusalOf(FEED('<entry/>'.repeat(MAX_ENTRIES + 1)));
    expect(refusal?.code).toBe('budget');
    expect(() => parseGreenButtonFeed('<feed/>')).not.toThrow();
  }, 60_000);
});

/* ==========================================================================
 * The declared scale — the too-small half the magnitude bound cannot see
 * ==========================================================================
 *
 * `assertBillDollars` bounds MAGNITUDE, so it refuses `1e308` and is blind to
 * the opposite lie: Enbridge Gas sends $175.76 as the raw integer 175760
 * with `measurement { powerOfTenMultiplier: -3 }`, and rendering it at the
 * ESPI hundred-thousandths default yields $1.76 — finite, well under
 * MAX_BILL_DOLLARS, and wrong by 100×. No absolute floor can catch that
 * either: a $1.76 bill is a figure a bill CAN hold, and a floor high enough
 * to fail it would refuse real credit bills, and a refusal is fatal to the
 * whole import. Only the file can say which figure it meant.
 *
 * This bound is asserted at the function deliberately. It compares a rendered
 * figure against the power of ten THE FILE DECLARED for that same figure, so
 * while the renderer derives its scale from the file — which is what
 * `billMoneyScale.test.ts` pins through the app's own entry point, with the
 * absolute magnitudes data CAN contradict — no data can disagree with it;
 * only a renderer that stops deriving can, and that is precisely the
 * regression it exists to catch.
 */

describe('the scale the file declares — a figure contradicted by its own power of ten is refused', () => {
  /** Enbridge's Amount Due: raw 175760, milli-dollars (power −3). */
  const RAW = 175760;
  const POWER = -3;
  const DOLLARS = 175.76;

  it('keeps the figure the file declares, to the last cent', () => {
    expect(() => assertDeclaredBillScale('amount', RAW, POWER, DOLLARS)).not.toThrow();
    expect(() => assertDeclaredBillScale('amount', 0, POWER, 0)).not.toThrow();
    expect(() => assertDeclaredBillScale('amount', -50000, POWER, -50)).not.toThrow(); // a credit
    // …and the same power computed twice lands on the same double, so the
    // agreement is exact; only an honest epsilon keeps it that way if the
    // arithmetic is ever rewritten.
    expect(() => assertDeclaredBillScale('amount', RAW, POWER, RAW / 10 ** -POWER)).not.toThrow();
  });

  it('refuses the 100×-small figure the old hard-coded scale produced', () => {
    const tooSmall = RAW / BILL_AMOUNT_SCALE; // what $175.76 became: 1.7576
    expect(tooSmall).toBe(1.7576);
    // `assertBillDollars` waves that through — it is a figure a bill can hold.
    expect(() => assertBillDollars('amount', tooSmall)).not.toThrow();

    try {
      assertDeclaredBillScale('amount', RAW, POWER, tooSmall);
      throw new Error('unreachable — a 100×-small bill was kept');
    } catch (e) {
      expect(isGreenButtonRefusal(e)).toBe(true);
      if (!isGreenButtonRefusal(e)) throw e;
      expect(e.code).toBe('bill-scale');
      expect(e.measured).toBe(tooSmall); // what it was rendered as
      expect(e.limit).toBe(DOLLARS); // …and what the file declares
      expect(e.detail).toContain('1.7576');
      expect(e.detail).toContain('175.76');
      expect(e.detail).toContain('10^-3');
      expect(e.detail).toMatch(/Nothing from this file was imported/);
    }
  });

  it('refuses the too-large half at the declared scale as well', () => {
    expect(() => assertDeclaredBillScale('amount', RAW, POWER, DOLLARS * 100)).toThrow(
      /wrong power of ten/,
    );
    expect(() => assertDeclaredBillScale('amount', RAW, POWER, Number.NaN)).toThrow(
      /Nothing from this file was imported/,
    );
  });

  it('compares nothing when the file declares nothing — the magnitude bound still applies', () => {
    // Oakville's money lines carry no measurement: the ESPI default is an
    // assumption, not a declaration, so there is nothing to contradict.
    expect(() =>
      assertDeclaredBillScale('billLastPeriod', 284259, null, 284259 / BILL_AMOUNT_SCALE),
    ).not.toThrow();
    expect(() => assertDeclaredBillScale('billLastPeriod', 1e303, null, 1e303)).not.toThrow();
  });
});

/* ==========================================================================
 * The span one billing period may state (t_edef78d7, F1 of t_3bfd4c3e)
 * ==========================================================================
 * `<billingPeriod><duration>` had no bound of its own: any finite figure
 * above zero became a `UsageSummary`, and every duration-driven pass then
 * priced it — the gas temperature bands walked one step per HOUR of it, so
 * one `<espi:duration>` was 4 449 ms at 1e12 s and 59 524 ms at 1e13 s of
 * main thread on this branch (the growth is linear; see gasTempBands.test.ts
 * for the ladder). This is the document-level half of the fix: refuse the
 * period at parse time, so it never becomes a bill, never reaches
 * localStorage, and never feeds a duration-driven loop anywhere downstream.
 *
 * The ceiling is 100 years, NOT the 400 days first proposed: the largest
 * billing period this repo parses is real — the Green Button Connect stand-in
 * states 721 958 400 s (22.9 y, cumulative since 2000-01-01) — and a 400-day
 * ceiling refused that whole document (measured on this branch: 5 files /
 * 10 tests red under it — usageSummary, billMoneyScale, utilitySamples,
 * parseDiagnostic and this file's own fixture control). 100 y sits 4.4x
 * above the real figure and still refuses every one the finding measured
 * (1e12 s = 31 709 y).
 */

describe('the span one billing period may state', () => {
  const READING =
    '<entry><content><espi:IntervalReading><espi:timePeriod><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></content></entry>';

  const SUMMARY_WITH_DURATION = (duration: number | string) =>
    '<entry><content><espi:UsageSummary><espi:billingPeriod><espi:start>1704067200</espi:start>' +
    `<espi:duration>${duration}</espi:duration></espi:billingPeriod>` +
    '<espi:billLastPeriod>1365030000</espi:billLastPeriod></espi:UsageSummary></content></entry>';

  it('refuses a 1e15-second billing period through the app\'s own funnel', () => {
    const xml = FEED(READING + SUMMARY_WITH_DURATION('1000000000000000'));
    // Nothing about the document is past any PRE-parse budget — the span is
    // the only thing wrong with it, and the flat scan cannot see inside one
    // block, which is exactly why this is judged where the period is known.
    expect(inspectDocument(xml).refusal).toBeNull();

    const refusal = refusalOf(xml);
    expect(refusal?.code).toBe('budget');
    expect(refusal?.dim).toBe('billPeriodSeconds');
    expect(refusal?.measured).toBe(1e15);
    expect(refusal?.limit).toBe(MAX_BILL_PERIOD_SECONDS);
    // The sentence names the span in DAYS (11 574 074 074 of them) and the
    // ceiling it broke (36 500), then says what happened to the file.
    expect(refusal?.detail).toMatch(/spans \d[\d, ]* days/);
    expect(refusal?.detail).toMatch(/Nothing from this file was imported/);
    expect(refusal?.headline).toBeTruthy();
    expect(refusal?.hints.length).toBeGreaterThan(0);
    // Fatal to the import, not just to this block: nothing is persisted.
    expect(() => parseGreenButtonFeed(xml)).toThrow(/Nothing from this file was imported/);
  }, 60_000);

  it('keeps a period AT the ceiling, and refuses one past it', () => {
    expect(() => assertBillPeriodSeconds(1)).not.toThrow();
    expect(() => assertBillPeriodSeconds(721_958_400)).not.toThrow(); // the real 22.9 y
    expect(() => assertBillPeriodSeconds(MAX_BILL_PERIOD_SECONDS)).not.toThrow();
    expect(() => assertBillPeriodSeconds(MAX_BILL_PERIOD_SECONDS - 1)).not.toThrow();

    expect(() => assertBillPeriodSeconds(MAX_BILL_PERIOD_SECONDS + 1)).toThrow(
      /Nothing from this file was imported/,
    );
    // The measured hostile figures — every one of them past the ceiling.
    for (const bad of [1e12, 1e13, 1e15, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => assertBillPeriodSeconds(bad), `seconds=${bad}`).toThrow(
        /Nothing from this file was imported/,
      );
    }
  });

  it('keeps the largest real billing period this repo parses — the 22.9-year cumulative summary', () => {
    const xml = readFileSync(
      join(__dirname, '../../../tests/fixtures/utility-espi-prefixed-standin.xml'),
      'utf8',
    );
    const summaries = parseUsageSummaries(xml);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].duration).toBe(721_958_400);
    expect(summaries[0].duration).toBeLessThanOrEqual(MAX_BILL_PERIOD_SECONDS);
    expect(() => parseGreenButtonFeed(xml)).not.toThrow();
  }, 60_000);
});
