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

  it('floors the group hit box at 44×44 without inflating the painted mark', () => {
    // The exact geometry quiet-meter-regression:677 measured failing at
    // origin/main: a 100×42 bar at 390 light ("targets under 44px").
    const { container } = render(
      <svg>
        <AccessibleBar
          x={93}
          y={4598}
          width={100}
          height={42}
          fill="#2563eb"
          payload={{ key: '2026-01-01', label: 'Jan 1', usage: 1.25, costTOU: 1, costTiered: 2, costULO: 3 }}
          onActivate={vi.fn()}
        />
      </svg>,
    );
    const bar = container.querySelector('g[role="button"]')!;
    const rects = bar.querySelectorAll('rect');
    // jsdom does no layout, so the pin is the prop contract the e2e geometry
    // walk then measures on the painted page: the mark is byte-identical...
    expect(rects).toHaveLength(2);
    expect(rects[1]).toHaveAttribute('x', '93');
    expect(rects[1]).toHaveAttribute('y', '4598');
    expect(rects[1]).toHaveAttribute('width', '100');
    expect(rects[1]).toHaveAttribute('height', '42');
    // ...and the invisible hit rect floors BOTH axes at the 44px budget,
    // growing up from the mark so the baseline stays where the data put it.
    const hit = rects[0];
    const hitBox = ['x', 'y', 'width', 'height'].map((a) => Number(hit.getAttribute(a)));
    expect(hitBox[2], 'width ≥ 44').toBeGreaterThanOrEqual(44);
    expect(hitBox[3], 'height ≥ 44').toBeGreaterThanOrEqual(44);
    expect(hitBox[0], 'grows sideways symmetrically').toBeLessThanOrEqual(93);
    expect(hitBox[1], 'grows upward, never below the bar top').toBeLessThanOrEqual(4598);
    expect(hitBox[1] + hitBox[3], 'baseline preserved').toBe(4598 + 42);
    expect(hit.getAttribute('fill'), 'invisible').toBe('transparent');
  });

  it('also floors a bar narrower than the budget', () => {
    const { container } = render(
      <svg>
        <AccessibleBar
          x={10}
          y={58}
          width={12}
          height={24}
          fill="#2563eb"
          payload={{ key: '2026-01-02', label: 'Jan 2', usage: 0.5, costTOU: 1, costTiered: 2, costULO: 3 }}
          onActivate={vi.fn()}
        />
      </svg>,
    );
    const rects = container.querySelector('g[role="button"]')!.querySelectorAll('rect');
    const hit = rects[0];
    expect(Number(hit.getAttribute('width'))).toBeGreaterThanOrEqual(44);
    expect(Number(hit.getAttribute('height'))).toBeGreaterThanOrEqual(44);
    expect(Number(hit.getAttribute('y')) + Number(hit.getAttribute('height'))).toBe(58 + 24);
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
