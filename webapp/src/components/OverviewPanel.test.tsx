import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import OverviewPanel from './OverviewPanel';
import { buildHeatmapData } from '@/lib/energy';
import type { BillProjection } from '@/lib/billProjection';
import type { EfficiencyReport } from '@/lib/statistics';
import type { HourlyTempsState } from '@/hooks/useHourlyTemps';
import type { StalenessResult } from '@/hooks/useRateStaleness';

const usage = {
  staleness: {
    checked: true,
    stale: {
      oebEffectiveDate: '2026-11-01',
      shippedEffectiveDate: '2025-11-01',
      deltas: [],
      impact: null,
      newSet: null,
    },
  } as StalenessResult,
  anomalies: [],
  heatmapData: buildHeatmapData([]),
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
  startDate: '2026-10-01',
  filteredData: [],
  hasData: false,
  onImport: vi.fn(),
};
const projection = {
  ready: false,
  emptyReason: 'no-data',
  plan: 'TOU',
  month: '2026-10',
  monthLabel: 'October 2026',
  daysIntoMonth: 14,
  daysInMonth: 31,
  monthDaysCovered: 0,
  monthToDateKwh: 0,
  monthToDateCost: 0,
  recentDays: 0,
  avgDailyKwh: 0,
  avgDailyCost: 0,
  remainingDays: 31,
  projectedKwh: 0,
  projectedCost: 0,
  dataThrough: '',
  caption: '',
  gateNote: 'No data',
} as BillProjection;

describe('Overview actionable attention items', () => {
  it('exposes a real route to the import review workflow from its own attention row', () => {
    render(
      <OverviewPanel
        comparison={null}
        userPlan="TOU"
        days={0}
        totals={null}
        costMode="yr"
        setCostMode={vi.fn()}
        reframe=""
        projection={projection}
        efficiency={{ allTime: null, inView: null, periods: [] } as unknown as EfficiencyReport}
        onOpenMoney={vi.fn()}
        onOpenPlans={vi.fn()}
        onOpenAnalytics={vi.fn()}
        importReview
        rateMismatch
        staleness={{
          checked: true,
          stale: {
            oebEffectiveDate: '2026-11-01',
            shippedEffectiveDate: '2025-11-01',
            newSet: null,
            deltas: [],
            impact: null,
          },
        }}
        latestPeriod={null}
        usage={usage}
      />,
    );
    const alert = screen.getByTestId('overview-attention');
    const control = screen.getByRole('link', { name: 'Review imports' });
    expect(alert).toContainElement(control);
    expect(control).toHaveAttribute('href', '/import');
    expect(screen.getByTestId('overview-plan-summary')).toContainElement(screen.getByRole('button', { name: 'Compare plans' }));
    expect(alert.textContent).not.toMatch(/\/api\/rates|github|editor|fix rate schedule/i);
    expect(alert.querySelector('a[href*="github"], a[href*="/api/rates"]')).toBeNull();
    const dates = screen.getByTestId('overview-rate-dates');
    expect(dates).toHaveTextContent('Ontario Energy Board rates are effective from');
    expect(dates).toHaveTextContent('this dashboard currently uses rates effective from');
    expect(dates).toHaveTextContent('2026-11-01');
    expect(dates).toHaveTextContent('2025-11-01');
  });

  it('suppresses the usage delta for a partial current month and labels a zero rate delta neutrally', () => {
    const monthlyRows = [
      ...Array.from({ length: 30 }, (_, index) => {
        const day = String(index + 1).padStart(2, '0');
        return { dayStr: `2026-09-${day}`, dateObj: new Date(`2026-09-${day}T12:00:00`), usage_kwh: 10, costTOU: 1, costTiered: 1, costULO: 1 };
      }),
      ...Array.from({ length: 6 }, (_, index) => {
        const day = String(index + 1).padStart(2, '0');
        return { dayStr: `2026-10-${day}`, dateObj: new Date(`2026-10-${day}T12:00:00`), usage_kwh: 10, costTOU: 1, costTiered: 1, costULO: 1 };
      }),
    ] as typeof usage.processedData;
    render(
      <OverviewPanel
        comparison={null}
        userPlan="TOU"
        days={36}
        totals={{ firstDate: '2026-09-01', lastDate: '2026-10-06', totalKwh: 360, costTOU: 36, costTiered: 36, costULO: 36, bestPlan: 'TOU', worstPlan: 'ULO', planDelta: 0 }}
        costMode="yr"
        setCostMode={vi.fn()}
        reframe=""
        projection={projection}
        efficiency={{ allTime: null, inView: null, periods: [] } as unknown as EfficiencyReport}
        onOpenMoney={vi.fn()}
        onOpenPlans={vi.fn()}
        onOpenAnalytics={vi.fn()}
        importReview={false}
        latestPeriod={null}
        usage={{ ...usage, processedData: monthlyRows, hasData: true }}
      />,
    );
    expect(screen.queryByText(/lower than last month/i)).not.toBeInTheDocument();
    expect(screen.getByText('No material change from last month')).toBeInTheDocument();
  });
});
