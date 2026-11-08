/**
 * `/import`'s bill-feed write decision (AC3/AC4 of t_05195060).
 *
 * Run: cd webapp && npx vitest run src/app/import/billFeedPlan.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { UsageSummary } from '@/lib/energy';
import type { BillFeed } from '@/hooks/useDashboard';
import { planBillFeed } from './billFeedPlan';

/** The shape `readStoredBillFeed` validates — only the fields the plan reads. */
const bill = (start: number): UsageSummary =>
  ({
    source: 'UsageSummary',
    start,
    duration: 28 * 86400,
    startDate: '2026-01-01',
    endDate: '2026-01-29',
    days: 28,
    billLastPeriod: 28 * 86400,
    billToDate: 0,
    costAdditionalLastPeriod: 0,
    currency: 124,
    consumption: null,
    volume: null,
    items: [],
  }) as unknown as UsageSummary;

const feed = (
  starts: number[],
  localTime: { tzOffset: number } | null = null,
  source: string | null = null,
): BillFeed => ({ summaries: starts.map(bill), localTime: localTime as BillFeed['localTime'], source });

const starts = (f: BillFeed) => f.summaries.map((s) => s.start);

describe('planBillFeed — merge never loses a bill', () => {
  it('keeps the existing periods and adds the file’s own', () => {
    const next = planBillFeed('merge', feed([1000, 2000]), feed([2000, 3000]));
    expect(starts(next)).toEqual([1000, 2000, 3000]);
  });

  it('a file with NO summaries leaves an existing bill feed untouched (AC3)', () => {
    const existing = feed([1000, 2000], { tzOffset: -18000 });
    const next = planBillFeed('merge', existing, feed([]));
    expect(starts(next)).toEqual([1000, 2000]);
    expect(next.localTime).toEqual({ tzOffset: -18000 });
  });

  it('into an empty profile the merge is just the file', () => {
    const next = planBillFeed('merge', { summaries: [], localTime: null, source: null }, feed([1000]));
    expect(starts(next)).toEqual([1000]);
  });

  it('is idempotent — re-importing the same file changes nothing', () => {
    const once = planBillFeed('merge', { summaries: [], localTime: null, source: null }, feed([1, 2]));
    const twice = planBillFeed('merge', once, feed([1, 2]));
    expect(starts(twice)).toEqual([1, 2]);
  });
});

describe('planBillFeed — replace is the only path that swaps', () => {
  it('drops what the file does not carry (AC4)', () => {
    const next = planBillFeed('replace', feed([1000, 2000]), feed([3000]));
    expect(starts(next)).toEqual([3000]);
  });

  it('an empty profile replaced by nothing is empty — the modal’s “panel to nothing”', () => {
    const next = planBillFeed('replace', feed([1000]), feed([]));
    expect(next.summaries).toEqual([]);
    expect(next.localTime).toBeNull();
  });

  it('takes the file’s clock as parsed, not the one already stored', () => {
    const next = planBillFeed('replace', feed([1000], { tzOffset: -18000 }), feed([3000]));
    expect(next.localTime).toBeNull();
  });

  it('and carries the file’s clock when it declares one', () => {
    const next = planBillFeed('replace', feed([1000]), feed([3000], { tzOffset: -21600 }));
    expect(next.localTime).toEqual({ tzOffset: -21600 });
  });
});
