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
    return {
      start: Date.UTC(2024, i, 1) / 1000,
      startDate,
      endDate,
      label: startDate,
      kwh: 1000,
      cost: cents * 10,
      cents,
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
    expect(chip.className).toContain('bg-emerald-400');
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
    expect(screen.getByText('Winter')).toBeInTheDocument();
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

    const inView = within(block).getByTestId('efficiency-in-view');
    expect(Number(inView.getAttribute('data-cents'))).toBeGreaterThan(0);
    expect(Number(inView.getAttribute('data-bills'))).toBeGreaterThanOrEqual(1);
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
    // Three bills: the stat stands, the verdict waits.
    expect(within(card).getByTestId('efficiency-trend-empty')).toHaveTextContent(
      'at least 4 closed bills',
    );
  });

  it('keeps the decision-first order: banner first, card after the strip', async () => {
    localStorage.setItem('usage_summaries', JSON.stringify(summaries));
    localStorage.setItem('energy_data', JSON.stringify(dailyReadings('2026-05-01', '2026-08-20')));
    await renderLoaded();

    const overview = screen.getByTestId('tab-panel-overview');
    const children = Array.from(overview.children);
    const index = (id: string) => children.indexOf(screen.getByTestId(id));
    expect(index('best-choice-banner')).toBe(0);
    expect(index('totals-strip')).toBe(1);
    expect(index('efficiency-card')).toBe(2);
  });

  it('does not render the card at all for a readings-only file', async () => {
    localStorage.setItem('energy_data', JSON.stringify(dailyReadings('2026-05-01', '2026-08-20')));
    await renderLoaded();
    expect(screen.queryByTestId('efficiency-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('efficiency-strip')).not.toBeInTheDocument();
  });
});
