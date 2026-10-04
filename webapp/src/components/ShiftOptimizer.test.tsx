import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ShiftOptimizer from './ShiftOptimizer';
import { classifyBlock, confidenceBadge } from '@/lib/touShift';
import type { TouShiftAnalysis, ShiftBlock, ShiftOption } from '@/lib/touShift';

const overnight: ShiftOption = {
  target: 'overnight_ulo',
  label: 'Overnight (ULO 23:00–07:00)',
  destRateCents: 3.9,
  savingsCentsPerKwh: 16.4,
  monthlySavings: 2.84,
  effort: 'plan-switch-required',
  assumption: 'Requires switching to the ULO plan and moving the load into 23:00–07:00.',
};

const weekend: ShiftOption = {
  target: 'weekend',
  label: 'Weekend off-peak',
  destRateCents: 9.8,
  savingsCentsPerKwh: 10.5,
  monthlySavings: 1.82,
  effort: 'no-plan-switch',
  assumption: 'Move the activity to any weekend hour — off-peak on TOU, no plan switch.',
};

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
    intraBlockCv: 0.05,
    baselineRateCents: 20.3,
    tier: 'on-peak',
    classification: classifyBlock({
      startHour: 12,
      endHour: 14,
      weeksSeen: 4,
      intraBlockCv: 0.05,
      consistencyCv: 0.05,
    }),
    confidence: confidenceBadge(0.05, 4),
    options: [overnight, weekend],
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
    // Honest empty states now cover both tiers
    expect(screen.getByText(/on-peak or mid-peak hours/i)).toBeInTheDocument();
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
    expect(screen.getAllByText(/overnight \(ulo 23:00–07:00\)/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/weekend off-peak/i)).toBeInTheDocument();
    // Both assumptions visible
    expect(screen.getByText(/requires switching to the ulo plan/i)).toBeInTheDocument();
    expect(screen.getAllByText(/no plan switch/i).length).toBeGreaterThan(0);
  });

  // --- Wave E: headline collapse -----------------------------------------
  it('collapses to ONE headline when a single target owns the majority of the savings', () => {
    const blocks = [
      makeBlock({ id: 'fri-11-17', label: 'Fri 11:00–17:00', startHour: 11, endHour: 17, bestMonthlySavings: 12.12 }),
      makeBlock({ id: 'thu-12-17', label: 'Thu 12:00–17:00', startHour: 12, endHour: 17, bestMonthlySavings: 10.93 }),
    ];
    render(<ShiftOptimizer analysis={makeAnalysis({ blocks, totalMonthlySavings: 23.05 })} />);

    const headline = screen.getByTestId('shift-headline');
    expect(headline).toBeInTheDocument();
    expect(headline).toHaveTextContent(
      'Switch to ULO and move your weekday daytime routine → ~$23.05/mo',
    );
    // The headline owns the worst badge of its supporting blocks
    expect(within(headline).getByTestId('confidence-badge')).toBeInTheDocument();
    expect(screen.getByTestId('shift-headline-share')).toHaveTextContent('100% of the savings');
    // Blocks are demoted to supporting rows, still addressable and evidenced
    expect(screen.getByTestId('shift-block-fri-11-17')).toBeInTheDocument();
    expect(screen.getByTestId('shift-block-thu-12-17')).toBeInTheDocument();
    expect(screen.getAllByText(/seen in 4 of 5 weeks/).length).toBe(2);
    // The headline still states the honest assumption behind the move
    expect(screen.getByText(/requires switching to the ulo plan/i)).toBeInTheDocument();
  });

  it('does NOT collapse when no target owns the majority — full cards stay', () => {
    const overnightBlock = makeBlock({ id: 'wed-12-14', bestMonthlySavings: 4 });
    const weekendBlock = makeBlock({
      id: 'fri-12-14',
      label: 'Fri 12:00–14:00',
      weekday: 5,
      bestMonthlySavings: 4,
      options: [{ ...weekend, monthlySavings: 4 }, { ...overnight, monthlySavings: 1.5 }],
    });
    render(
      <ShiftOptimizer
        analysis={makeAnalysis({ blocks: [overnightBlock, weekendBlock], totalMonthlySavings: 8 })}
      />,
    );
    expect(screen.queryByTestId('shift-headline')).not.toBeInTheDocument();
    // Full option cards are back (one per option, with assumptions)
    expect(screen.getAllByText(/requires switching to the ulo plan/i).length).toBe(2);
    expect(screen.getAllByText(/no plan switch/i).length).toBeGreaterThan(1);
  });

  // --- Wave E: confidence badges -----------------------------------------
  it('puts a confidence badge on every block and on the headline', () => {
    const steady = makeBlock({
      id: 'mon-07-10',
      label: 'Mon 07:00–10:00',
      weekday: 1,
      weeksSeen: 5,
      confidence: confidenceBadge(0.05, 5),
    });
    const shaky = makeBlock({
      id: 'tue-07-10',
      label: 'Tue 07:00–10:00',
      weekday: 2,
      weeksSeen: 4,
      confidence: confidenceBadge(0.35, 4),
    });
    render(<ShiftOptimizer analysis={makeAnalysis({ blocks: [steady, shaky], totalMonthlySavings: 5.68 })} />);

    // two block rows + one on the headline (headline takes the worst)
    expect(screen.getAllByTestId('confidence-badge')).toHaveLength(3);
    expect(
      within(screen.getByTestId('shift-block-mon-07-10')).getByTestId('confidence-badge'),
    ).toHaveAttribute('data-level', 'very-consistent');
    expect(
      within(screen.getByTestId('shift-block-tue-07-10')).getByTestId('confidence-badge'),
    ).toHaveAttribute('data-level', 'somewhat');
    const headlineBadge = within(screen.getByTestId('shift-headline')).getByTestId('confidence-badge');
    expect(headlineBadge).toHaveAttribute('data-level', 'somewhat');
  });

  // --- Wave E: effort chips ------------------------------------------------
  it('promotes effort as a first-class chip on every option', () => {
    render(
      <ShiftOptimizer
        analysis={makeAnalysis({ blocks: [makeBlock()], totalMonthlySavings: 2.84 })}
      />,
    );
    // headline + the block's two options all carry a chip
    const chips = screen.getAllByTestId('effort-chip');
    expect(chips.length).toBeGreaterThanOrEqual(3);
    expect(chips.some((c) => c.getAttribute('data-effort') === 'plan-switch-required')).toBe(true);
    expect(chips.some((c) => c.getAttribute('data-effort') === 'no-plan-switch')).toBe(true);
    // the chip wording itself is the promise the user reads
    expect(screen.getAllByText('plan switch required').length).toBeGreaterThan(0);
    expect(screen.getAllByText('no plan switch').length).toBeGreaterThan(0);
  });

  // --- Wave E: classification ---------------------------------------------
  it('labels blocks with a recognizable classification, including the honest fallback', () => {
    const unidentified = makeBlock({
      id: 'wed-13-14',
      label: 'Wed 13:00–14:00',
      endHour: 14,
      classification: classifyBlock({
        startHour: 13,
        endHour: 14,
        weeksSeen: 5,
        intraBlockCv: 0,
        consistencyCv: 0.34,
      }),
    });
    render(<ShiftOptimizer analysis={makeAnalysis({ blocks: [unidentified], totalMonthlySavings: 2.84 })} />);

    // Collapsed (single block, single target) → row still carries the label
    expect(screen.getByTestId('shift-block-wed-13-14')).toHaveTextContent(
      'Unidentified weekday routine',
    );
    // ...and the evidence behind it
    expect(screen.getByTestId('shift-block-wed-13-14')).toHaveTextContent(/week to week/i);
  });

  // --- Wave E: Mid-Peak lower tier ----------------------------------------
  it('shows Mid-Peak blocks behind a lower-tier heading when there is no headline', () => {
    const onPeak = makeBlock({
      id: 'wed-12-14',
      bestMonthlySavings: 4,
      options: [{ ...overnight, monthlySavings: 4 }],
    });
    const midPeak = makeBlock({
      id: 'wed-07-11',
      label: 'Wed 07:00–11:00',
      startHour: 7,
      endHour: 11,
      tier: 'mid-peak',
      baselineRateCents: 15.7,
      bestMonthlySavings: 4,
      options: [{ ...weekend, monthlySavings: 4 }],
    });
    render(
      <ShiftOptimizer
        analysis={makeAnalysis({ blocks: [onPeak, midPeak], totalMonthlySavings: 8 })}
      />,
    );

    expect(screen.queryByTestId('shift-headline')).not.toBeInTheDocument();
    expect(screen.getByTestId('shift-tier-midpeak')).toHaveTextContent(/2 more blocks|1 more block/i);
    const onPeakCard = screen.getByTestId('shift-block-wed-12-14');
    const midPeakCard = screen.getByTestId('shift-block-wed-07-11');
    expect(within(onPeakCard).queryByTestId('shift-tier-chip')).not.toBeInTheDocument();
    expect(within(midPeakCard).getByTestId('shift-tier-chip')).toBeInTheDocument();
    // On-Peak card comes first in the document order
    expect(
      onPeakCard.compareDocumentPosition(midPeakCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps the Mid-Peak tier chip on the supporting rows when collapsed', () => {
    const onPeak = makeBlock({ id: 'wed-12-14', bestMonthlySavings: 6 });
    const midPeak = makeBlock({
      id: 'wed-07-11',
      label: 'Wed 07:00–11:00',
      tier: 'mid-peak',
      baselineRateCents: 15.7,
      bestMonthlySavings: 5,
    });
    render(
      <ShiftOptimizer
        analysis={makeAnalysis({ blocks: [onPeak, midPeak], totalMonthlySavings: 11 })}
      />,
    );
    expect(screen.getByTestId('shift-headline')).toBeInTheDocument();
    expect(within(screen.getByTestId('shift-block-wed-07-11')).getByTestId('shift-tier-chip')).toBeInTheDocument();
    expect(screen.getByText(/1 On-Peak \+ 1 Mid-Peak recurring blocks found/i)).toBeInTheDocument();
  });
});
