/**
 * gasMonthly — the pure monthly/year-over-year builder behind the gas
 * Analytics panels (t_a2343a2f).
 *
 * Command: `npx vitest run src/lib/gasMonthly.test.ts`
 *
 * What is pinned here:
 *  1. monthly rows are the UNION of reading months and bill-start months,
 *     with the two m³ figures kept side by side and never merged;
 *  2. money passes through EXACTLY as the bill states it — a period with no
 *     Amount Due is null (never 0, never a rate × m³ substitute);
 *  3. the chart source is declared once per import and months outside it
 *     chart as a gap (null), never a fabricated zero;
 *  4. coverage days (firstDay/lastDay) drive the honest partial-month flags,
 *     including a bill that ends in a LATER month (it covers this row's
 *     month to its end);
 *  5. year-over-year gates on a span of MORE than 12 months and says exactly
 *     how much history exists; "stored but states no volume" is distinguished
 *     from "nothing stored".
 *
 * FIXTURE POLICY: SYNTHETIC only — summaries are built in-file; the real
 * EGD export never enters this repo.
 */
import { describe, expect, it, afterEach } from 'vitest';

import {
  buildGasMonthly,
  buildGasYearOverYear,
  daysInMonth,
} from './gasMonthly';
import { setLocale } from '@/i18n';
import type { UsageSummary, BillLineItem } from './energy';
import type { GasPoint } from './storage';

afterEach(() => setLocale('en'));

const line = (note: string, amount: number | null): BillLineItem => ({
  note,
  amount,
  rawAmount: amount !== null ? Math.round(amount * 1000) : null,
  itemKind: null,
  unitCost: null,
  measurement: null,
});

/** A synthetic Enbridge-shaped billing period starting on `start` (UTC). */
function bill(
  start: string,
  days: number,
  opts: { due?: number | null; total?: number | null; billed?: number | null } = {},
): UsageSummary {
  const startTs = Date.parse(`${start}T00:00:00Z`) / 1000;
  const duration = days * 86400;
  const endDate = new Date((startTs + duration) * 1000).toISOString().slice(0, 10);
  const items: BillLineItem[] = [];
  if (opts.due !== undefined) items.push(line('Amount Due', opts.due));
  if (opts.total !== undefined) items.push(line('Total Gas Charges ($)', opts.total));
  // Always present so a no-volume bill is still recognisably a gas bill
  // (GAS_NOTE_MARKERS matches "total gas charges" / "gas supply").
  if (!items.some((i) => i.note === 'Total Gas Charges ($)')) {
    items.push(line('Total Gas Charges ($)', opts.total ?? null));
  }
  items.push(line('Gas Supply Charge', opts.total ?? null));
  return {
    source: 'UsageSummary',
    start: startTs,
    duration,
    startDate: start,
    endDate,
    days,
    billLastPeriod: opts.due ?? null,
    billToDate: opts.due ?? null,
    costAdditionalLastPeriod: 0,
    currency: 124,
    consumption: null,
    volume:
      opts.billed !== undefined && opts.billed !== null
        ? {
            scaled: opts.billed,
            value: Math.round(opts.billed * 1000),
            powerOfTenMultiplier: -3,
            uom: 42,
          }
        : null,
    items,
  };
}

/** A stored interval reading at noon UTC on `day` (local-day safe). */
const reading = (isoDay: string, m3: number): GasPoint => ({
  timestamp: Date.parse(`${isoDay}T12:00:00Z`) / 1000,
  duration_s: 86400,
  volume_m3: m3,
});

describe('buildGasMonthly — union, attribution, honesty', () => {
  it('empty inputs: source none, no rows, nothing paid', () => {
    const m = buildGasMonthly([], []);
    expect(m.source).toBe('none');
    expect(m.rows).toEqual([]);
    expect(m.hasInterval).toBe(false);
    expect(m.hasBills).toBe(false);
    expect(m.hasPaid).toBe(false);
  });

  it('bills only → declared source `billed`, one row per bill-start month', () => {
    const m = buildGasMonthly(
      [],
      [bill('2025-01-25', 32, { due: 175.76, total: 161.89, billed: 429 }), bill('2025-02-26', 28, { due: 153.06, total: 153.06, billed: 388 })],
    );
    expect(m.source).toBe('billed');
    expect(m.hasBills).toBe(true);
    expect(m.hasPaid).toBe(true);
    expect(m.rows.map((r) => r.key)).toEqual(['2025-01', '2025-02']);
    // Billed m³ is charted from the bill's own stated volume.
    expect(m.rows[0].chartM3).toBe(429);
    expect(m.rows[0].bills[0].billedM3).toBe(429);
    // The bill's own money, byte-for-byte: 175.76 is not scaled, not summed
    // with anything, not recomputed from the 429 m³ beside it.
    expect(m.rows[0].bills[0].amountDue).toBe(175.76);
  });

  it('points present → declared source `interval`; bill-only months chart a gap', () => {
    const m = buildGasMonthly(
      [reading('2025-01-15', 10), reading('2025-01-20', 5), reading('2025-02-03', 7)],
      [bill('2025-03-25', 31, { due: 90, total: 90, billed: 200 })],
    );
    expect(m.source).toBe('interval');
    expect(m.hasInterval).toBe(true);
    expect(m.rows.map((r) => r.key)).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(m.rows[0].intervalM3).toBe(15);
    expect(m.rows[1].intervalM3).toBe(7);
    // The March row exists (the bill starts there) but the INTERVAL source
    // does not cover it — a gap, never a fabricated zero.
    expect(m.rows[2].chartM3).toBeNull();
    expect(m.rows[2].intervalM3).toBeNull();
    // The bill's figures are still on the row, side by side with the gap.
    expect(m.rows[2].bills).toHaveLength(1);
    expect(m.rows[2].bills[0].amountDue).toBe(90);
  });

  it('a bill is attributed to the month its period STARTS, not ends', () => {
    const m = buildGasMonthly([], [bill('2025-03-25', 32, { due: 10, total: 10, billed: 50 })]);
    expect(m.rows.map((r) => r.key)).toEqual(['2025-03']);
    expect(m.rows[0].bills[0].endDate).toBe('2025-04-26');
  });

  it('two bills starting the same month share one row and both are kept', () => {
    const m = buildGasMonthly(
      [],
      [
        bill('2025-05-01', 9, { due: 40, total: 40, billed: 90 }),
        bill('2025-05-10', 21, { due: 60, total: 60, billed: 110 }),
      ],
    );
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].bills.map((b) => b.amountDue)).toEqual([40, 60]);
    // Charted m³ sums the two STATED volumes — a sum of feed figures, not a
    // derived number — while the money stays per-bill, never summed here.
    expect(m.rows[0].chartM3).toBe(200);
    expect(m.rows[0].bills.map((b) => b.amountDue)).not.toContain(100);
  });

  it('a period with no stated amount is null — never zero, never derived', () => {
    const m = buildGasMonthly([], [bill('2025-06-25', 30, { due: null, total: null, billed: 120 })]);
    expect(m.hasPaid).toBe(false);
    expect(m.rows[0].bills[0].amountDue).toBeNull();
    expect(m.rows[0].bills[0].billedM3).toBe(120);
    // The m³ is present, so a missing dollar can never be "filled in" from it.
    expect(m.rows[0].bills[0].amountDue).not.toBe(0);
  });

  it('coverage: a bill ending in a later month covers this row to its end', () => {
    const m = buildGasMonthly(
      [],
      [bill('2025-01-25', 32, { due: 1, total: 1, billed: 10 })], // ends 2025-02-26
    );
    expect(m.rows[0].firstDay).toBe(25);
    expect(m.rows[0].lastDay).toBe(daysInMonth(2025, 0)); // 31 — not 26
  });

  it('coverage: a bill ending inside its own month bounds coverage at the end day', () => {
    const m = buildGasMonthly(
      [],
      [bill('2025-01-10', 10, { due: 1, total: 1, billed: 10 })], // ends 2025-01-20
    );
    expect(m.rows[0].firstDay).toBe(10);
    expect(m.rows[0].lastDay).toBe(20);
  });

  it('coverage: readings record their own start days', () => {
    const m = buildGasMonthly([reading('2025-07-05', 3), reading('2025-07-18', 4)], []);
    expect(m.rows[0].firstDay).toBe(5);
    expect(m.rows[0].lastDay).toBe(18);
  });
});

describe('buildGasYearOverYear — gate, deltas, totals, honest empties', () => {
  /** n monthly bills from `fromYear`-`fromMonth`, one per calendar month. */
  function monthlyBills(
    fromYear: number,
    fromMonth: number,
    count: number,
    opts: { startDay?: number; m3?: number; due?: number | null } = {},
  ): UsageSummary[] {
    const out: UsageSummary[] = [];
    const startDay = opts.startDay ?? 1;
    for (let i = 0; i < count; i++) {
      const y = fromYear + Math.floor((fromMonth - 1 + i) / 12);
      const m = ((fromMonth - 1 + i) % 12) + 1;
      const start = `${y}-${String(m).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
      const days = daysInMonth(y, m - 1) - startDay + 1;
      out.push(
        bill(start, days, {
          due: opts.due ?? 100,
          total: opts.due ?? 100,
          billed: opts.m3 ?? 100,
        }),
      );
    }
    return out;
  }

  it('nothing stored → the upload prompt, not a claim about volume', () => {
    const yoy = buildGasYearOverYear(buildGasMonthly([], []));
    expect(yoy.ready).toBe(false);
    expect(yoy.emptyMessage).toContain('No data loaded yet');
    expect(yoy.emptyMessage).toContain('Green Button XML');
  });

  it('stored but states no volume → says exactly that, never "no data"', () => {
    const yoy = buildGasYearOverYear(
      buildGasMonthly([], [bill('2025-01-01', 31, { due: 10, total: 10 })]), // no billed m³
    );
    expect(yoy.ready).toBe(false);
    expect(yoy.emptyMessage).toBe(
      'This import states no gas volume — there is nothing to chart.',
    );
    expect(yoy.emptyMessage).not.toContain('No data loaded yet');
  });

  it('exactly 12 months of span is NOT ready — the gate is MORE than 12', () => {
    const yoy = buildGasYearOverYear(buildGasMonthly([], monthlyBills(2025, 1, 12)));
    expect(yoy.ready).toBe(false);
    expect(yoy.emptyMessage).toMatch(
      /Need 12\+ months of data — you have 12 months \(Jan 2025 – Dec 2025\)\./,
    );
    expect(yoy.monthsOfData).toBe(12);
    expect(yoy.spanMonths).toBe(12);
  });

  it('13 months → ready: one series per year, a full delta row, year totals', () => {
    const yoy = buildGasYearOverYear(buildGasMonthly([], monthlyBills(2025, 1, 13)));
    expect(yoy.ready).toBe(true);
    expect(yoy.emptyMessage).toBeNull();
    expect(yoy.series.map((s) => s.year)).toEqual([2025, 2026]);
    // 2026 has a prior year → exactly one delta row, 12 cells, all equal
    // (same stated volume every month) → 0 %.
    expect(yoy.deltas).toHaveLength(1);
    expect(yoy.deltas[0].year).toBe(2026);
    expect(yoy.deltas[0].pct).toHaveLength(12);
    // Jan 2026 exists (equal volume → 0 %); Feb..Dec 2026 do not → null
    // cells, never zeros.
    expect(yoy.deltas[0].pct[0]).toBe(0);
    expect(yoy.deltas[0].pct.slice(1).every((p) => p === null)).toBe(true);
    // Full-year totals: 2025 complete, 2026 partial (1 of 12 months).
    expect(yoy.yearTotals.map((t) => [t.year, t.months, t.partial])).toEqual([
      [2025, 12, false],
      [2026, 1, true],
    ]);
    expect(yoy.yearTotals[0].m3).toBe(1200);
    // Every bill starts on day 1 and ends in the next month → both span
    // edges are FULLY covered: no partial month at all.
    expect(yoy.partialMonths).toEqual([]);
    expect(yoy.firstMonthLabel).toBe('Jan 2025');
    expect(yoy.lastMonthLabel).toBe('Jan 2026');
  });

  it('span edges: a first bill on the 25th marks the first month partial', () => {
    const yoy = buildGasYearOverYear(
      buildGasMonthly([], monthlyBills(2025, 1, 14, { startDay: 25 })),
    );
    expect(yoy.ready).toBe(true);
    expect(yoy.partialMonths).toContain('2025-01');
    // …and the partial edge makes that year's total honestly partial.
    const y2025 = yoy.yearTotals.find((t) => t.year === 2025)!;
    expect(y2025.partial).toBe(true);
  });

  it('a last month ending mid-month is partial; a bill ending later is not', () => {
    // Ends 2026-02-14 (inside Feb) → Feb 2026 partial.
    const midEnd = buildGasYearOverYear(
      buildGasMonthly(
        [],
        [...monthlyBills(2025, 1, 13), bill('2026-02-01', 14, { due: 5, total: 5, billed: 5 })],
      ),
    );
    expect(midEnd.partialMonths).toContain('2026-02');

    // Ends in a later month → the row's month is fully covered.
    const crossEnd = buildGasYearOverYear(
      buildGasMonthly(
        [],
        [...monthlyBills(2025, 1, 13), bill('2026-02-01', 30, { due: 5, total: 5, billed: 5 })],
      ),
    );
    expect(crossEnd.partialMonths).not.toContain('2026-02');
  });

  it('a zero prior-year month yields a null delta — never a division blowup', () => {
    const bills = [
      ...monthlyBills(2025, 1, 12, { m3: 0, due: 1 }),
      ...monthlyBills(2026, 1, 12, { m3: 50, due: 1 }),
    ];
    const yoy = buildGasYearOverYear(buildGasMonthly([], bills));
    expect(yoy.ready).toBe(true);
    expect(yoy.deltas[0].pct.every((p) => p === null)).toBe(true);
    // …while the year totals still show the real volumes.
    expect(yoy.yearTotals.find((t) => t.year === 2025)!.m3).toBe(0);
    expect(yoy.yearTotals.find((t) => t.year === 2026)!.m3).toBe(600);
  });

  it('the empty-state copy is locale-aware (FR month names)', () => {
    setLocale('fr');
    const yoy = buildGasYearOverYear(buildGasMonthly([], monthlyBills(2025, 1, 3)));
    expect(yoy.ready).toBe(false);
    expect(yoy.emptyMessage).toContain('janv 2025');
    expect(yoy.emptyMessage).toContain('mars 2025');
    expect(yoy.emptyMessage).toContain('en avez 3');
  });
});
