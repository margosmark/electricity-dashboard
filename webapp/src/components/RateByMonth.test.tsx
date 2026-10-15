import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProcessedPoint } from '@/lib/energy';
import RateByMonth from './RateByMonth';

const row = (date: string, kwh: number, costTOU: number) => ({
  dateObj: new Date(`${date}T12:00:00`), usage_kwh: kwh, costTOU, costTiered: costTOU * 2, costULO: costTOU * 3,
}) as ProcessedPoint;

describe('RateByMonth', () => {
  it('plots a weighted real-data monthly rate on a 0–14¢ grid with named focusable bars and table data', () => {
    render(<RateByMonth rows={[row('2026-01-03', 100, 10), row('2026-01-04', 100, 14), row('2026-02-01', 100, 12)]} plan="TOU" />);
    const bars = screen.getAllByTestId('rate-chart-bar');
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute('tabindex', '0');
    expect(bars[0]).toHaveAttribute('aria-label', expect.stringContaining('12.0'));
    expect(screen.getByTestId('rate-chart-svg')).toHaveTextContent('0');
    expect(screen.getByTestId('rate-chart-svg')).toHaveTextContent('14');
    fireEvent.focus(bars[0]);
    expect(screen.getByTestId('rate-chart-readout')).toHaveTextContent('JAN 26');
    fireEvent.click(screen.getByText(/View accessible data table/i));
    expect(screen.getByTestId('rate-chart-table').querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('renders a calm empty state without inventing values when no readings exist', () => {
    render(<RateByMonth rows={[]} plan="TOU" />);
    expect(screen.queryByTestId('rate-chart-bar')).not.toBeInTheDocument();
    expect(screen.getByText(/Import interval readings/)).toBeInTheDocument();
  });
});
