import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import MoneyPanel from './MoneyPanel';
import type { BillProjection } from '@/lib/billProjection';

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

describe('MoneyPanel DOM order', () => {
  it('puts bill decomposition before pace and what-if controls', () => {
    render(
      <MoneyPanel
        summaries={[]}
        allData={[]}
        filteredData={[]}
        plan="TOU"
        rates={null}
        startDate="2026-10-01"
        endDate="2026-10-14"
        projection={projection}
        openPeriod={null}
        billingDay={1}
      />,
    );
    const panel = screen.getByTestId('tab-panel-money');
    expect(Array.from(panel.children).map((child) => child.getAttribute('data-testid'))).toEqual([
      'money-decomposition-slot',
      'money-pace-slot',
      'money-true-bill-slot',
      'money-ev-slot',
    ]);
    // MoneySection is lazy-loaded; its slot still leads the live DOM before
    // the chart/pace and what-if controls hydrate.
    expect(screen.getByTestId('money-decomposition-slot')).toBe(panel.firstElementChild);
    expect(screen.getByTestId('money-pace-slot')).toContainElement(screen.getByTestId('bill-accrual'));
  });
});
