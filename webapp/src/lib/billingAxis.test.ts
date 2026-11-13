/**
 * The billing axis — the timeline taken from the file's own billingPeriod
 * stamps (pure functions, tests first).
 *
 * The fixture is the committed synthetic Oakville-shaped export: three 29-day
 * periods starting mid-month (May 25 / Jun 23 / Jul 22, 2026), contiguous,
 * which is exactly the shape Mark's real 2-year export has — 24 mid-month
 * periods abutting to the day, then an unbilled tail of readings.
 *
 * Every edge case the spec names has a case here: odd (non-1st-of-month)
 * starts, periods shorter than 25 days and longer than 40, an export whose
 * last reading predates the last bill (no open bucket), an export with bills
 * but zero readings, two exports whose periods overlap, and the billing-day
 * fallback for a file with no UsageSummary at all.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AXIS_GAP_TOLERANCE_S,
  buildBillingAxis,
  dateWindowOf,
  dedupeBillPeriods,
  periodAt,
  stepPeriod,
  type AxisRow,
} from './billingAxis';
import { billPeriodLabel, parseUsageSummaries, type UsageSummary } from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const OAKVILLE = fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8');
const summaries = parseUsageSummaries(OAKVILLE);

const DAY = 86400;
const ts = (iso: string) => Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000);

/** One reading a day from `fromIso`, for `days` days. */
function dailyRows(fromIso: string, days: number): AxisRow[] {
  const out: AxisRow[] = [];
  const start = ts(fromIso);
  for (let i = 0; i < days; i += 1) {
    out.push({ timestamp: start + i * DAY + 3600 });
  }
  return out;
}

/** A bare UsageSummary: enough for the axis, no line items to speak of. */
function fakeSummary(startIso: string, days: number, items: number = 21): UsageSummary {
  const start = ts(startIso);
  return {
    source: 'UsageSummary',
    start,
    duration: days * DAY,
    startDate: startIso,
    endDate: '',
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null, volume: null,
    items: Array.from({ length: items }, (_, i) => ({
      note: `line ${i}`,
      amount: 1,
      rawAmount: 100000,
      itemKind: 1,
      unitCost: null,
      measurement: null,
    })),
  };
}

/* ------------------------------------------------------- de-dupe (slice 4) */

describe('dedupeBillPeriods', () => {
  it('keeps one copy of a period two exports stamp identically', () => {
    const dup = [summaries[1], summaries[1], summaries[1]];
    const { kept, dropped } = dedupeBillPeriods(dup);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(2);
    expect(kept[0].start).toBe(summaries[1].start);
  });

  it('folds a period written with a different stamp into the richer bill', () => {
    // The same bill exported a day apart: same window, fewer line items in
    // the second file (a summary-only export).
    const rich = fakeSummary('2026-07-22', 29, 21);
    const thin = fakeSummary('2026-07-23', 28, 4);
    const { kept, dropped } = dedupeBillPeriods([thin, rich]);
    expect(kept).toHaveLength(1);
    expect(kept[0].items).toHaveLength(21);
    expect(dropped).toBe(1);
  });

  it('leaves genuinely different periods alone, in start order', () => {
    const { kept, dropped } = dedupeBillPeriods([summaries[2], summaries[0], summaries[1]]);
    expect(kept.map((s) => s.startDate)).toEqual(['2026-05-25', '2026-06-23', '2026-07-22']);
    expect(dropped).toBe(0);
  });

  it('reports an overlap of exactly one day as the same bill (clock skew)', () => {
    const a = fakeSummary('2026-07-22', 29, 21);
    const b = fakeSummary('2026-07-23', 29, 21);
    const { kept, dropped } = dedupeBillPeriods([a, b]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

/* ------------------------------------------------------------ the axis ---- */

describe('buildBillingAxis — the file’s own periods', () => {
  it('cuts one period per billingPeriod, mid-month starts intact', () => {
    const axis = buildBillingAxis({ summaries, rows: [] });
    expect(axis.billed).toHaveLength(3);
    expect(axis.usedFallback).toBe(false);
    expect(axis.billed.map((p) => p.startDate)).toEqual([
      '2026-05-25',
      '2026-06-23',
      '2026-07-22',
    ]);
    // Oakville never starts a period on the 1st — no calendar rule would
    // produce these windows.
    expect(axis.billed.every((p) => p.startDate.slice(8) !== '01')).toBe(true);
    expect(axis.gaps).toHaveLength(0);
    expect(axis.open).toBeNull();
    expect(axis.note).toContain('3 billing periods');
  });

  it('labels a period the way every bill panel already does', () => {
    const axis = buildBillingAxis({ summaries, rows: [] });
    const first = axis.billed[0];
    expect(first.label).toBe(billPeriodLabel(summaries[0].start, summaries[0].duration));
    expect(first.shortLabel).toBe(first.label.split(' – ')[0]);
    expect(dateWindowOf(first)).toEqual({ start: '2026-05-25', end: '2026-06-23' });
    expect(first.flag).toBeNull(); // 29 days: ordinary
    expect(first.estimated).toBe(false);
    expect(first.summary).toBe(summaries[0]);
  });

  it('flags a period shorter than 25 days and one longer than 40', () => {
    const short = buildBillingAxis({ summaries: [fakeSummary('2026-03-01', 20)], rows: [] });
    expect(short.billed[0].flag).toBe('short');
    const long = buildBillingAxis({ summaries: [fakeSummary('2026-03-01', 45)], rows: [] });
    expect(long.billed[0].flag).toBe('long');
    // An ordinary 29-day period carries no flag at all.
    expect(buildBillingAxis({ summaries, rows: [] }).billed.every((p) => p.flag === null)).toBe(
      true,
    );
  });

  it('holds coverage honestly when the file carries bills but no readings', () => {
    const axis = buildBillingAxis({ summaries, rows: [] });
    expect(axis.billed.every((p) => p.coverage === 0)).toBe(true);
    expect(axis.billed.every((p) => p.rows.length === 0)).toBe(true);
    expect(axis.open).toBeNull();
  });
});

describe('buildBillingAxis — gaps (unknown periods)', () => {
  it('cuts an unknown period where no bill covers the days', () => {
    // Drop the middle bill: Jun 23 – Jul 22 is a hole.
    const axis = buildBillingAxis({ summaries: [summaries[0], summaries[2]], rows: [] });
    expect(axis.billed).toHaveLength(2);
    expect(axis.gaps).toHaveLength(1);
    const gap = axis.gaps[0];
    expect(gap.kind).toBe('gap');
    expect(gap.startDate).toBe('2026-06-23');
    expect(gap.endDate).toBe('2026-07-21');
    expect(gap.label).toContain('no bill in this file');
    expect(gap.summary).toBeNull();
    expect(gap.estimated).toBe(false);
    expect(axis.note).toContain('gap between bills');
    // The timeline itself is still sorted and complete.
    expect(axis.periods.map((p) => p.kind)).toEqual(['billed', 'gap', 'billed']);
  });

  it('does not call a day of clock skew a gap', () => {
    const a = fakeSummary('2026-05-25', 29);
    const b = fakeSummary('2026-06-24', 29); // one day late, inside tolerance
    expect(b.start - (a.start + a.duration)).toBeLessThanOrEqual(AXIS_GAP_TOLERANCE_S);
    expect(buildBillingAxis({ summaries: [a, b], rows: [] }).gaps).toHaveLength(0);
  });

  it('counts readings that fall inside the hole instead of losing them', () => {
    const axis = buildBillingAxis({
      summaries: [summaries[0], summaries[2]],
      rows: dailyRows('2026-06-25', 10),
    });
    expect(axis.gaps[0].rows).toHaveLength(10);
    expect(axis.gaps[0].coverage).toBeCloseTo(10 / 29, 5);
  });
});

describe('buildBillingAxis — the open (unbilled) period', () => {
  it('groups everything past the last bill into one estimated period', () => {
    // Readings run 45 days past Aug 20: the tail the utility has not billed.
    const rows = dailyRows('2026-07-01', 100); // Jul 1 → Oct 8
    const axis = buildBillingAxis({ summaries, rows });
    const open = axis.open;
    expect(open).not.toBeNull();
    expect(open!.kind).toBe('open');
    expect(open!.estimated).toBe(true);
    expect(open!.summary).toBeNull();
    expect(open!.startDate).toBe('2026-08-20');
    expect(open!.endDate).toBe('2026-10-08');
    expect(open!.label).toContain('not billed yet');
    expect(open!.shortLabel).toBe('Open · 2026-08-20');
    // 50 days: the >40-day flag travels with the period, not just the bills.
    expect(open!.flag).toBe('long');
    // Every day of the tail carries a reading; the window starts mid-morning
    // on the read date, so the ratio is a hair under 1 rather than exactly 1.
    expect(open!.coverage).toBeGreaterThan(0.95);
    expect(open!.coverage).toBeLessThanOrEqual(1);
    expect(axis.periods[axis.periods.length - 1]).toBe(open);
    expect(axis.note).toContain('open, estimated period');
  });

  it('creates NO open bucket when the last reading predates the last bill', () => {
    // Everything this export holds was billed on Jul 22 – Aug 20.
    const rows = dailyRows('2026-07-01', 40); // Jul 1 → Aug 9
    const axis = buildBillingAxis({ summaries, rows });
    expect(axis.open).toBeNull();
    expect(axis.periods.every((p) => p.kind === 'billed')).toBe(true);
  });

  it('creates no open bucket when the readings stop on the bill’s read date', () => {
    // The last bill was read Aug 20 at 05:00; this export’s newest reading
    // is Aug 20 at 01:00 — nothing is unbilled, so nothing is estimated.
    const axis = buildBillingAxis({ summaries, rows: dailyRows('2026-07-22', 30) });
    expect(axis.open).toBeNull();
  });

  it('starts the tail at the meter reads, not at the coarse stamp', () => {
    // The reads win (Wave L): a bill whose reads run past the stamp must not
    // have those already-billed hours re-billed as "unbilled".
    const withReads: UsageSummary = {
      ...summaries[2],
      // The fixture already ships its own read dates (Aug 20); drop them so
      // this bill is stamped with reads that run three days past the stamp.
      items: [
        ...summaries[2].items.filter((i) => !i.note.toLowerCase().includes('read date')),
        {
          note: 'Billing Period - Previous Read Date',
          amount: null,
          rawAmount: null,
          itemKind: null,
          unitCost: null,
          measurement: {
            value: summaries[2].start + 3 * DAY,
            scaled: summaries[2].start + 3 * DAY,
            powerOfTenMultiplier: 0,
            uom: 27,
          },
        },
        {
          note: 'Billing Period - Current Read Date',
          amount: null,
          rawAmount: null,
          itemKind: null,
          unitCost: null,
          measurement: {
            value: summaries[2].start + summaries[2].duration + 3 * DAY,
            scaled: summaries[2].start + summaries[2].duration + 3 * DAY,
            powerOfTenMultiplier: 0,
            uom: 27,
          },
        },
      ],
    };
    const rows = [
      ...dailyRows('2026-07-22', 32),
      ...dailyRows('2026-08-23', 5),
    ];
    const axis = buildBillingAxis({ summaries: [withReads], rows });
    expect(axis.open).not.toBeNull();
    // Reads end Aug 23 (stamp ends Aug 20): the three read days are billed.
    expect(axis.open!.startDate).toBe('2026-08-23');
    expect(axis.open!.rows).toHaveLength(5);
  });
});

/* ---------------------------------------------------- billing-day fallback */

describe('buildBillingAxis — billing-day fallback (no UsageSummary)', () => {
  const rows = dailyRows('2026-04-01', 190); // Apr 1 → Sep 27

  it('cuts periods on the billing day when the file states no bills', () => {
    const axis = buildBillingAxis({ summaries: [], rows, billingDay: 15 });
    expect(axis.usedFallback).toBe(true);
    expect(axis.billed).toHaveLength(0);
    expect(axis.periods.length).toBeGreaterThan(4);
    expect(axis.periods.every((p) => p.kind === 'derived')).toBe(true);
    expect(axis.periods.every((p) => p.startDate.endsWith('-15'))).toBe(true);
    expect(axis.periods.every((p) => p.summary === null)).toBe(true);
    expect(axis.periods.every((p) => p.estimated === false)).toBe(true);
    expect(axis.note).toContain('billing day');
    expect(axis.note).toContain('the 15th');
  });

  it('tiles the fallback periods with no holes and no money claims', () => {
    const axis = buildBillingAxis({ summaries: [], rows, billingDay: 15 });
    for (let i = 1; i < axis.periods.length; i += 1) {
      expect(axis.periods[i].start).toBe(axis.periods[i - 1].end);
    }
    expect(axis.gaps).toHaveLength(0);
    expect(axis.open).toBeNull(); // no bill to be unbilled against
    expect(axis.note).not.toContain('estimated');
  });

  it('says so plainly when there is nothing at all to build', () => {
    const axis = buildBillingAxis({ summaries: [], rows: [] });
    expect(axis.periods).toHaveLength(0);
    expect(axis.usedFallback).toBe(false);
    expect(axis.note).toMatch(/no timeline/i);
  });
});

/* ------------------------------------------------------- navigation helper */

describe('periodAt / stepPeriod', () => {
  const rows = dailyRows('2026-07-01', 100);
  const axis = buildBillingAxis({ summaries, rows });

  it('finds the period containing an instant', () => {
    expect(periodAt(axis, ts('2026-05-30'))!.kind).toBe('billed');
    expect(periodAt(axis, ts('2026-08-25'))!.kind).toBe('open');
    expect(periodAt(axis, ts('2026-01-01'))).toBeNull();
  });

  it('steps forwards and backwards through the timeline', () => {
    const first = axis.billed[0];
    const second = stepPeriod(axis, first.start, 'next')!;
    expect(second.start).toBe(axis.billed[1].start);
    expect(stepPeriod(axis, second.start, 'prev')!.start).toBe(first.start);
    const open = stepPeriod(axis, axis.billed[axis.billed.length - 1].start, 'next')!;
    expect(open.kind).toBe('open');
  });

  it('clamps at both ends instead of wrapping to the other side', () => {
    expect(stepPeriod(axis, axis.periods[0].start, 'prev')).toBeNull();
    expect(stepPeriod(axis, axis.periods[axis.periods.length - 1].start, 'next')).toBeNull();
  });

  it('aims at the nearest period when the window sits outside the timeline', () => {
    expect(stepPeriod(axis, ts('2025-01-01'), 'next')!.startDate).toBe('2026-05-25');
    expect(stepPeriod(axis, ts('2027-01-01'), 'prev')!.kind).toBe('open');
  });
});

/* --------------------------------------------------- two exports, one axis */

describe('two exports with overlapping ranges', () => {
  it('puts every period on the timeline exactly once', () => {
    const fileA = summaries;
    // File B re-states the last two periods a day late (different read job)
    // plus one genuinely new period after them.
    const fileB = [
      fakeSummary('2026-06-24', 29, 21),
      fakeSummary('2026-07-23', 28, 21),
      fakeSummary('2026-08-20', 29, 21),
    ];
    const axis = buildBillingAxis({ summaries: [...fileA, ...fileB], rows: [] });
    expect(axis.billed.map((p) => p.startDate)).toEqual([
      '2026-05-25',
      '2026-06-23',
      '2026-07-22',
      '2026-08-20',
    ]);
    expect(axis.droppedDuplicates).toBe(2);
    expect(axis.note).toContain('2 duplicate periods');
    expect(axis.gaps).toHaveLength(0);
  });
});
