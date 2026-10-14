/**
 * Wave O — the MONEY section: what renders, what the toggles do, and what the
 * empty state says.
 *
 * Numbers come off the committed synthetic fixture (three 29-day periods,
 * audited sums) with readings built to cover every period, so the plan
 * overlay has something to model. Where an assertion quotes a figure it is
 * derived from `billTotals` rather than retyped, so the test fails if the
 * parser and the panel ever disagree instead of quietly agreeing on a stale
 * constant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import MoneySection from './MoneySection';
import Dashboard from './Dashboard';
import { billedKwh, billTotals, billWindow, parseUsageSummaries, type ProcessedPoint, type RateSet } from '@/lib/energy';
import { fmtMoney } from '@/i18n';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const summaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

// The same formatter the components print with — grouping included, so the
// expectation tracks whatever the UI actually renders.
const money = (n: number) => fmtMoney(n);

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** Hourly readings across every period, so coverage is 100% everywhere. */
function rowsForAll(): ProcessedPoint[] {
  const out: ProcessedPoint[] = [];
  for (const s of summaries) {
    const { start, end } = billWindow(s);
    const days = Math.max(1, Math.round((end - start) / 86400));
    const usage = (billedKwh(s) ?? 0) / (days * 24);
    for (let day = 0; day < days; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const timestamp = start + day * 86400 + hour * 3600;
        const d = new Date(timestamp * 1000);
        const tou = hour < 7 ? 'Off-Peak' : hour < 16 ? 'Mid-Peak' : 'On-Peak';
        const rate = tou === 'Off-Peak' ? 9.8 : tou === 'Mid-Peak' ? 15.7 : 20.3;
        out.push({
          timestamp,
          usage_kwh: usage,
          dateObj: d,
          dayStr: d.toISOString().slice(0, 10),
          hourStr: `${String(hour).padStart(2, '0')}:00`,
          touCategory: tou,
          uloCategory: tou === 'On-Peak' ? 'On-Peak' : 'Overnight',
          isWinter: false,
          costTOU: (usage * rate) / 100,
          costTiered: (usage * 13) / 100,
          costULO: (usage * (tou === 'On-Peak' ? 39.1 : 3.9)) / 100,
          activeRateSet: rateSet,
        });
      }
    }
  }
  return out;
}

const allRows = rowsForAll();

const totals = summaries.map((s) => billTotals(s));

beforeEach(() => {
  localStorage.clear();
});

describe('empty state', () => {
  it('asks for an export with billing periods instead of drawing zeros', () => {
    render(<MoneySection summaries={[]} allData={allRows} plan="TOU" />);
    const empty = screen.getByTestId('money-empty');
    expect(empty).toHaveTextContent(
      /Upload a Green Button export with billing periods to unlock the money views/i,
    );
    expect(screen.queryByTestId('money-stacked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('money-deltas')).not.toBeInTheDocument();
  });
});

describe('stacked composition', () => {
  it('shows one row per billing period, paid exactly as the bill says', async () => {
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    await waitFor(() => expect(screen.getByTestId('money-stacked')).toBeInTheDocument());
    const rows = screen.getAllByTestId('money-row');
    expect(rows).toHaveLength(3);
    totals.forEach((t, i) => {
      expect(rows[i]).toHaveTextContent(money(t.payable));
    });
    // The legend only names the slices this file has.
    const legend = within(screen.getByTestId('money-legend'));
    expect(legend.getByText('Commodity · off-peak')).toBeInTheDocument();
    expect(legend.getByText('Delivery')).toBeInTheDocument();
    expect(legend.getByText('Ontario Electricity Rebate — below the line')).toBeInTheDocument();
  });

  it('answers the delivery question with this household’s own bill', async () => {
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const stat = await screen.findByTestId('non-commodity-pct');
    // 311.61 delivery + 45.15 regulatory over 1542.49 charged.
    expect(stat).toHaveTextContent('23.1%');
    expect(screen.getByTestId('rebate-pct')).toHaveTextContent('20.8%');
  });

  it('switches to the 100% share view and back', async () => {
    const user = userEvent.setup();
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const shareToggle = await screen.findByTestId('money-mode-share');
    expect(shareToggle.tagName.toLowerCase()).toBe('button');
    expect(shareToggle.className).toContain('seg');
    expect(shareToggle.className).toContain('min-h-[44px]');
    await user.click(shareToggle);
    expect(screen.getByTestId('money-mode-share')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('money-stacked')).toHaveTextContent(
      /before the rebate/i,
    );
    // Shares are printed in the table, and they are not dollars.
    const row = screen.getAllByTestId('money-row')[0];
    expect(row.textContent).toMatch(/\d+\.\d%/);
    // A credit has no share of a bill: the rebate column and its legend chip
    // must be gone here, not sitting at a meaningless 0.0%.
    const headers = [...screen.getAllByRole('columnheader')].map((th) => th.textContent);
    expect(headers.some((h) => /OEB rebate/i.test(h ?? ''))).toBe(false);
    expect(screen.queryByText(/Ontario Electricity Rebate — below the line/i)).not.toBeInTheDocument();
    await user.click(screen.getByTestId('money-mode-dollars'));
    expect(screen.getByTestId('money-mode-dollars')).toHaveAttribute('aria-pressed', 'true');
    // Back in dollars the credit is visible again.
    expect(
      screen.getByText('Ontario Electricity Rebate — below the line'),
    ).toBeInTheDocument();
  });

  it('stacks the bill’s own kWh in usage mode', async () => {
    const user = userEvent.setup();
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    await user.click(await screen.findByTestId('money-mode-usage'));
    expect(screen.getByTestId('money-stacked')).toHaveTextContent(/What you used, per period/i);
    expect(screen.queryByTestId('money-usage-empty')).not.toBeInTheDocument();
    const row = screen.getAllByTestId('money-row')[0];
    // Billed kWh for period 1, formatted with thousands separators as needed.
    expect(row.textContent).toContain(
      (billedKwh(summaries[0]) ?? 0).toLocaleString('en-CA', { maximumFractionDigits: 1 }),
    );
  });
});

describe('plan overlay', () => {
  it('draws the three alternatives against what was actually paid', async () => {
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const lines = await screen.findByTestId('money-overlay-lines');
    const payable = totals.reduce((n, t) => n + t.payable, 0);
    expect(lines).toHaveTextContent(/Time-of-Use/);
    expect(lines).toHaveTextContent(/Tiered/);
    expect(lines).toHaveTextContent(/Ultra-Low Overnight/);
    expect(lines).toHaveTextContent(`you paid ${money(payable)}`);
    // Money goes through the locale formatter, which groups thousands —
    // the app-wide convention (I18N.md, `fmtMoney(1365.03)` → `$1,365.03`).
    expect(lines.textContent).toMatch(/\$1,\d{3}\.\d{2}/);
  });

  it('states its assumptions rather than implying a tariff quote', async () => {
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const chart = await screen.findByTestId('money-stacked');
    expect(chart).toHaveTextContent(/modelled with your bill's own delivery/i);
    expect(chart).toHaveTextContent(/modelling assumption/i);
  });

  it('can be switched off', async () => {
    const user = userEvent.setup();
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const toggle = await screen.findByTestId('money-overlay-toggle');
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.queryByTestId('money-overlay-lines')).not.toBeInTheDocument();
  });

  it('says why it cannot model when the readings do not reach the bill', async () => {
    render(<MoneySection summaries={summaries} allData={[]} plan="TOU" />);
    const reason = await screen.findByTestId('money-overlay-off');
    expect(reason).toHaveTextContent(/would be a guess/i);
    expect(screen.queryByTestId('money-overlay-lines')).not.toBeInTheDocument();
  });
});

describe('period deltas', () => {
  it('prints a baseline first and signed changes after it', async () => {
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const table = await screen.findByTestId('money-deltas-table');
    expect(within(table).getByText(/Baseline · May 25, 2026/)).toBeInTheDocument();
    // Every later column is the change from the period in the column to its
    // left, so the header only needs the destination: "Δ → Jun 23, 2026".
    expect(within(table).getByText(/Δ → Jun 23, 2026/)).toBeInTheDocument();
    // Three periods fit one screen; the sideways-scroll note only appears
    // once the table is genuinely wider than a page (>6 columns).
    expect(screen.queryByTestId('money-deltas-scroll-hint')).not.toBeInTheDocument();
    const payableRow = within(table).getByTestId('money-delta-payable');
    const cells = payableRow.querySelectorAll('td');
    // Baseline column = period 1's own figure …
    expect(cells[1].textContent).toBe(money(totals[0].payable));
    // … then two signed deltas that sum to the whole change.
    const deltaText = (i: number) => cells[i].textContent!.replace('−', '-');
    const d1 = Number(deltaText(2).replace(/[$+]/g, ''));
    const d2 = Number(deltaText(3).replace(/[$+]/g, ''));
    expect(d1 + d2).toBeCloseTo(totals[2].payable - totals[0].payable, 1);
  });

  it('is honest with a single period', async () => {
    render(<MoneySection summaries={summaries.slice(0, 1)} allData={allRows} plan="TOU" />);
    const note = await screen.findByTestId('money-deltas-note');
    expect(note).toHaveTextContent(/Only one billing period/i);
    expect(screen.getByTestId('money-deltas-baseline')).toBeInTheDocument();
  });
});

describe('hour-of-day price histogram', () => {
  it('prices every hour and names the window average', async () => {
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const avg = await screen.findByTestId('money-hour-average');
    expect(avg.textContent).toMatch(/^\d+\.\d¢$/);
    expect(screen.getByTestId('money-hour-histogram')).toHaveTextContent(/commodity only/i);
  });

  it('says why there is nothing to draw', async () => {
    render(<MoneySection summaries={summaries} allData={[]} plan="TOU" />);
    const empty = await screen.findByTestId('money-hour-empty');
    expect(empty).toHaveTextContent(/No readings in the current window/i);
  });
});

describe('attribution waterfall', () => {
  it('ends on the bill’s own amount due', async () => {
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    const total = await screen.findByTestId('money-waterfall-total');
    // Newest period by default — same figure the actual-bill panel prints.
    expect(total).toHaveTextContent(money(totals[totals.length - 1].payable));
    const steps = within(screen.getByTestId('money-waterfall-steps'));
    expect(steps.getByText('Commodity')).toBeInTheDocument();
    expect(steps.getByText('Delivery')).toBeInTheDocument();
    expect(steps.getByText('HST')).toBeInTheDocument();
    expect(steps.getByText('OEB rebate')).toBeInTheDocument();
    expect(steps.getByText('Amount due')).toBeInTheDocument();
  });

  it('switches between periods', async () => {
    const user = userEvent.setup();
    render(<MoneySection summaries={summaries} allData={allRows} plan="TOU" />);
    await screen.findByTestId('money-waterfall-picker');
    await user.click(screen.getByTestId(`money-waterfall-pick-${summaries[0].startDate}`));
    expect(screen.getByTestId('money-waterfall-total')).toHaveTextContent(
      money(totals[0].payable),
    );
  });
});

describe('wiring into the Money & What-If tab', () => {
  it('renders the honest empty state when no bill is loaded', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('tab', { name: 'Money' }));
    const panel = await screen.findByTestId('tab-panel-money');
    const moneySection = await within(panel).findByTestId('money-section');
    expect(moneySection).toHaveTextContent(/Upload a Green Button export with billing periods/i);
    // Nothing is drawn before a bill exists.
    expect(within(panel).queryByTestId('money-stacked')).not.toBeInTheDocument();
  });
});
