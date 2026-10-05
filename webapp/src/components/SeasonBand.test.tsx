/**
 * Wave G item 6 — the season band and the season-aware tier threshold.
 *
 * The band's geometry lives in src/lib/season.test.ts (pure data, boundaries
 * pinned); this file checks it reaches the user: chips under the chart that
 * name the window(s), shading when the labels allow it, and the Tiered card
 * naming which seasonal threshold is in force.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import ChartView, { type ChartViewProps } from './ChartView';
import { type ChartDataItem, type ProcessedPoint, type RateSet } from '@/lib/energy';
import type { BillProjection } from '@/lib/billProjection';
import type { ReactNode, ReactElement } from 'react';

/**
 * jsdom gives ResponsiveContainer a 0x0 box, so recharts renders nothing at
 * all — no axes, no bars, no bands. Hand the chart a real size so the
 * ReferenceArea bands are actually built and assertable.
 */
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  const { cloneElement, isValidElement } = await import('react');
  const ResponsiveContainer = ({ children }: { children?: ReactNode }) => (
    <div style={{ width: 640, height: 400 }}>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, { width: 640, height: 400 })
        : children}
    </div>
  );
  return { ...actual, ResponsiveContainer };
});

vi.mock('@/components/BillProjectionBanner', () => ({ default: () => null }));
vi.mock('@/components/TrueBillEstimate', () => ({ TrueBillEstimate: () => null }));
vi.mock('@/components/ExportCsvButton', () => ({ ExportCsvButton: () => null }));

const RATE: RateSet = {
  effectiveDate: '2026-01-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

const bar = (key: string): ChartDataItem => ({
  key,
  label: key.slice(5), // '04-28' style — unique within a year
  usage: 3,
  costTOU: 0.5,
  costTiered: 0.6,
  costULO: 0.7,
});

const row = (isWinter: boolean): ProcessedPoint[] =>
  [{ timestamp: 1, usage_kwh: 3, isWinter }] as ProcessedPoint[];

function props(over: Partial<ChartViewProps>): ChartViewProps {
  return {
    zoomLevel: 'daily',
    zoomTarget: null,
    goBack: vi.fn(),
    navigatePeriod: vi.fn(),
    setZoomLevelAndClear: vi.fn(),
    activeChartData: [],
    handleBarClick: vi.fn(),
    selectionCost: 12.34,
    userPlan: 'TOU',
    setUserPlan: vi.fn(),
    comparison: { TOU: 10, Tiered: 11, ULO: 12 },
    activeRateSet: RATE,
    filteredData: [],
    startDate: '2026-04-28',
    endDate: '2026-05-03',
    projection: {} as BillProjection,
    wfh: null,
    ...over,
  };
}

afterEach(cleanup);

const chips = () => screen.queryAllByTestId('season-chip').map((c) => c.textContent || '');

describe('season band chips', () => {
  it('shows one chip naming the window when the chart sits inside one season', () => {
    render(<ChartView {...props({
      activeChartData: [bar('2026-07-01'), bar('2026-07-02'), bar('2026-07-03')],
      filteredData: row(false),
      startDate: '2026-07-01',
      endDate: '2026-07-03',
    })} />);
    const labels = chips();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/Summer · May 1 – Oct 31/);
  });

  it('shows BOTH windows when the chart crosses May 1', () => {
    render(<ChartView {...props({
      activeChartData: [
        bar('2026-04-28'), bar('2026-04-29'), bar('2026-04-30'),
        bar('2026-05-01'), bar('2026-05-02'), bar('2026-05-03'),
      ],
      filteredData: row(false),
    })} />);
    const labels = chips();
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/Winter · Nov 1 – Apr 30 · 3 bars/);
    expect(labels[1]).toMatch(/Summer · May 1 – Oct 31 · 3 bars/);
  });

  it('shows both windows when the chart crosses Nov 1', () => {
    render(<ChartView {...props({
      activeChartData: [bar('2026-10-31'), bar('2026-11-01')],
      filteredData: row(true),
      startDate: '2026-10-31',
      endDate: '2026-11-01',
    })} />);
    const labels = chips();
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/Summer/);
    expect(labels[1]).toMatch(/Winter/);
  });

  it('renders a ReferenceArea band per season over the bars', async () => {
    render(<ChartView {...props({
      activeChartData: [bar('2026-04-30'), bar('2026-05-01')],
      filteredData: row(false),
    })} />);
    // The bars moved behind `next/dynamic` in Wave I (recharts only ships when
    // there is something to draw), so the panel arrives on its own chunk — wait
    // for it instead of asserting on the first synchronous render.
    await waitFor(() => {
      // ResponsiveContainer is 0x0 in jsdom; recharts still builds the layer, so
      // if this ever stops rendering the browser check in evidence/ is the backstop.
      expect(document.querySelectorAll('.recharts-reference-area').length).toBeGreaterThan(0);
    }, { timeout: 5000 });
  });
});

describe('season-aware tier threshold', () => {
  it('names the summer threshold when the window ends in summer', () => {
    render(<ChartView {...props({
      activeChartData: [bar('2026-04-30'), bar('2026-05-01')],
      filteredData: row(false), // most recent reading is summer
    })} />);
    const t = screen.getByTestId('tier-threshold');
    expect(t).toHaveTextContent('Tier 1 cut-off');
    expect(t).toHaveTextContent('600 kWh/mo');
    expect(t).toHaveTextContent(/Summer rate window \(May 1 – Oct 31\)/);
    expect(t).toHaveTextContent(/window spans both seasons/);
    expect(t).toHaveTextContent('other window: 1,000 kWh/mo');
  });

  it('names the winter threshold when the window ends in winter', () => {
    render(<ChartView {...props({
      activeChartData: [bar('2026-01-15'), bar('2026-01-16')],
      filteredData: row(true),
      startDate: '2026-01-15',
      endDate: '2026-01-16',
    })} />);
    const t = screen.getByTestId('tier-threshold');
    expect(t).toHaveTextContent('1,000 kWh/mo');
    expect(t).toHaveTextContent(/Winter rate window \(Nov 1 – Apr 30\)/);
    expect(t).toHaveTextContent('other window: 600 kWh/mo');
    expect(t).not.toHaveTextContent(/spans both/);
  });

  it('falls back to the season in view when there are no rows', () => {
    render(<ChartView {...props({
      activeChartData: [bar('2026-01-15')],
      filteredData: [],
      startDate: '2026-01-15',
      endDate: '2026-01-15',
    })} />);
    expect(screen.getByTestId('tier-threshold')).toHaveTextContent('1,000 kWh/mo');
  });
});
