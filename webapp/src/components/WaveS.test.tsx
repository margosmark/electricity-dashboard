/**
 * Wave S — the EFFICIENCY card and its place on OVERVIEW.
 *
 * Covered here, in the order the slices were specified:
 *   1. the card itself — headline stat, the split verdict chip (USAGE, never
 *      the delivery/fixed term that the follow-through audit found was 96% of
 *      the old "behaviour" slope on real data) with rates, delivery and net
 *      beside it, and the honest sentence;
 *   2. the mini-line — every bill, the regression over the verdict window,
 *      Nov 1 rate-change ticks, winter/summer bands — and its click
 *      through to the MONEY tab;
 *   3. the empty states (no bills / too few bills for a verdict);
 *   4. OVERVIEW wiring — the all-time and in-view ¢/kWh numbers inside the
 *      EXISTING totals strip, no new strip.
 *
 * The fixture is SYNTHETIC (the owner's real export never enters the repo);
 * it carries three bills, which is exactly the dataset that must NOT earn a
 * trend verdict — three points cannot support an error bar.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Dashboard from './Dashboard';
import EfficiencyCard from './EfficiencyCard';
import { parseUsageSummaries, type RateSet } from '@/lib/energy';
import { seasonForDay } from '@/lib/season';
import {
  buildEfficiency,
  efficiencyTrend,
  weightedCentsPerKwh,
  type PeriodEfficiency,
} from '@/lib/statistics';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);
const summaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

const rates: RateSet[] = [
  {
    effectiveDate: '2024-06-15',
    tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
  },
  {
    effectiveDate: '2023-01-01',
    tou: { offPeak: 7.6, midPeak: 12.2, onPeak: 15.8 },
    tiered: { tier1: 9.3, tier2: 11.0, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 2.8, weekendOffPeak: 7.6, midPeak: 12.2, onPeak: 28.4 },
  },
];

/** Twelve monthly periods spanning both Ontario rate seasons. */
function yearOfPeriods(): PeriodEfficiency[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = String(i + 1).padStart(2, '0');
    const startDate = `2024-${month}-01`;
    const endDate = `2024-${month}-28`;
    const cents = 19;
    // Each bill carries HST at 13% of its own Total Electricity Charges —
    // $190 → $24.70 — so the incl-tax figure is (190 + 24.70) ÷ 1,000 kWh
    // = 21.47¢. The verdict, the split and the fit must not notice it.
    const tax = 24.7;
    return {
      start: Date.UTC(2024, i, 1) / 1000,
      startDate,
      endDate,
      label: startDate,
      kwh: 1000,
      cost: cents * 10,
      tax,
      cents,
      centsInclTax: ((cents * 10 + tax) / 1000) * 100,
      // Usage −0.2¢/period, rates +0.2¢/period, delivery flat 4¢ → the
      // observed 19¢ is flat, and the verdict may only read the usage half.
      usageCents: 16 - 0.2 * i,
      deliveryCents: 4,
      rateCents: -1 + 0.2 * i,
      unmappedKwh: 0,
      season: seasonForDay(startDate),
    };
  });
}

function yearReport() {
  const periods = yearOfPeriods();
  const trend = efficiencyTrend(periods, rates);
  return {
    periods,
    allTime: weightedCentsPerKwh(periods),
    inView: weightedCentsPerKwh(periods.slice(6)),
    trend,
  };
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: () => Promise.resolve({ historicalRates: rates }) }),
  );
}

/** Daily readings across the fixture's three billing periods. */
function dailyReadings(from: string, to: string): { timestamp: number; usage_kwh: number }[] {
  const out: { timestamp: number; usage_kwh: number }[] = [];
  const end = new Date(`${to}T12:00:00Z`).getTime();
  for (let t = new Date(`${from}T12:00:00Z`).getTime(); t <= end; t += 86400_000) {
    out.push({ timestamp: Math.floor(t / 1000), usage_kwh: 12 });
  }
  return out;
}

beforeEach(() => {
  stubFetch();
  localStorage.clear();
  window.history.replaceState(null, '', window.location.pathname);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/* ========================================================================== *
 * 1 + 2. The card
 * ========================================================================== */

describe('Wave S 1 — the EFFICIENCY card', () => {
  it('states the all-time ¢/kWh as the headline number', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const headline = screen.getByTestId('efficiency-all-time');
    // Twelve equal bills of 19.0¢/kWh → the weighted mean is 19.0¢.
    expect(headline).toHaveTextContent('19.0¢');
    expect(headline).toHaveAttribute('data-cents', '19.00');
    // …and the card says out loud that this reading is the pre-tax one.
    expect(headline.parentElement).toHaveTextContent('excl. tax');
  });

  it('prints the incl-tax reading of the SAME bills right beside it', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    // $190 + $24.70 HST over 1,000 kWh = 21.47¢ — same bills, same kWh,
    // one more line of the bill added back. Both are on screen at once:
    // no toggle, no hover, nothing to discover.
    const incl = screen.getByTestId('efficiency-all-time-incl-tax');
    expect(incl).toHaveTextContent('21.5¢');
    expect(incl).toHaveAttribute('data-cents', '21.47');
    expect(incl.parentElement).toHaveTextContent('incl. tax');

    // Both readings live in the SAME headline block — the pair is the
    // point, so one of them cannot be rendered somewhere else entirely.
    const block = screen.getByTestId('efficiency-headline');
    expect(within(block).getByTestId('efficiency-all-time')).toBeInTheDocument();
    expect(within(block).getByTestId('efficiency-all-time-incl-tax')).toBeInTheDocument();
    expect(block).toHaveAttribute('data-cents', '19.00');
    expect(block).toHaveAttribute('data-cents-incl-tax', '21.47');
    expect(block).toHaveAttribute('data-tax', '296.40');
  });

  it('says what the numerator contains instead of leaving it to be inferred', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const subtitle = screen.getByTestId('efficiency-subtitle');
    expect(subtitle).toHaveTextContent(/ALL electricity charges/i);
    expect(subtitle).toHaveTextContent(/commodity \+ delivery \+ regulatory/);
    expect(subtitle).toHaveTextContent(/tax excluded/);
  });

  it('quotes the tax rate the FILE states, and the two things the numbers are not', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const note = screen.getByTestId('efficiency-tax-footnote');
    // 296.40 ÷ 2,280 = 13.0% — derived from the loaded bills, not assumed.
    expect(note).toHaveAttribute('data-tax-pct', '13');
    expect(note).toHaveTextContent('HST on your bills is 13.0%');
    expect(note).toHaveTextContent('adds that line back over the same kWh');
    // A separate utility bill (water/gas) is not in these numbers, and the
    // note says so rather than letting the figure imply a whole-house rate.
    expect(note).toHaveTextContent('Water and gas are billed separately');
    expect(note).toHaveTextContent('never in these numbers');
  });

  it('gives the mini-line the same two figures per endpoint', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const range = screen.getByTestId('efficiency-range');
    // All twelve bills are identical, so both endpoints read 19.0¢ / 21.5¢
    // — but as SEPARATE figures, labelled excl and incl.
    expect(range).toHaveTextContent(/2024-01-01: 19\.0¢ excl · 21\.5¢ incl/);
    expect(range).toHaveTextContent(/2024-12-01: 19\.0¢ excl · 21\.5¢ incl/);
    expect(range).toHaveAttribute('data-first-cents', '19.00');
    expect(range).toHaveAttribute('data-first-cents-incl-tax', '21.47');
    expect(range).toHaveAttribute('data-last-cents', '19.00');
    expect(range).toHaveAttribute('data-last-cents-incl-tax', '21.47');
  });

  it('carries both readings on every bill the mini-line draws', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const points = screen.getAllByTestId('efficiency-point');
    expect(points).toHaveLength(12);
    for (const p of points) {
      expect(p).toHaveAttribute('data-cents', '19.00');
      expect(p).toHaveAttribute('data-cents-incl-tax', '21.47');
      expect(p).toHaveAttribute('data-tax', '24.70');
    }
  });

  it('keeps the verdict, the split and the fit on the PRE-TAX number', () => {
    // A tax line is a constant multiplier: it moves every ¢/kWh by the same
    // factor and therefore moves no slope and changes no verdict. The chip
    // must still read the pre-tax usage component, not the incl-tax one.
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const chip = screen.getByTestId('efficiency-trend-chip');
    expect(chip).toHaveAttribute('data-verdict', 'improving');
    expect(chip).toHaveAttribute('data-slope', '-0.200');
    expect(chip).toHaveAttribute('data-net-slope', '0.000');
  });

  it('reads the verdict from the USAGE component, with rates, delivery and net beside it', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const chip = screen.getByTestId('efficiency-trend-chip');
    expect(chip).toHaveAttribute('data-verdict', 'improving');
    expect(chip).toHaveAttribute('data-window', '12');
    expect(chip).toHaveAttribute('data-usage-slope', '-0.200');
    expect(chip).toHaveAttribute('data-delivery-slope', '0.000');
    expect(chip).toHaveAttribute('data-rate-slope', '0.200');
    expect(chip).toHaveAttribute('data-net-slope', '0.000');
    expect(chip).toHaveTextContent('IMPROVING');
    expect(chip).toHaveTextContent('-0.2¢/kWh per period');
    expect(chip).toHaveTextContent('(your last 12 bills)');

    // The chip is green only because the USAGE half improved.
    expect(chip.className).toContain('bg-good-slab');
    expect(screen.getByTestId('efficiency-rates-line')).toHaveAttribute('data-direction', 'up');
    expect(screen.getByTestId('efficiency-rates-line')).toHaveTextContent('+0.2¢/period');
    // Delivery gets its own line — reported, never credited with the verdict.
    const delivery = screen.getByTestId('efficiency-delivery-line');
    expect(delivery).toHaveAttribute('data-direction', 'flat');
    expect(delivery).toHaveTextContent('delivery & fixed ±0.0¢');
    expect(screen.getByTestId('efficiency-net-line')).toHaveAttribute('data-verdict', 'stable');
  });

  it('spells the split out in one sentence, rates and delivery and all', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const sentence = screen.getByTestId('efficiency-sentence').textContent || '';
    expect(sentence).toContain('usage mix improved (-0.2¢/kWh behavior-driven)');
    expect(sentence).toContain('rates rose (+0.2¢/kWh)');
    expect(sentence).toContain('delivery & fixed charges flat (±0.0¢)');
    expect(sentence).toContain('net stable');
  });

  it('draws every bill with the regression, the rate tick and both season bands', () => {
    render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const chart = screen.getByTestId('efficiency-chart');
    expect(chart).toHaveAttribute('data-points', '12');
    expect(chart).toHaveAttribute('data-window', '12');
    expect(screen.getByTestId('efficiency-regression-line')).toBeInTheDocument();
    expect(screen.getByTestId('efficiency-series')).toBeInTheDocument();

    // One circle per bill, carrying the number it draws — this is what the
    // deployed browser check reads back against the data audit.
    const points = screen.getAllByTestId('efficiency-point');
    expect(points).toHaveLength(12);
    expect(points[0]).toHaveAttribute('data-start', '2024-01-01');
    expect(points[0]).toHaveAttribute('data-cents', '19.00');
    expect(points[0]).toHaveAttribute('data-kwh', '1000.0');

    // Nov 1 rate season + the Jun 15 set: exactly one tick inside 2024.
    const ticks = screen.getAllByTestId('efficiency-rate-tick');
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toHaveAttribute('data-date', '2024-06-15');

    // Jan–Apr winter, May–Oct summer, Nov–Dec winter.
    const bands = screen.getAllByTestId('efficiency-season-band');
    expect(bands).toHaveLength(3);
    expect(bands.map((b) => b.getAttribute('data-season'))).toEqual([
      'winter',
      'summer',
      'winter',
    ]);
    // …labelled, because "summer bills are cheaper per kWh" has to be said.
    // D3c (t_fcbba376) swapped the old `bars >= 3` gate for a FIT test —
    // `band width >= 4.3 × labelFs` — so the 2-bar Nov–Dec winter segment
    // earns its label too (110 units wide at 12 bills, the word is ~41).
    // Every band that passed before still passes.
    expect(screen.getAllByText('Winter')).toHaveLength(2);
    expect(screen.getByText('Summer')).toBeInTheDocument();
  });

  it('jumps to the MONEY tab when the mini-line is clicked', async () => {
    const user = userEvent.setup();
    const onOpenMoney = vi.fn();
    render(<EfficiencyCard report={yearReport()} onOpenMoney={onOpenMoney} />);
    const target = screen.getByTestId('efficiency-open-money');
    expect(target.tagName).toBe('BUTTON');
    expect(target).toHaveTextContent('Open the Money tab');
    await user.click(target);
    expect(onOpenMoney).toHaveBeenCalledTimes(1);
  });
});

/* ========================================================================== *
 * 3. Empty states
 * ========================================================================== */

describe('Wave S 3 — honest empty states', () => {
  it('refuses a verdict below the trend floor instead of guessing', () => {
    // The fixture carries three bills: enough for the stat, not for a slope.
    const report = buildEfficiency({ summaries, rates, view: null });
    expect(report.allTime).not.toBeNull();
    render(<EfficiencyCard report={report} onOpenMoney={() => {}} />);
    const empty = screen.getByTestId('efficiency-trend-empty');
    expect(empty).toHaveTextContent('at least 4 closed bills');
    expect(empty).toHaveTextContent('you have 3');
    expect(screen.queryByTestId('efficiency-trend-chip')).not.toBeInTheDocument();
  });

  it('says why the split is off when no rate set is loaded', () => {
    const report = buildEfficiency({ summaries, rates: null, view: null });
    expect(report.trend.splitAvailable).toBe(false);
    expect(report.trend.splitNote).toMatch(/no OEB rate set/i);
  });

  it('asks for a file when there is nothing at all', () => {
    const report = buildEfficiency({ summaries: [], rates: [], view: null });
    render(<EfficiencyCard report={report} onOpenMoney={() => {}} />);
    expect(screen.getByTestId('efficiency-empty')).toHaveTextContent(/upload/i);
    expect(screen.queryByTestId('efficiency-chart')).not.toBeInTheDocument();
  });
});

/* ========================================================================== *
 * 4. OVERVIEW wiring
 * ========================================================================== */

describe('Wave S 4 — OVERVIEW: strip numbers + the card', () => {
  async function renderLoaded() {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
  }

  it('puts the all-time and in-view ¢/kWh inside the EXISTING totals strip', async () => {
    localStorage.setItem(
      'usage_summaries',
      JSON.stringify(parseUsageSummaries(
        fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
      )),
    );
    localStorage.setItem('energy_data', JSON.stringify(dailyReadings('2026-05-01', '2026-08-20')));
    await renderLoaded();

    const strip = screen.getByTestId('totals-strip');
    // No new strip: the numbers live in the one that already exists.
    const block = within(strip).getByTestId('efficiency-strip');
    const allTime = within(block).getByTestId('efficiency-all-time-strip');
    // 1,365.03 ÷ 8,080 kWh — the audit's three-period arithmetic.
    expect(allTime).toHaveAttribute('data-cents', '16.89');
    expect(allTime).toHaveTextContent('16.9¢');
    expect(allTime).toHaveAttribute('data-bills', '3');
    // The strip answers the same question the card does: BOTH readings.
    // 1,365.03 + 177.46 = 1,542.49 ÷ 8,080 kWh.
    const allTimeIncl = within(block).getByTestId('efficiency-all-time-strip-incl-tax');
    expect(allTimeIncl).toHaveAttribute('data-cents', '19.09');
    expect(allTimeIncl).toHaveTextContent('19.1¢');
    expect(block).toHaveTextContent(/excl\. tax/);
    expect(block).toHaveTextContent(/incl\. tax/);
    // The strip carries the same subtitle as the card, so the two views of
    // the same numbers cannot describe their numerator differently.
    expect(block).toHaveTextContent(/ALL electricity charges/);
    expect(block).toHaveTextContent(/tax excluded/);

    const inView = within(block).getByTestId('efficiency-in-view');
    expect(Number(inView.getAttribute('data-cents'))).toBeGreaterThan(0);
    expect(Number(inView.getAttribute('data-bills'))).toBeGreaterThanOrEqual(1);
    // In-view carries the pair too, scoped to the same bill set.
    const inViewIncl = within(block).getByTestId('efficiency-in-view-incl-tax');
    expect(Number(inViewIncl.getAttribute('data-cents'))).toBeGreaterThan(
      Number(inView.getAttribute('data-cents')),
    );
    expect(block).toHaveTextContent('3 bills');
  });

  it('renders the EFFICIENCY card on Overview, gated on the trend floor', async () => {
    localStorage.setItem(
      'usage_summaries',
      JSON.stringify(summaries),
    );
    localStorage.setItem('energy_data', JSON.stringify(dailyReadings('2026-05-01', '2026-08-20')));
    await renderLoaded();

    const overview = screen.getByTestId('tab-panel-overview');
    const card = within(overview).getByTestId('efficiency-card');
    expect(within(card).getByTestId('efficiency-all-time')).toHaveTextContent('16.9¢');
    // Same three bills, both readings, on the card the user actually sees:
    // 1,542.49 ÷ 8,080 kWh = 19.1¢ incl. tax.
    expect(within(card).getByTestId('efficiency-all-time-incl-tax')).toHaveTextContent('19.1¢');
    expect(within(card).getByTestId('efficiency-subtitle')).toHaveTextContent(/tax excluded/);
    expect(within(card).getByTestId('efficiency-tax-footnote')).toHaveTextContent(
      'HST on your bills is 13.0%',
    );
    // Three bills: the stat stands, the verdict waits.
    expect(within(card).getByTestId('efficiency-trend-empty')).toHaveTextContent(
      'at least 4 closed bills',
    );
  });

  it('orders the period, projected-bill focus, rate history, and decision surfaces before detail', async () => {
    localStorage.setItem('usage_summaries', JSON.stringify(summaries));
    localStorage.setItem('energy_data', JSON.stringify(dailyReadings('2026-05-01', '2026-08-20')));
    await renderLoaded();

    const overview = screen.getByTestId('tab-panel-overview');
    const children = Array.from(overview.children);
    const index = (id: string) => children.indexOf(screen.getByTestId(id));
    expect(index('overview-period-heading')).toBe(0);
    expect(index('overview-key-figures')).toBe(1);
    expect(index('overview-bill-focus')).toBe(2);
    expect(index('rate-by-month')).toBe(3);
    expect(index('overview-plan-attention')).toBe(4);
    expect(index('totals-strip')).toBe(5);
    expect(index('efficiency-card')).toBe(6);
    expect(within(screen.getByTestId('overview-plan-summary')).getByTestId('best-choice-banner')).toBeInTheDocument();
  });

  it('does not render the card at all for a readings-only file', async () => {
    localStorage.setItem('energy_data', JSON.stringify(dailyReadings('2026-05-01', '2026-08-20')));
    await renderLoaded();
    expect(screen.queryByTestId('efficiency-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('efficiency-strip')).not.toBeInTheDocument();
  });
});
