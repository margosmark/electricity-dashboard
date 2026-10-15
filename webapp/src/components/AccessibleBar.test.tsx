import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccessibleBar, ChartDataTable } from './BarChartPanel';

describe('accessible chart bars', () => {
  it('renders the mark as a keyboard-focusable named SVG group', () => {
    const onActivate = vi.fn();
    const { container } = render(
      <svg>
        <AccessibleBar
          x={2}
          y={3}
          width={12}
          height={24}
          fill="#2563eb"
          payload={{ key: '2026-01-01', label: 'Jan 1', usage: 1.25, costTOU: 1, costTiered: 2, costULO: 3 }}
          onActivate={onActivate}
        />
      </svg>,
    );
    const bar = screen.getByRole('button', { name: /Jan 1.*1\.25/ });
    expect(bar.tagName.toLowerCase()).toBe('g');
    expect(bar).toHaveAttribute('tabindex', '0');
    expect(bar).toContainElement(container.querySelector('rect'));
    fireEvent.keyDown(bar, { key: 'Enter' });
    fireEvent.keyDown(bar, { key: ' ' });
    fireEvent.click(bar);
    expect(onActivate).toHaveBeenCalledTimes(3);
    expect(onActivate).toHaveBeenLastCalledWith({ key: '2026-01-01' });
  });
});

describe('usage chart companion table', () => {
  it('publishes every plotted period and plan cost outside the SVG', () => {
    render(<ChartDataTable data={[
      { key: '2026-01-01', label: 'Jan 1', usage: 1.25, costTOU: 1, costTiered: 2, costULO: 3 },
    ]} />);
    const table = screen.getByTestId('chart-data-table');
    expect(table).toHaveTextContent('Usage chart data by period');
    expect(table).toHaveTextContent('Jan 1');
    expect(table).toHaveTextContent('1.25 kWh');
    expect(table).toHaveTextContent('$1.00');
    expect(table).toHaveTextContent('$2.00');
    expect(table).toHaveTextContent('$3.00');
  });
});
