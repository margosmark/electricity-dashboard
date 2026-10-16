/**
 * The Plans tab's Quiet Meter contract.
 *
 * Requirement: the plan cards and the panels around them use the approved
 * quiet treatment — hairline edges, no hard offset shadows, no oversized
 * radii, medium weights — instead of the neobrutalist language the rest of
 * the app used before the redesign. The behavior contract (role=button,
 * aria-pressed, keyboard selection, the rate chips reading the active
 * RateSet) is asserted here too, because "quiet" must never be bought with
 * an interaction the user can no longer drive.
 *
 * Two nets, deliberately: the render tests see what the DOM actually gets,
 * and the source sweep pins every Plans component that this suite does not
 * happen to mount — a panel that renders only after a real import would
 * otherwise slip through unstyled and unmeasured.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PlanCards, { type PlanCardsProps } from './PlanCards';
import VerdictLine from './VerdictLine';
import type { RateSet } from '@/lib/energy';

/** The neobrutalist signature, at class granularity. Never `shadow-none`. */
const HEAVY =
  /(?:^|[\s"'`])(?:md:)?border-(?:2|4|8)\b|(?:^|[\s"'`])(?:md:)?shadow-hard-\d+|(?:^|[\s"'`])shadow-xl\b|rounded-\[(?:[\d.]+rem)\]|(?:^|[\s"'`])font-black\b|(?<![\w-])italic(?![\w-])|ring-\d+\s|ring-yellow/;

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 7.4, midPeak: 13.6, onPeak: 21.9 },
  tiered: { tier1: 11.3, tier2: 15.8, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 2.7, weekendOffPeak: 8.1, midPeak: 14.4, onPeak: 41.2 },
};

function cardProps(over: Partial<PlanCardsProps> = {}): PlanCardsProps {
  return {
    comparison: { TOU: 213.44, Tiered: 231.02, ULO: 198.77 },
    userPlan: 'TOU',
    setUserPlan: vi.fn(),
    activeRateSet: RATES,
    startDate: '2026-05-25',
    endDate: '2026-06-23',
    ...over,
  };
}

/** Every class string in the rendered tree, so one assertion sees them all. */
function classesIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('*')]
    .map((el) => el.getAttribute('class') || '')
    .filter(Boolean);
}

afterEach(() => vi.restoreAllMocks());

describe('Plans tab quiet treatment', () => {
  it('renders the plan cards without a single neobrutalist class', () => {
    const { container } = render(<PlanCards {...cardProps()} />);
    const heavy = classesIn(container).filter((c) => HEAVY.test(c));
    expect(heavy, `heavy classes on the plan cards: ${heavy.join(' | ')}`).toEqual([]);
    // …and the quiet ladder is actually there, not merely "not heavy".
    const card = screen.getByRole('button', { name: /Time-of-Use/i });
    expect(card.className).toMatch(/\bbg-card\b/);
    expect(card.className).toMatch(/\bborder\b/);
    expect(card.className).not.toMatch(/\bshadow-/);
  });

  it('keeps the card contract: pressable, keyboard-selectable, state-marked', () => {
    const setUserPlan = vi.fn();
    render(<PlanCards {...cardProps({ setUserPlan })} />);
    const card = screen.getByRole('button', { name: /Time-of-Use/i });
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveAttribute('tabindex', '0');
    // The quiet equivalent of the old yellow ring: an accent edge on the card
    // that is current, nothing on the other two.
    expect(card.className).toMatch(/\bborder-accent\b/);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(setUserPlan).toHaveBeenCalledWith('TOU');
    fireEvent.keyDown(card, { key: ' ' });
    expect(setUserPlan).toHaveBeenCalledTimes(2);
  });

  it('renders the verdict line without heavy classes', () => {
    const { container } = render(
      <VerdictLine comparison={{ TOU: 213.44, Tiered: 231.02, ULO: 198.77 }} userPlan="TOU" days={30} />,
    );
    expect(screen.getByTestId('verdict-line')).toBeInTheDocument();
    const heavy = classesIn(container).filter((c) => HEAVY.test(c));
    expect(heavy, `heavy classes on the verdict line: ${heavy.join(' | ')}`).toEqual([]);
  });
});

describe('Plans tab components the suite does not mount', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const COMPONENTS = [
    'VerdictLine.tsx',
    'ShiftOptimizer.tsx',
    'ShiftVerificationCard.tsx',
    'PlanCards.tsx',
    'PlanSwitchTimeline.tsx',
    'PlanTimelineEditor.tsx',
    'SwitchTrackRecord.tsx',
    'HindsightPanel.tsx',
    'ActualBillPanel.tsx',
    'PlansPanel.tsx',
  ];

  /** Comments are prose: a design note that MENTIONS a shadow must not fail. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it.each(COMPONENTS)('%s stays on the quiet ladder', (file) => {
    const src = stripComments(fs.readFileSync(path.join(here, file), 'utf8'));
    const found = src.match(HEAVY);
    expect(found, `${file} still carries ${found?.[0]} in a class`).toBeNull();
  });
});
