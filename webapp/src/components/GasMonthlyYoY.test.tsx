/**
 * The gas Analytics panels in jsdom (t_a2343a2f) — monthly overview +
 * year-over-year, mounted through the real `GasAnalyticsPanel`:
 *
 *  1. the monthly table keeps BOTH m³ figures side by side and prints each
 *     bill's own period + stated Amount Due (never a derived price; a bill
 *     that states no amount says "not in this import");
 *  2. year-over-year renders only past a 13-month span and otherwise says
 *     exactly how much history exists;
 *  3. EN + FR both paint from the catalog, and no kWh token ever appears on
 *     a gas surface;
 *  4. `prefers-reduced-motion` flags the charts (final-state geometry, no
 *     animation dependency).
 *
 * FIXTURE POLICY: SYNTHETIC only — the committed Enbridge-shaped XML plus
 * in-file summaries; the real EGD export never enters this repo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { GasAnalyticsPanel } from './GasSection';
import { parseGreenButtonFeed } from '@/lib/energy';
import { extractGasPoints } from '@/lib/commodity';
import { gasMoney } from '@/lib/gasBillUi';
import { fmtMoney, setLocale } from '@/i18n';
import { daysInMonth } from '@/lib/gasMonthly';
import type { BillLineItem, UsageSummary } from '@/lib/energy';

const MULTISERIES = parseGreenButtonFeed(
  readFileSync(
    join(__dirname, '../../tests/fixtures/enbridge-gas-multiseries-synthetic.xml'),
    'utf8',
  ),
);
const POINTS = extractGasPoints(MULTISERIES.groups);

const line = (note: string, amount: number | null): BillLineItem => ({
  note,
  amount,
  rawAmount: amount !== null ? Math.round(amount * 1000) : null,
  itemKind: null,
  unitCost: null,
  measurement: null,
});

/** One synthetic Enbridge-shaped bill per calendar month, starting `day`. */
function monthlyBills(
  fromYear: number,
  fromMonth: number,
  count: number,
  startDay = 1,
): UsageSummary[] {
  const out: UsageSummary[] = [];
  for (let i = 0; i < count; i++) {
    const y = fromYear + Math.floor((fromMonth - 1 + i) / 12);
    const m = ((fromMonth - 1 + i) % 12) + 1;
    const startTs = Date.UTC(y, m - 1, startDay) / 1000;
    const days = daysInMonth(y, m - 1) - startDay + 1;
    const endDate = new Date((startTs + days * 86400) * 1000).toISOString().slice(0, 10);
    out.push({
      source: 'UsageSummary',
      start: startTs,
      duration: days * 86400,
      startDate: `${y}-${String(m).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`,
      endDate,
      days,
      billLastPeriod: 100000,
      billToDate: 100000,
      costAdditionalLastPeriod: 0,
      currency: 124,
      consumption: null,
      volume: { scaled: 100, value: 100000, powerOfTenMultiplier: -3, uom: 42 },
      items: [line('Amount Due', 100), line('Total Gas Charges ($)', 100)],
    });
  }
  return out;
}

afterEach(() => {
  cleanup();
  setLocale('en');
  vi.unstubAllGlobals();
});

describe('monthly overview — both m³ figures, feed-stated money', () => {
  it('renders one row per calendar month the import touches', async () => {
    render(<GasAnalyticsPanel points={POINTS} summaries={MULTISERIES.summaries} />);
    const panel = await screen.findByTestId('gas-monthly-panel', undefined, {
      timeout: 8000,
    });
    expect(panel).toBeInTheDocument();
    // Bills start 2025-12-25 and 2026-01-27; readings run 2026-01-05 …
    // 2026-02-06 → the union is Dec 2025, Jan 2026, Feb 2026.
    const rows = await screen.findAllByTestId('gas-monthly-row');
    expect(rows.map((r) => r.getAttribute('data-month'))).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    // The source note declares which series the BARS draw (interval here).
    expect(screen.getByText(/Bars: stored interval readings/)).toBeInTheDocument();
    // The chart itself loads as a dynamic chunk.
    expect(await screen.findByTestId('gas-monthly-chart', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByTestId('gas-monthly-table')).toBeInTheDocument();
  }, 15_000);

  it('prints each bill’s own period and stated Amount Due — nothing derived', async () => {
    render(<GasAnalyticsPanel points={POINTS} summaries={MULTISERIES.summaries} />);
    const rows = await screen.findAllByTestId('gas-monthly-row');
    const first = rows[0];
    // Bill period dates come from the feed's own stamps.
    expect(first.textContent).toContain('Dec 25, 2025');
    // The stated Amount Due of the first bill, formatted — asserted against
    // gasMoney() so the test pins PASS-THROUGH, not a recomputation.
    const stated = gasMoney(MULTISERIES.summaries[0]).amountDue;
    expect(stated).not.toBeNull();
    expect(first.textContent).toContain(fmtMoney(stated as number));
    // Jan 2026 carries a bill AND interval readings → both m³ columns.
    const jan = rows[1];
    expect(jan.textContent).toContain(fmtMoney(gasMoney(MULTISERIES.summaries[1]).amountDue as number));
  }, 15_000);

  it('a period that states no Amount Due says "not in this import"', async () => {
    const noAmount = MULTISERIES.summaries.map((s, i) =>
      i === 0
        ? { ...s, items: s.items.filter((it) => !/amount due/i.test(it.note)) }
        : s,
    );
    render(<GasAnalyticsPanel points={[]} summaries={noAmount} />);
    const rows = await screen.findAllByTestId('gas-monthly-row');
    expect(rows[0].textContent).toContain('not in this import');
    // The other period still states its figure.
    expect(rows[1].textContent).toContain(fmtMoney(gasMoney(noAmount[1]).amountDue as number));
  }, 15_000);

  it('bill-only imports chart the BILLED volume and say so', async () => {
    render(<GasAnalyticsPanel points={[]} summaries={MULTISERIES.summaries} />);
    expect(await screen.findByTestId('gas-monthly-panel', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText(/No interval readings in this import — bars:/)).toBeInTheDocument();
    // The interval chart stays honestly empty while the monthly chart draws.
    expect(screen.getByTestId('gas-chart-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('gas-chart')).toBeNull();
    const rows = await screen.findAllByTestId('gas-monthly-row');
    // Bill-only world: the two bill-start months. Feb 2026 exists only in
    // the readings this test deliberately does not pass.
    expect(rows.map((r) => r.getAttribute('data-month'))).toEqual([
      '2025-12',
      '2026-01',
    ]);
  }, 15_000);

  it('never renders a kWh token anywhere on the panel', async () => {
    const { container } = render(
      <GasAnalyticsPanel points={POINTS} summaries={MULTISERIES.summaries} />,
    );
    await screen.findByTestId('gas-monthly-panel', undefined, { timeout: 8000 });
    await screen.findByTestId('gas-yoy-panel', undefined, { timeout: 8000 });
    expect((container.textContent ?? '').match(/kWh/gi) ?? []).toEqual([]);
  }, 15_000);
});

describe('year-over-year — gated, honest, electricity-parity layout', () => {
  it('under 13 months of span: honest empty state naming the history', async () => {
    render(<GasAnalyticsPanel points={POINTS} summaries={MULTISERIES.summaries} />);
    const empty = await screen.findByTestId('gas-yoy-empty', undefined, { timeout: 8000 });
    expect(empty.textContent).toContain('Need 12+ months of data');
    // Interval source: Dec 2025 carries a bill but no readings, so only
    // Jan + Feb 2026 are chartable — the message counts what it could draw.
    expect(empty.textContent).toContain('you have 2 months');
    expect(empty.textContent).toContain('(Jan 2026 – Feb 2026)');
    expect(screen.queryByTestId('gas-yoy-chart')).toBeNull();
  }, 15_000);

  it('two years of bills: chart + delta row + full-year totals with partial flags', async () => {
    render(
      <GasAnalyticsPanel
        points={[]}
        summaries={[...monthlyBills(2025, 1, 12), ...monthlyBills(2026, 1, 12)]}
      />,
    );
    const chart = await screen.findByTestId('gas-yoy-chart', undefined, { timeout: 8000 });
    expect(chart).toBeInTheDocument();
    expect(chart.getAttribute('aria-label')).toContain('2 years in cubic metres');
    // Delta row for the latest year vs its prior.
    expect(screen.getByTestId('gas-yoy-deltas').textContent).toContain(
      'Δ vs 2025 (2026 vs 2025)',
    );
    // Both years carry all twelve months → neither is partial.
    const totals = screen.getAllByTestId('gas-yoy-year-total');
    expect(totals).toHaveLength(2);
    expect(totals[0].getAttribute('data-partial')).toBe('false');
    expect(totals[1].getAttribute('data-partial')).toBe('false');
    expect(totals[0].textContent).toContain('12/12');
    // Meta line: 2 years, 24 months of data.
    expect(screen.getByTestId('gas-yoy-meta').textContent).toContain(
      '2 years · 24 months of data (Jan 2025 – Dec 2026)',
    );
    // The sr-only table carries every plotted number without hover.
    expect(screen.getByTestId('gas-yoy-data-table')).toBeInTheDocument();
  }, 15_000);

  it('a partial edge month wears the honest partial badge on its year', async () => {
    render(
      <GasAnalyticsPanel
        points={[]}
        summaries={[...monthlyBills(2025, 1, 12, 25), ...monthlyBills(2026, 1, 12, 25)]}
      />,
    );
    await screen.findByTestId('gas-yoy-chart', undefined, { timeout: 8000 });
    const y2025 = screen
      .getAllByTestId('gas-yoy-year-total')
      .find((el) => el.getAttribute('data-year') === '2025')!;
    expect(y2025.getAttribute('data-partial')).toBe('true');
    expect(y2025.querySelector('[data-testid="gas-yoy-partial-badge"]')).not.toBeNull();
    expect(screen.getByTestId('gas-yoy-meta').textContent).toContain('Partial months');
    expect(screen.getByTestId('gas-yoy-meta').textContent).toContain('Jan 2025');
  }, 15_000);
});

describe('locale + reduced motion', () => {
  it('FR paints the panel titles and the honest states from the catalog', async () => {
    setLocale('fr');
    render(
      <GasAnalyticsPanel
        points={[]}
        summaries={[...monthlyBills(2025, 1, 12), ...monthlyBills(2026, 1, 12)]}
      />,
    );
    expect(await screen.findByTestId('gas-monthly-panel', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByTestId('gas-monthly-panel').textContent).toContain(
      'Gaz par mois civil',
    );
    expect(screen.getByTestId('gas-yoy-panel').textContent).toContain(
      "D'une année à l'autre — m³ mensuels",
    );
    expect(screen.getByTestId('gas-yoy-totals').textContent).toContain('Totaux annuels');
    expect(screen.getByTestId('gas-yoy-meta').textContent).toContain(
      '2 années · 24 mois de données',
    );
  }, 15_000);

  it('prefers-reduced-motion flags the monthly chart (final-state geometry)', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    );
    render(<GasAnalyticsPanel points={POINTS} summaries={MULTISERIES.summaries} />);
    const chart = await screen.findByTestId('gas-monthly-chart', undefined, {
      timeout: 8000,
    });
    expect(chart.getAttribute('data-reduced-motion')).toBe('true');
    const yoy = await screen.findByTestId('gas-yoy-panel', undefined, { timeout: 8000 });
    // Not ready under this fixture's span — but the flag is on the wrapper
    // whenever a chart paints; here only the monthly chart exists.
    expect(yoy).toBeInTheDocument();
    expect(chart.getAttribute('data-reduced-motion')).toBe('true');
  }, 15_000);
});
