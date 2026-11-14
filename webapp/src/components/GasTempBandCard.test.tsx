/**
 * The gas usage-vs-temperature card (t_909aa5fa) — four layers, mirroring
 * `GasChart.test.tsx` for the chart it stands beside:
 *
 *  1. FEED SCOPE (the section's hard assertion): the card and its pure lib
 *     never contain the electric storage key, never read localStorage, and
 *     offer no kWh conversion and no price — source-scanned with the same
 *     stripped-comment rule the rest of the gas section uses.
 *  2. THE PAINTED CHART: seven bands with the report's own numbers on every
 *     bar (m³/day, days, intervals, share, mean °C), the sr-only table as
 *     the text alternative, the aria label, and the verdict sentence.
 *  3. STATES: loading while the browser asks Open-Meteo, the shared honest
 *     weather error, "nothing to band", the honest no-volume /
 *     no-interval-length states, and the two drop-counter notes.
 *  4. LOCALES: EN and FR from the catalog, parity-gated elsewhere; this pins
 *     the render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import GasTempBandCard from './GasTempBandCard';
import { GasAnalyticsPanel } from './GasSection';
import { buildGasTempBandReport, gasTempSpanRows } from '@/lib/gasTempBands';
import type { GasPoint } from '@/lib/storage';
import type { UsageSummary } from '@/lib/energy';
import { setLocale } from '@/i18n';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400;
const JAN5 = Date.UTC(2026, 0, 5) / 1000;
const JUL5 = Date.UTC(2026, 6, 5) / 1000;
const JAN1 = Date.UTC(2026, 0, 1) / 1000;

const HOUR = 3_600;
function seriesFor(spans: readonly { start: number; duration_s: number; temp: number }[]) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of spans) {
    const a = Math.floor(s.start / HOUR);
    const b = Math.floor((s.start + s.duration_s - 1) / HOUR);
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  const values: (number | null)[] = new Array<number | null>(hi - lo + 1).fill(null);
  for (const s of spans) {
    const a = Math.floor(s.start / HOUR);
    const b = Math.floor((s.start + s.duration_s - 1) / HOUR);
    for (let h = a; h <= b; h += 1) values[h - lo] = s.temp;
  }
  return { startHour: lo, values };
}

const point = (timestamp: number, volume_m3: number, duration_s: number | null = DAY): GasPoint => ({
  timestamp,
  duration_s,
  volume_m3,
});

const isoDay = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);

function bill(start: number, days: number, volumeM3: number | null): UsageSummary {
  const duration = days * DAY;
  return {
    source: 'UsageSummary',
    start,
    duration,
    startDate: isoDay(start),
    endDate: isoDay(start + duration),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null,
    volume:
      volumeM3 === null
        ? null
        : { scaled: volumeM3, value: volumeM3, powerOfTenMultiplier: 0, uom: 42 },
    items:
      volumeM3 === null
        ? [
            {
              // A gas-only note: without it the feed would not read as a
              // gas bill at all (isGasSummary), and the honest counter
              // would never see it.
              note: 'Total gas charges ($)',
              amount: 157.3,
              rawAmount: 15730,
              itemKind: null,
              unitCost: null,
              measurement: null,
            },
          ]
        : [],
  };
}

/** A painted report: one heavy cold day, one light mild day. */
function paintedReport() {
  const points = [point(JAN5, 10), point(JUL5, 1)];
  const temps = seriesFor([
    { start: JAN5, duration_s: DAY, temp: -5 },
    { start: JUL5, duration_s: DAY, temp: 15 },
  ]);
  return buildGasTempBandReport(points, [], temps);
}

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
  // Any weather request answers with the rates payload: parseOpenMeteoHourly
  // rejects it as "not weather", so the card lands on its honest error state
  // instead of a network call (the same stub the section's other tests use).
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(RATES) }),
  );
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale('en');
});

/* ================================================================== *
 * 1. Feed scope — source scan of the card and its lib
 * ================================================================== */

describe('feed scope: the temperature card is gas-fed and unit-honest', () => {
  const read = (f: string) =>
    fs
      .readFileSync(path.join(HERE, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('never contains the electric key, the gas key, or localStorage', () => {
    for (const f of ['GasTempBandCard.tsx', path.join('..', 'lib', 'gasTempBands.ts')]) {
      const src = read(f);
      expect(src, `${f} must not mention a storage key`).not.toMatch(
        /energy_data_v2|ENERGY_KEY_V2|energy_gas_v2|ENERGY_GAS_KEY/,
      );
      expect(src, `${f} must not read localStorage itself`).not.toMatch(/localStorage/);
    }
  });

  it('offers no kWh conversion and no price', () => {
    for (const f of ['GasTempBandCard.tsx', path.join('..', 'lib', 'gasTempBands.ts')]) {
      const src = read(f);
      expect(src, `${f} must not offer a kWh conversion or a price`).not.toMatch(
        /kWh|\$\s*\d|¢|price/i,
      );
    }
  });
});

/* ================================================================== *
 * 2. The painted chart
 * ================================================================== */

describe('the painted chart', () => {
  it('draws all seven bands and puts the report’s own numbers on each bar', () => {
    const report = paintedReport();
    render(
      <GasTempBandCard report={report} status="ready" loading={false} source="network" spanLabel="Jan 5, 2026 – Jul 5, 2026" />,
    );
    const bars = document.querySelectorAll('[data-testid="gas-temp-band-bar"]');
    expect(bars).toHaveLength(7);
    const cold = document.querySelector('[data-testid="gas-temp-band-bar"][data-band="-10..5"]');
    expect(cold).not.toBeNull();
    expect(cold?.getAttribute('data-mean-perday')).toBe('10.000');
    expect(cold?.getAttribute('data-days')).toBe('1.00');
    expect(cold?.getAttribute('data-intervals')).toBe('1');
    expect(cold?.getAttribute('data-mean-temp')).toBe('-5.0');
    const mild = document.querySelector('[data-testid="gas-temp-band-bar"][data-band="12..18"]');
    expect(mild?.getAttribute('data-mean-perday')).toBe('1.000');
    // Shares are the report's, rounded only for the strip label.
    expect(Number(cold?.getAttribute('data-share'))).toBeCloseTo(10 / 11, 4);
    expect(document.querySelectorAll('[data-testid="gas-temp-band-share"]')).toHaveLength(7);
  });

  it('carries the sr-only table with every plotted number and the aria label', () => {
    const report = paintedReport();
    render(
      <GasTempBandCard report={report} status="ready" loading={false} source="network" spanLabel={null} />,
    );
    const table = screen.getByTestId('gas-temp-band-table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(7);
    // −5 °C day: 1 interval, 1 day, 10.00 m³/day, −5.0 °C, 91 % of the m³.
    const coldRow = table.querySelector('tr[data-band="-10..5"]');
    expect(coldRow?.textContent).toContain('10');
    expect(coldRow?.textContent).toContain('91%');
    const plot = screen.getByTestId('gas-temp-band-plot');
    expect(plot.getAttribute('role')).toBe('img');
    expect(plot.getAttribute('aria-label')).toContain('7 bands');
    // The verdict says the ratio out loud — the picture is never the only source.
    const sentence = screen.getByTestId('gas-temp-band-sentence');
    expect(sentence.textContent).toMatch(/10\.0× as much/);
    expect(sentence.textContent).toContain('91%');
  });

  it('is flagged for reduced motion and paints with no animation to wait on', () => {
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
    render(
      <GasTempBandCard report={paintedReport()} status="ready" loading={false} source="network" spanLabel={null} />,
    );
    const plot = screen.getByTestId('gas-temp-band-plot');
    expect(plot.getAttribute('data-reduced-motion')).toBe('true');
    // Final geometry is present from the first paint (hand-drawn SVG).
    expect(document.querySelectorAll('[data-testid="gas-temp-band-bar"]')).toHaveLength(7);
  });
});

/* ================================================================== *
 * 3. States
 * ================================================================== */

describe('states', () => {
  it('loading while the browser is asking for the temperatures', () => {
    render(
      <GasTempBandCard report={paintedReport()} status="idle" loading source="cache" spanLabel="Jan 5, 2026" />,
    );
    expect(screen.getByTestId('gas-temp-band-loading').textContent).toContain('Jan 5, 2026');
    expect(document.querySelector('[data-testid="gas-temp-band-card"]')).toHaveAttribute(
      'data-status',
      'idle',
    );
  });

  it('the shared honest weather error when the fetch fails', () => {
    render(
      <GasTempBandCard report={paintedReport()} status="error" loading={false} source={null} spanLabel={null} />,
    );
    expect(screen.getByTestId('gas-temp-band-error').textContent).toContain(
      'the weather service did not answer',
    );
    expect(screen.getByTestId('gas-temp-band-card')).toHaveAttribute('data-status', 'error');
    // Footer admits the temperature is unavailable rather than going silent.
    expect(screen.getByTestId('gas-temp-band-card').textContent).toContain('unavailable');
  });

  it('"nothing to band" when no interval meets a temperature', () => {
    const report = buildGasTempBandReport([point(JAN5, 10)], [], null);
    render(
      <GasTempBandCard report={report} status="ready" loading={false} source="network" spanLabel={null} />,
    );
    expect(screen.getByTestId('gas-temp-band-empty').textContent).toContain(
      "None of this import's intervals could be matched",
    );
  });

  it('the honest no-volume state (and its interval-length variant)', () => {
    const none = buildGasTempBandReport([], [], null);
    const { unmount } = render(
      <GasTempBandCard report={none} status="idle" loading={false} source={null} spanLabel={null} />,
    );
    expect(screen.getByTestId('gas-temp-band-no-volume').textContent).toContain(
      'states no gas volume to band',
    );
    unmount();

    const noDuration = buildGasTempBandReport([point(JAN5, 10, null)], [], null);
    render(
      <GasTempBandCard report={noDuration} status="idle" loading={false} source={null} spanLabel={null} />,
    );
    expect(screen.getByTestId('gas-temp-band-no-volume').textContent).toContain(
      'state no interval length',
    );
  });

  it('names the declared source and the honest drop counters', () => {
    const interval = paintedReport();
    const { unmount } = render(
      <GasTempBandCard report={interval} status="ready" loading={false} source="network" spanLabel={null} />,
    );
    expect(screen.getByTestId('gas-temp-band-source').textContent).toContain(
      "each reading's own volume ÷ its stated interval length",
    );
    unmount();

    const bills = [bill(JAN1, 30, 300), bill(JAN1 + 30 * DAY, 30, null)];
    const billed = buildGasTempBandReport(
      [point(JUL5, 3, null)], // readings exist but state no length → billed source
      bills,
      seriesFor([{ start: JAN1, duration_s: 60 * DAY, temp: -10 }]),
    );
    expect(billed.source).toBe('billed');
    render(
      <GasTempBandCard report={billed} status="ready" loading={false} source="network" spanLabel={null} />,
    );
    expect(screen.getByTestId('gas-temp-band-source').textContent).toContain('bill-period granularity');
    expect(screen.getByTestId('gas-temp-band-skipped').textContent).toContain(
      '1 stored readings cannot be banded',
    );
    expect(screen.getByTestId('gas-temp-band-volumeless').textContent).toContain(
      '1 bills in this import state no volume',
    );
    // …and the chart itself still paints the bill periods it COULD band.
    expect(document.querySelectorAll('[data-testid="gas-temp-band-bar"]')).toHaveLength(7);
    expect(screen.getByTestId('gas-temp-band-card')).toHaveAttribute('data-band-source', 'billed');
  });
});

/* ================================================================== *
 * 4. Locales
 * ================================================================== */

describe('French render', () => {
  it('paints the FR catalog strings', () => {
    setLocale('fr');
    render(
      <GasTempBandCard report={paintedReport()} status="ready" loading={false} source="network" spanLabel={null} />,
    );
    expect(screen.getByText('Consommation de gaz vs température extérieure')).toBeInTheDocument();
    expect(screen.getByTestId('gas-temp-band-source').textContent).toContain(
      "durée d'intervalle indiquée",
    );
    const table = screen.getByTestId('gas-temp-band-table');
    expect(table.textContent).toContain('Intervalle');
    expect(table.textContent).toContain('m³/jour (moy.)');
    expect(screen.getByTestId('gas-temp-band-sentence').textContent).toContain('× plus');
  });
});

/* ================================================================== *
 * 5. Panel integration — bill-only import through GasAnalyticsPanel
 * ================================================================== */

describe('GasAnalyticsPanel feeds the card from the gas bucket', () => {
  it('a bill-only import: declared billed source, bill-period note, honest empty', async () => {
    const bills = [bill(JAN1, 30, 300), bill(JAN1 + 30 * DAY, 30, 280)];
    render(<GasAnalyticsPanel points={[]} summaries={bills} />);
    const card = await screen.findByTestId('gas-temp-band-card', undefined, { timeout: 8000 });
    expect(card).toHaveAttribute('data-band-source', 'billed');
    expect(screen.getByTestId('gas-temp-band-source').textContent).toContain(
      'No metered reading with a stated interval length',
    );
    // The fetch answered "not weather" (the rates stub) → the honest error,
    // never a chart of invented temperatures.
    expect(await screen.findByTestId('gas-temp-band-error', undefined, { timeout: 8000 })).toBeInTheDocument();
  });

  it('the temp span rows cover both edges of the chosen series', () => {
    const bills = [bill(JAN1, 30, 300)];
    expect(gasTempSpanRows([], bills)).toEqual([
      { timestamp: JAN1 },
      { timestamp: JAN1 + 30 * DAY },
    ]);
  });
});
