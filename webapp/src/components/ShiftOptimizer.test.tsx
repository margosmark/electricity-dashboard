import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ShiftOptimizer from './ShiftOptimizer';
import type { TouShiftAnalysis, ShiftBlock } from '@/lib/touShift';

function makeBlock(overrides: Partial<ShiftBlock> = {}): ShiftBlock {
  return {
    id: 'wed-12-14',
    weekday: 3,
    startHour: 12,
    endHour: 14,
    label: 'Wed 12:00–14:00',
    avgWeeklyKwh: 4.0,
    weeksSeen: 4,
    consistencyCv: 0.05,
    baselineRateCents: 20.3,
    options: [
      {
        target: 'overnight_ulo',
        label: 'Overnight (ULO 23:00–07:00)',
        destRateCents: 3.9,
        savingsCentsPerKwh: 16.4,
        monthlySavings: 2.84,
        assumption: 'Requires switching to the ULO plan and moving the load into 23:00–07:00.',
      },
      {
        target: 'weekend',
        label: 'Weekend off-peak',
        destRateCents: 9.8,
        savingsCentsPerKwh: 10.5,
        monthlySavings: 1.82,
        assumption: 'Move the activity to any weekend hour — off-peak on TOU, no plan switch.',
      },
    ],
    bestMonthlySavings: 2.84,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<TouShiftAnalysis> = {}): TouShiftAnalysis {
  return {
    blocks: [],
    totalMonthlySavings: 0,
    dataWeeks: 5,
    emptyReason: null,
    ...overrides,
  };
}

describe('ShiftOptimizer', () => {
  it('shows the honest "no recurring On-Peak blocks" empty state', () => {
    render(<ShiftOptimizer analysis={makeAnalysis({ emptyReason: 'no-recurring-onpeak' })} />);
    expect(screen.getByTestId('shift-optimizer-empty')).toBeInTheDocument();
    expect(screen.getByText(/no recurring on-peak blocks detected/i)).toBeInTheDocument();
    // Must explain WHY (3-of-5-weeks rule), not just say "nothing found"
    expect(screen.getByText(/at least 3 of 5 weeks/i)).toBeInTheDocument();
  });

  it('shows the insufficient-history empty state with the actual week count', () => {
    render(<ShiftOptimizer analysis={makeAnalysis({ emptyReason: 'insufficient-history', dataWeeks: 2 })} />);
    expect(screen.getByText(/need more history/i)).toBeInTheDocument();
    expect(screen.getByText(/covers 2 of the last 5 weeks/i)).toBeInTheDocument();
  });

  it('shows the no-data empty state', () => {
    render(<ShiftOptimizer analysis={makeAnalysis({ emptyReason: 'no-data', dataWeeks: 0 })} />);
    expect(screen.getByText(/no data to analyze/i)).toBeInTheDocument();
  });

  it('renders ranked blocks with dollar impact and the total', () => {
    const big = makeBlock({ id: 'thu-12-14', weekday: 4, label: 'Thu 12:00–14:00', bestMonthlySavings: 5.12, avgWeeklyKwh: 7.2 });
    const small = makeBlock({ bestMonthlySavings: 2.84 });
    const analysis = makeAnalysis({
      blocks: [big, small],
      totalMonthlySavings: 7.96,
      emptyReason: null,
    });
    render(<ShiftOptimizer analysis={analysis} />);

    expect(screen.getByTestId('shift-optimizer')).toBeInTheDocument();
    expect(screen.getByText(/2 recurring on-peak blocks found/i)).toBeInTheDocument();
    expect(screen.getByText('$7.96')).toBeInTheDocument();

    // Both blocks render with their labels and best-case savings
    expect(screen.getByTestId('shift-block-thu-12-14')).toBeInTheDocument();
    expect(screen.getByTestId('shift-block-wed-12-14')).toBeInTheDocument();
    expect(screen.getAllByText(/\$5\.12/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$2\.84/).length).toBeGreaterThan(0);

    // Recurrence evidence is surfaced, not hidden
    expect(screen.getAllByText(/seen in 4 of 5 weeks/).length).toBe(2);
  });

  it('renders one card per option, each with its assumption text', () => {
    render(<ShiftOptimizer analysis={makeAnalysis({ blocks: [makeBlock()], emptyReason: null })} />);
    expect(screen.getByText(/overnight \(ulo 23:00–07:00\)/i)).toBeInTheDocument();
    expect(screen.getByText(/weekend off-peak/i)).toBeInTheDocument();
    // Both assumptions visible
    expect(screen.getByText(/requires switching to the ulo plan/i)).toBeInTheDocument();
    expect(screen.getByText(/no plan switch/i)).toBeInTheDocument();
  });
});
