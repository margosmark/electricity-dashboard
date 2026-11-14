/**
 * The electricity panel's window caption, against a row that is not a date
 * (t_7ce07989 — the sibling of `GasSection.outOfRangeStart.test.tsx`).
 *
 * `loadEnergyData`'s `isDataPoint` accepts ANY finite `timestamp`, so a
 * payload written before the parser's interval bound existed can carry
 * `1e15`: `new Date(ts * 1000)` is then Invalid and date-fns `format()`
 * THROWS `RangeError: Invalid time value` — the caption is computed in a
 * `useMemo`, so the throw is synchronous and takes the whole panel (and the
 * tab with it) to the AppErrorBoundary.
 *
 * The guard mirrors `gasWindowLabel` and `UsagePointPicker`'s own input
 * bound: the first/last RENDERABLE row labels the span, and a dataset with
 * no renderable row degrades to the caller's fallback instead of throwing.
 * Both variants are pinned — `components/UsagePanel.tsx` and its
 * `classic/` copy each carry their own `windowLabel`.
 *
 * The rows are handed to the panel as props (this file measures the caption,
 * not the storage reader), which is also how `WaveT.test.tsx` builds them.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import UsagePanel from './UsagePanel';
import ClassicUsagePanel from './classic/UsagePanel';
import type { ChartViewProps } from './ChartView';
import type { HourlyTempsState } from '@/hooks/useHourlyTemps';
import type { StalenessResult } from '@/hooks/useRateStaleness';
import {
  buildHeatmapData,
  type Anomaly,
  type ChartDataItem,
  type ProcessedPoint,
  type RateSet,
} from '@/lib/energy';

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** Local noon: `fmtDate` reads the browser's zone, not UTC. */
const REAL_TS = new Date(2026, 0, 1, 12).getTime() / 1000;

/** The crash class: finite, but `new Date(ts * 1000)` is Invalid. */
const HOSTILE_TS = [
  1_000_000_000_000_000,
  -1_000_000_000_000_000,
  8_640_000_000_001,
  1e308,
];

function row(timestamp: number): ProcessedPoint {
  const dateObj = new Date(timestamp * 1000);
  const valid = Number.isFinite(dateObj.getTime());
  const p2 = (n: number) => String(n).padStart(2, '0');
  return {
    timestamp,
    usage_kwh: 1.5,
    dateObj,
    // The storage reader keeps a `NaN-NaN-NaN` day string for such a row;
    // build it the same way so this is the stored shape, not a invention.
    dayStr: valid
      ? `${dateObj.getFullYear()}-${p2(dateObj.getMonth() + 1)}-${p2(dateObj.getDate())}`
      : 'NaN-NaN-NaN',
    hourStr: valid ? `${p2(dateObj.getHours())}:00` : 'NaN:NaN',
    touCategory: 'Off-Peak',
    uloCategory: 'Overnight',
    isWinter: false,
    costTOU: 0.1,
    costTiered: 0.1,
    costULO: 0.1,
    activeRateSet: rateSet,
  };
}

function chartProps(filteredData: ProcessedPoint[]): ChartViewProps {
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
    startDate: '',
    filteredData,
  };
}

const temps: HourlyTempsState = {
  status: 'idle',
  temps: null,
  source: null,
  coveredHours: 0,
  spanHours: 0,
  loading: false,
};

const STALENESS: StalenessResult = { stale: null } as StalenessResult;

/** Both variants share the caption rule; both are rendered per case. */
const VARIANTS: [string, typeof UsagePanel][] = [
  ['quiet', UsagePanel],
  ['classic', ClassicUsagePanel],
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(VARIANTS)('windowLabel — a row that is not a date (%s variant)', (_name, Panel) => {
  it.each(HOSTILE_TS)('renders with a %s-second row instead of throwing RangeError', (ts) => {
    const rows = [row(ts)];
    // anomalies/heatmap are caller-built props here, so the caption is the
    // only thing in this panel that reads a timestamp.
    expect(() =>
      render(
        <Panel
          {...chartProps(rows)}
          hasData={true}
          onImport={vi.fn()}
          staleness={STALENESS}
          anomalies={[]}
          heatmapData={buildHeatmapData([])}
          processedData={rows}
          temps={temps}
        />,
      ),
    ).not.toThrow();
    // The weather card is a next/dynamic chunk; asserting it mounted is what
    // "renders its normal states" measures here (both variants carry it).
    expect(screen.getByTestId('temp-band-card')).toBeInTheDocument();
    expect(screen.getByTestId('temp-band-loading')).toBeInTheDocument();
  });

  it('still labels a healthy span that has a hostile row at one end', () => {
    const rows = [row(REAL_TS), row(1e15)];
    render(
      <Panel
        {...chartProps(rows)}
        hasData={true}
        onImport={vi.fn()}
        staleness={STALENESS}
        anomalies={[]}
        heatmapData={buildHeatmapData([])}
        processedData={rows}
        temps={temps}
      />,
    );
    // The real edge survives: the caption reaches the DOM as the loading
    // line's {span} — the renderable end labels it, not the hostile one.
    const card = screen.getByTestId('temp-band-card');
    expect(card).toBeInTheDocument();
    expect(screen.getByTestId('temp-band-loading').textContent).toContain('Jan 1, 2026');
    expect(screen.getByTestId('temp-band-loading').textContent).not.toContain('33657588');
  });

  it('every row hostile → the panel still mounts and falls back', () => {
    const rows = [row(1e15), row(-1e15)];
    render(
      <Panel
        {...chartProps(rows)}
        hasData={true}
        onImport={vi.fn()}
        staleness={STALENESS}
        anomalies={[] as Anomaly[]}
        heatmapData={buildHeatmapData([])}
        processedData={rows}
        temps={temps}
      />,
    );
    // No renderable row → the caption degrades to the shared fallback.
    expect(screen.getByTestId('temp-band-card')).toBeInTheDocument();
    expect(screen.getByTestId('temp-band-loading').textContent).toContain(
      'the dates your readings cover',
    );
    expect(screen.getByTestId('temp-band-loading').textContent).not.toContain('33657588');
  });

  it('leaves a real span captioned exactly as before', () => {
    const rows = [row(REAL_TS), row(REAL_TS + 3 * 86400)];
    render(
      <Panel
        {...chartProps(rows)}
        hasData={true}
        onImport={vi.fn()}
        staleness={STALENESS}
        anomalies={[]}
        heatmapData={buildHeatmapData(rows)}
        processedData={rows}
        temps={temps}
      />,
    );
    const loading = screen.getByTestId('temp-band-loading');
    expect(loading.textContent).toContain('Jan 1, 2026');
    expect(loading.textContent).toContain('Jan 4, 2026');
  });
});
