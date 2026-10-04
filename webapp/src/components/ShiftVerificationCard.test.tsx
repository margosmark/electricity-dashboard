import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ShiftVerificationCard from './ShiftVerificationCard';
import { analyzeShiftVerification } from '@/lib/shiftVerification';
import { processRawData, type DataPoint, type RateSet } from '@/lib/energy';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** Hourly rows from 2026-06-01 (no DST), so every day holds exactly 24. */
function hourly(days: number, kwhAt: (dayOfMonth: number, hour: number, weekend: boolean) => number) {
  const raw: DataPoint[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const date = new Date(2026, 5, 1 + d, h, 0, 0);
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      raw.push({ timestamp: Math.floor(date.getTime() / 1000), usage_kwh: kwhAt(date.getDate(), h, weekend) });
    }
  }
  return processRawData(raw, [RATES]);
}

/** Recent week (day >= 22) off-peak heavy, prior week on-peak heavy. */
const improvedWeek = (day: number, h: number, weekend: boolean) => {
  if (weekend) return 1;
  const off = h >= 19 || h < 7;
  return (day >= 22 ? !off : off) ? 0.6 : 2.4;
};

describe('ShiftVerificationCard', () => {
  it('renders both windows, the verdict and the evidence when a shift shows up', () => {
    const verification = analyzeShiftVerification(hourly(28, improvedWeek), 'TOU');
    expect(verification.ready).toBe(true);
    expect(verification.verdict).toBe('improved');

    render(<ShiftVerificationCard verification={verification} />);

    const card = screen.getByTestId('shift-verification');
    expect(card).toHaveAttribute('data-verdict', 'improved');
    expect(screen.getByTestId('shift-verification-headline')).toBeInTheDocument();
    expect(screen.getByTestId('shift-verification-detail')).toBeInTheDocument();

    // Two 7-day windows, anchored on the newest complete day.
    expect(screen.getByText('Last 7 days · off-peak')).toBeInTheDocument();
    expect(screen.getByText('Prior 7 days · off-peak')).toBeInTheDocument();
    expect(screen.getByText(/2026-06-22 → 2026-06-28 · 7 days/)).toBeInTheDocument();
    expect(screen.getByText(/2026-06-15 → 2026-06-21 · 7 days/)).toBeInTheDocument();

    // The share moved a long way — the headline must quote it, not hand-wave.
    expect(screen.getByTestId('shift-verification-headline')).toHaveTextContent(/Off-peak share up \d+ pts/);
    // And it must carry the "one week is a hint, not proof" caveat.
    expect(screen.getByText(/one week is a hint, not proof/)).toBeInTheDocument();
  });

  it('falls back to an explained empty state instead of a fake verdict', () => {
    const verification = analyzeShiftVerification([], 'TOU');
    expect(verification.ready).toBe(false);

    render(<ShiftVerificationCard verification={verification} />);

    expect(screen.getByTestId('shift-verification-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('shift-verification-headline')).not.toBeInTheDocument();
    expect(screen.getByTestId('shift-verification-empty')).toHaveTextContent(verification.headline);
  });

  it('keeps both windows visible for a Tiered household that has no off-peak', () => {
    const flat = (day: number, h: number, weekend: boolean) =>
      weekend ? 1.2 : h >= 7 && h < 19 ? 1.6 : 0.9;
    const verification = analyzeShiftVerification(hourly(30, flat), 'Tiered');
    expect(verification.ready).toBe(true);
    expect(verification.verdict).toBe('no-offpeak');
    expect(verification.offPeakLabel).toBeNull();

    render(<ShiftVerificationCard verification={verification} />);

    expect(screen.getByTestId('shift-verification')).toHaveAttribute('data-verdict', 'no-offpeak');
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();
    expect(screen.getByText('Prior 7 days')).toBeInTheDocument();
  });
});
