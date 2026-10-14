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

describe('Overview actionable import alert', () => {
  it('exposes a real route to the import review workflow', () => {
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
        importReview
        usage={usage}
      />,
    );
    const alert = screen.getByTestId('overview-import-alert');
    const control = screen.getByRole('link', { name: 'Review imports' });
    expect(alert).toContainElement(control);
    expect(control).toHaveAttribute('href', '/import');
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Fix rate schedule' })).toHaveAttribute(
      'href',
      'https://github.com/margosmark/electricity-dashboard/edit/main/webapp/src/app/api/rates/route.ts',
    );
  });
});
