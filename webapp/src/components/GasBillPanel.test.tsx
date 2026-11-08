/**
 * The Enbridge gas surfaces as a user meets them (t_6c2606d1): the
 * commodity-7 branch inside "Your actual bill", EN and FR, with the spec's
 * DOM hooks (t_860756c3 §5) and its money/volume/granularity contracts
 * asserted on the RENDERED DOM — not on the model.
 *
 * FIXTURE POLICY: SYNTHETIC only (tests/fixtures/enbridge-gas-synthetic.xml).
 * The real EGD export (Mark's name, address, account number, meter serial,
 * agreement id) never enters the repo or a fixture.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { ActualBillPanel } from './ActualBillPanel';
import { enrichGasSummaries } from '@/lib/gasBillUi';
import { parseGreenButtonFeed } from '@/lib/energy';
import { setLocale } from '@/i18n';

const USAGE_XML = readFileSync(
  join(__dirname, '../../tests/fixtures/enbridge-gas-synthetic.xml'),
  'utf8',
);
const summaries = enrichGasSummaries(parseGreenButtonFeed(USAGE_XML));

const renderPanel = () =>
  render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('gas surfaces — EN (spec §5 hooks + DoD contracts)', () => {
  it('renders ten gas period cards and none of the electric bill machinery', () => {
    renderPanel();
    expect(screen.getAllByTestId('gas-period')).toHaveLength(10);
    // No electricity-only claims: payable headline, kWh crosscheck, bucket
    // grid, OEB rate banner, ¢/kWh decomposition.
    expect(screen.queryByTestId('actual-payable')).toBeNull();
    expect(screen.queryByTestId('kwh-crosscheck')).toBeNull();
    expect(screen.queryByTestId('rate-assumptions-banner')).toBeNull();
    expect(screen.queryByTestId('charge-decompositions')).toBeNull();
    expect(screen.queryByTestId('commodity-check')).toBeNull();
    expect(screen.queryByTestId('commodity-mismatch')).toBeNull();
    expect(document.body.textContent).not.toMatch(/kWh/);
    expect(document.body.textContent).not.toMatch(/¢\/kWh/);
  });

  it('header: Amount Due $175.76 and 429.0 m³ billed for period 1', () => {
    renderPanel();
    const first = screen.getAllByTestId('gas-period')[0];
    expect(within(first).getByTestId('gas-amount-due').textContent).toContain('$175.76');
    expect(within(first).getByTestId('gas-header-volume').textContent).toContain('429');
    expect(within(first).getByTestId('gas-amount-due').textContent).not.toContain('176.21');
  });

  it('the money group: Total Gas Charges $161.89 and the unexplained Δ $13.87', () => {
    renderPanel();
    const first = screen.getAllByTestId('gas-period')[0];
    expect(within(first).getByTestId('gas-total-charges').textContent).toContain('$161.89');
    const diff = within(first).getByTestId('gas-difference');
    expect(diff.getAttribute('data-delta')).toBe('13.87');
    expect(diff.getAttribute('data-reconciliation')).toBe('unexplained-in-feed');
    expect(diff.textContent).toContain('$13.87');
    // Equal periods render the quiet row, no banner.
    const second = screen.getAllByTestId('gas-period')[1];
    expect(within(second).getByTestId('gas-difference').getAttribute('data-delta')).toBe('0.00');
    expect(within(second).queryByTestId('gas-unexplained-banner')).toBeNull();
  });

  it('the banner is a status region with the spec\'s exact copy', () => {
    renderPanel();
    const banner = screen.getAllByTestId('gas-unexplained-banner')[0];
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('data-reconciliation')).toBe('unexplained-in-feed');
    expect(banner.textContent).toContain('Unexplained in the feed');
    expect(banner.textContent).toContain('$13.87');
    // Money-honesty: the banner never claims the lines add up.
    expect(banner.textContent).not.toMatch(/sum|adds? up/i);
  });

  it('granularity is stated on the surface: monthly, never hourly', () => {
    renderPanel();
    expect(document.body.textContent).toContain(
      'monthly billing periods — gas is billed monthly, not hourly',
    );
    expect(document.body.textContent).not.toMatch(/hourly data|per hour/i);
  });

  it('commodity badge: natural gas, and an explicit electricity skip line', () => {
    renderPanel();
    const badges = screen.getAllByTestId('gas-badge');
    expect(badges).toHaveLength(10);
    for (const b of badges) expect(b.textContent).toContain('Natural gas');
    const skips = screen.getAllByTestId('gas-skip-electricity');
    expect(skips).toHaveLength(10);
    expect(skips[0].textContent).toContain('OEB electricity rates do not price gas');
  });

  it('volume group: billed, unadjusted, meter reads — three labeled numbers', () => {
    renderPanel();
    const first = screen.getAllByTestId('gas-period')[0];
    expect(within(first).getByTestId('gas-volume-billed').getAttribute('data-m3')).toBe('429.0');
    expect(within(first).getByTestId('gas-volume-reads').textContent).toContain('1,175.000');
    expect(within(first).getByTestId('gas-volume-reads').textContent).toContain('427');
    expect(within(first).getByTestId('gas-volume-unadjusted').textContent).toContain('426.569');
  });

  it('interval states: 4 present, 1 stub, 5 absent — absence says so, never 0', () => {
    renderPanel();
    const states = screen.getAllByTestId('gas-interval-state').map((n) =>
      n.getAttribute('data-state'),
    );
    expect(states).toEqual([
      'present', 'present', 'present', 'present', 'stub',
      'absent', 'absent', 'absent', 'absent', 'absent',
    ]);
    const absent = screen
      .getAllByTestId('gas-interval-state')
      .filter((n) => n.getAttribute('data-state') === 'absent');
    for (const node of absent) {
      expect(node.textContent).toContain('No interval data in the feed');
      expect(node.textContent).toContain('not zero usage');
      expect(node.textContent).not.toMatch(/\b0(\.0)?\s*m³/);
    }
    // The stub labels itself a 1-day window and says what it is NOT.
    const stub = screen
      .getAllByTestId('gas-interval-state')
      .find((n) => n.getAttribute('data-state') === 'stub');
    expect(stub?.textContent).toContain('1-day read window');
    expect(stub?.textContent).toContain('— not a monthly reading');
  });

  it('rates: ¢/m³ with four decimals, listed, never dollars', () => {
    renderPanel();
    const first = screen.getAllByTestId('gas-period')[0];
    const rates = within(first).getByTestId('gas-rates');
    expect(rates.textContent).toContain('20.4037 ¢/m³');
    expect(rates.textContent).not.toMatch(/\$20/);
    expect(screen.getAllByTestId('gas-not-summed')[0].textContent).toContain(
      'does not add these lines up',
    );
  });

  it('zero-line disclosure keeps the count visible and is operable', () => {
    renderPanel();
    const first = screen.getAllByTestId('gas-period')[0];
    const zero = within(first).getByTestId('gas-zero-lines');
    expect(zero.getAttribute('data-count')).toBe('12');
    const btn = within(zero).getByRole('button');
    expect(btn.textContent).toBe('12 more lines, all zero');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // The promoted total is NEVER re-listed as a line — it lives in the
    // money group (gas-total-charges) only.
    expect(within(first).queryAllByTestId('bill-line-total')).toHaveLength(0);
  });

  it('bill facts carry the feed\'s own days line with its caveat', () => {
    renderPanel();
    const first = screen.getAllByTestId('gas-period')[0];
    expect(first.textContent).toContain('the period label above uses the billing period');
    expect(first.textContent).toContain('Pressure factor');
    expect(first.textContent).toContain('Adjustment Factor');
  });
});

describe('gas surfaces — FR (runtime, not just the static gate)', () => {
  it('paints French copy and fr-CA money inside the sentences', () => {
    setLocale('fr');
    renderPanel();
    // fr-CA currency runs "13,87 $" — often behind a NBSP; compare on
    // normalized whitespace so the assertion checks composition, not glyphs.
    const flat = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ');
    expect(screen.getAllByTestId('gas-badge')[0].textContent).toContain('Gaz naturel');
    const banner = screen.getAllByTestId('gas-unexplained-banner')[0];
    expect(flat(banner.textContent)).toContain('Non expliqué dans le fichier');
    // Money composed INSIDE the FR sentence — the known failure mode.
    expect(flat(banner.textContent)).toContain('13,87 $');
    expect(flat(banner.textContent)).not.toContain('$13.87');
    const first = screen.getAllByTestId('gas-period')[0];
    expect(flat(within(first).getByTestId('gas-amount-due').textContent)).toContain('175,76 $');
    expect(flat(within(first).getByTestId('gas-difference').textContent)).toContain('13,87 $');
    expect(flat(within(first).getByTestId('gas-volume-billed').textContent)).toContain('429,0 m³');
    // The explicit English strings must not survive into French.
    expect(document.body.textContent).not.toContain('Unexplained in the feed');
    expect(document.body.textContent).not.toContain('Not compared');
    expect(document.body.textContent).not.toContain('No interval data in the feed');
  });

  it('period picker and card headers stay French', () => {
    setLocale('fr');
    renderPanel();
    expect(screen.getAllByTestId('gas-skip-electricity')[0].textContent).toContain(
      'Non comparé',
    );
    expect(document.body.textContent).toContain('mensuelles');
  });
});
