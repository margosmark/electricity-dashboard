import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BillProjectionBanner from './BillProjectionBanner';
import { projectMonthBill, MIN_DAYS_FOR_PROJECTION } from '@/lib/billProjection';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from '@/lib/energy';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

function hourlyFrom(start: Date, days: number, kwhPerHour: number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d, h, 0, 0);
      raw.push({ timestamp: Math.floor(dt.getTime() / 1000), usage_kwh: kwhPerHour });
    }
  }
  return processRawData(raw, [RATES]);
}

const oct = (day: number) => new Date(2026, 9, day);

describe('BillProjectionBanner', () => {
  it('shows the projected amount with month-to-date context when ready', () => {
    const projection = projectMonthBill(hourlyFrom(oct(1), 10, 1), 'Tiered', oct(10));
    expect(projection.ready).toBe(true);

    render(<BillProjectionBanner projection={projection} />);

    expect(screen.getByTestId('bill-projection')).toHaveAttribute('data-state', 'ready');
    // 240 kWh measured over 10 covered days: 197.37 kWh at tier 1 (12¢) + 42.63
    // at tier 2 (14.2¢) = $29.74 MTD; the 7-day average is $2.97/day, so 21
    // days left → $92.19. Flat tier 1 would have said $28.80 / $89.28.
    expect(screen.getByTestId('bill-projection-amount')).toHaveTextContent('$92.19');
    expect(screen.getByText('Projected October 2026 bill')).toBeInTheDocument();
    expect(screen.getByText('Month to date')).toBeInTheDocument();
    expect(screen.getByText(/\$29\.74/)).toBeInTheDocument();
    expect(screen.getByText('10/31')).toBeInTheDocument();
    expect(screen.getByText(/Commodity cost only/)).toBeInTheDocument();
  });

  it('says why it will not project yet instead of showing a number', () => {
    const projection = projectMonthBill(hourlyFrom(oct(1), 2, 1), 'Tiered', oct(2));
    expect(projection.ready).toBe(false);
    expect(projection.emptyReason).toBe('too-early');

    render(<BillProjectionBanner projection={projection} />);

    expect(screen.getByTestId('bill-projection')).toHaveAttribute('data-state', 'gated');
    expect(screen.queryByTestId('bill-projection-amount')).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp(`switches on at day ${MIN_DAYS_FOR_PROJECTION}`))).toBeInTheDocument();
    expect(screen.getByText(/This month.s bill/)).toBeInTheDocument();
  });

  it('never renders a number when the month has no readings', () => {
    const projection = projectMonthBill([], 'TOU', oct(10));
    expect(projection.ready).toBe(false);
    expect(projection.emptyReason).toBe('no-data');

    render(<BillProjectionBanner projection={projection} />);

    expect(screen.getByTestId('bill-projection')).toHaveAttribute('data-state', 'gated');
    expect(screen.queryByTestId('bill-projection-amount')).not.toBeInTheDocument();
    expect(screen.getByText(/No readings for October 2026 yet/)).toBeInTheDocument();
  });
});
