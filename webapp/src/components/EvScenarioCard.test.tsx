import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EvScenarioCard from './EvScenarioCard';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from '@/lib/energy';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

function hourly(days: number, kwhAt: (d: Date) => number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let day = 0; day < days; day++) {
    for (let h = 0; h < 24; h++) {
      const d = new Date(2026, 5, 1 + day, h, 0, 0);
      raw.push({ timestamp: Math.floor(d.getTime() / 1000), usage_kwh: kwhAt(d) });
    }
  }
  return processRawData(raw, [RATES]);
}

/** Quiet 0.4 kW house plus `ev` kWh in `evHours` on every night. */
function houseWithNightBlock(days: number, evHours: number[], ev: number) {
  const evSet = new Set(evHours);
  return hourly(days, (d) => (evSet.has(d.getHours()) ? 0.4 + ev : 0.4));
}

describe('EvScenarioCard', () => {
  it('prices a detected overnight block under all three plans', () => {
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0);
    render(<EvScenarioCard rows={rows} rates={RATES} />);

    const card = screen.getByTestId('ev-scenario');
    expect(card).toHaveAttribute('data-source', 'detected');
    expect(screen.getByTestId('ev-detect-note')).toBeInTheDocument();

    // Prefilled from the household's OWN data: 3.4 kW × 3 h = 10.2 kWh.
    expect(screen.getByTestId('ev-kwh-input')).toHaveValue(10.2);

    // ULO overnight 3.9¢ → 10.2 × 0.039 = $0.40 per charge.
    expect(screen.getByTestId('ev-per-charge-ULO')).toHaveTextContent('$0.40');
    // TOU off-peak 9.8¢ → 10.2 × 0.098 = $1.00 per charge.
    expect(screen.getByTestId('ev-per-charge-TOU')).toHaveTextContent('$1.00');
    expect(screen.getByTestId('ev-per-month-TOU')).toHaveTextContent('$29.99');

    expect(screen.getByTestId('ev-plan-comparison')).toBeInTheDocument();
    expect(screen.getByTestId('ev-peak-exposure')).toBeInTheDocument();
    expect(screen.getByTestId('ev-assumptions')).toBeInTheDocument();
  });

  it('reprices the moment the household types their own kWh', async () => {
    const user = userEvent.setup();
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0);
    render(<EvScenarioCard rows={rows} rates={RATES} />);

    const input = screen.getByTestId('ev-kwh-input');
    await user.clear(input);
    await user.type(input, '20');

    // 20 kWh × 3.9¢ = $0.78 on ULO, × 9.8¢ = $1.96 on TOU.
    expect(screen.getByTestId('ev-per-charge-ULO')).toHaveTextContent('$0.78');
    expect(screen.getByTestId('ev-per-charge-TOU')).toHaveTextContent('$1.96');
    // 30 charging nights a month: 20 × 9.8¢ × 30 = $58.80.
    expect(screen.getByTestId('ev-per-month-TOU')).toHaveTextContent('$58.80');
  });

  it('never claims to have found a car when it found nothing', async () => {
    const user = userEvent.setup();
    const rows = hourly(20, () => 0.4);
    render(<EvScenarioCard rows={rows} rates={RATES} />);

    expect(screen.getByTestId('ev-scenario')).toHaveAttribute('data-source', 'none');
    expect(screen.queryByTestId('ev-detect-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('ev-scenario-empty')).toBeInTheDocument();
    expect(screen.getByTestId('ev-scenario-empty')).toHaveTextContent(/Tag a nightly kWh above/);
    expect(screen.getByText(/could not find an overnight charging block/)).toBeInTheDocument();
    expect(screen.queryByTestId('ev-plan-comparison')).not.toBeInTheDocument();

    // …but the peak exposure is a property of the data, so it still shows.
    expect(screen.getByTestId('ev-peak-exposure')).toBeInTheDocument();

    // And typing a number brings the pricing up without inventing a detection.
    await user.type(screen.getByTestId('ev-kwh-input'), '10');
    expect(screen.queryByTestId('ev-scenario-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('ev-per-charge-ULO')).toHaveTextContent('$0.39');
    // Still tagged by the household, never relabelled as "found in your data".
    expect(screen.getByTestId('ev-scenario')).toHaveAttribute('data-source', 'tagged');
  });

  it('shows the plan comparison honestly when shifting buys nothing', () => {
    // An all-weekend block already sits in ULO's cheapest hours.
    const rows = hourly(20, (d) => (d.getHours() >= 23 || d.getHours() < 7 ? 3.4 : 0.4));
    render(<EvScenarioCard rows={rows} rates={RATES} />);

    const comparison = screen.getByTestId('ev-plan-comparison');
    expect(comparison).toBeInTheDocument();
    // ULO moves nobody's cost: the shift is a no-op, and it says so.
    expect(comparison).toHaveTextContent('no change from shifting');
    expect(comparison).toHaveTextContent(/Today \$/);
  });
});
