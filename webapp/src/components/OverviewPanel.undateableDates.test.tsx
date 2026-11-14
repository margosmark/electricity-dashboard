/**
 * The Overview heading and the billing-axis caption over undateable
 * instants — F2 + F3 of t_bcc1b9c6, at RENDER (not just at storage):
 *
 *  F2 — `calculateFullDataTotals` is fed unfiltered `processedData`, so a
 *       hostile row lands a `NaN-NaN-NaN` day key in `totals.firstDate` /
 *       `totals.lastDate`. The formatters are the unguarded half: date-fns
 *       `format()` on `new Date('NaN-NaN-NANT00:00:00')` throws
 *       `RangeError: Invalid time value` (dateSpan.ts:33 and freshness.ts:60
 *       already NaN-guard the same keys — the render sites did not).
 *  F3 — `assertBillPeriodStart` is ceiling-only, so a fresh negative bill
 *       start parses clean; `billedPeriodOf` then stamps `endDate` as
 *       `NaN-NaN-NaN` (truthy!) and `billPeriodLabel` composes
 *       `"undefined NaN, NaN – undefined NaN"`. `headingDate` prefers that
 *       truthy garbage and throws at the heading.
 *
 * Both signs and all five `HOSTILE_STARTS` shapes of
 * `GasSection.outOfRangeStart.test.tsx`, through the REAL chain:
 * `processRawData → calculateFullDataTotals` for F2 and
 * `buildBillingAxis → Dashboard's own open ?? at(-1)` pick for F3.
 *
 * RED control: revert the heading/day-key guards in `OverviewPanel.tsx` +
 * `billPeriodLabel`'s date check in `energy.ts` and every case fails with
 * `RangeError: Invalid time value` (the render throws before any
 * assertion). Reverting only `billPeriodLabel` fails the no-garbage text
 * assertion with the hostile caption quoted instead.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import OverviewPanel from './OverviewPanel';
import ClassicOverviewPanel from './classic/OverviewPanel';
import { calculateFullDataTotals, processRawData } from '@/lib/energy';
import type {
  DataPoint, FullDataTotals, RateSet, UsageSummary,
} from '@/lib/energy';
import { buildBillingAxis, type AxisPeriod } from '@/lib/billingAxis';
import { setLocale } from '@/i18n';
import type { BillProjection } from '@/lib/billProjection';
import type { EfficiencyReport } from '@/lib/statistics';
import type { HourlyTempsState } from '@/hooks/useHourlyTemps';
import type { StalenessResult } from '@/hooks/useRateStaleness';

/**
 * The five shapes `GasSection.outOfRangeStart.test.tsx` pins — every one a
 * finite number whose `new Date(ts * 1000)` is Invalid, both signs.
 */
const HOSTILE_STARTS = [
  1_000_000_000_000_000,
  -1_000_000_000_000_000,
  8_640_000_000_001,
  Number.MAX_SAFE_INTEGER,
  1e308,
];

/** 2026-01-01T00:00:00Z — the one healthy reading every dataset holds. */
const HEALTHY: DataPoint = { timestamp: 1_767_286_800, usage_kwh: 2 };
const DAY = 86_400;

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** F2: totals through the real pricing chain, hostile row and all. */
const totalsFor = (ts: number): FullDataTotals => {
  const totals = calculateFullDataTotals(
    processRawData([{ timestamp: ts, usage_kwh: 1.5 }, HEALTHY], [RATES]),
  );
  expect(totals).not.toBeNull();
  return totals!;
};

/** F3: a stated bill at `start`, shaped like the parser's own output. */
function bill(start: number, days = 31): UsageSummary {
  const duration = days * DAY;
  const dayKey = (ts: number): string => {
    const d = new Date(ts * 1000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  };
  return {
    source: 'UsageSummary',
    start,
    duration,
    startDate: dayKey(start),
    endDate: dayKey(start + duration),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null,
    volume: { scaled: 300, value: 300, powerOfTenMultiplier: 0, uom: 42 },
    items: [],
  };
}

const usage = {
  staleness: { checked: true, stale: null } as unknown as StalenessResult,
  anomalies: [],
  heatmapData: { grid: [], maxAvg: 0 },
  processedData: [],
  temps: { status: 'idle', loading: false, source: 'none', temps: new Map() } as unknown as HourlyTempsState,
  zoomLevel: 'monthly' as const,
  zoomTarget: null,
  goBack: vi.fn(),
  navigatePeriod: vi.fn(),
  setZoomLevelAndClear: vi.fn(),
  activeChartData: [],
  handleBarClick: vi.fn(),
  selectionCost: 0,
  userPlan: 'TOU' as const,
  startDate: '2026-01-01',
  filteredData: [],
  hasData: false,
  onImport: vi.fn(),
};

const projection = {
  ready: false,
  emptyReason: 'no-data',
  plan: 'TOU',
  month: '2026-01',
  monthLabel: 'January 2026',
  daysIntoMonth: 10,
  daysInMonth: 31,
  monthDaysCovered: 0,
  monthToDateKwh: 0,
  monthToDateCost: 0,
  recentDays: 0,
  avgDailyKwh: 0,
  avgDailyCost: 0,
  remainingDays: 21,
  projectedKwh: 0,
  projectedCost: 0,
  dataThrough: '',
  caption: '',
  gateNote: 'No data',
} as BillProjection;

const efficiency = { allTime: null, inView: null, periods: [] } as unknown as EfficiencyReport;

const modernProps = {
  comparison: null,
  userPlan: 'TOU' as const,
  days: 1,
  costMode: 'yr' as const,
  setCostMode: vi.fn(),
  reframe: '',
  projection,
  efficiency,
  onOpenMoney: vi.fn(),
  onOpenPlans: vi.fn(),
  onOpenAnalytics: vi.fn(),
  importReview: false,
  usage,
  showUsage: false,
};

const classicProps = {
  comparison: null,
  userPlan: 'TOU' as const,
  days: 1,
  costMode: 'yr' as const,
  setCostMode: vi.fn(),
  reframe: '',
  projection,
  efficiency,
  onOpenMoney: vi.fn(),
};

/** No `NaN` / `undefined` may reach the painted text of either panel. */
const expectCleanText = (container: HTMLElement) => {
  const text = container.textContent ?? '';
  expect(text).not.toContain('NaN');
  expect(text).not.toContain('undefined');
};

beforeEach(() => setLocale('en'));
afterEach(() => cleanup());

describe('F2 — totals whose first/last day key is not a date', () => {
  it.each(HOSTILE_STARTS)('modern Overview with totals holding %s renders clean', (ts) => {
    const { container } = render(<OverviewPanel {...modernProps} totals={totalsFor(ts)} latestPeriod={null} />);
    expectCleanText(container);
    expect(screen.getByTestId('overview-period-heading')).toBeInTheDocument();
  });

  it.each(HOSTILE_STARTS)('classic Overview with totals holding %s renders clean', (ts) => {
    const { container } = render(<ClassicOverviewPanel {...classicProps} totals={totalsFor(ts)} />);
    expectCleanText(container);
    expect(screen.getByTestId('totals-strip')).toBeInTheDocument();
  });

  it.each(HOSTILE_STARTS)('modern Overview with totals holding %s and a healthy axis period renders clean', (ts) => {
    // The in-app shape: Dashboard always has a period when rows exist
    // (axis.open ?? at(-1)), so the heading survives on that period's end
    // and the crash lands on the dataAsOf / wholeDataset sites instead
    // (OverviewPanel.tsx:170/455/471, and :282 for the negative sign).
    const healthyAxis = buildBillingAxis({ summaries: [bill(1_767_225_600)], rows: [], billingDay: 1 });
    const latestPeriod = healthyAxis.open ?? healthyAxis.periods.at(-1) ?? null;
    expect(latestPeriod).not.toBeNull();
    const { container } = render(<OverviewPanel {...modernProps} totals={totalsFor(ts)} latestPeriod={latestPeriod} />);
    expectCleanText(container);
    expect(screen.getByTestId('overview-period-heading').textContent).toMatch(/\d{4}/);
  });

  it('control: healthy totals still paint the real dates', () => {
    const { container } = render(<OverviewPanel {...modernProps} totals={totalsFor(HEALTHY.timestamp)} latestPeriod={null} />);
    expectCleanText(container);
    // 2026-01-01T00:00:00Z reads as Dec 31, 2025 in this machine's zone.
    expect(screen.getByTestId('overview-period-heading').textContent).toMatch(/\d{4}/);
  });
});

describe('F3 — a billed period whose start is not a date', () => {
  it.each(HOSTILE_STARTS)('the axis period at %s renders the heading clean', (ts) => {
    const axis = buildBillingAxis({ summaries: [bill(ts)], rows: [], billingDay: 1 });
    // Dashboard.tsx:901's own pick: the open tail, else the newest period.
    const latestPeriod: AxisPeriod | null = axis.open ?? axis.periods.at(-1) ?? null;
    expect(latestPeriod).not.toBeNull();

    // Render FIRST: the control must fail with the heading's RangeError,
    // not on a later assertion.
    const { container } = render(
      <OverviewPanel {...modernProps} totals={totalsFor(HEALTHY.timestamp)} latestPeriod={latestPeriod} />,
    );
    expectCleanText(container);
    expect(screen.getByTestId('overview-period-heading').textContent).toMatch(/\d{4}/);

    // The axis caption itself must not compose "undefined NaN, NaN".
    // (startDate/endDate are STRUCTURAL day keys — they feed dateWindowOf's
    // window, never a formatter; the heading above proves they no longer
    // reach the screen. Their residual text exposure is posted as a finding
    // on t_bcc1b9c6, outside this card's F1–F5.)
    const captions = axis.periods.map((p) => `${p.label} ${p.shortLabel}`).join(' ');
    expect(captions).not.toMatch(/NaN|undefined/);
  });

  it('control: a healthy bill still captions its period', () => {
    const axis = buildBillingAxis({ summaries: [bill(1_767_225_600)], rows: [], billingDay: 1 });
    const latestPeriod = axis.open ?? axis.periods.at(-1) ?? null;
    expect(latestPeriod).not.toBeNull();
    expect(latestPeriod!.label).toMatch(/\w/);
    expect(latestPeriod!.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});