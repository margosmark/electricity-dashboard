/**
 * Wave R — the bill accrual curve: cumulative cost inside the OPEN billing
 * period against a pace line.
 *
 * The projection banner says what the month will cost; this says whether you
 * can SEE it coming. Days that have happened accumulate into a black line,
 * a dashed pace line runs from the start of the period to where your current
 * run-rate lands, and the gap between them at today is printed as a number —
 * so "am I on pace for a big bill?" is answerable without arithmetic.
 *
 * Deliberately hand-drawn SVG rather than Recharts: it is two lines and a
 * marker, the recharts chunk is a ~651 KB vendor bundle this app works hard
 * to keep off the critical path (Wave I item 4), and a first visit should not
 * pay for a chart it may never open. The numbers the chart draws are all
 * ALSO printed as text below it — the SVG is marked decorative, so a screen
 * reader gets the same verdict a sighted user gets from the picture.
 */

'use client';

import { useMemo } from 'react';
import { format } from 'date-fns';
import { TrendingUp } from 'lucide-react';
import {
  buildAccrualCurve,
  type AccrualCurve,
  type AccrualPlan,
} from '@/lib/billAccrual';
import type { BillProjection } from '@/lib/billProjection';
import type { ProcessedPoint } from '@/lib/energy';

export type BillAccrualCurveProps = {
  /** Every priced reading — the open period is wider than the chart window. */
  rows: ProcessedPoint[];
  plan: AccrualPlan;
  /** The open (unbilled) period from Wave Q's axis; null = nothing to accrue. */
  period: { start: number; end: number } | null;
  projection: BillProjection;
  /** Injectable so the test is not a function of today's date. */
  today?: Date;
};

const W = 720;
const H = 240;
const PAD = { top: 18, right: 16, bottom: 30, left: 54 };

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function Chart({ curve }: { curve: AccrualCurve }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const maxY = Math.max(curve.projectedTotal, curve.total, 1) * 1.1;
  const x = (dayIndex: number) =>
    PAD.left + (dayIndex / Math.max(1, curve.daysInPeriod)) * innerW;
  const y = (value: number) => PAD.top + innerH - (value / maxY) * innerH;

  const actual = curve.points
    .map((point, index) => `${x(index + 1)},${y(point.cumulative)}`)
    .join(' ');
  const todayX = x(curve.daysElapsed);
  const last = curve.points[curve.points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      aria-hidden="true"
      data-testid="accrual-chart"
    >
      {/* Frame */}
      <line x1={PAD.left} y1={PAD.top + innerH} x2={W - PAD.right} y2={PAD.top + innerH} stroke="#000" strokeWidth={2} />
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerH} stroke="#000" strokeWidth={2} />

      {/* $0 + the top of the scale, labelled */}
      <text x={PAD.left - 8} y={PAD.top + innerH + 4} textAnchor="end" fontSize={11} fontWeight={900} fill="#000">
        $0
      </text>
      <text x={PAD.left - 8} y={PAD.top + 8} textAnchor="end" fontSize={11} fontWeight={900} fill="#000">
        {money(maxY)}
      </text>

      {/* Pace line: the whole period, so the empty half is the point. */}
      <line
        x1={x(0)}
        y1={y(0)}
        x2={x(curve.daysInPeriod)}
        y2={y(curve.projectedTotal)}
        stroke="#2563eb"
        strokeWidth={3}
        strokeDasharray="8 6"
        data-testid="accrual-pace-line"
      />
      <text
        x={x(curve.daysInPeriod) - 4}
        y={y(curve.projectedTotal) - 8}
        textAnchor="end"
        fontSize={11}
        fontWeight={900}
        fill="#2563eb"
      >
        pace {money(curve.projectedTotal)}
      </text>

      {/* Today: how far into the period the black line is allowed to reach. */}
      <line x1={todayX} y1={PAD.top} x2={todayX} y2={PAD.top + innerH} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />

      {/* The accrual itself. */}
      <polyline
        points={actual}
        fill="none"
        stroke="#000"
        strokeWidth={4}
        strokeLinejoin="round"
        strokeLinecap="round"
        data-testid="accrual-actual-line"
      />
      {last && (
        <circle cx={x(curve.points.length)} cy={y(last.cumulative)} r={6} fill="#facc15" stroke="#000" strokeWidth={3} />
      )}

      {/* x labels: period start, today, period end */}
      <text x={PAD.left} y={H - 10} fontSize={11} fontWeight={900} fill="#000">
        {curve.periodStart}
      </text>
      <text x={todayX} y={H - 10} fontSize={11} fontWeight={900} fill="#000" textAnchor="middle">
        today
      </text>
      <text x={W - PAD.right} y={H - 10} fontSize={11} fontWeight={900} fill="#000" textAnchor="end">
        {curve.periodEnd}
      </text>
    </svg>
  );
}

export default function BillAccrualCurve({
  rows,
  plan,
  period,
  projection,
  today,
}: BillAccrualCurveProps) {
  const now = useMemo(() => today ?? new Date(), [today]);
  const curve = useMemo(
    () => buildAccrualCurve({ rows, plan, period, today: now, projection }),
    [rows, plan, period, now, projection],
  );

  if (curve.points.length === 0) {
    return (
      <section
        data-testid="bill-accrual"
        aria-labelledby="accrual-heading"
        className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-dashed border-black text-black font-black uppercase"
      >
        <h3 id="accrual-heading" className="text-xl md:text-3xl italic mb-2">
          Bill accrual — am I on pace?
        </h3>
        <p data-testid="accrual-empty" className="text-[11px] md:text-sm font-bold normal-case text-slate-600">
          {curve.note}
        </p>
      </section>
    );
  }

  const { gap, overPace } = curve;
  const verdict =
    overPace === null
      ? 'No pace line yet'
      : Math.abs(gap) < 0.01
        ? 'Exactly on the line'
        : overPace
          ? `Ahead of the line by ${money(gap)}`
          : `Behind the line by ${money(-gap)}`;

  return (
    <section
      data-testid="bill-accrual"
      aria-labelledby="accrual-heading"
      data-pace-source={curve.paceSource}
      data-days-elapsed={curve.daysElapsed}
      data-days-in-period={curve.daysInPeriod}
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-4 md:mb-6">
        <span aria-hidden className="bg-black text-yellow-400 p-2 md:p-3 rounded-xl border-2 md:border-4 border-black">
          <TrendingUp size={22} strokeWidth={4} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-slate-400 font-black uppercase">
            {format(new Date(`${curve.periodStart}T12:00:00`), 'MMM d')} – {format(new Date(`${curve.periodEnd}T12:00:00`), 'MMM d, yyyy')} · open period
          </div>
          <h3 id="accrual-heading" className="text-xl md:text-3xl italic font-black uppercase text-black">
            Bill accrual — am I on pace?
          </h3>
        </div>
      </div>

      <Chart curve={curve} />

      {/* The chart is decorative; every number it draws is here as text. */}
      <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <div className="bg-black text-white p-3 md:p-4 rounded-xl border-4 border-black">
          <div className="text-[8px] md:text-[10px] uppercase text-yellow-400 font-black">Accrued so far</div>
          <div className="text-lg md:text-2xl italic font-black" data-testid="accrual-total">
            {money(curve.total)}
          </div>
          <div className="text-[8px] font-black text-slate-400 normal-case">
            {curve.coveredDays} of {curve.daysElapsed} days measured
          </div>
        </div>
        <div className="bg-blue-50 p-3 md:p-4 rounded-xl border-4 border-black">
          <div className="text-[8px] md:text-[10px] uppercase text-slate-500 font-black">Pace to date</div>
          <div className="text-lg md:text-2xl italic font-black" data-testid="accrual-pace">
            {money(curve.paceToDate)}
          </div>
          <div className="text-[8px] font-black text-slate-500 normal-case">{money(curve.paceDaily)}/day</div>
        </div>
        <div className="bg-yellow-400 p-3 md:p-4 rounded-xl border-4 border-black">
          <div className="text-[8px] md:text-[10px] uppercase font-black">Landing at</div>
          <div className="text-lg md:text-2xl italic font-black" data-testid="accrual-projected">
            {money(curve.projectedTotal)}
          </div>
          <div className="text-[8px] font-black normal-case">this period, at your current run-rate</div>
        </div>
        <div
          className={`p-3 md:p-4 rounded-xl border-4 border-black ${
            overPace === null ? 'bg-slate-100' : overPace ? 'bg-red-400' : 'bg-emerald-300'
          }`}
        >
          <div className="text-[8px] md:text-[10px] uppercase font-black">vs the pace line</div>
          <div className="text-sm md:text-xl italic font-black" data-testid="accrual-verdict">
            {verdict}
          </div>
          <div className="text-[8px] font-black normal-case">
            {curve.daysElapsed} of {curve.daysInPeriod} days in
          </div>
        </div>
      </div>

      <p data-testid="accrual-note" className="mt-4 text-[10px] md:text-xs font-bold text-slate-600 normal-case">
        {curve.note} Commodity (variable) charges only — no delivery, regulatory charges or HST.
      </p>
    </section>
  );
}
