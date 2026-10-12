/**
 * D3 (t_fcbba376) — the Efficiency card's mini-line type, measured.
 *
 * The chart is a fixed 720-unit viewBox scaled to its container, so a literal
 * `fontSize={10}` renders at `10 × (boxW / 720)` CSS px — 4.1px at a 390px
 * viewport and 4.65px on Mark's 427px/3.0-DPR device. What failed was the
 * SIZE of the type, not its colour, so the fix is one width-compensated
 * `labelFs` that the whole chart (and the PAD that frames it) derives from.
 *
 * Two contracts are pinned here, both of them the "desktop must not change"
 * bar the fix was accepted against:
 *   1. at any container ≥ 648px (i.e. ≥768px layout) `labelFs` is 10 — the
 *      literal every one of those labels used before;
 *   2. `chartPad(10)` is byte-identical to the hard-coded
 *      `{ top: 22, right: 16, bottom: 30, left: 46 }` this file replaces.
 *
 * jsdom has no layout and no ResizeObserver, so the render below observes the
 * default boxW = 720 → labelFs 10: it pins the DESKTOP contract. The
 * compensated one is asserted at both real viewports in
 * `webapp/tests/e2e/mobile-defects.spec.ts`, where there is a layout to
 * measure.
 */

import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';

import EfficiencyCard, { chartLabelFs, chartPad } from './EfficiencyCard';
import type { RateSet } from '@/lib/energy';
import { seasonForDay } from '@/lib/season';
import { efficiencyTrend, weightedCentsPerKwh, type PeriodEfficiency } from '@/lib/statistics';

const rates: RateSet[] = [
  {
    effectiveDate: '2024-06-15',
    tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
  },
];

/** Twelve monthly periods spanning both Ontario rate seasons. */
function yearOfPeriods(): PeriodEfficiency[] {
  return Array.from({ length: 12 }, (_, i) => {
    const startDate = `2024-${String(i + 1).padStart(2, '0')}-01`;
    const endDate = `2024-${String(i + 1).padStart(2, '0')}-28`;
    const cents = 19;
    const tax = 24.7;
    return {
      start: Date.UTC(2024, i, 1) / 1000,
      startDate,
      endDate,
      label: startDate,
      kwh: 1000,
      cost: cents * 10,
      tax,
      cents,
      centsInclTax: ((cents * 10 + tax) / 1000) * 100,
      usageCents: 16 - 0.2 * i,
      deliveryCents: 4,
      rateCents: -1 + 0.2 * i,
      unmappedKwh: 0,
      season: seasonForDay(startDate),
    };
  });
}

function yearReport() {
  const periods = yearOfPeriods();
  return {
    periods,
    allTime: weightedCentsPerKwh(periods),
    inView: weightedCentsPerKwh(periods.slice(6)),
    trend: efficiencyTrend(periods, rates),
  };
}

/** The rendered size, in CSS px, that `labelFs` produces at a given width. */
const renderedPx = (boxW: number) => (chartLabelFs(boxW) * boxW) / 720;

describe('D3a — one width-compensated label size', () => {
  it('is the pre-change literal 10 at the viewBox width and above', () => {
    expect(chartLabelFs(720)).toBe(10);
    // 768px layout measures a 648px chart — the smallest width at which the
    // compensation still resolves to today's literal.
    expect(chartLabelFs(648)).toBe(10);
    expect(chartLabelFs(1440)).toBe(10);
    expect(chartLabelFs(4000)).toBe(10);
  });

  it('never returns a sub-10 size, so desktop type can only grow, not shrink', () => {
    for (const boxW of [1, 100, 298, 334.7, 647, 648, 720, 900, 5000]) {
      expect(chartLabelFs(boxW)).toBeGreaterThanOrEqual(10);
    }
  });

  it('lands the type at ~9 CSS px on both of Mark\'s viewports', () => {
    // 390×844: the chart measures 298px (ux's render, confirmed on mine).
    expect(chartLabelFs(298)).toBe(22);
    expect(renderedPx(298)).toBeGreaterThanOrEqual(8);
    expect(renderedPx(298)).toBeLessThanOrEqual(10);
    // 427×952 @ DPR 3.0 — the device the screenshot was actually taken on:
    // chart measures 334.7px.
    expect(chartLabelFs(334.7)).toBe(19);
    expect(renderedPx(334.7)).toBeGreaterThanOrEqual(8);
    expect(renderedPx(334.7)).toBeLessThanOrEqual(10);
  });

  it('survives an unmeasured container instead of dividing by zero', () => {
    expect(chartLabelFs(0)).toBe(10);
    expect(chartLabelFs(-1)).toBe(10);
    expect(Number.isFinite(chartLabelFs(0))).toBe(true);
  });
});

describe('D3 correction — PAD rides with labelFs', () => {
  it('is byte-identical to the old hard-coded PAD at the desktop size', () => {
    expect(chartPad(10)).toEqual({ top: 22, right: 16, bottom: 30, left: 46 });
  });

  it('grows the frame as the type grows, so the label stays inside it', () => {
    expect(chartPad(22)).toEqual({ top: 24, right: 16, bottom: 30, left: 50 });
    // Top: the band label's baseline is PAD.top + round(0.85 × labelFs); its
    // cap height is ~0.72 × labelFs, so cap top = PAD.top + 0.13 × labelFs
    // stays ≥ PAD.top (inside the band rect) only while PAD.top ≥ labelFs
    // minus a couple of units.
    for (const labelFs of [10, 14, 19, 22, 30]) {
      const pad = chartPad(labelFs);
      expect(pad.top).toBeGreaterThanOrEqual(labelFs);
      // Left: the y-axis max label is textAnchor=end at PAD.left − 6 and is
      // ~1.9 × labelFs wide for "24¢", so it must not cross x = 0.
      expect(pad.left - 6 - 1.9 * labelFs).toBeGreaterThanOrEqual(-2);
      expect(pad.top).toBeGreaterThanOrEqual(22);
      expect(pad.left).toBeGreaterThanOrEqual(46);
    }
  });
});

describe('D3 in the rendered chart (jsdom = default boxW = desktop contract)', () => {
  it('draws every label at the ONE compensated size — no literal left', () => {
    const { container } = render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const chart = container.querySelector('[data-testid="efficiency-chart"]');
    expect(chart).not.toBeNull();

    const sizes = [...chart!.querySelectorAll('text')].map((t) => t.getAttribute('font-size'));
    expect(sizes.length).toBeGreaterThan(0);
    // One size for every family — the old literals were 10 (bands, axes,
    // period ends) and 9 (the rate tick).
    expect(new Set(sizes)).toEqual(new Set([String(chartLabelFs(720))]));
    expect(sizes).not.toContain('9');
  });

  it('puts the rate word on its own row instead of the band labels\' baseline', () => {
    const { container } = render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const chart = container.querySelector('[data-testid="efficiency-chart"]')!;
    const labelFs = chartLabelFs(720);
    const pad = chartPad(labelFs);
    const innerH = 210 - pad.top - pad.bottom;

    const bandLabel = chart.querySelector('g > text')!;
    expect(bandLabel.getAttribute('y')).toBe(String(pad.top + Math.round(labelFs * 0.85)));

    const rateTick = chart.querySelector('[data-testid="efficiency-rate-tick"]')!;
    const rateLabel = rateTick.nextElementSibling as SVGTextElement;
    expect(rateLabel.tagName.toLowerCase()).toBe('text');
    expect(rateLabel.getAttribute('text-anchor')).toBe('middle');
    expect(rateLabel.getAttribute('y')).toBe(String(pad.top + innerH - Math.round(labelFs * 0.45)));
    // …and it is nowhere near the band row any more.
    expect(Number(rateLabel.getAttribute('y'))).toBeGreaterThan(Number(bandLabel.getAttribute('y')) + 50);
  });

  it('draws its strokes from tokens, not the two hex literals (D3d)', () => {
    const { container } = render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const svg = container.querySelector('[data-testid="efficiency-chart"]')!;
    const markup = svg.outerHTML;
    // Light theme's --bad/--info resolve to these exact hexes, so the pixels
    // are unchanged; dark theme gets #f87171/#60a5fa instead of the 2.19:1
    // and 3.45:1 literals.
    expect(markup).not.toContain('#b91c1c');
    expect(markup).not.toContain('#2563eb');
    expect(svg.querySelector('[data-testid="efficiency-rate-tick"]')!.getAttribute('stroke')).toBe('var(--bad)');
    expect(svg.querySelector('[data-testid="efficiency-regression-line"]')!.getAttribute('stroke')).toBe(
      'var(--info)',
    );
  });

  it('labels every band whose width fits the word (D3c fit test, not a bar count)', () => {
    const { container } = render(<EfficiencyCard report={yearReport()} onOpenMoney={() => {}} />);
    const chart = container.querySelector('[data-testid="efficiency-chart"]')!;
    const labelFs = chartLabelFs(720);
    const bands = [...chart.querySelectorAll('[data-testid="efficiency-season-band"]')];

    for (const band of bands) {
      const rect = band as SVGRectElement;
      const width = Number(rect.getAttribute('width'));
      const group = rect.closest('g')!;
      const label = group.querySelector('text');
      if (width >= 4.3 * labelFs) {
        expect(label, `a ${width}-unit band must carry its label`).not.toBeNull();
      } else {
        expect(label, `a ${width}-unit band must NOT carry a label it cannot fit`).toBeNull();
      }
    }
    // The fixture's bands are 4/6/2 bills wide: 219/329/110 units at 12
    // bills — all three fit a 41-unit word, so all three are labelled. (The
    // pre-D3 `bars >= 3` gate hid the 2-bar one; the fit test is the spec'd
    // replacement, t_fcbba376 3c.)
    expect(bands).toHaveLength(3);
    const svg = chart as unknown as HTMLElement;
    expect(within(svg).getAllByText('Winter')).toHaveLength(2);
    expect(within(svg).getByText('Summer')).toBeInTheDocument();
  });
});
