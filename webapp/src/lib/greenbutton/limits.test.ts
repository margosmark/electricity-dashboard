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
  MAX_BILL_MEASUREMENT,
  MAX_CLOCK_OFFSET_S,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH,
  MAX_ENTRIES,
  MAX_READINGS,
  MAX_UNIT_PRICE_DOLLARS,
  assertBillDollars,
  assertBillMeasurement,
  assertDocumentBudget,
  assertUnitPrice,
  budgetRefusal,
  inspectDocument,
  isClockOffset,
  isGreenButtonRefusal,
  measureDocument,
  type DocumentStats,
} from './limits';
import { parseGreenButtonFeed, parseGreenButtonUsagePoints } from '@/lib/energy';
import { diagnoseGreenButtonDocument } from '@/lib/parseDiagnostic';

function stats(o: Partial<DocumentStats>): DocumentStats {
  return { bytes: 0, depth: 0, entries: 0, readings: 0, ...o };
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
