/**
 * Wave T — the three new slices in the DOM.
 *
 * The lib tests own the arithmetic; this file owns the contract between the
 * numbers and what a person (or the browser check) can read off the screen:
 * that the temperature card draws all seven bins with their numbers attached,
 * that an anomaly card carries the weather verdict computed with its
 * detection, that the delivery decomposition prints its split — or its
 * refusal — with the figures that earned it, and that every one of those
 * surfaces degrades honestly when there is no weather to show.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import UsagePanel from './UsagePanel';
import TempBandCard from './TempBandCard';
import { ActualBillPanel } from './ActualBillPanel';
import type { ChartViewProps } from './ChartView';
import type { HourlyTempsState } from '@/hooks/useHourlyTemps';
import type { StalenessResult } from '@/hooks/useRateStaleness';
import {
  billTotals,
  buildHeatmapData,
  detectAnomalies,
  parseUsageSummaries,
  type Anomaly,
  type ChartDataItem,
  type ProcessedPoint,
  type RateSet,
} from '@/lib/energy';
import type { HourlyTemps } from '@/lib/openMeteo';
import { buildTempBandReport } from '@/lib/tempBands';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const summaries = parseUsageSummaries(fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'));

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** An hour of readings from `startHour`, one per hour, at a flat `kwh`. */
function dayOf(startHour: number, hours: number, kwh: number, cost = kwh * 0.1): ProcessedPoint[] {
  return Array.from({ length: hours }, (_, i) => {
    const timestamp = (startHour + i) * 3600;
    const dateObj = new Date(timestamp * 1000);
    return {
      timestamp,
      usage_kwh: kwh,
      dateObj,
      dayStr: dateObj.toISOString().slice(0, 10),
      hourStr: `${String(dateObj.getUTCHours()).padStart(2, '0')}:00`,
      touCategory: 'Off-Peak',
      uloCategory: 'Overnight',
      isWinter: false,
      costTOU: cost,
      costTiered: cost,
      costULO: cost,
      activeRateSet: rateSet,
    };
  });
}

const series = (startHour: number, temps: (number | null)[]): HourlyTemps => ({ startHour, values: temps });

/** 48 hours: a cold morning and a hot afternoon, 1 kWh each. */
const HOUR_0 = 1_780_000;
const rows = dayOf(HOUR_0, 48, 1, 0.1);
const temps = series(HOUR_0, [
  ...Array.from({ length: 24 }, () => -3),
  ...Array.from({ length: 24 }, () => 29),
]);

const STALENESS: StalenessResult = { stale: null } as StalenessResult;

function chartProps(over: Partial<ChartViewProps> = {}): ChartViewProps {
  return {
    zoomLevel: 'daily',
    zoomTarget: null,
    goBack: vi.fn(),
    navigatePeriod: vi.fn(),
    setZoomLevelAndClear: vi.fn(),
    activeChartData: [] as ChartDataItem[],
    handleBarClick: vi.fn(),
    selectionCost: 12.34,
    userPlan: 'TOU',
    startDate: '2026-05-25',
    filteredData: rows,
    ...over,
  };
}

function tempsState(over: Partial<HourlyTempsState> = {}): HourlyTempsState {
  return {
    status: 'ready',
    temps,
    source: 'network',
    coveredHours: 48,
    spanHours: 48,
    loading: false,
    ...over,
  };
}

afterEach(cleanup);

/* ================================================== the temperature card == */

describe('TempBandCard', () => {
  const report = buildTempBandReport(rows, temps, 'TOU');

  it('draws all seven bins with the numbers the audit reads back', () => {
    render(<TempBandCard report={report} status="ready" loading={false} source="network" spanLabel="Jan 1 – Jan 3, 2026" />);
    const bars = screen.getAllByTestId('temp-band-bar');
    expect(bars).toHaveLength(7);
    expect(bars.map((b) => b.getAttribute('data-band'))).toEqual([
      'lt-10', '-10..5', '5..12', '12..18', '18..24', '24..30', 'gt-30',
    ]);
    // Two bins are populated — the -3 °C hours and the 29 °C ones — each at
    // 1.000 kWh/h and 10.00 ¢/kWh, and each carrying half the window's kWh.
    const cold = bars[1]; // -10..5
    const hot = bars[5]; // 24..30
    expect(cold.getAttribute('data-hours')).toBe('24');
    expect(cold.getAttribute('data-mean-kwh')).toBe('1.000');
    expect(cold.getAttribute('data-cents')).toBe('10.00');
    expect(cold.getAttribute('data-share')).toBe('0.5000');
    expect(hot.getAttribute('data-hours')).toBe('24');
    expect(hot.getAttribute('data-mean-temp')).toBe('29.0');
    expect(bars[0].getAttribute('data-hours')).toBe('0');
    expect(bars[6].getAttribute('data-hours')).toBe('0');

    // The share strip is drawn for every bin, populated or not.
    expect(screen.getAllByTestId('temp-band-share')).toHaveLength(7);
    expect(screen.getByTestId('temp-band-card')).toHaveAttribute('data-matched', '48');
    expect(screen.getByTestId('temp-band-card')).toHaveAttribute('data-total', '48');
  });

  it('states the comparison in words, not only in bars', () => {
    render(<TempBandCard report={report} status="ready" loading={false} source="network" />);
    const sentence = screen.getByTestId('temp-band-sentence').textContent!;
    expect(sentence).toContain('-10 to 5');
    expect(sentence).toContain('kWh/h');
    expect(sentence).toContain('50%');
  });

  it('says the weather came from a CDN fetch this browser made', () => {
    render(<TempBandCard report={report} status="ready" loading={false} source="cache" spanLabel="Jan 1, 2026" />);
    const card = screen.getByTestId('temp-band-card');
    expect(card).toHaveAttribute('data-source', 'cache');
    expect(card.textContent).toContain('Open-Meteo');
    expect(card.textContent).toContain('No server saw this request');
    expect(card.textContent).toContain('All 48 hours matched');
  });

  it('reports a PARTIAL match as partial', () => {
    const partial = buildTempBandReport(rows, series(HOUR_0, [...temps.values.slice(0, 40), ...Array.from({ length: 8 }, () => null)]), 'TOU');
    render(<TempBandCard report={partial} status="ready" loading={false} source="network" />);
    expect(screen.getByTestId('temp-band-card').textContent).toContain('40 of 48 hours matched');
    expect(screen.getByTestId('temp-band-card').textContent).toContain('left out of the averages');
  });

  it('asks, then says nothing — instead of drawing a fake flat winter', () => {
    const { rerender } = render(
      <TempBandCard report={report} status="idle" loading source={null} spanLabel="Jan 1, 2026" />,
    );
    expect(screen.getByTestId('temp-band-loading').textContent).toContain('Asking Open-Meteo');
    expect(screen.queryByTestId('temp-band-chart')).not.toBeInTheDocument();

    rerender(<TempBandCard report={report} status="error" loading={false} source={null} />);
    expect(screen.getByTestId('temp-band-error').textContent).toContain('No temperature data');
    expect(screen.queryByTestId('temp-band-chart')).not.toBeInTheDocument();

    const empty = buildTempBandReport(rows, null, 'TOU');
    rerender(<TempBandCard report={empty} status="ready" loading={false} source="network" />);
    expect(screen.getByTestId('temp-band-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('temp-band-chart')).not.toBeInTheDocument();
  });
});

/* ================================================ the anomaly context line = */

/** A spike day of 5 readings whose total beats the flat week around it. */
function anomalyRows(spikeHour: number): ProcessedPoint[] {
  const flat = Array.from({ length: 7 }, (_, d) => dayOf(spikeHour - (7 - d) * 24, 24, 5));
  const spike = dayOf(spikeHour, 5, 10);
  return [...flat.flat(), ...spike];
}

const heatmap = buildHeatmapData(anomalyRows(HOUR_0 + 24 * 8));

function panelAnomalies(spikeHour: number, hourly: HourlyTemps | null): Anomaly[] {
  const all = anomalyRows(spikeHour);
  return detectAnomalies(all, all, hourly);
}

describe('the anomaly card\u2019s weather line', () => {
  const spikeHour = HOUR_0 + 24 * 8;

  it('prints the verdict that was computed with the detection', () => {
    const hot = panelAnomalies(spikeHour, series(spikeHour, [21, 24, 28, 31, 27]));
    expect(hot.length).toBeGreaterThan(0);
    render(
      <UsagePanel
        {...chartProps()}
        hasData={true}
        onImport={vi.fn()}
        staleness={STALENESS}
        anomalies={hot}
        heatmapData={heatmap}
        processedData={[]}
        temps={tempsState({ temps: series(spikeHour, [21, 24, 28, 31, 27]) })}
      />,
    );
    const line = screen.getByTestId('anomaly-context-0');
    expect(line.textContent).toBe('31°C — that’s AC');
    expect(line).toHaveAttribute('data-kind', 'ac');
    expect(line).toHaveAttribute('data-temp', '31');
  });

  it('says "no data" — and nothing invented — when no temperatures were loaded', () => {
    const cold = panelAnomalies(spikeHour, null);
    render(
      <UsagePanel
        {...chartProps()}
        hasData={true}
        onImport={vi.fn()}
        staleness={STALENESS}
        anomalies={cold}
        heatmapData={heatmap}
        processedData={[]}
        temps={tempsState({ status: 'error', temps: null, source: null, coveredHours: 0 })}
      />,
    );
    const line = screen.getByTestId('anomaly-context-0');
    expect(line.textContent).toBe('no data');
    expect(line).toHaveAttribute('data-kind', 'unknown');
    expect(line).toHaveAttribute('data-temp', '');
    // The temperature card is on the same tab and is equally honest.
    expect(screen.getByTestId('temp-band-card')).toHaveAttribute('data-status', 'error');
  });

  it('keeps the existing card layout — the context is one more line in the same box', () => {
    const hot = panelAnomalies(spikeHour, series(spikeHour, [21, 24, 28, 31, 27]));
    render(
      <UsagePanel
        {...chartProps()}
        hasData={true}
        onImport={vi.fn()}
        staleness={STALENESS}
        anomalies={hot}
        heatmapData={heatmap}
        processedData={[]}
        temps={tempsState()}
      />,
    );
    const card = screen.getByTestId('anomaly-context-0').parentElement!;
    expect(card).toContainElement(screen.getByTestId('anomaly-signature-0'));
    expect(card.textContent).toContain('kWh');
    expect(card.textContent).toContain('% vs average');
  });
});

/* ============================================== the delivery decomposition = */

describe('the fixed-vs-usage decomposition on the Money tab', () => {
  it('prints the split, and the figures that earned it', () => {
    render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    const card = screen.getByTestId('charge-decomposition-delivery');
    expect(card).toHaveAttribute('data-status', 'split');
    expect(card).toHaveAttribute('data-periods', '3');
    const amount = billTotals(summaries[summaries.length - 1]).delivery;
    expect(card).toHaveAttribute('data-amount', amount.toFixed(2));
    const headline = screen.getByTestId('decomposition-headline-delivery').textContent!;
    expect(headline).toContain(`Of your $${amount.toFixed(2)} delivery this period`);
    expect(headline).toContain('is fixed (you\u2019d pay it at 0 kWh)'.replace('\u2019', "'"));
    expect(headline).toContain('is volume-driven');
    expect(Number(card.getAttribute('data-fixed')) + Number(card.getAttribute('data-variable')))
      .toBeCloseTo(amount, 2);
    expect(card.textContent).toContain('billing periods');
  });

  it('gives regulatory the same card, under its own name', () => {
    render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    const card = screen.getByTestId('charge-decomposition-regulatory');
    expect(screen.getByTestId('decomposition-headline-regulatory').textContent).toContain('Regulatory charges');
    expect(card).toHaveAttribute(
      'data-amount',
      billTotals(summaries[summaries.length - 1]).regulatory.toFixed(2),
    );
  });

  it('renders NOTHING when the file carried no bill', () => {
    const { container } = render(<ActualBillPanel summaries={[]} allData={[]} plan="TOU" />);
    expect(container).toBeEmptyDOMElement();
  });
});
