/**
 * Wave S — the EFFICIENCY card: what a kWh cost, whether that is getting
 * better, and — the part that keeps the verdict honest — which half of the
 * movement you caused.
 *
 * Contents, in decision order:
 *   1. the headline stat: all-time kWh-weighted ¢/kWh — published TWICE,
 *      once excl. tax (the utility's own "Total Electricity Charges" line:
 *      commodity + delivery + regulatory) and once incl. tax (that line plus
 *      the bill's HST, over the same kWh). Both are shown simultaneously
 *      because the owner's own question — "does the avg kWh cost include
 *      all fees?" — went unanswered by a card that printed one bare number
 *      whose numerator it had never stated. The subtitle now names the
 *      charges and the divisor, and the footnote under the pair quotes the
 *      tax rate the FILE states rather than a rate assumed from outside it;
 *   2. the trend chip, read from the USAGE component of the split — what
 *      your commodity would cost at today's rates — with the rate component,
 *      delivery/other and the net printed beside it, because a slope that
 *      includes an OEB rate bump (or the fixed delivery charge spread over a
 *      winter's worth of kWh) is a lie in green ink;
 *   3. the mini-line: every closed bill's ¢/kWh (each point carrying both
 *      the excl- and incl-tax figure), the regression over the verdict
 *      window, Nov 1 rate-change ticks, and winter/summer bands — summer
 *      bills are structurally cheaper per kWh (off-peak dominates and the
 *      fixed delivery charge spreads over 2.5× the kWh), and the bands say
 *      so instead of letting the eye infer genius;
 *   4. a click through to the MONEY tab, where the same bills are broken
 *      apart.
 *
 * The regression, the split components and the verdict all stay on the
 * PRE-TAX number: a tax line scales a ¢/kWh by a constant, so it moves no
 * slope and changes no verdict — only the headline reading.
 *
 * Deliberately hand-drawn SVG rather than Recharts: the recharts chunk is a
 * ~651 KB vendor bundle this app keeps off the critical path (Wave I item 4),
 * and a first visit should not pay for a 24-point sparkline. The chart is
 * decorative — every number it draws is also printed as text, so a screen
 * reader gets the same verdict a sighted user gets from the picture.
 */

'use client';

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { fmtCents, fmtDateLong, useTranslation } from '@/i18n';

import { seasonSegments, type Season } from '@/lib/season';
import {
  EFFICIENCY_SUBTITLE_KEY,
  fmtBand,
  fmtSigned,
  impliedTaxPct,
  taxFootnote,
  type EfficiencyReport,
  type EfficiencyTrend,
  type PeriodEfficiency,
  type TrendVerdict,
} from '@/lib/statistics';

export type EfficiencyCardProps = {
  report: EfficiencyReport;
  /** Wired by Dashboard — jumps to the MONEY tab. */
  onOpenMoney: () => void;
};

const W = 720;
const H = 210;

/**
 * D3a (t_fcbba376) — one width-compensated label size for the whole chart.
 *
 * The SVG is a fixed 720-unit viewBox scaled to its container, so a literal
 * `fontSize={10}` renders at `10 × (boxW / 720)` CSS px: 4.1px in the 298px
 * chart at a 390px viewport, 4.65px on the 334.7px chart of Mark's 427px
 * device. The type, not the drawing, is what fails — every label is sub-5px.
 *
 * Measuring the container and scaling the USER units keeps the rendered size
 * at ~9 CSS px whatever the width. The floor is 10: at ≥768px boxW ≥ 648 so
 * `9 × 720 / boxW ≤ 10`, i.e. the desktop resolves to exactly today's
 * literals (10) and nothing about the ≥768px render changes.
 *
 * A container that has not been measured yet — jsdom, a `display: none`
 * panel, the first paint before the ResizeObserver fires — reports 0, so a
 * non-positive width falls back to the viewBox width (i.e. scale 1.0, the
 * old literal) rather than dividing by zero.
 */
export function chartLabelFs(boxW: number): number {
  const width = boxW > 0 ? boxW : W;
  return Math.max(10, Math.round((9 * W) / width));
}

/**
 * D3 correction (soft-dev's verification on t_fcbba376) — PAD rides with
 * `labelFs`, otherwise the compensated type outgrows the frame it is drawn
 * in: at fs22 the band label's cap clears the top of its own band rect, the
 * y-axis max label clips off the SVG's left edge, and the rate tick's
 * descender lands on the axis line.
 *
 * At `labelFs === 10` this is byte-identical to the old hard-coded
 * `{ top: 22, right: 16, bottom: 30, left: 46 }` — the acceptance bar 3c
 * already set for "desktop does not change".
 */
export function chartPad(labelFs: number): { top: number; right: number; bottom: number; left: number } {
  return {
    top: Math.max(22, labelFs + 2),
    right: 16,
    bottom: 30,
    left: Math.max(46, 2 * labelFs + 6),
  };
}

const SEASON_FILL: Record<Season, string> = {
  winter: 'var(--season-winter)',
  summer: 'var(--season-summer)',
};

const CHIP_CLASS: Record<TrendVerdict, string> = {
  improving: 'bg-good-slab text-accent-ink',
  worsening: 'bg-bad-slab text-accent-ink',
  stable: 'bg-track',
};

const CHIP_WORD_KEY: Record<TrendVerdict, string> = {
  improving: 'efficiency.verdict.improving',
  worsening: 'efficiency.verdict.worsening',
  stable: 'efficiency.verdict.stable',
};

/**
 * Signed slope with its unit; the stable case quotes the band instead.
 * Wave U: the sentence comes from the catalog so "IMPROVING −0.4¢/kWh per
 * period" becomes "AMÉLIORATION −0,4 ¢/kWh par période" on toggle.
 */
function slopeText(t: (key: string, p?: Record<string, string | number>) => string, verdict: TrendVerdict, slope: number, band: number): string {
  return verdict === 'stable'
    ? t('efficiency.slopeBand', { band: fmtBand(band) })
    : t('efficiency.slope', { slope: fmtSigned(slope) });
}

function Chart({
  points,
  trend,
}: {
  points: PeriodEfficiency[];
  trend: EfficiencyTrend;
}) {
  // Wave U — season words and ¢ axis labels render in the active language.
  const { t } = useTranslation();

  // D3a — measure the rendered chart so `labelFs` can pay back the viewBox
  // scale. The initial state is the viewBox width itself (scale 1.0 →
  // labelFs 10), so the very first paint is the old literal render and a
  // later observation only ever tightens it toward ~9 CSS px.
  const svgRef = useRef<SVGSVGElement>(null);
  const [boxW, setBoxW] = useState(W);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    // jsdom has no ResizeObserver (and no layout to observe): boxW stays at
    // W, which is the pre-D3 desktop render, so unit tests keep pinning it.
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setBoxW(entry.contentRect.width));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const labelFs = chartLabelFs(boxW);
  // D3 correction 2 — PAD rides with the label size (see chartPad). It keeps
  // the module-level name so the geometry below reads unchanged.
  const PAD = useMemo(() => chartPad(labelFs), [labelFs]);

  const geometry = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const n = points.length;
    const step = innerW / Math.max(1, n);
    const x = (i: number) => PAD.left + step * (i + 0.5);

    const values = points.map((p) => p.cents);
    // Min/max as a LOOP: `Math.min(...values)` passes one ARGUMENT per billing
    // period, and the loaded file decides how many periods there are, so a
    // six-figure bill set threw `RangeError: Maximum call stack size exceeded`.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > lo)) {
      lo -= 0.5;
      hi += 0.5;
    }
    const pad = (hi - lo) * 0.18;
    lo -= pad;
    hi += pad;
    const y = (v: number) => PAD.top + innerH * (1 - (v - lo) / (hi - lo));

    // Season bands: Wave R's run-length machinery, over the period start days.
    const indexOf = new Map<string, number>();
    points.forEach((p, i) => {
      if (!indexOf.has(p.startDate)) indexOf.set(p.startDate, i);
    });
    const bands = seasonSegments(
      points.map((p) => p.startDate),
      (key) => points[indexOf.get(key) ?? 0].season,
    )
      .map((seg) => {
        const from = indexOf.get(seg.fromKey);
        const to = indexOf.get(seg.toKey);
        if (from === undefined || to === undefined) return null;
        return {
          season: seg.season,
          bars: seg.bars,
          x1: x(from) - step / 2,
          x2: x(to) + step / 2,
        };
      })
      .filter((b): b is { season: Season; bars: number; x1: number; x2: number } => b !== null);

    // Rate-change ticks: a Nov 1 boundary lands on the bill AFTER it.
    const ticks = trend.rateBoundaries
      .map((date) => {
        const index = points.findIndex((p) => p.startDate >= date);
        if (index <= 0) return null;
        return { date, x: PAD.left + step * index };
      })
      .filter((t): t is { date: string; x: number } => t !== null);

    // The regression is fitted on the WINDOW's local indices only — drawing
    // it across the whole chart would extrapolate a line nobody fitted.
    const windowStart = n - trend.windowSize;
    const regression =
      trend.net !== null
        ? points.slice(windowStart).map((_, i) => {
            const fitted = trend.net!.intercept + trend.net!.slope * i;
            return `${x(windowStart + i)},${y(fitted)}`;
          })
        : [];

    return {
      innerH,
      step,
      lo,
      hi,
      x,
      y,
      bands,
      ticks,
      regression,
      polyline: points.map((p, i) => `${x(i)},${y(p.cents)}`).join(' '),
    };
  }, [points, trend, PAD]);

  const { innerH, lo, hi, x, y, bands, ticks, regression, polyline } = geometry;
  const last = points[points.length - 1];
  const first = points[0];

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      aria-hidden="true"
      data-testid="efficiency-chart"
      data-points={points.length}
      data-window={trend.windowSize}
      data-rate-ticks={ticks.length}
      data-season-bands={bands.length}
    >
      {/* Season bands sit behind everything. */}
      {bands.map((b, i) => (
        <g key={`${b.season}-${i}`}>
          <rect
            x={b.x1}
            y={PAD.top}
            width={Math.max(0, b.x2 - b.x1)}
            height={innerH}
            fill={SEASON_FILL[b.season]}
            data-testid="efficiency-season-band"
            data-season={b.season}
          />
          {/* D3c — a WIDTH test, not a bar count. At `labelFs` the word is
              ~4.1 × labelFs user units wide, so a band narrower than
              4.3 × labelFs pushes its label out of the band and into the
              y-axis gutter. At desktop `labelFs` is 10 → 43 units, and a
              3-bar band is 82 units at 24 bills: everything that passed the
              old `bars >= 3` still passes. */}
          {b.x2 - b.x1 >= 4.3 * labelFs && (
            <text
              x={(b.x1 + b.x2) / 2}
              y={PAD.top + Math.round(labelFs * 0.85)}
              textAnchor="middle"
              fontSize={labelFs}
              fontWeight={900}
              fill="var(--ink-2)"
            >
              {b.season === 'winter' ? t('season.winter') : t('season.summer')}
            </text>
          )}
        </g>
      ))}

      {/* Frame */}
      <line
        x1={PAD.left}
        y1={PAD.top + innerH}
        x2={W - PAD.right}
        y2={PAD.top + innerH}
        stroke="var(--ink)"
        strokeWidth={2}
      />
      <line
        x1={PAD.left}
        y1={PAD.top}
        x2={PAD.left}
        y2={PAD.top + innerH}
        stroke="var(--ink)"
        strokeWidth={2}
      />
      <text x={PAD.left - 6} y={PAD.top + 8} textAnchor="end" fontSize={labelFs} fontWeight={900} fill="var(--ink)">
        {fmtCents(hi, 0)}
      </text>
      <text
        x={PAD.left - 6}
        y={PAD.top + innerH + 4}
        textAnchor="end"
        fontSize={labelFs}
        fontWeight={900}
        fill="var(--ink)"
      >
        {fmtCents(lo, 0)}
      </text>

      {/* Rate-change ticks — the Nov 1 boundaries, named. */}
      {/* Wave U: the loop variable is `tick`, not `t` — `t` is the
          translator from useTranslation() above. */}
      {ticks.map((tick) => (
        <g key={tick.date}>
          <line
            x1={tick.x}
            y1={PAD.top}
            x2={tick.x}
            y2={PAD.top + innerH}
            stroke="var(--bad)"
            strokeWidth={2}
            strokeDasharray="5 4"
            data-testid="efficiency-rate-tick"
            data-date={tick.date}
          />
          {/* D3b — the rate word used to share the band labels' baseline,
              which is the crowding Mark saw at 390px. Its own row at the
              bottom of the plot is ~140 units below the band row, centred on
              the tick it names, with its descender clearing the axis line
              (`Math.round(labelFs * 0.45)`) at every label size. */}
          <text
            x={tick.x}
            y={PAD.top + innerH - Math.round(labelFs * 0.45)}
            textAnchor="middle"
            fontSize={labelFs}
            fontWeight={900}
            fill="var(--bad)"
          >
            {t('efficiency.ratesTick')}
          </text>
        </g>
      ))}

      {/* Regression over the verdict window. */}
      {regression.length > 1 && (
        <polyline
          points={regression.join(' ')}
          fill="none"
          stroke="var(--info)"
          strokeWidth={3}
          strokeDasharray="7 5"
          data-testid="efficiency-regression-line"
        />
      )}

      {/* The bills themselves. */}
      <polyline
        points={polyline}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={3}
        strokeLinejoin="round"
        strokeLinecap="round"
        data-testid="efficiency-series"
      />
      {points.map((p, i) => (
        <circle
          key={p.startDate}
          cx={x(i)}
          cy={y(p.cents)}
          r={3}
          fill="var(--ink)"
          /* The chart is decorative for screen readers, but the numbers it
             draws are the ones the browser check reads back — one circle per
             bill, with the audited ¢/kWh and the kWh it was divided by. */
          data-testid="efficiency-point"
          data-start={p.startDate}
          data-cents={p.cents.toFixed(2)}
          data-cents-incl-tax={p.centsInclTax.toFixed(2)}
          data-tax={p.tax.toFixed(2)}
          data-kwh={p.kwh.toFixed(1)}
        />
      ))}
      {last && (
        <circle
          cx={x(points.length - 1)}
          cy={y(last.cents)}
          r={6}
          fill="var(--chart-pace)"
          stroke="var(--ink)"
          strokeWidth={3}
        />
      )}

      {/* First and last period only — 24 monthly labels would be noise. */}
      <text x={PAD.left} y={H - 10} fontSize={labelFs} fontWeight={900} fill="var(--ink)">
        {first.label}
      </text>
      <text x={W - PAD.right} y={H - 10} textAnchor="end" fontSize={labelFs} fontWeight={900} fill="var(--ink)">
        {last.label}
      </text>
    </svg>
  );
}

export default function EfficiencyCard({ report, onOpenMoney }: EfficiencyCardProps) {
  const { t } = useTranslation();
  const { periods, allTime, trend } = report;

  if (!allTime || periods.length === 0) {
    return (
      <section
        data-testid="efficiency-card"
        className="bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-dashed border-edge text-ink"
      >
        <div className="flex items-center gap-3 mb-2">
          <span aria-hidden className="bg-hover p-2 rounded-xl border-2 border-edge">
            <Gauge size={20} strokeWidth={4} />
          </span>
          <h3 className="text-lg md:text-2xl italic font-black uppercase">{t('efficiency.title')}</h3>
        </div>
        <p data-testid="efficiency-empty" className="text-[11px] md:text-sm font-bold text-ink-2 normal-case">
          {trend.emptyMessage ?? t('efficiency.empty')}
        </p>
      </section>
    );
  }

  const first = periods[0];
  const last = periods[periods.length - 1];
  const ready = trend.ready && trend.verdict !== null;

  return (
    <section
      data-testid="efficiency-card"
      aria-labelledby="efficiency-heading"
      data-bills={periods.length}
      data-split={String(trend.splitAvailable)}
      className="relative z-[100] bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-edge text-ink"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-4">
        <span aria-hidden className="bg-inv text-accent-yellow p-2 md:p-3 rounded-xl border-2 md:border-4 border-edge">
          <Gauge size={22} strokeWidth={4} />
        </span>
        <div>
          <div
            className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-3 font-black uppercase"
            data-testid="efficiency-subtitle"
          >
            {t(EFFICIENCY_SUBTITLE_KEY)}
          </div>
          <h3 id="efficiency-heading" className="text-xl md:text-3xl italic font-black uppercase">
            {t('efficiency.title')}
          </h3>
        </div>

        {/* 1. The headline stat — BOTH readings of the same bills, side by
            side. The pre-tax number is the one the totals strip and the
            trend fit are built on; the incl-tax number is what the bill
            asked for before the rebate. Neither is "the" number, so neither
            gets to stand alone without saying which one it is. */}
        <div
          className="ml-auto bg-inv text-inv-ink px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-edge text-right"
          data-testid="efficiency-headline"
          data-cents={allTime.cents.toFixed(2)}
          data-cents-incl-tax={allTime.centsInclTax.toFixed(2)}
          data-tax={allTime.tax.toFixed(2)}
        >
          <div className="text-[8px] md:text-[10px] text-accent-yellow uppercase font-black">
            {t('efficiency.allTime', { count: allTime.bills })}
          </div>
          <div className="flex items-end justify-end gap-4 md:gap-6">
            <div>
              <div
                className="text-xl md:text-3xl italic font-black"
                data-testid="efficiency-all-time"
                data-cents={allTime.cents.toFixed(2)}
              >
                {fmtCents(allTime.cents, 1)}
                <span className="text-[10px] md:text-xs not-italic font-black ml-1">{t('efficiency.perKwh')}</span>
              </div>
              <div className="text-[8px] md:text-[10px] text-inv-ink-2 uppercase font-black">
                {t('efficiency.exclTax')}
              </div>
            </div>
            <div>
              <div
                className="text-xl md:text-3xl italic font-black text-accent-yellow"
                data-testid="efficiency-all-time-incl-tax"
                data-cents={allTime.centsInclTax.toFixed(2)}
              >
                {fmtCents(allTime.centsInclTax, 1)}
                <span className="text-[10px] md:text-xs not-italic font-black ml-1">{t('efficiency.perKwh')}</span>
              </div>
              <div className="text-[8px] md:text-[10px] text-inv-ink-2 uppercase font-black">
                {t('efficiency.inclTax')}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. The footnote that makes the pair legible: the rate the FILE
          states, and the two things these numbers are not. Derived from the
          loaded bills, never hardcoded — a file with no tax line says so. */}
      <p
        data-testid="efficiency-tax-footnote"
        data-tax-pct={impliedTaxPct(allTime) ?? ''}
        className="mb-3 text-[10px] md:text-xs font-bold text-ink-3 normal-case"
      >
        {taxFootnote(allTime)}
      </p>

      {/* 2. The verdict — read from the usage component, rates/delivery beside it. */}
      {ready ? (
        <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-3">
          <span
            data-testid="efficiency-trend-chip"
            data-verdict={trend.verdict}
            data-window={trend.windowSize}
            data-slope={(trend.slope ?? 0).toFixed(3)}
            data-usage-slope={(trend.usage?.slope ?? 0).toFixed(3)}
            data-delivery-slope={(trend.delivery?.slope ?? 0).toFixed(3)}
            data-rate-slope={(trend.rate?.slope ?? 0).toFixed(3)}
            data-net-slope={(trend.net?.slope ?? 0).toFixed(3)}
            data-stable-band={trend.band.toFixed(3)}
            className={`inline-flex items-center px-3 md:px-4 py-2 rounded-xl md:rounded-2xl border-4 border-edge font-black uppercase text-[11px] md:text-sm ${CHIP_CLASS[trend.verdict!]}`}
          >
            {t(CHIP_WORD_KEY[trend.verdict!])}{' '}
            <span className="ml-2 normal-case">
              {slopeText(t, trend.verdict!, trend.slope ?? 0, trend.band)}
            </span>
            <span className="ml-1 text-[9px] md:text-[11px] font-black">
              ({trend.windowLabel})
            </span>
          </span>

          <span
            data-testid="efficiency-rates-line"
            data-direction={trend.rateDirection ?? 'unknown'}
            className={`inline-flex items-center px-3 py-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge font-black text-[10px] md:text-xs ${
              trend.rateDirection === 'up'
                ? 'bg-bad-soft text-bad'
                : trend.rateDirection === 'down'
                  ? 'bg-good-soft text-good'
                  : 'bg-hover text-ink-2'
            }`}
          >
            {trend.rateDirection === 'flat'
              ? t('efficiency.ratesFlat', { band: fmtBand(trend.rate?.stderr ?? 0) })
              : trend.rateDirection === 'up' || trend.rateDirection === 'down'
                ? t('efficiency.ratesSlope', { slope: fmtSigned(trend.rate?.slope ?? 0) })
                : t('efficiency.ratesNotSplit')}
          </span>

          <span
            data-testid="efficiency-delivery-line"
            data-direction={trend.deliveryDirection ?? 'unknown'}
            className={`inline-flex items-center px-3 py-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge font-black text-[10px] md:text-xs ${
              trend.deliveryDirection === 'up'
                ? 'bg-warn-soft text-warn'
                : trend.deliveryDirection === 'down'
                  ? 'bg-good-soft text-good'
                  : 'bg-hover text-ink-2'
            }`}
          >
            {trend.deliveryDirection === 'flat'
              ? `${t('efficiency.deliveryFixed')} ±${fmtBand(trend.delivery?.stderr ?? 0)}¢`
              : trend.deliveryDirection === 'up'
                ? `${t('efficiency.deliveryFixed')} ${fmtSigned(trend.delivery?.slope ?? 0)}${t('efficiency.perPeriod')}`
                : trend.deliveryDirection === 'down'
                  ? `${t('efficiency.deliveryFixed')} ${fmtSigned(trend.delivery?.slope ?? 0)}${t('efficiency.perPeriod')}`
                  : t('efficiency.deliveryNotSplit')}
          </span>

          <span
            data-testid="efficiency-net-line"
            data-verdict={trend.netVerdict}
            className={`inline-flex items-center px-3 py-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge font-black text-[10px] md:text-xs ${
              trend.netVerdict === 'improving'
                ? 'bg-good-soft text-good'
                : trend.netVerdict === 'worsening'
                  ? 'bg-bad-soft text-bad'
                  : 'bg-hover text-ink-2'
            }`}
          >
            {trend.netVerdict === 'stable'
              ? t('efficiency.netStable', { band: fmtBand(trend.net?.stderr ?? 0) })
              : t('efficiency.netSlope', { slope: fmtSigned(trend.net?.slope ?? 0) })}
          </span>
        </div>
      ) : (
        <p
          data-testid="efficiency-trend-empty"
          className="mb-3 text-[11px] md:text-sm font-bold text-ink-2 normal-case"
        >
          {trend.emptyMessage}
        </p>
      )}

      {trend.sentence && (
        <p data-testid="efficiency-sentence" className="mb-3 text-[11px] md:text-sm font-bold text-ink-2 normal-case">
          {trend.sentence}
        </p>
      )}

      {/* 3 + 4. The mini-line, clickable through to the MONEY tab. */}
      <button
        type="button"
        onClick={onOpenMoney}
        data-testid="efficiency-open-money"
        className="block w-full text-left rounded-xl border-2 md:border-4 border-edge bg-inset hover:bg-card active:bg-hover transition-colors p-2 md:p-3 min-h-11 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-500"
      >
        {periods.length > 1 ? (
          <Chart points={periods} trend={trend} />
        ) : (
          <p className="text-[11px] font-bold text-ink-2 normal-case">
            {t('efficiency.oneBill')}
          </p>
        )}
        <span
          className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[9px] md:text-[11px] font-black uppercase text-ink-3"
          data-testid="efficiency-range"
          data-first-cents={first.cents.toFixed(2)}
          data-first-cents-incl-tax={first.centsInclTax.toFixed(2)}
          data-last-cents={last.cents.toFixed(2)}
          data-last-cents-incl-tax={last.centsInclTax.toFixed(2)}
        >
          <span>
            {t('efficiency.firstLast', {
              firstLabel: first.label,
              firstExcl: fmtCents(first.cents, 1),
              firstIncl: fmtCents(first.centsInclTax, 1),
              lastLabel: last.label,
              lastExcl: fmtCents(last.cents, 1),
              lastIncl: fmtCents(last.centsInclTax, 1),
            })}
          </span>
          <span className="text-info">{t('efficiency.openMoney')}</span>
        </span>
      </button>

      <p className="mt-3 text-[10px] md:text-xs font-bold text-ink-2 normal-case">
        {trend.splitAvailable
          ? t('efficiency.splitNote')
          : (trend.splitNote ?? t('efficiency.splitUnavailable'))}
        {' '}{trend.rateBoundaries.length > 0
          ? t('efficiency.bandsNote', {
              dates: trend.rateBoundaries
                .map((d) => fmtDateLong(new Date(`${d}T00:00:00`)))
                .join(', '),
            })
          : t('efficiency.bandsNoteNone')}
      </p>
    </section>
  );
}
