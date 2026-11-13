/**
 * The TIER 1 / TIER 2 split as it reaches the screen.
 *
 * Two surfaces carry it, and both are checked here:
 *
 *   • the stacked money chart's legend, its raw-numbers table and its
 *     tooltip get one slice per tier, with the bill's OWN figures;
 *   • the PeriodDeltaTable gets a "Tier 1" and a "Tier 2" row, and every
 *     cell where a period was never billed on that tier — a TOU period, and
 *     the OPEN estimate, which is one blended commodity figure we refuse to
 *     cut into tiers after the fact — prints a dash rather than "$0.00" or
 *     "TIER X" over money nobody has charged.
 *
 * The two Tiered periods are Mark's own bills inlined note-for-note, the way
 * `planTimeline.test.ts` inlines the BLOCK notes (the real 24-period export
 * never enters this repo). Every figure is the bill's own note → amount pair
 * and checks out as rate × kWh:
 *
 *   9.3¢ × 631   = $58.68   BLOCK 1- Summer   (Sep 2025)
 *  11.0¢ × 828.6 = $91.14   BLOCK 2 - Summer  (Sep 2025)
 *
 * i.e. BLOCK 1 is the cheap tier. The TOU period in front of them is what a
 * mixed file looks like: it keeps its off/mid/on-peak columns and reads a
 * dash under both tiers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import MoneySection from './MoneySection';
import type { BillLineItem, ProcessedPoint, UsageSummary } from '@/lib/energy';

const DAY = 86400;
const ts = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);

/** A priced bill line; `kwh` adds the matching "… Usage" measurement line. */
const line = (note: string, amount: number | null = null, kwh: number | null = null): BillLineItem => ({
  note,
  amount,
  rawAmount: amount === null ? null : Math.round(amount * 100000),
  itemKind: 10,
  unitCost: null,
  measurement:
    kwh === null
      ? null
      : { scaled: kwh, value: Math.round(kwh * 1e6), powerOfTenMultiplier: -6, uom: 72 },
});

/** A UsageSummary with no read-date lines, so billWindow = billingPeriod. */
function bill(startDate: string, days: number, items: BillLineItem[]): UsageSummary {
  const start = ts(startDate);
  const duration = days * DAY;
  const end = new Date((start + duration) * 1000);
  return {
    source: 'UsageSummary',
    start,
    duration,
    startDate,
    endDate: end.toISOString().slice(0, 10),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null, volume: null,
    items,
  };
}

/** One reading a day at 03:00, priced under all three plans. */
function daily(fromTs: number, days: number, kwh = 1): ProcessedPoint[] {
  const out: ProcessedPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const timestamp = fromTs + i * DAY + 3 * 3600;
    const d = new Date(timestamp * 1000);
    out.push({
      timestamp,
      usage_kwh: kwh,
      dateObj: d,
      dayStr: d.toISOString().slice(0, 10),
      hourStr: '03:00',
      touCategory: 'Off-Peak',
      uloCategory: 'Overnight',
      isWinter: false,
      costTOU: (kwh * 9.8) / 100,
      costTiered: (kwh * 12) / 100,
      costULO: (kwh * 3.9) / 100,
      activeRateSet: {
        effectiveDate: '2025-11-01',
        tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
        tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
        ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
      },
    });
  }
  return out;
}

/* Aug 26 – Sep 25 2025, billed time-of-use. */
const TOU_PERIOD = bill('2025-08-26', 30, [
  line('Off Peak-Summer', 122.82),
  line('Mid Peak-Summer', 49.22),
  line('On Peak-Summer', 55.29),
  line('Delivery', 55.1),
  line('Regulatory Charges', 5.9, null),
  line('H.S.T. # 869177972', 30.4),
]);

/* Sep 25 – Oct 27 2025, billed tiered: both blocks. */
const TIERED_PERIOD = bill('2025-09-25', 32, [
  line('BLOCK 1- Summer', 58.68, 631),
  line('BLOCK 2 - Summer', 91.14, 828.6),
  line('Delivery', 60.06),
  line('Regulatory Charges', 9.35),
  line('H.S.T. # 869177972', 30.46),
]);

const summaries = [TOU_PERIOD, TIERED_PERIOD];

/** Both bills, plus a 40-day tail so the axis carries an OPEN period. */
const allData = [
  ...daily(TOU_PERIOD.start, TOU_PERIOD.days),
  ...daily(TIERED_PERIOD.start, TIERED_PERIOD.days),
  ...daily(TIERED_PERIOD.start + TIERED_PERIOD.duration, 40),
];

const cells = (row: HTMLElement) =>
  [...row.querySelectorAll('td')].map((td) => td.textContent!.trim());

beforeEach(() => {
  localStorage.clear();
});

describe('the tier split in the stacked money chart', () => {
  it('names Tier 1 and Tier 2 in the legend, and prints the bill’s own figures', async () => {
    render(<MoneySection summaries={summaries} allData={allData} plan="Tiered" />);
    await screen.findByTestId('money-stacked');

    const legend = within(screen.getByTestId('money-legend'));
    expect(legend.getByText('Tier 1')).toBeInTheDocument();
    expect(legend.getByText('Tier 2')).toBeInTheDocument();

    // The raw-numbers table: one row per period, one column per slice.
    const table = screen.getByTestId('money-table');
    const headers = [...within(table).getAllByRole('columnheader')].map((th) =>
      th.textContent!.trim(),
    );
    const col = (name: string) => {
      const i = headers.indexOf(name);
      expect(i, `column "${name}" (${headers.join(' | ')})`).toBeGreaterThan(-1);
      return i;
    };
    const tiered = within(table).getAllByTestId('money-row')[1];

    // BLOCK 1 = the cheap tier: 9.3¢ × 631 kWh. Not the other way round.
    expect(cells(tiered)[col('Tier 1')]).toBe('$58.68');
    expect(cells(tiered)[col('Tier 2')]).toBe('$91.14');

    // The TOU period in front of it has no tiers: a dash, never "$0.00".
    const tou = within(table).getAllByTestId('money-row')[0];
    expect(cells(tou)[col('Tier 1')]).toBe('—');
    expect(cells(tou)[col('Tier 2')]).toBe('—');
    expect(cells(tou)[col('Off-peak')]).toBe('$122.82');
  });

  it('keeps the OPEN row an estimate: tier cells are dashes, not a tiered claim', async () => {
    render(<MoneySection summaries={summaries} allData={allData} plan="Tiered" />);
    await screen.findByTestId('money-stacked');

    const table = screen.getByTestId('money-table');
    const headers = [...within(table).getAllByRole('columnheader')].map((th) =>
      th.textContent!.trim(),
    );
    const rows = within(table).getAllByTestId('money-row');
    // billed, billed, open.
    expect(rows).toHaveLength(3);

    const open = cells(rows[2]);
    expect(open[headers.indexOf('Tier 1')]).toBe('—');
    expect(open[headers.indexOf('Tier 2')]).toBe('—');
    // …while its own estimate is still there, labelled as one.
    expect(rows[2]).toHaveTextContent(/Est\. commodity/);
    expect(rows[2]).toHaveTextContent(/Estimate/);
    // The tail's commodity is estimated as ONE blended figure (planCostFor),
    // so it must not have moved into a tier column: the commodity cell is
    // where the money is, and it is badged as an estimate everywhere else.
    expect(open[headers.indexOf('Commodity')]).toMatch(/^\$/);
    expect(rows[2]).toHaveTextContent(/~/);
  });
});

describe('the tier split in the PeriodDeltaTable', () => {
  it('gives Tier 1 and Tier 2 their own rows, with the figures that were billed', async () => {
    render(<MoneySection summaries={summaries} allData={allData} plan="Tiered" />);
    const table = await screen.findByTestId('money-deltas-table');

    const tier1 = within(table).getByTestId('money-delta-tier1');
    const tier2 = within(table).getByTestId('money-delta-tier2');
    expect(tier1).toHaveTextContent('Tier 1');
    expect(tier2).toHaveTextContent('Tier 2');

    const c1 = cells(tier1);
    const c2 = cells(tier2);
    // Columns: baseline (TOU), the Tiered period, the OPEN tail.
    expect(c1).toHaveLength(4);
    expect(c2).toHaveLength(4);

    // Baseline is the TOU period — no tier money, so a dash, not "$0.00".
    expect(c1[1]).toBe('—');
    expect(c2[1]).toBe('—');
    expect(within(tier1).getAllByTestId('money-delta-no-tier')).toHaveLength(2);

    // The Tiered column is the change against that TOU baseline, which for a
    // tier is the tier's own figure: 58.68 and 91.14.
    expect(c1[2]).toContain('$58.68');
    expect(c2[2]).toContain('$91.14');
  });

  it('never labels the unbilled tail with a tier', async () => {
    render(<MoneySection summaries={summaries} allData={allData} plan="Tiered" />);
    const table = await screen.findByTestId('money-deltas-table');

    // The OPEN column is badged an estimate …
    const flags = screen.getAllByTestId('money-column-flag');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toHaveTextContent('Estimate');

    // … and both tier rows print a dash under it: no "TIER 1 ~$41.00" over
    // days the utility has not billed.
    for (const key of ['tier1', 'tier2'] as const) {
      const row = within(table).getByTestId(`money-delta-${key}`);
      const c = cells(row);
      expect(c[3]).toBe('—');
      expect(c[3]).not.toContain('$');
      expect(c[3]).not.toContain('~');
    }

    // The estimate itself still exists — as the commodity line it is.
    const other = within(table).getByTestId('money-delta-commodityOther');
    expect(cells(other)[3]).toContain('~');
  });
});
