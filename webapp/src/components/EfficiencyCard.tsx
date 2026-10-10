/**
 * Wave S — the EFFICIENCY card: what a kWh cost, whether that is getting
 * better, and — the part that keeps the verdict honest — which half of the
 * movement you caused.
 *
 * Contents, in decision order:
 *   1. the headline stat: all-time kWh-weighted ¢/kWh (the same number the
 *      totals strip quotes, stated once as THE number);
 *   2. the trend chip, read from the USAGE component of the split — what
 *      your commodity would cost at today's rates — with the rate component,
 *      delivery/other and the net printed beside it, because a slope that
 *      includes an OEB rate bump (or the fixed delivery charge spread over a
 *      winter's worth of kWh) is a lie in green ink;
 *   3. the mini-line: every closed bill's ¢/kWh, the regression over the
 *      verdict window, Nov 1 rate-change ticks, and winter/summer bands —
 *      summer bills are structurally cheaper per kWh (off-peak dominates and
 *      the fixed delivery charge spreads over 2.5× the kWh), and the bands
 *      say so instead of letting the eye infer genius;
 *   4. a click through to the MONEY tab, where the same bills are broken
 *      apart.
 *
 * Deliberately hand-drawn SVG rather than Recharts: the recharts chunk is a
 * ~651 KB vendor bundle this app keeps off the critical path (Wave I item 4),
 * and a first visit should not pay for a 24-point sparkline. The chart is
 * decorative — every number it draws is also printed as text, so a screen
 * reader gets the same verdict a sighted user gets from the picture.
 */

'use client';

import React, { useMemo } from 'react';
import { format } from 'date-fns';
import { Gauge } from 'lucide-react';

import { seasonSegments, type Season } from '@/lib/season';
import {
  fmtBand,
  fmtSigned,
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
const PAD = { top: 22, right: 16, bottom: 30, left: 46 };

const SEASON_FILL: Record<Season, string> = {
  winter: '#e2e8f0',
  summer: '#fef3c7',
};

const CHIP_CLASS: Record<TrendVerdict, string> = {
  improving: 'bg-emerald-400',
  worsening: 'bg-red-400',
  stable: 'bg-slate-200',
};

const CHIP_WORD: Record<TrendVerdict, string> = {
  improving: 'IMPROVING',
  worsening: 'WORSENING',
  stable: 'STABLE',
};

/** Signed slope with its unit; the stable case quotes the band instead. */
function slopeText(verdict: TrendVerdict, slope: number, band: number): string {
  return verdict === 'stable'
    ? `±${fmtBand(band)}¢/kWh per period`
    : `${fmtSigned(slope)}¢/kWh per period`;
}

function Chart({
  points,
  trend,
}: {
  points: PeriodEfficiency[];
  trend: EfficiencyTrend;
}) {
  const geometry = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const n = points.length;
    const step = innerW / Math.max(1, n);
    const x = (i: number) => PAD.left + step * (i + 0.5);

    const values = points.map((p) => p.cents);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
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
  }, [points, trend]);

  const { innerH, lo, hi, x, y, bands, ticks, regression, polyline } = geometry;
  const last = points[points.length - 1];
  const first = points[0];

  return (
    <svg
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
          {b.bars >= 3 && (
            <text
              x={(b.x1 + b.x2) / 2}
              y={PAD.top + 12}
              textAnchor="middle"
              fontSize={10}
              fontWeight={900}
              fill="#334155"
            >
              {b.season === 'winter' ? 'Winter' : 'Summer'}
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
        stroke="#000"
        strokeWidth={2}
      />
      <line
        x1={PAD.left}
        y1={PAD.top}
        x2={PAD.left}
        y2={PAD.top + innerH}
        stroke="#000"
        strokeWidth={2}
      />
      <text x={PAD.left - 6} y={PAD.top + 8} textAnchor="end" fontSize={10} fontWeight={900} fill="#000">
        {hi.toFixed(0)}¢
      </text>
      <text
        x={PAD.left - 6}
        y={PAD.top + innerH + 4}
        textAnchor="end"
        fontSize={10}
        fontWeight={900}
        fill="#000"
      >
        {lo.toFixed(0)}¢
      </text>

      {/* Rate-change ticks — the Nov 1 boundaries, named. */}
      {ticks.map((t) => (
        <g key={t.date}>
          <line
            x1={t.x}
            y1={PAD.top}
            x2={t.x}
            y2={PAD.top + innerH}
            stroke="#b91c1c"
            strokeWidth={2}
            strokeDasharray="5 4"
            data-testid="efficiency-rate-tick"
            data-date={t.date}
          />
          <text
            x={t.x + 3}
            y={PAD.top + 12}
            fontSize={9}
            fontWeight={900}
            fill="#b91c1c"
          >
            rates
          </text>
        </g>
      ))}

      {/* Regression over the verdict window. */}
      {regression.length > 1 && (
        <polyline
          points={regression.join(' ')}
          fill="none"
          stroke="#2563eb"
          strokeWidth={3}
          strokeDasharray="7 5"
          data-testid="efficiency-regression-line"
        />
      )}

      {/* The bills themselves. */}
      <polyline
        points={polyline}
        fill="none"
        stroke="#000"
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
          fill="#000"
          /* The chart is decorative for screen readers, but the numbers it
             draws are the ones the browser check reads back — one circle per
             bill, with the audited ¢/kWh and the kWh it was divided by. */
          data-testid="efficiency-point"
          data-start={p.startDate}
          data-cents={p.cents.toFixed(2)}
          data-kwh={p.kwh.toFixed(1)}
        />
      ))}
      {last && (
        <circle
          cx={x(points.length - 1)}
          cy={y(last.cents)}
          r={6}
          fill="#facc15"
          stroke="#000"
          strokeWidth={3}
        />
      )}

      {/* First and last period only — 24 monthly labels would be noise. */}
      <text x={PAD.left} y={H - 10} fontSize={10} fontWeight={900} fill="#000">
        {first.label}
      </text>
      <text x={W - PAD.right} y={H - 10} textAnchor="end" fontSize={10} fontWeight={900} fill="#000">
        {last.label}
      </text>
    </svg>
  );
}

export default function EfficiencyCard({ report, onOpenMoney }: EfficiencyCardProps) {
  const { periods, allTime, trend } = report;

  if (!allTime || periods.length === 0) {
    return (
      <section
        data-testid="efficiency-card"
        className="bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-dashed border-black text-black"
      >
        <div className="flex items-center gap-3 mb-2">
          <span aria-hidden className="bg-slate-100 p-2 rounded-xl border-2 border-black">
            <Gauge size={20} strokeWidth={4} />
          </span>
          <h3 className="text-lg md:text-2xl italic font-black uppercase">Efficiency</h3>
        </div>
        <p data-testid="efficiency-empty" className="text-[11px] md:text-sm font-bold text-slate-600 normal-case">
          {trend.emptyMessage ?? 'Upload a Green Button export to see what a kWh cost you.'}
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
      className="relative z-[100] bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black text-black"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-4">
        <span aria-hidden className="bg-black text-yellow-400 p-2 md:p-3 rounded-xl border-2 md:border-4 border-black">
          <Gauge size={22} strokeWidth={4} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-slate-500 font-black uppercase">
            ¢ per kilowatt-hour · Total Electricity Charges ÷ billed kWh
          </div>
          <h3 id="efficiency-heading" className="text-xl md:text-3xl italic font-black uppercase">
            Efficiency
          </h3>
        </div>

        {/* 1. The headline stat. */}
        <div className="ml-auto bg-black text-white px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-black text-right">
          <div className="text-[8px] md:text-[10px] text-yellow-400 uppercase font-black">
            All time · {allTime.bills} bills
          </div>
          <div
            className="text-xl md:text-3xl italic font-black"
            data-testid="efficiency-all-time"
            data-cents={allTime.cents.toFixed(2)}
          >
            {allTime.cents.toFixed(1)}¢
            <span className="text-[10px] md:text-xs not-italic font-black ml-1">/kWh</span>
          </div>
        </div>
      </div>

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
            className={`inline-flex items-center px-3 md:px-4 py-2 rounded-xl md:rounded-2xl border-4 border-black font-black uppercase text-[11px] md:text-sm ${CHIP_CLASS[trend.verdict!]}`}
          >
            {CHIP_WORD[trend.verdict!]}{' '}
            <span className="ml-2 normal-case">
              {slopeText(trend.verdict!, trend.slope ?? 0, trend.band)}
            </span>
            <span className="ml-1 text-[9px] md:text-[11px] font-black">
              ({trend.windowLabel})
            </span>
          </span>

          <span
            data-testid="efficiency-rates-line"
            data-direction={trend.rateDirection ?? 'unknown'}
            className={`inline-flex items-center px-3 py-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black text-[10px] md:text-xs ${
              trend.rateDirection === 'up'
                ? 'bg-red-100 text-red-800'
                : trend.rateDirection === 'down'
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'bg-slate-100 text-slate-600'
            }`}
          >
            {trend.rateDirection === 'flat'
              ? `rates flat ±${fmtBand(trend.rate?.stderr ?? 0)}¢`
              : trend.rateDirection === 'up'
                ? `rates ${fmtSigned(trend.rate?.slope ?? 0)}¢/period`
                : trend.rateDirection === 'down'
                  ? `rates ${fmtSigned(trend.rate?.slope ?? 0)}¢/period`
                  : 'rates: not split'}
          </span>

          <span
            data-testid="efficiency-delivery-line"
            data-direction={trend.deliveryDirection ?? 'unknown'}
            className={`inline-flex items-center px-3 py-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black text-[10px] md:text-xs ${
              trend.deliveryDirection === 'up'
                ? 'bg-amber-50 text-amber-800'
                : trend.deliveryDirection === 'down'
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'bg-slate-100 text-slate-600'
            }`}
          >
            {trend.deliveryDirection === 'flat'
              ? `delivery & fixed ±${fmtBand(trend.delivery?.stderr ?? 0)}¢`
              : trend.deliveryDirection === 'up'
                ? `delivery & fixed ${fmtSigned(trend.delivery?.slope ?? 0)}¢/period`
                : trend.deliveryDirection === 'down'
                  ? `delivery & fixed ${fmtSigned(trend.delivery?.slope ?? 0)}¢/period`
                  : 'delivery & fixed: not split'}
          </span>

          <span
            data-testid="efficiency-net-line"
            data-verdict={trend.netVerdict}
            className={`inline-flex items-center px-3 py-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black text-[10px] md:text-xs ${
              trend.netVerdict === 'improving'
                ? 'bg-emerald-50 text-emerald-800'
                : trend.netVerdict === 'worsening'
                  ? 'bg-red-50 text-red-800'
                  : 'bg-slate-100 text-slate-600'
            }`}
          >
            {trend.netVerdict === 'stable'
              ? `net stable ±${fmtBand(trend.net?.stderr ?? 0)}¢`
              : `net ${fmtSigned(trend.net?.slope ?? 0)}¢/period`}
          </span>
        </div>
      ) : (
        <p
          data-testid="efficiency-trend-empty"
          className="mb-3 text-[11px] md:text-sm font-bold text-slate-600 normal-case"
        >
          {trend.emptyMessage}
        </p>
      )}

      {trend.sentence && (
        <p data-testid="efficiency-sentence" className="mb-3 text-[11px] md:text-sm font-bold text-slate-700 normal-case">
          {trend.sentence}
        </p>
      )}

      {/* 3 + 4. The mini-line, clickable through to the MONEY tab. */}
      <button
        type="button"
        onClick={onOpenMoney}
        data-testid="efficiency-open-money"
        className="block w-full text-left rounded-xl border-2 md:border-4 border-black bg-slate-50 hover:bg-white active:bg-slate-100 transition-colors p-2 md:p-3 min-h-11 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-500"
      >
        {periods.length > 1 ? (
          <Chart points={periods} trend={trend} />
        ) : (
          <p className="text-[11px] font-bold text-slate-600 normal-case">
            One bill so far — the line starts at your second.
          </p>
        )}
        <span
          className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[9px] md:text-[11px] font-black uppercase text-slate-500"
          data-testid="efficiency-range"
        >
          <span>
            {first.label}: {first.cents.toFixed(1)}¢ → {last.label}: {last.cents.toFixed(1)}¢
          </span>
          <span className="text-blue-700">Open the Money tab →</span>
        </span>
      </button>

      <p className="mt-3 text-[10px] md:text-xs font-bold text-slate-600 normal-case">
        {trend.splitAvailable
          ? 'Usage prices YOUR commodity at today’s OEB rates; the rate line is what the schedule did instead. Delivery & fixed is the rest of the bill — no public rate schedule to reprice, so it is reported beside the verdict, never credited with it.'
          : (trend.splitNote ?? 'Usage/rate split unavailable.')}
        {' '}Bands are Ontario’s rate seasons (Nov 1 – Apr 30 winter); red ticks are rate changes:{' '}
        {trend.rateBoundaries.length > 0
          ? trend.rateBoundaries.map((d) => format(new Date(`${d}T00:00:00`), 'MMM d, yyyy')).join(', ')
          : 'none inside this data'}.
      </p>
    </section>
  );
}
