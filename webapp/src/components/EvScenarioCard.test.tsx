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

/** Mon 2026-01-05 for 28 days: WINTER (Nov 1 – Apr 30), 20 weekdays + 8 weekend days. */
const WINTER = new Date(2026, 0, 5);

function hourly(days: number, kwhAt: (d: Date) => number): ProcessedPoint[] {
  return hourlyFrom(new Date(2026, 5, 1), days, kwhAt);
}

/** Rows for `days` days starting at `start` — the start date pins the season. */
function hourlyFrom(start: Date, days: number, kwhAt: (d: Date) => number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let day = 0; day < days; day++) {
    for (let h = 0; h < 24; h++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, h, 0, 0);
      raw.push({ timestamp: Math.floor(d.getTime() / 1000), usage_kwh: kwhAt(d) });
    }
  }
  return processRawData(raw, [RATES]);
}

/**
 * A house that charges in the EVENING: detectEvCandidate finds nothing in the
 * night, so nothing is prefilled and the household has to answer the hour
 * question — exactly the household whose complaint built this feature.
 */
function eveningCharger(start: Date, days: number, evHours = [19, 20], ev = 3.0) {
  const set = new Set(evHours);
  return hourlyFrom(start, days, (d) => (set.has(d.getHours()) ? 0.4 + ev : 0.4));
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

  /* --- EV v2: the hour wheel and the stay-vs-move counterfactual --------- */

  it('asks when you charge, and prices staying at 7 PM against moving to midnight', async () => {
    const user = userEvent.setup();
    const rows = eveningCharger(WINTER, 28);
    render(<EvScenarioCard rows={rows} rates={RATES} />);

    // No night block to prefill from — the wheel starts unanswered, and the
    // card asks instead of inventing an hour.
    expect(screen.getByTestId('ev-charge-hour')).toHaveValue('');
    await user.type(screen.getByTestId('ev-kwh-input'), '10');
    expect(screen.getByTestId('ev-charge-move-empty')).toHaveTextContent(
      'When do you usually charge?',
    );
    expect(screen.queryByTestId('ev-charge-move')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('ev-charge-hour'), '19');
    const move = screen.getByTestId('ev-charge-move');
    expect(move).toHaveTextContent('Stay at 18:00–21:00 vs move to 23:00–07:00');
    expect(move).toHaveTextContent('Priced on Time-of-Use');

    // Winter weekday 18:00 is On-Peak and 19:00/20:00 are Off-Peak: 12.3¢
    // blended across the ±1 h band → $36.90/mo to stay, $11.70/mo moved.
    const stay = screen.getByTestId('ev-stay-side');
    expect(stay).toHaveTextContent('18:00–21:00 · 12.3¢/kWh');
    expect(stay).toHaveTextContent('$36.90');
    expect(stay).toHaveTextContent('$1.23 a charge');
    const moved = screen.getByTestId('ev-move-side');
    expect(moved).toHaveTextContent('23:00–07:00 · 3.9¢/kWh');
    expect(moved).toHaveTextContent('$11.70');

    const result = screen.getByTestId('ev-move-result');
    expect(result).toHaveTextContent('$25.20/mo better off');
    // …and it says WHERE the money is: shifting the hour, not the plan.
    expect(result).toHaveTextContent('+$80.49/mo for moving the hour');
    expect(result).toHaveTextContent('−$55.29/mo for changing plan');
    expect(result).toHaveTextContent('never counted twice');
    // Evidence: the hours and windows it blended, from their own readings.
    expect(result).toHaveTextContent('18:00 On-Peak + Off-Peak 17.3¢');
    expect(screen.getByTestId('ev-assumptions')).toHaveTextContent('Winter rates');
  });

  it('prefills the hour from the detected block and says the shift would buy nothing', () => {
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0);
    render(<EvScenarioCard rows={rows} rates={RATES} />);

    // Reuse the winning candidate rather than asking blind.
    expect(screen.getByTestId('ev-charge-hour')).toHaveValue('23');
    expect(screen.getByTestId('ev-charge-move')).toHaveTextContent(
      'Stay at 23:00–02:00 vs move to 23:00–07:00',
    );
    expect(screen.getByTestId('ev-already-overnight')).toBeInTheDocument();

    const result = screen.getByTestId('ev-move-result');
    expect(result).toHaveTextContent('nothing to shift');
    expect(result).toHaveTextContent('is the plan, not the clock');
    expect(result).toHaveTextContent('+$0.00/mo for moving the hour');
    expect(result).toHaveTextContent('+$18.05/mo for changing plan');
    expect(result).toHaveTextContent('$18.05/mo is the plan, not the clock');
  });

  it('prices the stay side on the plan the household selected', async () => {
    const user = userEvent.setup();
    render(<EvScenarioCard rows={eveningCharger(WINTER, 28)} rates={RATES} plan="ULO" />);

    await user.type(screen.getByTestId('ev-kwh-input'), '10');
    await user.selectOptions(screen.getByTestId('ev-charge-hour'), '19');

    expect(screen.getByTestId('ev-charge-move')).toHaveTextContent(
      'Priced on Ultra-Low Overnight',
    );
    // On ULO those same hours are weekday On-Peak: staying costs $92.19/mo and
    // the plan half of the answer is exactly zero (it IS the plan already).
    const stay = screen.getByTestId('ev-stay-side');
    expect(stay).toHaveTextContent('30.7¢/kWh');
    expect(stay).toHaveTextContent('$92.19');
    const result = screen.getByTestId('ev-move-result');
    expect(result).toHaveTextContent('+$0.00/mo for changing plan');
    expect(result).toHaveTextContent('+$80.49/mo for moving the hour');
    expect(result).toHaveTextContent('$80.49/mo better off');
  });

  it('invents no saving when the household already charges overnight on ULO', async () => {
    const user = userEvent.setup();
    render(<EvScenarioCard rows={hourly(20, () => 0.4)} rates={RATES} plan="ULO" />);

    await user.type(screen.getByTestId('ev-kwh-input'), '10');
    await user.selectOptions(screen.getByTestId('ev-charge-hour'), '0');

    expect(screen.getByTestId('ev-already-overnight')).toBeInTheDocument();
    const result = screen.getByTestId('ev-move-result');
    expect(result).toHaveTextContent('Nothing to gain by moving this charge');
    expect(result).toHaveTextContent('+$0.00/mo for moving the hour');
    expect(result).toHaveTextContent('+$0.00/mo for changing plan');
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
