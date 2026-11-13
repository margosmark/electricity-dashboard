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
import { cleanup, render, screen } from '@testing-library/react';

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
