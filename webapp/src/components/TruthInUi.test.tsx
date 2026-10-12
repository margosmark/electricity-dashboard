/**
 * Truth-in-UI sweep (2026-10-10) — the plan-alternative and EV counterfactual
 * surfaces, audited against the two labeling risks the bill-accrual card
 * fixed: a "You paid" header over money nobody quoted, and a bare number
 * whose scope the card never declares.
 *
 * Every case here is a recurrence of one of those two, found on a surface
 * this app ships:
 *
 *  1. A bill with no priced lines — the Green Button Alliance reference
 *     sample is exactly this shape, a bare ElectricPowerUsageSummary — sums
 *     through `billTotals` to a clean $0.00. "Your actual bill" printed it as
 *     "you paid · 199,563 kWh billed" and the switch track record printed
 *     "Not modeled — …. You paid $0.00." Both assert a payment the utility
 *     never quoted; the money chart met the same shape as an unbilled row and
 *     badged it ESTIMATE.
 *  2. The plan cards' headline figure carried no scope at all, and their rate
 *     chips fell back to hardcoded Ontario rates that render identically to a
 *     loaded schedule — while the prop contract next to them says the chips
 *     "read it, never a hardcoded number".
 *  3. The EV card labelled its whole-file baseline "Today", and its peak
 *     exposure "/mo" ran with no disclosure that the month is a scaling of
 *     the window on screen (the empty state carried no disclosure of any
 *     kind).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ActualBillPanel } from './ActualBillPanel';
import EvScenarioCard from './EvScenarioCard';
import MoneySection from './MoneySection';
import MoneyStackedChart from './MoneyStackedChart';
import PeriodDeltaTable from './PeriodDeltaTable';
import PlanCards from './PlanCards';
import SwitchTrackRecord from './SwitchTrackRecord';
import VerdictLine from './VerdictLine';
import { getLocale, planLabel, setLocale } from '@/i18n';
import { buildPeriodStacks, periodDeltaRows, type PlanOverlay } from '@/lib/moneyViz';
import {
  billTotals,
  parseUsageSummaries,
  processRawData,
  summaryStatesMoney,
  type DataPoint,
  type RateSet,
  type UsageSummary,
} from '@/lib/energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A bare ElectricPowerUsageSummary: usage, no charge lines, no money. */
const alliance = parseUsageSummaries(read('green-button-alliance-sample.xml'));
/** Three real Oakville bills with every line priced. */
const oakville = parseUsageSummaries(read('usage-summary-synthetic.xml'));

/**
 * A loaded schedule whose numbers are NOTHING like the hardcoded Ontario
 * table this fix removed (12.0 / 14.2 / 9.8 / 15.7 / 20.3 / 3.9 / 39.1¢).
 * The chips' own contract says they read the active RateSet, so a test that
 * feeds the component the same numbers the fallback prints proves nothing:
 * the card could ignore the prop entirely and still pass. These values are
 * chosen so that "is it reading the prop?" has exactly one answer.
 */
const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 7.4, midPeak: 13.6, onPeak: 21.9 },
  tiered: { tier1: 11.3, tier2: 15.8, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 2.7, weekendOffPeak: 8.1, midPeak: 14.4, onPeak: 41.2 },
};

/** The removed fallback, asserted absent wherever a rate is printed. */
const HARDCODED_ONTARIO = ['12.0¢', '14.2¢', '9.8¢', '15.7¢', '20.3¢', '3.9¢', '39.1¢'];

/** A bill that states money — including one that states exactly $0.00. */
function withAmounts(summary: UsageSummary, amounts: (number | null)[]): UsageSummary {
  return {
    ...summary,
    items: summary.items.map((item, i) => ({ ...item, amount: amounts[i] ?? null })),
  };
}

describe('summaryStatesMoney', () => {
  it('is false for a bill that carries no priced line at all', () => {
    expect(alliance).toHaveLength(1);
    expect(alliance[0]).toBeDefined();
    expect(summaryStatesMoney(alliance[0])).toBe(false);
    // …which is why billTotals hands back a zero nobody quoted.
    expect(billTotals(alliance[0]).payable).toBe(0);
  });

  it('is true for a priced bill, and stays true when the bill genuinely totals zero', () => {
    expect(summaryStatesMoney(oakville[0])).toBe(true);

    const zeroed = withAmounts(oakville[0], oakville[0].items.map(() => 0));
    expect(billTotals(zeroed).payable).toBe(0);
    // The zero is stated on the lines, so it is a real $0.00 — not an absence.
    expect(summaryStatesMoney(zeroed)).toBe(true);
  });
});

describe('Truth in UI — "Your actual bill"', () => {
  it('never asserts a payment a bill did not state', () => {
    const { container } = render(<ActualBillPanel summaries={alliance} allData={[]} plan="TOU" />);

    expect(screen.getByTestId('actual-payable')).toHaveTextContent('—');
    expect(screen.getByTestId('actual-payable').nextElementSibling).toHaveTextContent(
      'no charge lines in this bill',
    );
    // Nothing derived from the absent total may print as a number either.
    const card = screen.getByTestId('actual-bill-period');
    expect(card).not.toHaveTextContent('$0.00');
    // And the commodity check refuses rather than comparing against the zero.
    expect(within(card).getByTestId('commodity-skip')).toHaveTextContent(
      'this bill states no charge lines',
    );
    expect(within(card).queryByTestId('commodity-mismatch')).not.toBeInTheDocument();
    void container;
  });

  it('still prints the payment when the bill states one', () => {
    render(<ActualBillPanel summaries={oakville} allData={[]} plan="TOU" />);
    const payables = screen.getAllByTestId('actual-payable');
    expect(payables).toHaveLength(oakville.length);
    expect(payables[0]).toHaveTextContent('$445.22');
    expect(payables[0].nextElementSibling).toHaveTextContent('you paid');
  });
});

describe('Truth in UI — switch track record', () => {
  it('never claims "You paid $0.00" for a bill that quoted no money', () => {
    render(<SwitchTrackRecord summaries={alliance} allData={[]} />);

    const skip = screen.getByTestId('switch-skip');
    expect(skip).toHaveTextContent('this bill states no charge lines');
    expect(skip).not.toHaveTextContent('You paid');
    // The row prints the reason where the number would be: no cell claims to
    // be what you paid on a bill that stated no charge.
    expect(screen.queryByTestId('switch-actual')).not.toBeInTheDocument();
    // The whole panel, not just the row: the headline is built from `saving`,
    // which for this file would be the modeled bill itself.
    expect(screen.getByTestId('switch-track-record')).not.toHaveTextContent('$0.00');
  });

  it('keeps the payment line on a bill that states one', () => {
    render(<SwitchTrackRecord summaries={oakville} allData={[]} />);
    const skips = screen.getAllByTestId('switch-skip');
    expect(skips).toHaveLength(oakville.length);
    expect(skips[0]).toHaveTextContent(/You paid \$/);
  });
});

/** Shared PlanCards props — module scope so the French pass can re-render
 *  the exact same card the English one pins. */
const PLAN_PROPS = {
  comparison: { TOU: 213.44, Tiered: 231.02, ULO: 198.77 },
  userPlan: 'TOU' as const,
  setUserPlan: vi.fn(),
  activeRateSet: RATES,
  startDate: '2026-05-25',
  endDate: '2026-06-23',
};

/** A quiet house plus a nightly block, so the EV scenario is ready to render. */
function rows(days: number, kwhAt: (d: Date) => number) {
  const raw: DataPoint[] = [];
  for (let day = 0; day < days; day++) {
    for (let h = 0; h < 24; h++) {
      const d = new Date(2026, 5, 1 + day, h, 0, 0);
      raw.push({ timestamp: Math.floor(d.getTime() / 1000), usage_kwh: kwhAt(d) });
    }
  }
  return processRawData(raw, [RATES]);
}
const night = new Set([23, 0, 1]);
const withEv = rows(20, (d) => (night.has(d.getHours()) ? 3.4 : 0.4));
const withoutEv = rows(20, () => 0.4);

describe('Truth in UI — plan cards', () => {
  const props = PLAN_PROPS;

  it('declares the scope under its headline figure', () => {
    const { container } = render(<PlanCards {...props} />);
    const scopes = container.querySelectorAll('[data-testid="plan-card-scope"]');
    expect(scopes).toHaveLength(3);
    for (const scope of scopes) {
      expect(scope).toHaveTextContent('commodity only');
      // The window the figure was computed over, named on the card itself.
      expect(scope).toHaveTextContent(/May 25 – Jun 23 on screen/);
    }
  });

  it('prints THIS schedule on the chips, never the removed hardcoded table', () => {
    render(<PlanCards {...props} />);
    // One value per plan from the prop: TOU off-peak 7.4¢, Tiered tier 1
    // 11.3¢, ULO on-peak 41.2¢. With RATES chosen to differ from the old
    // fallback on every line, a card that ignored `activeRateSet` would print
    // 9.8¢ / 12.0¢ / 39.1¢ and this test would fail.
    expect(screen.getAllByText('7.4¢')).toHaveLength(1);
    expect(screen.getAllByText('11.3¢')).toHaveLength(1);
    expect(screen.getAllByText('41.2¢')).toHaveLength(1);
    for (const rate of HARDCODED_ONTARIO) {
      expect(screen.queryByText(rate)).not.toBeInTheDocument();
    }
  });

  it('shows no rate at all — never a stranger’s tariff — when no schedule is loaded', () => {
    const { container } = render(<PlanCards {...props} activeRateSet={null} />);
    // The hardcoded Ontario fallbacks that used to render here looked exactly
    // like loaded rates on a card that has none.
    for (const rate of HARDCODED_ONTARIO) {
      expect(screen.queryByText(rate)).not.toBeInTheDocument();
    }
    // Display SSOT: without a RateSet the card prints no rate rows at all, so
    // there is not a single ¢ figure that did not come from a schedule this
    // household actually has.
    expect(container.textContent).not.toMatch(/¢/);
  });

  it('states the switch caveat once, not twice', () => {
    render(
      <VerdictLine
        comparison={{ TOU: 213.44, Tiered: 198.77, ULO: 231.02 }}
        userPlan="TOU"
        days={30}
      />,
    );
    const line = screen.getByTestId('verdict-line').textContent ?? '';
    expect(line.match(/Shift advice and the switch/g)).toHaveLength(1);
    expect(line).toContain('track record below can move this');
  });
});

describe('Truth in UI — EV counterfactual', () => {
  it('names the whole-file comparison a baseline, never "Today"', () => {
    render(<EvScenarioCard rows={withEv} rates={RATES} />);
    const comparison = screen.getByTestId('ev-plan-comparison');
    expect(comparison).toHaveTextContent('Baseline $');
    expect(comparison).not.toHaveTextContent('Today $');
    // The delta is measured against that same baseline.
    expect(comparison.textContent).not.toMatch(/vs today/);
  });

  it('declares the peak-exposure run-rate when the scenario is ready', () => {
    render(<EvScenarioCard rows={withEv} rates={RATES} />);
    const basis = screen.getByTestId('ev-exposure-basis');
    expect(basis).toHaveTextContent('Commodity only');
    expect(basis).toHaveTextContent(/run-rate, not a metered month/);
    // The window it was scaled FROM is named, not implied.
    expect(basis).toHaveTextContent('20 days of your data');
  });

  it('declares the same run-rate in the empty state, where no assumptions list renders', () => {
    render(<EvScenarioCard rows={withoutEv} rates={RATES} />);
    // No EV tagged, so the scenario is not ready — and the exposure still
    // carries its basis instead of an unqualified "/mo".
    expect(screen.queryByTestId('ev-assumptions')).not.toBeInTheDocument();
    expect(screen.getByTestId('ev-peak-exposure')).toBeInTheDocument();
    const basis = screen.getByTestId('ev-exposure-basis');
    expect(basis).toHaveTextContent('Commodity only');
    expect(basis).toHaveTextContent('20 days of your data');
  });
});


describe('Truth in UI — the disclosures survive the French toggle', () => {
  afterEach(() => setLocale('en'));

  it('says why the bill has no payment, in French, and never leaks a key', () => {
    setLocale('fr');
    expect(getLocale()).toBe('fr');

    render(<ActualBillPanel summaries={alliance} allData={[]} plan="TOU" />);
    expect(screen.getByTestId('actual-payable')).toHaveTextContent('—');
    expect(screen.getByTestId('actual-payable').nextElementSibling).toHaveTextContent(
      'aucune ligne de frais dans cette facture',
    );
    const card = screen.getByTestId('actual-bill-period');
    expect(card).not.toHaveTextContent('$0.00');
    // A catalog key missing from fr.json falls back to the KEY text — a
    // half-translated honesty disclosure is exactly the failure this pass
    // exists to catch, so assert it never reaches the screen.
    expect(card.textContent).not.toMatch(/actualBill\./);
    expect(within(card).getByTestId('commodity-skip')).toHaveTextContent(
      'cette facture n’indique aucune ligne de frais',
    );
    expect(within(card).queryByTestId('commodity-mismatch')).not.toBeInTheDocument();
  });

  it('keeps the plan-card scope caption, its window and its rates in French', () => {
    setLocale('fr');
    const { container } = render(<PlanCards {...PLAN_PROPS} />);
    const scopes = container.querySelectorAll('[data-testid="plan-card-scope"]');
    expect(scopes).toHaveLength(3);
    for (const scope of scopes) {
      expect(scope).toHaveTextContent('électricité seulement');
      expect(scope).toHaveTextContent(/25 mai – 23 juin à l’écran/);
    }
    expect(screen.queryByText('commodity only')).not.toBeInTheDocument();
    // The chips read the same prop and format it for fr-CA: 7,4 ¢, not 7.4¢.
    expect(screen.getAllByText('7,4 ¢')).toHaveLength(1);
    expect(screen.queryByText('7.4¢')).not.toBeInTheDocument();
    for (const rate of HARDCODED_ONTARIO) {
      expect(screen.queryByText(rate)).not.toBeInTheDocument();
    }
  });

  it('keeps the track record’s no-charge-lines skip in French, still unpaid', () => {
    setLocale('fr');
    render(<SwitchTrackRecord summaries={alliance} allData={[]} />);
    const skip = screen.getByTestId('switch-skip');
    expect(skip).toHaveTextContent(
      'cette facture n’indique aucune ligne de frais, donc rien à comparer',
    );
    // The French payment line is what the untranslated fix would print here
    // ("Non modélisé — …. Vous avez payé 0,00 $."): no payment, in either
    // language, on a bill that quoted none.
    expect(skip).not.toHaveTextContent('You paid');
    expect(skip).not.toHaveTextContent('Vous avez payé');
    expect(screen.queryByTestId('switch-actual')).not.toBeInTheDocument();
    expect(screen.getByTestId('switch-track-record').textContent).not.toMatch(/track\./);
  });

  it('keeps the EV baseline and run-rate disclosure in French', () => {
    setLocale('fr');
    render(<EvScenarioCard rows={withEv} rates={RATES} />);
    const comparison = screen.getByTestId('ev-plan-comparison');
    // fr-CA puts the currency symbol AFTER the number — this also pins that
    // the card's money goes through the locale formatter rather than a
    // hand-rolled `$`-prefixed template (which would read "Référence $34.98").
    expect(comparison.textContent).toMatch(/Référence \d[\d\s.,]*\s*\$/);
    expect(comparison.textContent).not.toMatch(/Référence \$/);
    expect(comparison).not.toHaveTextContent('Today');
    expect(comparison.textContent).not.toMatch(/ev\./);
    const basis = screen.getByTestId('ev-exposure-basis');
    expect(basis).toHaveTextContent('Électricité seulement');
    expect(basis).toHaveTextContent('rythme annualisé, pas un mois mesuré');
    expect(basis).toHaveTextContent('20 jours de vos données');
  });
});


/* ==========================================================================
 * Money tab — the period table's "you paid" column (t_f915a15c)
 *
 * The residual the truth-in-UI sweep recorded in `moneyTabZeroHits`: the
 * Plans tab says "— no charge lines in this bill" for a bill that quotes no
 * charge, and the Money tab's period table next to it printed YOU PAID
 * $0.00 for that very same bill — the shape PR #53 closed, one surface over.
 * ========================================================================== */

/**
 * The two shapes this must never collapse into one:
 *   • `alliance` — a bill that states NO charge line, so `billTotals` sums
 *     its amount-less lines to a $0.00 nobody quoted;
 *   • `zeroed`   — a priced bill whose STATED lines all read 0, so the
 *     $0.00 on screen is a fact about the bill, not an absence.
 * `summaryStatesMoney` is the only thing that tells them apart.
 */
const allianceStacks = buildPeriodStacks(alliance, []);
const pricedStacks = buildPeriodStacks(oakville, []);
const zeroedStacks = buildPeriodStacks(
  [withAmounts(oakville[0], oakville[0].items.map(() => 0))],
  [],
);
/** The same two shapes as columns of the period-over-period table. */
const silentSecond = withAmounts(oakville[1], oakville[1].items.map(() => null));
const silentFirst = withAmounts(oakville[0], oakville[0].items.map(() => null));

/** No rates, no full-coverage readings: the overlay key never renders. */
const overlayOff: PlanOverlay = {
  ready: false,
  reason: 'no rates to model with',
  lines: [],
  actual: 0,
  actualPerPeriod: 0,
  covered: 0,
  periods: 1,
  chargesSource: null,
  rebateRate: null,
  assumptions: [],
};

/**
 * A READY overlay, injected: the chart takes it as a prop, so the key can be
 * pinned without a fixture that also clears the coverage AND rate gates.
 */
// Labels come from `planLabel()` — exactly what `moneyViz.planOverlay`
// produces — so this fixture follows the locale the way the real overlay does
// rather than hardcoding one language.
const overlayOn = (actual: number): PlanOverlay => ({
  ...overlayOff,
  ready: true,
  reason: '',
  lines: [
    { plan: 'TOU', label: planLabel('TOU'), amount: 210.5, perPeriod: 105.25 },
    { plan: 'Tiered', label: planLabel('Tiered'), amount: 198.25, perPeriod: 99.13 },
    { plan: 'ULO', label: planLabel('ULO'), amount: 187.4, perPeriod: 93.7 },
  ],
  actual,
  actualPerPeriod: actual / 2,
  covered: 2,
  chargesSource: 'typed',
});

describe('Truth in UI — the Money tab', () => {
  afterEach(() => setLocale('en'));

  it('never prints a payment the bill did not state (EN)', () => {
    const { container } = render(
      <MoneyStackedChart stacks={allianceStacks} overlay={overlayOff} />,
    );
    const table = screen.getByTestId('money-table');
    // The absence the utility left may not be filled in with a zero …
    expect(table).not.toHaveTextContent('$0.00');
    expect(table).not.toHaveTextContent('0,00 $');
    expect(table).not.toHaveTextContent(/you paid/i);
    expect(container).not.toHaveTextContent('$0.00');
    // … the column says why there is no figure …
    expect(screen.getByTestId('money-paid-head')).toHaveTextContent(
      'no charge lines in this bill',
    );
    // … and the row says it too, so a row read on its own claims nothing.
    const cell = screen.getByTestId('money-no-charge-lines');
    expect(cell).toHaveTextContent('no charge lines in this bill');
    expect(cell).toHaveTextContent('—');
    expect(table).toHaveTextContent('no charge lines in this bill');
  });

  it('never prints a payment the bill did not state (FR)', () => {
    setLocale('fr');
    const { container } = render(
      <MoneyStackedChart stacks={allianceStacks} overlay={overlayOff} />,
    );
    const table = screen.getByTestId('money-table');
    expect(table).not.toHaveTextContent('$0.00');
    expect(table).not.toHaveTextContent('0,00 $');
    expect(table).not.toHaveTextContent(/vous avez payé/i);
    expect(container).not.toHaveTextContent('$0.00');
    expect(screen.getByTestId('money-paid-head')).toHaveTextContent(
      'aucune ligne de frais dans cette facture',
    );
    expect(screen.getByTestId('money-no-charge-lines')).toHaveTextContent(
      'aucune ligne de frais dans cette facture',
    );
    // A key missing from fr.json falls back to its own KEY text on screen.
    expect(table.textContent).not.toMatch(/\b(?:actualBill|money)\.[a-zA-Z]/);
  });

  it('still prints a real $0.00 for a bill whose stated lines sum to zero', () => {
    render(<MoneyStackedChart stacks={zeroedStacks} overlay={overlayOff} />);
    const table = screen.getByTestId('money-table');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    // The column is still a payment column: this zero was QUOTED, not derived.
    expect(heads.some((h) => /you paid/i.test(h))).toBe(true);
    expect(heads.some((h) => /no charge lines/i.test(h))).toBe(false);
    expect(screen.queryByTestId('money-no-charge-lines')).not.toBeInTheDocument();
    expect(table).toHaveTextContent('$0.00');
  });

  it('still prints the payment of a bill that states one', () => {
    render(<MoneyStackedChart stacks={pricedStacks} overlay={overlayOff} />);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(heads.some((h) => /you paid/i.test(h))).toBe(true);
    expect(screen.queryByTestId('money-no-charge-lines')).not.toBeInTheDocument();
    // Oakville period 1, derived in the same suite by ActualBillPanel.
    expect(screen.getByTestId('money-table')).toHaveTextContent('$445.22');
  });

  it('says why in the period-over-period table, beside a bill that does state money', () => {
    render(
      <PeriodDeltaTable
        table={periodDeltaRows(buildPeriodStacks([oakville[0], silentSecond], []))}
      />,
    );
    const table = screen.getByTestId('money-deltas-table');
    expect(table).not.toHaveTextContent('$0.00');
    // Every cell of the silent column carries the reason …
    const silentCells = within(table).getAllByTestId('money-delta-no-charge-lines');
    expect(silentCells.length).toBeGreaterThan(1);
    for (const cell of silentCells) {
      expect(cell).toHaveTextContent('no charge lines in this bill');
      expect(cell).toHaveTextContent('—');
    }
    // … while the priced baseline beside it keeps its real figure.
    expect(table).toHaveTextContent('$445.22');
  });

  it('reports no change measured out of a bill that stated nothing', () => {
    render(
      <PeriodDeltaTable
        table={periodDeltaRows(buildPeriodStacks([silentFirst, oakville[1]], []))}
      />,
    );
    const table = screen.getByTestId('money-deltas-table');
    // Neither the silent baseline NOR the change out of it is a money figure:
    // a delta against an absence would be "+$445.22" out of nothing.
    expect(table.textContent).not.toMatch(/\$/);
    expect(within(table).getAllByTestId('money-delta-no-charge-lines').length).toBeGreaterThan(1);
  });

  it('says why in the overlay key instead of printing a derived payment', () => {
    render(<MoneyStackedChart stacks={allianceStacks} overlay={overlayOn(0)} />);
    const key = screen.getByTestId('money-overlay-key');
    expect(screen.getByTestId('money-overlay-no-charge-lines')).toHaveTextContent(
      'no charge lines in this bill',
    );
    expect(key).toHaveTextContent('no charge lines in this bill');
    expect(key).not.toHaveTextContent(/you paid/i);
    expect(key).not.toHaveTextContent('$0.00');
    const lines = screen.getByTestId('money-overlay-lines');
    expect(lines).toHaveTextContent('no charge lines in this bill');
    expect(lines).not.toHaveTextContent('$0.00');
  });

  it('keeps the payment, its total and its wording in the overlay key', () => {
    render(<MoneyStackedChart stacks={pricedStacks} overlay={overlayOn(889.44)} />);
    const key = screen.getByTestId('money-overlay-key');
    expect(key).toHaveTextContent('You paid $444.72');
    expect(key).toHaveTextContent('($889.44 total)');
    expect(screen.getByTestId('money-overlay-lines')).toHaveTextContent(
      'you paid $889.44',
    );
  });

  it('translates the overlay key’s payment line in French', () => {
    setLocale('fr');
    render(<MoneyStackedChart stacks={pricedStacks} overlay={overlayOn(889.44)} />);
    const key = screen.getByTestId('money-overlay-key');
    expect(key).toHaveTextContent('Vous avez payé 444,72 $');
    expect(key).toHaveTextContent('(889,44 $ au total)');
    expect(screen.getByTestId('money-overlay-lines')).toHaveTextContent(
      'vous avez payé 889,44 $',
    );
    // The overlay legend's plan names are display text, so they translate too.
    expect(screen.getByTestId('money-overlay-lines')).toHaveTextContent(
      'Tarification par paliers',
    );
  });

  it('the whole Money section prints no zero for that bill (EN)', () => {
    render(<MoneySection summaries={alliance} allData={[]} plan="TOU" />);
    const section = screen.getByTestId('money-section');
    expect(section).not.toHaveTextContent('$0.00');
    expect(section).not.toHaveTextContent('0,00 $');
    expect(screen.getByTestId('money-no-charge-lines')).toBeInTheDocument();
    expect(screen.getByTestId('money-paid-head')).toHaveTextContent(
      'no charge lines in this bill',
    );
  });

  it('the whole Money section prints no zero for that bill (FR)', () => {
    setLocale('fr');
    render(<MoneySection summaries={alliance} allData={[]} plan="TOU" />);
    const section = screen.getByTestId('money-section');
    expect(section).not.toHaveTextContent('$0.00');
    expect(section).not.toHaveTextContent('0,00 $');
    expect(screen.getByTestId('money-no-charge-lines')).toHaveTextContent(
      'aucune ligne de frais dans cette facture',
    );
    expect(screen.getByTestId('money-table').textContent).not.toMatch(
      /\b(?:actualBill|money)\.[a-zA-Z]/,
    );
  });
});
