/**
 * The estimate ledger — the promise that "we estimated it" can later be
 * scored against "the utility billed it".
 *
 * The claims are made up here (this browser has no future bill yet), but the
 * bills are the committed fixture's, so `actual` in every assertion comes
 * from `billTotals` rather than a retyped constant: if the parser and the
 * ledger ever disagree, the test fails instead of agreeing with a stale
 * number.
 *
 * The whole module is clock-free on purpose: it is derived while React
 * renders, where `Date.now()` has no business being.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOSE_COVERAGE,
  EMPTY_LEDGER,
  accuracySummary,
  closeEstimates,
  readLedger,
  recordOpenEstimate,
  serializeLedger,
} from './estimateLedger';
import { billPeriodLabel, billTotals, parseUsageSummaries } from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const summaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

const DAY = 86400;
const first = summaries[0];
const firstCommodity = billTotals(first).commodity;
const firstSpan = { start: first.start, end: first.start + first.duration };

const claim = (over: Partial<Parameters<typeof recordOpenEstimate>[1]> = {}) =>
  recordOpenEstimate(EMPTY_LEDGER, {
    windowStart: firstSpan.start,
    windowEnd: firstSpan.end,
    plan: 'TOU',
    estimated: firstCommodity,
    meteredKwh: 1000,
    ...over,
  });

describe('readLedger', () => {
  it('treats missing and corrupt storage as an empty ledger', () => {
    expect(readLedger(null)).toEqual(EMPTY_LEDGER);
    expect(readLedger('')).toEqual(EMPTY_LEDGER);
    expect(readLedger('{not json')).toEqual(EMPTY_LEDGER);
    expect(readLedger('"a string"')).toEqual(EMPTY_LEDGER);
    expect(readLedger('{"open":"nope","closed":3}')).toEqual(EMPTY_LEDGER);
  });

  it('round-trips a real ledger and drops malformed entries', () => {
    const ledger = claim();
    expect(readLedger(serializeLedger(ledger))).toEqual(ledger);

    const dirty = readLedger(
      JSON.stringify({
        open: [{ windowStart: 1 }, { windowStart: 2, windowEnd: 5, estimated: 3 }],
        closed: [null, { windowStart: 7, actual: 4 }],
      }),
    );
    expect(dirty.open).toHaveLength(1);
    expect(dirty.open[0].windowStart).toBe(2);
    expect(dirty.closed).toHaveLength(1);
    // A record that never states a rate derives one — and with no kWh it is
    // honestly 0 rather than NaN.
    expect(dirty.open[0].ratePerKwh).toBe(0);
  });
});

describe('recordOpenEstimate', () => {
  it('upserts one claim per window instead of stacking revisions', () => {
    const firstClaim = claim();
    const second = recordOpenEstimate(firstClaim, {
      windowStart: firstSpan.start,
      windowEnd: firstSpan.end + 7 * DAY, // the tail grew as readings arrived
      plan: 'TOU',
      estimated: firstCommodity * 1.2,
      meteredKwh: 1200,
    });
    expect(second.open).toHaveLength(1);
    expect(second.open[0].windowEnd).toBe(firstSpan.end + 7 * DAY);
    expect(second.open[0].estimated).toBeCloseTo(firstCommodity * 1.2, 6);
    expect(second.open[0].ratePerKwh).toBeCloseTo((firstCommodity * 1.2) / 1200, 6);
  });

  it('returns the SAME object when nothing changed (the panel derives in render)', () => {
    const once = claim();
    const again = recordOpenEstimate(once, {
      windowStart: firstSpan.start,
      windowEnd: firstSpan.end,
      plan: 'TOU',
      estimated: firstCommodity,
      meteredKwh: 1000,
    });
    expect(again).toBe(once);
  });

  it('refuses to record a claim that estimates nothing', () => {
    expect(claim({ estimated: 0 }).open).toHaveLength(0);
    expect(claim({ windowEnd: firstSpan.start }).open).toHaveLength(0);
  });

  it('keeps several windows in start order', () => {
    let ledger = claim();
    ledger = recordOpenEstimate(ledger, {
      windowStart: firstSpan.start + 400 * DAY,
      windowEnd: firstSpan.end + 400 * DAY,
      plan: 'TOU',
      estimated: 10,
      meteredKwh: 100,
    });
    expect(ledger.open.map((r) => r.windowStart)).toEqual([
      firstSpan.start,
      firstSpan.start + 400 * DAY,
    ]);
  });
});

describe('closeEstimates — the reconciliation loop', () => {
  it('scores an exact claim at 100% and files it', () => {
    const ledger = closeEstimates(claim(), summaries);
    expect(ledger.open).toHaveLength(0);
    expect(ledger.closed).toHaveLength(1);
    const [check] = ledger.closed;
    expect(check.actual).toBeCloseTo(firstCommodity, 6);
    expect(check.estimated).toBeCloseTo(firstCommodity, 6);
    expect(check.delta).toBeCloseTo(0, 6);
    expect(check.accuracy).toBeCloseTo(100, 6);
    expect(check.coverage).toBeCloseTo(1, 6);
    expect(check.partial).toBe(false);
    expect(check.label).toBe(billPeriodLabel(first.start, first.duration));
  });

  it('scores a claim that overshot by 10% at 90%', () => {
    const ledger = closeEstimates(claim({ estimated: firstCommodity * 1.1 }), summaries);
    const [check] = ledger.closed;
    expect(check.delta).toBeCloseTo(firstCommodity * 0.1, 6);
    expect(check.accuracy).toBeCloseTo(90, 6);
  });

  it('leaves a window open until the bills cover enough of it', () => {
    // One bill covers only a third of the claim's window.
    const wide = claim({
      windowStart: firstSpan.start,
      windowEnd: firstSpan.end + 2 * first.duration,
    });
    const ledger = closeEstimates(wide, [first]);
    expect(ledger.open).toHaveLength(1);
    expect(ledger.closed).toHaveLength(0);
    expect(1 / 3).toBeLessThan(CLOSE_COVERAGE);

    // The other two bills arrive: the window is now fully covered.
    const settled = closeEstimates(ledger, summaries);
    expect(settled.open).toHaveLength(0);
    expect(settled.closed).toHaveLength(1);
    expect(settled.closed[0].coverage).toBeCloseTo(1, 6);
    expect(settled.closed[0].partial).toBe(false);
  });

  it('prorates when the closing bill straddles the claim’s window', () => {
    // Claim a 20-day window that starts 10 days INTO a 29-day bill. The bills
    // cover 19 of the 20 claimed days (well past CLOSE_COVERAGE), but 10 days
    // of that bill belong to someone else — so the bill's charge is scaled to
    // the 19/29 of it that sits inside the window, and the claim to the 19/20
    // of the window the bills actually reached.
    const span = 20 * DAY;
    const windowStart = firstSpan.start + 10 * DAY;
    const windowEnd = windowStart + span;
    const coverage = (19 * DAY) / span;
    const billShare = (19 * DAY) / (firstSpan.end - firstSpan.start);
    // State the claim so it would be exactly right at those prorations: the
    // score then measures the proration, not a made-up miss.
    const estimate = (firstCommodity * billShare) / coverage;

    const ledger = closeEstimates(claim({ windowStart, windowEnd, estimated: estimate }), [first]);
    expect(ledger.open).toHaveLength(0);
    const [check] = ledger.closed;
    expect(check.coverage).toBeCloseTo(coverage, 6);
    expect(check.partial).toBe(true);
    expect(check.estimated).toBeCloseTo(estimate * coverage, 6);
    expect(check.actual).toBeCloseTo(firstCommodity * billShare, 6);
    expect(check.accuracy).toBeCloseTo(100, 6);
  });

  it('never double-scores: a settled window is not re-opened by new bills', () => {
    const once = closeEstimates(claim(), summaries);
    const twice = closeEstimates(once, summaries);
    expect(twice.closed).toHaveLength(1);
    expect(twice.closed[0]).toEqual(once.closed[0]);
  });

  it('does nothing — the SAME object — when there is no claim or no bill', () => {
    expect(closeEstimates(EMPTY_LEDGER, summaries)).toBe(EMPTY_LEDGER);
    const unclaimed = claim();
    expect(closeEstimates(unclaimed, [])).toBe(unclaimed);
  });

  it('is idempotent: settling an already-settled ledger returns it untouched', () => {
    const settled = closeEstimates(claim(), summaries);
    expect(closeEstimates(settled, summaries)).toBe(settled);
  });
});

describe('accuracySummary', () => {
  it('reports nothing before the first claim settles', () => {
    expect(accuracySummary([])).toEqual({
      settled: 0,
      meanAccuracy: null,
      allWithinDollar: false,
    });
  });

  it('averages the settled scores', () => {
    const ledger = closeEstimates(claim({ estimated: firstCommodity * 1.1 }), summaries);
    const second = closeEstimates(
      claim({
        windowStart: summaries[1].start,
        windowEnd: summaries[1].start + summaries[1].duration,
        estimated: billTotals(summaries[1]).commodity,
      }),
      [summaries[1]],
    );
    const all = { open: [], closed: [...ledger.closed, ...second.closed] };
    const summary = accuracySummary(all.closed);
    expect(summary.settled).toBe(2);
    expect(summary.meanAccuracy).toBeCloseTo(95, 1);
    expect(summary.allWithinDollar).toBe(false); // one of them missed by > $1
  });
});
