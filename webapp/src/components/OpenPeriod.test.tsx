/**
 * The billing axis as the MONEY section's timeline: the open (unbilled)
 * period, the badges that stop it reading like a bill, and the ledger that
 * later scores it.
 *
 * Numbers come off the committed synthetic fixture (three 29-day bills,
 * May 25 / Jun 23 / Jul 22 2026) with readings that deliberately run PAST the
 * last bill — the shape of Mark's real export, whose tail is the whole point
 * of this feature. Where an assertion quotes a figure it is derived from the
 * same rows the panel is given, so the test fails if the two ever disagree.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import MoneySection from './MoneySection';
import { buildAxisStacks, periodDeltaRows } from '@/lib/moneyViz';
import { buildBillingAxis } from '@/lib/billingAxis';
import {
  ESTIMATE_LEDGER_KEY,
  recordOpenEstimate,
  serializeLedger,
  type EstimateLedger,
  type OpenEstimateRecord,
} from '@/lib/estimateLedger';
import { billTotals, parseUsageSummaries, type ProcessedPoint, type RateSet } from '@/lib/energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const summaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

const DAY = 86400;
const ts = (iso: string) => Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000);

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** One off-peak kWh a day between two UTC dates (inclusive of the first). */
function dailyRows(fromIso: string, days: number, fromTs?: number): ProcessedPoint[] {
  const start = fromTs ?? ts(fromIso);
  const out: ProcessedPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const timestamp = start + i * DAY + 3 * 3600;
    const d = new Date(timestamp * 1000);
    out.push({
      timestamp,
      usage_kwh: 1,
      dateObj: d,
      dayStr: d.toISOString().slice(0, 10),
      hourStr: '03:00',
      touCategory: 'Off-Peak',
      uloCategory: 'Overnight',
      isWinter: false,
      costTOU: 9.8 / 100,
      costTiered: 12 / 100,
      costULO: 3.9 / 100,
      activeRateSet: rateSet,
    });
  }
  return out;
}

/** Every billed period, plus `tailDays` of readings past the last bill. */
function rowsWithTail(tailDays: number): ProcessedPoint[] {
  const out: ProcessedPoint[] = [];
  for (const s of summaries) {
    out.push(...dailyRows(s.startDate, Math.round(s.duration / DAY)));
  }
  if (tailDays > 0) {
    const last = summaries[summaries.length - 1];
    out.push(...dailyRows('', tailDays, last.start + last.duration));
  }
  return out;
}

const money = (n: number) => `$${n.toFixed(2)}`;

beforeEach(() => {
  localStorage.clear();
});

/* ------------------------------------------------------------- the panel -- */

describe('open period panel', () => {
  it('says what has been billed and what has not, with the estimate on its own', async () => {
    const rows = rowsWithTail(40);
    const axis = buildBillingAxis({ summaries, rows });
    render(<MoneySection summaries={summaries} allData={rows} plan="TOU" />);

    const panel = await screen.findByTestId('open-period');
    // Billed through the last bill's own end day, at the bill's own payable.
    expect(within(panel).getByTestId('billed-through-date')).toHaveTextContent('2026-08-20');
    const lastTotals = billTotals(summaries[summaries.length - 1]);
    expect(within(panel).getByTestId('billed-through-amount')).toHaveTextContent(
      money(lastTotals.payable),
    );

    // Unbilled since that day, commodity only.
    expect(within(panel).getByTestId('unbilled-since-date')).toHaveTextContent('2026-08-20');
    // The tail starts where the last bill was READ (Wave L's rule), so rows
    // before that instant are billed, not unbilled.
    const tailRows = rows.filter((r) => r.timestamp >= axis.open!.start);
    const expected = tailRows.reduce((n, r) => n + r.costTOU, 0);
    expect(within(panel).getByTestId('unbilled-since-amount').textContent).toContain(
      money(expected),
    );
    expect(within(panel).getByTestId('unbilled-since-amount').textContent).toContain(
      'estimated commodity',
    );
    expect(within(panel).getByTestId('unbilled-since-amount').textContent).not.toContain('actual');

    // The caveat must refuse to add up a bill that does not exist yet.
    expect(within(panel).getByTestId('open-period-caveat')).toHaveTextContent(
      /not billed yet/i,
    );
    expect(within(panel).getByTestId('open-period-caveat').textContent).not.toMatch(
      /delivery.*billed yet.*\$/i,
    );
    expect(within(panel).getByTestId('open-period-badge')).toHaveTextContent(/estimate/i);
  });

  it('draws no panel when every reading has been billed', async () => {
    const rows = rowsWithTail(0);
    render(<MoneySection summaries={summaries} allData={rows} plan="TOU" />);
    await screen.findByTestId('money-stacked');
    expect(screen.queryByTestId('open-period')).not.toBeInTheDocument();
    expect(localStorage.getItem(ESTIMATE_LEDGER_KEY)).toBeNull();
  });
});

/* --------------------------------------------------- the chart and table -- */

describe('the timeline the money views draw', () => {
  it('gives the open period its own flagged row', async () => {
    render(<MoneySection summaries={summaries} allData={rowsWithTail(40)} plan="TOU" />);
    await screen.findByTestId('money-stacked');

    const rows = screen.getAllByTestId('money-row');
    expect(rows).toHaveLength(4); // 3 bills + 1 open
    const badges = screen.getAllByTestId('money-row-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Estimate');

    // The open row's figure is an estimate of commodity only, marked as one.
    const openRow = rows[3];
    expect(openRow.textContent).toContain('Open · 2026-08-20');
    expect(openRow.textContent).toMatch(/~\$|\bEstimate\b/);
    expect(screen.getByTestId('money-chart-flagged')).toHaveTextContent(/not bills/i);

    // The billed rows are untouched: exactly what the bills say.
    const totals = summaries.map((s) => billTotals(s).payable);
    totals.forEach((t, i) => expect(rows[i]).toHaveTextContent(money(t)));
  });

  it('marks the open column in the delta table instead of inventing a change', async () => {
    render(<MoneySection summaries={summaries} allData={rowsWithTail(40)} plan="TOU" />);
    await screen.findByTestId('money-deltas');

    const flags = screen.getAllByTestId('money-column-flag');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toHaveTextContent('Estimate');
    // Every non-zero line of the open column is printed as an estimate
    // (the zero ones are dashes — no charge exists for them yet).
    const estimates = screen.getAllByTestId('money-delta-estimate');
    expect(estimates.length).toBeGreaterThanOrEqual(1);
    expect(estimates[0]).toHaveTextContent('~$');
    expect(screen.getByTestId('money-deltas-note')).toHaveTextContent(/real bill against real bill/i);
  });

  it('keeps a hole between bills visible as "no bill", never as $0', async () => {
    // Drop the middle bill: Jun 23 – Jul 22 has readings but no bill.
    const rows = rowsWithTail(10);
    render(<MoneySection summaries={[summaries[0], summaries[2]]} allData={rows} plan="TOU" />);
    await screen.findByTestId('money-stacked');

    const rowsDom = screen.getAllByTestId('money-row');
    expect(rowsDom).toHaveLength(4); // billed, gap, billed, open
    const badges = screen.getAllByTestId('money-row-badge').map((b) => b.textContent);
    expect(badges).toEqual(['No bill', 'Estimate']);
    // The gap row prints an em dash where money would be, not $0.00.
    expect(rowsDom[1].textContent).toContain('—');
    expect(rowsDom[1].textContent).not.toContain('$0.00');
    expect(screen.getAllByTestId('money-column-flag')[0]).toHaveTextContent('No bill');
  });
});

/* ------------------------------------------------ the ledger / the loop --- */

describe('the estimate ledger in the browser', () => {
  it('records today’s claim so a later export can score it', async () => {
    const rows = rowsWithTail(40);
    const axis = buildBillingAxis({ summaries, rows });
    render(<MoneySection summaries={summaries} allData={rows} plan="TOU" />);
    await screen.findByTestId('open-period');
    await waitFor(() => {
      expect(localStorage.getItem(ESTIMATE_LEDGER_KEY)).not.toBeNull();
    });

    const stored = JSON.parse(localStorage.getItem(ESTIMATE_LEDGER_KEY)!) as {
      open: OpenEstimateRecord[];
      closed: unknown[];
    };
    expect(stored.open).toHaveLength(1);
    const [record] = stored.open;
    expect(record.windowStart).toBe(axis.open!.start);
    expect(record.windowEnd).toBe(axis.open!.end);
    expect(record.estimated).toBeGreaterThan(0);
    expect(record.plan).toBe('TOU');
    expect(record.ratePerKwh).toBeGreaterThan(0);

    // Nothing has been billed for it yet, and the panel says exactly that.
    expect(stored.closed).toHaveLength(0);
    expect(screen.getByTestId('estimate-accuracy-empty')).toHaveTextContent(
      /moment an export bills this window/i,
    );
  });

  it('scores a claim the bills already cover, and shows the accuracy once', async () => {
    // Seed the claim this browser would have made when that window was open.
    const target = summaries[2];
    const actual = billTotals(target).commodity;
    const seeded: EstimateLedger = recordOpenEstimate(
      { open: [], closed: [] },
      {
        windowStart: target.start,
        windowEnd: target.start + target.duration,
        plan: 'TOU',
        estimated: actual * 1.05, // we would have been 5% high
        meteredKwh: 1000,
      },
    );
    localStorage.setItem(ESTIMATE_LEDGER_KEY, serializeLedger(seeded));

    render(<MoneySection summaries={summaries} allData={rowsWithTail(40)} plan="TOU" />);
    await screen.findByTestId('open-period');

    await waitFor(() => {
      expect(screen.getByTestId('estimate-accuracy')).toBeInTheDocument();
    });
    expect(screen.getByTestId('estimate-accuracy')).toHaveTextContent('95%');
    const check = screen.getByTestId('estimate-check');
    expect(check).toHaveTextContent(money(actual * 1.05));
    expect(check).toHaveTextContent(money(actual));
    expect(screen.getByTestId('estimate-check-accuracy')).toHaveTextContent('95.0% accurate');
    expect(screen.queryByTestId('estimate-accuracy-empty')).not.toBeInTheDocument();

    // The settled claim is out of the open list — one score, not two.
    const stored = JSON.parse(localStorage.getItem(ESTIMATE_LEDGER_KEY)!) as {
      open: unknown[];
      closed: unknown[];
    };
    expect(stored.open).toHaveLength(1); // only the live tail remains
    expect(stored.closed).toHaveLength(1);
  });
});

/* ------------------------------------------------------- pure-layer check  */

describe('buildAxisStacks / periodDeltaRows', () => {
  it('prices the open period with the plan on screen and nothing else', () => {
    const rows = rowsWithTail(40);
    const axis = buildBillingAxis({ summaries, rows });
    const stacks = buildAxisStacks(axis, rows, 'TOU');

    expect(stacks.map((s) => s.kind)).toEqual(['billed', 'billed', 'billed', 'open']);
    const open = stacks[3];
    expect(open.estimated).toBe(true);
    expect(open.summary).toBeNull();
    expect(open.days).toBe(40);

    const tailRows = rows.filter((r) => r.timestamp >= axis.open!.start);
    const expected = tailRows.reduce((n, r) => n + r.costTOU, 0);
    expect(open.cost.offPeak).toBeCloseTo(expected, 6);
    expect(open.totals.payable).toBeCloseTo(expected, 2);
    // Nothing but electricity: delivery / regulatory / HST are not real yet.
    expect(open.cost.delivery).toBe(0);
    expect(open.cost.regulatory).toBe(0);
    expect(open.cost.tax).toBe(0);
    expect(open.cost.credit).toBe(0);
    expect(open.usageTotal).toBeCloseTo(tailRows.length, 6);

    // The billed bars still sum to exactly what the bills say.
    const billed = stacks.filter((s) => s.kind === 'billed');
    expect(billed.reduce((n, s) => n + s.totals.payable, 0)).toBeCloseTo(
      summaries.reduce((n, s) => n + billTotals(s).payable, 0),
      2,
    );
  });

  it('does not let the estimate move the share percentages', () => {
    const rows = rowsWithTail(40);
    const axis = buildBillingAxis({ summaries, rows });
    const stacks = buildAxisStacks(axis, rows, 'TOU');
    const table = periodDeltaRows(stacks);

    expect(table.columns.at(-1)!.kind).toBe('open');
    expect(table.columns.at(-1)!.estimated).toBe(true);
    // The change INTO the open period is not a change: it is an estimate.
    for (const row of table.rows) {
      expect(row.deltas.at(-1)).toBeNull();
    }
    expect(table.hasComparison).toBe(true);
  });
});
