/**
 * The Money tab's commodity-7 branch (t_6c2606d1; epic DoD 4/6/7):
 * GasMoneyTable replaces the electric money stack — feed-stated amounts and
 * their difference only, with no plan column, no derived payable (the
 * stacked chart's "Amount paid (incl. HST, less rebate)" would print
 * $180.52 against a stated $175.76), no kWh usage mode and no ¢/kWh
 * histogram anywhere on a gas dataset.
 *
 * FIXTURE POLICY: SYNTHETIC only (tests/fixtures/enbridge-gas-synthetic.xml).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import MoneySection from './MoneySection';
import { enrichGasSummaries } from '@/lib/gasBillUi';
import { parseGreenButtonFeed } from '@/lib/energy';
import { setLocale } from '@/i18n';

const USAGE_XML = readFileSync(
  join(__dirname, '../../tests/fixtures/enbridge-gas-synthetic.xml'),
  'utf8',
);
const summaries = enrichGasSummaries(parseGreenButtonFeed(USAGE_XML));

const renderMoney = () =>
  render(<MoneySection summaries={summaries} allData={[]} plan="TOU" />);

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('Money tab on gas — feed-only table, no electric machinery', () => {
  it('renders the gas table with ten rows and the spec captions', () => {
    renderMoney();
    expect(screen.getByTestId('gas-money-table')).toBeTruthy();
    expect(screen.getAllByTestId('gas-money-row')).toHaveLength(10);
    expect(screen.getByTestId('gas-money-not-summed').textContent).toContain(
      'does not add these lines up to a total',
    );
  });

  it('labels the three Δ periods unexplained-in-feed and the rest equal', () => {
    renderMoney();
    const rows = screen.getAllByTestId('gas-money-row');
    const deltas = rows
      .map((r) => ({
        start: r.getAttribute('data-period-start'),
        delta: r.getAttribute('data-delta'),
        rec: r.getAttribute('data-reconciliation'),
      }))
      .filter((r) => r.rec === 'unexplained-in-feed');
    expect(deltas.map((d) => `${d.start}:${d.delta}:${d.rec}`)).toEqual([
      '2025-12-25:13.87:unexplained-in-feed',
      '2026-06-24:5.30:unexplained-in-feed',
      '2026-09-25:6.18:unexplained-in-feed',
    ]);
    // The seven equal periods carry no delta row value.
    expect(rows.filter((r) => r.getAttribute('data-reconciliation') === 'equal')).toHaveLength(7);
  });

  it('never renders the electric stack: no chart, no plan cells, no kWh', () => {
    renderMoney();
    expect(screen.queryByTestId('money-overlay')).toBeNull();
    expect(screen.queryByTestId('plan-cell')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Total Electricity Charges/);
    expect(document.body.textContent).not.toMatch(/kWh/);
    expect(document.body.textContent).not.toMatch(/¢\/kWh/);
    expect(document.body.textContent).not.toMatch(/HST less rebate/);
  });

  it('FR: the table and captions are localized with fr-CA money', () => {
    setLocale('fr');
    renderMoney();
    expect(screen.getAllByTestId('gas-money-row')).toHaveLength(10);
    expect(screen.getByTestId('gas-money-not-summed').textContent).toContain(
      "cette application n'additionne pas",
    );
    // P1 delta: fmtMoney in fr-CA = "13,87 $" (comma, NBSP, trailing $).
    expect(document.body.textContent).toContain('13,87');
    expect(document.body.textContent).not.toMatch(/\$13\.87/);
  });
});

/* ================================================================== *
 * Per-period line disclosure (t_a2343a2f) — what you actually paid,
 * itemised: the bill's own lines behind each row, feed-stated only.
 * ================================================================== */

describe('per-period line disclosure', () => {
  it('opens the bill’s own lines with aria wiring and keeps the row count', () => {
    renderMoney();
    const rows = screen.getAllByTestId('gas-money-row');
    expect(rows).toHaveLength(10);
    const toggles = screen.getAllByTestId('gas-money-lines-toggle');
    expect(toggles).toHaveLength(10);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('gas-money-lines')).toBeNull();
    // Closed, nothing renders the target, so nothing may point at it: an
    // aria-controls naming an id that is not in the document is the dangling
    // reference axe dings as `aria-valid-attr-value` (t_d5cc9a2d; the rule
    // TabNav.tsx documents, and GasBillPeriodCard follows by carrying no
    // aria-controls at all).
    toggles.forEach((t) => expect(t).not.toHaveAttribute('aria-controls'));

    fireEvent.click(toggles[0]);

    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByTestId('gas-money-lines');
    expect(region).toHaveAttribute('data-period-start', '2025-12-25');
    // Open, the reference resolves: aria-controls names an id that IS in the
    // document, and it is the region this row just painted. Only the open
    // row carries one — the other nine still render no region at all.
    const controls = toggles[0].getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const target = controls ? document.getElementById(controls) : null;
    expect(target).not.toBeNull();
    expect(target?.getAttribute('role')).toBe('region');
    expect(region.contains(target)).toBe(true);
    toggles.slice(1).forEach((t) => expect(t).not.toHaveAttribute('aria-controls'));
    // The bill's own line items, greppable by the utility's wording.
    expect(region.textContent).toContain('Charges, as the file reports them');
    expect(region.querySelectorAll('[data-bill-note]').length).toBeGreaterThan(0);
    // The detail row is NOT a money row — the ten-row contract is intact
    // (the journey e2e counts these rows and parses cells 1 and 2).
    expect(screen.getAllByTestId('gas-money-row')).toHaveLength(10);
    // The toggle flips its label so the reader knows what a second click does.
    expect(toggles[0].textContent).toContain('Hide bill lines');

    // Closing restores the rest state.
    fireEvent.click(toggles[0]);
    expect(screen.queryByTestId('gas-money-lines')).toBeNull();
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');
    // …and takes the reference back out of the DOM with the region.
    expect(toggles[0]).not.toHaveAttribute('aria-controls');
  });

  it('the all-zero lines stay reachable behind their own toggle, never dropped', () => {
    renderMoney();
    fireEvent.click(screen.getAllByTestId('gas-money-lines-toggle')[0]);
    const zero = screen.getByTestId('gas-money-zero-lines');
    const count = Number(zero.getAttribute('data-count'));
    expect(count).toBeGreaterThan(0);
    const notesAtRest = screen
      .getByTestId('gas-money-lines')
      .querySelectorAll('[data-bill-note]').length;
    fireEvent.click(zero.querySelector('button')!);
    const notesOpen = screen
      .getByTestId('gas-money-lines')
      .querySelectorAll('[data-bill-note]').length;
    expect(notesOpen).toBeGreaterThan(notesAtRest);
    expect(notesOpen - notesAtRest).toBe(count);
  });

  it('a period with no stated Amount Due says "not in this import"', () => {
    const stripped = summaries.map((s, i) =>
      i === 0 ? { ...s, items: s.items.filter((it) => !/amount due/i.test(it.note)) } : s,
    );
    render(<MoneySection summaries={stripped} allData={[]} plan="TOU" />);
    const first = screen.getAllByTestId('gas-money-row')[0];
    expect(first.textContent).toContain('not in this import');
    // The total the file DOES state is still printed beside it.
    expect(first.textContent).toContain('$161.89');
    // Later periods are untouched.
    expect(screen.getAllByTestId('gas-money-row')).toHaveLength(10);
  });
});
