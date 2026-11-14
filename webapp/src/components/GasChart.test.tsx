/**
 * The gas interval chart (t_78f788b3) — what it must prove, in four layers:
 *
 *  1. FEED SCOPE (the card's hard assertion): the gas chart files never
 *     contain the electric storage key, and the electric chart files never
 *     contain the gas one — source-scanned, not eyeballed. Behaviourally: a
 *     browser seeded with BOTH commodities shows the gas readings on the gas
 *     Analytics tab and no kWh figure anywhere on it.
 *  2. UNIT HONESTY: m³ on the Y axis, in the tooltip and in every sr-only
 *     table cell; no kWh token and no currency anywhere in the component
 *     source, and none in the painted output.
 *  3. MULTI-SERIES: the committed `69F1A08B-…`-style fixture (several volume
 *     series × daily readings + bills) flattens to every stored point,
 *     sorted by timestamp — document order is deliberately NOT time order —
 *     and two series publishing the same start stay two rows labelled
 *     "(2)", never summed into one.
 *  4. STATES + LOCALES + MOTION: data state, honest bill-only empty state,
 *     FR strings, and reduced motion rendering with `data-reduced-motion`.
 *
 * WHY EXPLICIT DIMENSIONS: jsdom gives `ResponsiveContainer` a zero-size box,
 * so through the container recharts paints nothing (measured in this card's
 * probes). `GasBarChart` is therefore rendered directly with width/height
 * for the SVG-level assertions; the panel-level tests use the default export
 * (dynamic import included) for wiring and states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GasBarChart,
  GasChartDataTable,
  GasTooltipBody,
  buildGasChartRows,
} from './GasChartPanel';
import { GasAnalyticsPanel } from './GasSection';
import Dashboard from './Dashboard';
import { parseGreenButtonFeed } from '@/lib/energy';
import { extractGasPoints } from '@/lib/commodity';
import { fmtDateLong, setLocale } from '@/i18n';
import {
  ENERGY_KEY_V2,
  ENERGY_GAS_KEY,
  GAS_SCHEMA_VERSION,
  BILLING_DAY_KEY,
} from '@/lib/storage';
import {
  USAGE_SUMMARIES_KEY,
  LOCAL_TIME_KEY,
  GAS_USAGE_SUMMARIES_KEY,
  GAS_LOCAL_TIME_KEY,
  COMMODITY_STORAGE_KEY,
} from '@/hooks/useDashboard';
import { TAB_STORAGE_KEY } from '@/lib/tabs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../tests/fixtures');

const MULTISERIES = parseGreenButtonFeed(
  fs.readFileSync(path.join(FIXTURES, 'enbridge-gas-multiseries-synthetic.xml'), 'utf8'),
);
const GAS_POINTS = extractGasPoints(MULTISERIES.groups);
const ELECTRIC_FEED = parseGreenButtonFeed(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-open-tail.xml'), 'utf8'),
);

/** First/last interval starts of the fixture's four series (UTC epochs). */
const JAN5 = 1767571200; // series A's first daily reading
const FEB1 = 1769904000; // series D's first — listed FIRST in the document

const RATES = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(RATES) }),
  );
  setLocale('en');
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  setLocale('en');
  window.history.replaceState(null, '', '/');
});

/* ================================================================== *
 * 1. Feed scope — source scan of the two charts' files
 * ================================================================== */

describe('feed scope: each chart is fed by its own key only', () => {
  // Comments discuss the rules (and name the forbidden tokens when doing
  // so) — the scans are about CODE, so strip commentary first.
  const read = (f: string) =>
    fs
      .readFileSync(path.join(HERE, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('the gas chart files never contain the electric key (nor localStorage)', () => {
    // t_a2343a2f added the monthly + year-over-year panels and the money
    // table's line disclosure — every file that renders gas figures joins
    // the scan, so isolation is source-asserted for the whole section.
    for (const f of [
      'GasChartPanel.tsx',
      'GasSection.tsx',
      'GasMonthlyPanel.tsx',
      'GasYearOverYearPanel.tsx',
      'GasMoneyTable.tsx',
    ]) {
      const src = read(f);
      expect(src, `${f} must not mention the electric storage key`).not.toMatch(
        /energy_data_v2|ENERGY_KEY_V2/,
      );
      expect(src, `${f} must not read localStorage itself`).not.toMatch(/localStorage/);
    }
  });

  it('the electricity chart files never contain the gas key', () => {
    for (const f of ['ChartView.tsx', 'BarChartPanel.tsx']) {
      const src = read(f);
      expect(src, `${f} must not mention the gas storage key`).not.toMatch(
        /energy_gas_v2|ENERGY_GAS_KEY/,
      );
    }
  });

  it('the gas chart source never offers a kWh conversion or a price', () => {
    // Every gas CHART source: kWh (any casing), a currency symbol before a
    // value, the cent sign, or the word itself — template interpolation
    // `${` is not a price. (The monthly table prints the bills' OWN stated
    // dollars through fmtMoney at runtime; the source still carries no
    // literal price and never a rate × m³ expression.)
    for (const f of ['GasChartPanel.tsx', 'GasMonthlyPanel.tsx', 'GasYearOverYearPanel.tsx']) {
      const src = read(f);
      expect(src, `${f} must not offer a kWh conversion or a price`).not.toMatch(
        /kWh|\$\s*\d|¢|price/i,
      );
    }
  });
});

/* ================================================================== *
 * 2. buildGasChartRows — sorting, slots, honesty
 * ================================================================== */

describe('buildGasChartRows', () => {
  it('the fixture flattens to every stored point, document order NOT time order', () => {
    // 4 volume series × 6 daily readings; the February series is listed
    // first in the file, so raw extract order starts at FEB1.
    expect(GAS_POINTS).toHaveLength(24);
    expect(GAS_POINTS[0].timestamp).toBe(FEB1);
    expect(GAS_POINTS[0].volume_m3).toBeCloseTo(9.8, 6);
  });

  it('sorts by timestamp and keeps one row per stored point', () => {
    const rows = buildGasChartRows(GAS_POINTS);
    expect(rows).toHaveLength(24);
    expect(rows[0].timestamp).toBe(JAN5);
    expect(rows[rows.length - 1].timestamp).toBe(FEB1 + 5 * 86400);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].timestamp, `row ${i} out of order`).toBeGreaterThanOrEqual(
        rows[i - 1].timestamp,
      );
    }
    // Volumes survive untouched: first daily reading is 8400 × 10⁻³ m³.
    expect(rows[0].volume).toBeCloseTo(8.4, 6);
  });

  it('keeps two series publishing the same start as two rows — never summed', () => {
    const rows = buildGasChartRows([
      { timestamp: JAN5, duration_s: 86400, volume_m3: 8.4 },
      { timestamp: JAN5, duration_s: 86400, volume_m3: 9.1 },
      { timestamp: JAN5 + 86400, duration_s: 86400, volume_m3: 1 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.volume)).toEqual([8.4, 9.1, 1]);
    // Same day twice → the axis slot must disambiguate, not collapse.
    expect(rows[0].label).not.toBe(rows[1].label);
    expect(rows[1].label).toContain('(2)');
    expect(rows.some((r) => r.volume === 17.5)).toBe(false);
  });

  it('drops non-finite points instead of painting a broken axis', () => {
    const rows = buildGasChartRows([
      { timestamp: JAN5, duration_s: 86400, volume_m3: Number.NaN },
      { timestamp: Number.POSITIVE_INFINITY, duration_s: null, volume_m3: 3 },
      { timestamp: JAN5 + 86400, duration_s: 86400, volume_m3: 3 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].volume).toBe(3);
  });
});

/* ================================================================== *
 * 3. The sr-only table — every plotted number, with its unit
 * ================================================================== */

describe('GasChartDataTable (the chart’s text alternative)', () => {
  it('lists every reading with m³, and never says kWh', () => {
    const rows = buildGasChartRows(GAS_POINTS);
    const { container } = render(<GasChartDataTable rows={rows} />);
    const table = container.querySelector('[data-testid="gas-chart-data-table"]');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(24);
    expect(table?.textContent).toContain('m³');
    expect(table?.textContent).toContain('8.4');
    expect(table?.textContent).not.toMatch(/kWh/i);
    expect(table?.textContent).not.toMatch(/[$€¢]/);
    // Caption + headers name the unit for screen readers.
    expect(table?.querySelector('caption')?.textContent).toBe(
      'Gas interval readings by period',
    );
  });
});

/* ================================================================== *
 * 4. The SVG itself — axis unit, one bar per reading, tooltip
 * ================================================================== */

describe('GasBarChart (explicit dimensions — jsdom has no layout)', () => {
  it('puts m³ on the Y axis and draws one bar per stored reading', () => {
    const rows = buildGasChartRows(GAS_POINTS);
    const { container } = render(<GasBarChart rows={rows} width={400} height={300} />);
    const texts = Array.from(container.querySelectorAll('svg text')).map(
      (t) => t.textContent ?? '',
    );
    expect(texts.some((s) => s.includes('Gas volume (m³)'))).toBe(true);
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(24);
    // No kWh token can ever be tick/label text.
    expect(texts.join(' ')).not.toMatch(/kWh/i);
  });

  it('shows both bars when two series published the same day', () => {
    const rows = buildGasChartRows([
      { timestamp: JAN5, duration_s: 86400, volume_m3: 8.4 },
      { timestamp: JAN5, duration_s: 86400, volume_m3: 9.1 },
    ]);
    const { container } = render(<GasBarChart rows={rows} width={400} height={300} />);
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(2);
    // The axis disambiguates rather than collapsing the two onto one x.
    expect(container.textContent).toContain('(2)');
  });

  it('tooltip body: exact date, volume, m³ — never a price, never kWh', () => {
    const [row] = buildGasChartRows(GAS_POINTS);
    render(<GasTooltipBody row={row} />);
    const tip = screen.getByTestId('gas-chart-tooltip');
    expect(tip.textContent).toContain('8.4');
    expect(tip.textContent).toContain('m³');
    expect(tip.textContent).toContain(fmtDateLong(row.timestamp * 1000));
    expect(tip.textContent).not.toMatch(/kWh/i);
    expect(tip.textContent).not.toMatch(/[$€¢]/);
  });
});

/* ================================================================== *
 * 5. Panel states — data vs the honest bill-only empty state
 * ================================================================== */

describe('GasAnalyticsPanel states', () => {
  it('data state: title, footnote with the count, and the live chart', async () => {
    render(<GasAnalyticsPanel points={GAS_POINTS} summaries={MULTISERIES.summaries} />);
    expect(screen.getByText('Gas volume by interval')).toBeInTheDocument();
    expect(screen.getByText(/24 interval readings stored/)).toBeInTheDocument();
    // The chart is a dynamic chunk — wait for it (WaveH pattern).
    const chart = await screen.findByTestId('gas-chart', undefined, { timeout: 8000 });
    expect(chart).toBeInTheDocument();
    expect(await screen.findByTestId('gas-chart-data-table')).toBeInTheDocument();
    expect(chart.getAttribute('aria-label')).toContain('24 readings in cubic metres');
  }, 15_000);

  it('empty state: bills but no volume series says so — no chart, no zero baseline', () => {
    render(<GasAnalyticsPanel points={[]} summaries={MULTISERIES.summaries} />);
    expect(screen.getByText('No interval data in this import')).toBeInTheDocument();
    expect(screen.getByTestId('gas-chart-empty')).toHaveTextContent(
      /billing periods but no interval readings for gas/,
    );
    expect(screen.queryByTestId('gas-chart')).toBeNull();
    expect(screen.queryByTestId('gas-chart-data-table')).toBeNull();
  });
});

/* ================================================================== *
 * 6. Behavioural: one browser, both commodities, no bleed
 * ================================================================== */

function seedBoth(): void {
  localStorage.clear();
  localStorage.setItem(
    ENERGY_KEY_V2,
    JSON.stringify({
      version: 2,
      uploadedAt: '2026-01-01T00:00:00Z',
      source: 'usage-summary-open-tail.xml',
      points: ELECTRIC_FEED.groups.flatMap((g) => g.readings),
    }),
  );
  localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(ELECTRIC_FEED.summaries));
  if (ELECTRIC_FEED.localTime) {
    localStorage.setItem(LOCAL_TIME_KEY, JSON.stringify(ELECTRIC_FEED.localTime));
  }
  localStorage.setItem(
    ENERGY_GAS_KEY,
    JSON.stringify({
      version: GAS_SCHEMA_VERSION,
      uploadedAt: '2026-01-01T00:00:00Z',
      source: 'enbridge-gas-multiseries-synthetic.xml',
      points: GAS_POINTS,
    }),
  );
  localStorage.setItem(GAS_USAGE_SUMMARIES_KEY, JSON.stringify(MULTISERIES.summaries));
  if (MULTISERIES.localTime) {
    localStorage.setItem(GAS_LOCAL_TIME_KEY, JSON.stringify(MULTISERIES.localTime));
  }
  localStorage.setItem(BILLING_DAY_KEY, '1');
  localStorage.setItem(COMMODITY_STORAGE_KEY, 'gas');
  localStorage.setItem(TAB_STORAGE_KEY, 'overview');
  localStorage.setItem('oeo_locale', 'en');
}

describe('a browser holding both commodities', () => {
  it('gas Analytics charts the gas readings — electric numbers never leak in', async () => {
    seedBoth();
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(
      () => expect(document.querySelector('[data-testid="dashboard-toolbar"]')).not.toBeNull(),
      { timeout: 8000 },
    );
    await user.click(screen.getByRole('tab', { name: 'Analytics' }));
    const table = await screen.findByTestId('gas-chart-data-table', undefined, {
      timeout: 8000,
    });
    // 24 gas readings, first value 8.4 m³ — the gas bucket's own contents.
    expect(table.querySelectorAll('tbody tr')).toHaveLength(24);
    expect(table.textContent).toContain('8.4');
    expect(table.textContent).toContain('m³');
    // And not one kWh figure anywhere on the painted page.
    const figures =
      ((document.body.textContent ?? '').match(/(?:\d[\d,.]*\s*kWh|¢\/kWh)/gi) ?? []);
    expect(figures, `kWh figures leaked onto the gas tab: ${figures.join(', ')}`).toEqual([]);
  }, 30_000);
});

/* ================================================================== *
 * 7. FR locale — the catalogues are parity-gated; this pins the render
 * ================================================================== */

describe('French render', () => {
  it('panel + axis carry the FR strings', async () => {
    setLocale('fr');
    render(<GasAnalyticsPanel points={GAS_POINTS} summaries={MULTISERIES.summaries} />);
    expect(screen.getByText('Volume de gaz par intervalle')).toBeInTheDocument();
    expect(screen.getByText(/jamais convertis, jamais tarifiés/)).toBeInTheDocument();
    await screen.findByTestId('gas-chart', undefined, { timeout: 8000 });
    expect(screen.getByTestId('gas-chart-data-table').textContent).toContain(
      'Relevés d\'intervalle de gaz par période',
    );

    const rows = buildGasChartRows(GAS_POINTS);
    const { container } = render(<GasBarChart rows={rows} width={400} height={300} />);
    const texts = Array.from(container.querySelectorAll('svg text')).map(
      (t) => t.textContent ?? '',
    );
    expect(texts.some((s) => s.includes('Volume de gaz (m³)'))).toBe(true);
  }, 15_000);
});

/* ================================================================== *
 * 8. Reduced motion — final-state rendering, no grow-in animation
 * ================================================================== */

describe('prefers-reduced-motion', () => {
  it('flags the chart and renders with animation off', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    render(<GasAnalyticsPanel points={GAS_POINTS} summaries={MULTISERIES.summaries} />);
    const chart = await screen.findByTestId('gas-chart', undefined, { timeout: 8000 });
    expect(chart.getAttribute('data-reduced-motion')).toBe('true');
    // Final-state geometry is present regardless (bars come from the
    // explicit-dimension path in tests; here we only pin the flag wiring).
    expect(screen.getByTestId('gas-chart-data-table')).toBeInTheDocument();
  }, 15_000);

  it('is false when the media query does not match', async () => {
    render(<GasAnalyticsPanel points={GAS_POINTS} summaries={MULTISERIES.summaries} />);
    const chart = await screen.findByTestId('gas-chart', undefined, { timeout: 8000 });
    expect(chart.getAttribute('data-reduced-motion')).toBe('false');
  }, 15_000);
});
