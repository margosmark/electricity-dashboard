/**
 * Wave R — the bill accrual curve: cumulative cost inside the OPEN billing
 * period against a pace line.
 *
 * The projection banner says what the month will cost; this says whether you
 * can SEE it coming. Days that have happened accumulate into a grey line,
 * a dashed pace line runs from the start of the period to where your current
 * run-rate lands BY THE BILL DATE (not by the newest reading — a chart that
 * stops at today has no future to be on pace for), and the gap between them
 * at today is printed as a number — so "am I on pace for a big bill?" is
 * answerable without arithmetic.
 *
 * Slice 7 — the card answers its own question at a glance:
 *
 *   • the headline is the projected landing ("$X by Oct 25"), not a period
 *     label the reader has to interpret;
 *   • the pacing chip judges that landing against the last ≤3 bills'
 *     commodity charge — green below, red above — so "am I on pace?" is a
 *     COLOUR before it is a number;
 *   • one fixed explainer sentence names every line on the chart, so the
 *     picture never needs a legend hunt;
 *   • on Tiered plans the prorated tier-1 allowance gets a vertical marker:
 *     the day the cheap rate runs out;
 *   • on a phone the card shows headline + chip + a sparkline, and the full
 *     chart is one tap away — a 720-wide chart squashed into 390 px is a
 *     grey smear, not a picture.
 *
 * Deliberately hand-drawn SVG rather than Recharts: it is three lines and a
 * marker, the recharts chunk is a ~651 KB vendor bundle this app works hard
 * to keep off the critical path (Wave I item 4), and a first visit should not
 * pay for a chart it may never open. The numbers the chart draws are all
 * ALSO printed as text below it — the SVG is marked decorative, so a screen
 * reader gets the same verdict a sighted user gets from the picture.
 */

'use client';

import { fmtDate, fmtMoney, useTranslation } from '@/i18n';
import { useId, useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  buildAccrualCurve,
  priorBillCommodities,
  type AccrualBillDateSource,
  type AccrualCurve,
  type AccrualPlan,
} from '@/lib/billAccrual';
import type { BillProjection } from '@/lib/billProjection';
import type { ProcessedPoint, UsageSummary } from '@/lib/energy';

export type BillAccrualCurveProps = {
  /** Every priced reading — the open period is wider than the chart window. */
  rows: ProcessedPoint[];
  plan: AccrualPlan;
  /** The open (unbilled) period from Wave Q's axis; null = nothing to accrue. */
  period: { start: number; end: number } | null;
  projection: BillProjection;
  /**
   * Bills already in the file — the benchmark the landing is judged against.
   * Their commodity charges (never their amounts due: the accrual is
   * commodity-only, and comparing the two would always read "you're below").
   */
  summaries?: UsageSummary[];
  /**
   * When this period will be billed through (exclusive boundary, same
   * convention as `period.end`). Null = the pace line lands on the period's
   * own end. Computed by the caller from the axis's billing cadence.
   */
  billDate?: { at: number; source: AccrualBillDateSource } | null;
  /** Injectable so the test is not a function of today's date. */
  today?: Date;
};

const W = 720;
const H = 240;
const PAD = { top: 18, right: 16, bottom: 30, left: 54 };
/** Sparkline geometry for the phone shape — no axes, no labels, just shape. */
const SPARK_W = 340;
const SPARK_H = 92;
const SPARK_PAD = { top: 8, right: 6, bottom: 8, left: 6 };

/** The one sentence that explains every line. Fixed copy, by design. */
export const ACCRUAL_EXPLAINER =
  'Grey line = spent so far this period (your estimate). Yellow dashed = where you’re on pace to land by the bill date. Dotted = your average of the last 3 bills.';
/** Wave U — the display translates; ACCRUAL_EXPLAINER stays canonical. */
export const ACCRUAL_EXPLAINER_KEY = 'accrual.explainer';

function money(n: number): string {
  return fmtMoney(n);
}

/** ms per day — used only on yyyy-MM-dd stamps, so no DST can skew it. */
const MS_PER_DAY = 86_400_000;

/**
 * Index of a `yyyy-MM-dd` day counted from a `yyyy-MM-dd` start.
 *
 * Parsing both at UTC midnight keeps the subtraction in whole days: the same
 * stamps parsed as local time drift by an hour twice a year, and a day count
 * that is wrong by one paints a reference line on the wrong date.
 */
function dayIndexFrom(start: string, day: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / MS_PER_DAY));
}

function Chart({ curve }: { curve: AccrualCurve }) {
  const { t } = useTranslation();
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const maxY =
    Math.max(curve.projectedTotal, curve.total, curve.avgPriorBill ?? 0, 1) * 1.1;
  const x = (dayIndex: number) =>
    PAD.left + (dayIndex / Math.max(1, curve.daysInPeriod)) * innerW;
  const y = (value: number) => PAD.top + innerH - (value / maxY) * innerH;

  const actual = curve.points
    .map((point, index) => `${x(index + 1)},${y(point.cumulative)}`)
    .join(' ');
  const todayX = x(curve.daysElapsed);
  const last = curve.points[curve.points.length - 1];
  // The crossing is often a PROJECTION past the drawn data — findIndex then
  // returns -1, and x(-1 + 1) painted "tier 2" on the left edge of the chart,
  // i.e. exactly opposite the date the note gives. Fall back to counting days
  // from the period start, which lands on the same index when the day IS in
  // the points and on the right future date when it is not.
  const crossingIdx = curve.tierCrossingDay
    ? curve.points.findIndex((p) => p.day === curve.tierCrossingDay)
    : -1;
  const tierX = curve.tierCrossingDay
    ? x(
        (crossingIdx >= 0 ? crossingIdx : dayIndexFrom(curve.periodStart, curve.tierCrossingDay)) + 1,
      )
    : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      aria-hidden="true"
      data-testid="accrual-chart"
    >
      {/* Frame */}
      <line x1={PAD.left} y1={PAD.top + innerH} x2={W - PAD.right} y2={PAD.top + innerH} stroke="var(--ink)" strokeWidth={2} />
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerH} stroke="var(--ink)" strokeWidth={2} />

      {/* $0 + the top of the scale, labelled */}
      <text x={PAD.left - 8} y={PAD.top + innerH + 4} textAnchor="end" fontSize={11} fontWeight={900} fill="var(--ink)">
        $0
      </text>
      <text x={PAD.left - 8} y={PAD.top + 8} textAnchor="end" fontSize={11} fontWeight={900} fill="var(--ink)">
        {money(maxY)}
      </text>

      {/* Tier 1 runs out here (Tiered plans only): everything to the right
          of this line bills at the tier-2 rate, which the accrual does not
          include. Projected crossings are drawn lighter — they are a
          forecast, not a fact. */}
      {tierX !== null && (
        <>
          <line
            x1={tierX}
            y1={PAD.top}
            x2={tierX}
            y2={PAD.top + innerH}
            stroke="#7C3AED"
            strokeWidth={2}
            strokeDasharray="6 4"
            opacity={curve.tierCrossingProjected ? 0.45 : 1}
            data-testid="accrual-tier-marker"
          />
          <text
            x={tierX + 4}
            y={PAD.top + 12}
            fontSize={10}
            fontWeight={900}
            fill="#7C3AED"
            opacity={curve.tierCrossingProjected ? 0.6 : 1}
          >
            {t('accrual.tierTwoArrow')}
          </text>
        </>
      )}

      {/* The benchmark: the last ≤3 bills' commodity charge, as a level. */}
      {curve.avgPriorBill !== null && (
        <>
          <line
            x1={PAD.left}
            y1={y(curve.avgPriorBill)}
            x2={W - PAD.right}
            y2={y(curve.avgPriorBill)}
            stroke="var(--ink)"
            strokeWidth={3}
            strokeDasharray="1 6"
            strokeLinecap="round"
            data-testid="accrual-benchmark-line"
          />
          <text
            x={W - PAD.right - 4}
            y={y(curve.avgPriorBill) - 6}
            textAnchor="end"
            fontSize={11}
            fontWeight={900}
            fill="var(--ink)"
          >
            {t('accrual.threeBillAvg')} {money(curve.avgPriorBill)}
          </text>
        </>
      )}

      {/* Pace line: the whole period to the bill date, so the empty future
          is the point — this is where you are heading. Drawn twice: a black
          casing (yellow on white is a 1.4:1 line, invisible on a projector
          and to low-vision readers) with the yellow dashed line on top, so
          it reads as one yellow dashed line with an outline. */}
      <line
        x1={x(0)}
        y1={y(0)}
        x2={x(curve.daysInPeriod)}
        y2={y(curve.projectedTotal)}
        stroke="var(--ink)"
        strokeWidth={7}
        strokeDasharray="10 6"
        strokeLinecap="butt"
      />
      <line
        x1={x(0)}
        y1={y(0)}
        x2={x(curve.daysInPeriod)}
        y2={y(curve.projectedTotal)}
        stroke="#FACC15"
        strokeWidth={4}
        strokeDasharray="10 6"
        data-testid="accrual-pace-line"
      />
      <text
        x={x(curve.daysInPeriod) - 4}
        y={y(curve.projectedTotal) - 8}
        textAnchor="end"
        fontSize={11}
        fontWeight={900}
        fill="var(--ink)"
      >
        {money(curve.projectedTotal)} {t('accrual.by')} {curve.billDate}
      </text>

      {/* Today: how far into the period the grey line is allowed to reach. */}
      <line x1={todayX} y1={PAD.top} x2={todayX} y2={PAD.top + innerH} stroke="var(--ink-4)" strokeWidth={1} strokeDasharray="3 3" />

      {/* The accrual itself — the money already spent. */}
      <polyline
        points={actual}
        fill="none"
        stroke="var(--ink-3)"
        strokeWidth={4}
        strokeLinejoin="round"
        strokeLinecap="round"
        data-testid="accrual-actual-line"
      />
      {last && (
        <circle cx={x(curve.points.length)} cy={y(last.cumulative)} r={6} fill="#FACC15" stroke="var(--ink)" strokeWidth={3} />
      )}

      {/* x labels: period start, today, bill date */}
      <text x={PAD.left} y={H - 10} fontSize={11} fontWeight={900} fill="var(--ink)">
        {curve.periodStart}
      </text>
      <text x={todayX} y={H - 10} fontSize={11} fontWeight={900} fill="var(--ink)" textAnchor="middle">
        {t('accrual.todayAxis')}
      </text>
      <text x={W - PAD.right} y={H - 10} fontSize={11} fontWeight={900} fill="var(--ink)" textAnchor="end">
        {t('accrual.billAxis')} {curve.billDate}
      </text>
    </svg>
  );
}

/** The phone shape: the same two lines, no furniture. */
function Sparkline({ curve }: { curve: AccrualCurve }) {
  const innerW = SPARK_W - SPARK_PAD.left - SPARK_PAD.right;
  const innerH = SPARK_H - SPARK_PAD.top - SPARK_PAD.bottom;
  const maxY = Math.max(curve.projectedTotal, curve.total, 1) * 1.1;
  const x = (dayIndex: number) =>
    SPARK_PAD.left + (dayIndex / Math.max(1, curve.daysInPeriod)) * innerW;
  const y = (value: number) => SPARK_PAD.top + innerH - (value / maxY) * innerH;
  const actual = curve.points
    .map((point, index) => `${x(index + 1)},${y(point.cumulative)}`)
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="w-full"
      aria-hidden="true"
      data-testid="accrual-sparkline"
    >
      <line
        x1={x(0)}
        y1={y(0)}
        x2={x(curve.daysInPeriod)}
        y2={y(curve.projectedTotal)}
        stroke="var(--ink)"
        strokeWidth={5}
        strokeDasharray="8 5"
      />
      <line
        x1={x(0)}
        y1={y(0)}
        x2={x(curve.daysInPeriod)}
        y2={y(curve.projectedTotal)}
        stroke="#FACC15"
        strokeWidth={3}
        strokeDasharray="8 5"
      />
      <polyline
        points={actual}
        fill="none"
        stroke="var(--ink-3)"
        strokeWidth={3}
        strokeLinejoin="round"
        strokeLinecap="round"
        data-testid="accrual-sparkline-actual"
      />
    </svg>
  );
}

export default function BillAccrualCurve({
  rows,
  plan,
  period,
  projection,
  summaries = [],
  billDate,
  today,
}: BillAccrualCurveProps) {
  const { t, locale } = useTranslation();
  // Wave U — month abbreviations follow the toggle ("Aug 26" / "26 août").
  const billDatePattern = locale === 'fr' ? 'd MMM' : 'MMM d';
  const [showFull, setShowFull] = useState(false);
  const explainerId = useId();
  const now = useMemo(() => today ?? new Date(), [today]);
  const priorBills = useMemo(() => priorBillCommodities(summaries), [summaries]);
  const curve = useMemo(
    () =>
      buildAccrualCurve({
        rows,
        plan,
        period,
        today: now,
        projection,
        billDate,
        priorBills,
      }),
    [rows, plan, period, now, projection, billDate, priorBills],
  );

  if (curve.points.length === 0) {
    return (
      <section
        data-testid="bill-accrual"
        aria-labelledby="accrual-heading"
        className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-dashed border-edge text-ink font-black uppercase"
      >
        <h3 id="accrual-heading" className="text-xl md:text-3xl italic mb-2">
          {t('accrual.isMyBillOnPace')}
        </h3>
        <p data-testid="accrual-empty" className="text-[11px] md:text-sm font-bold normal-case text-ink-2">
          {curve.note}
        </p>
      </section>
    );
  }

  const { gap, overPace } = curve;
  const verdict =
    overPace === null
      ? t('accrual.curvePaceNone')
      : Math.abs(gap) < 0.01
        ? t('accrual.paceOnLine')
        : overPace
          ? t('accrual.paceAhead', { amount: money(gap) })
          : t('accrual.paceBehind', { amount: money(-gap) });

  // The glance: landing vs the last ≤3 bills. A colour before a number.
  const chip =
    curve.paceVsAvg === null || curve.avgPriorBill === null
      ? null
      : Math.abs(curve.paceVsAvg) < 0.01
        ? { tone: 'bg-track text-ink', direction: 'even' as const, text: 'right on your 3-bill average' }
        : curve.overAvg
          ? { tone: 'bg-red-400 text-accent-ink', direction: 'above' as const, text: t('accrual.chipAbove', { amount: money(curve.paceVsAvg) }) }
          : { tone: 'bg-emerald-300 text-accent-ink', direction: 'below' as const, text: t('accrual.chipBelow', { amount: money(-curve.paceVsAvg) }) };

  const billDateLabel = fmtDate(new Date(`${curve.billDate}T12:00:00`), billDatePattern);

  return (
    <section
      data-testid="bill-accrual"
      aria-labelledby="accrual-heading"
      aria-describedby={explainerId}
      data-pace-source={curve.paceSource}
      data-days-elapsed={curve.daysElapsed}
      data-days-in-period={curve.daysInPeriod}
      data-bill-date={curve.billDate}
      data-avg-prior-bills={curve.avgPriorBill?.toFixed(2) ?? ''}
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 text-ink"
    >
      {/* ---- the answer, before any picture ------------------------------ */}
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-1 md:mb-2">
        <span aria-hidden className="bg-inv text-accent-yellow p-2 md:p-3 rounded-xl border-2 md:border-4 border-edge">
          <TrendingUp size={22} strokeWidth={4} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-ink-4 font-black uppercase">
            {fmtDate(new Date(`${curve.periodStart}T12:00:00`), billDatePattern)} – {billDateLabel} · {t('accrual.openPeriod')}
          </div>
          <h3 id="accrual-heading" className="text-xl md:text-3xl italic font-black uppercase text-ink">
            {t('accrual.isMyBillOnPace')}
          </h3>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-3 md:mb-4">
        <div
          className="text-3xl md:text-5xl italic font-black"
          data-testid="accrual-headline"
          data-projected-total={curve.projectedTotal.toFixed(2)}
        >
          {money(curve.projectedTotal)} {t('accrual.by')} {billDateLabel}
        </div>
        {chip ? (
          <span
            data-testid="accrual-pace-chip"
            data-direction={chip.direction}
            className={`${chip.tone} border-4 border-edge px-3 py-1 rounded-xl text-[11px] md:text-sm font-black uppercase`}
          >
            {chip.text}
          </span>
        ) : (
          <span
            data-testid="accrual-pace-chip"
            data-direction="none"
            className="bg-hover border-4 border-edge px-3 py-1 rounded-xl text-[10px] md:text-xs font-black uppercase text-ink-3"
          >
            {t('accrual.noBillsYet')}
          </span>
        )}
      </div>

      {/* The fixed explainer: every line on the chart, named once. */}
      <p
        id={explainerId}
        data-testid="accrual-explainer"
        className="mb-4 text-[10px] md:text-xs font-bold normal-case text-ink-2 leading-relaxed"
      >
        {t(ACCRUAL_EXPLAINER_KEY)}
      </p>

      {/* ---- the picture ------------------------------------------------- */}
      {/* One shape per breakpoint, each mounted once and picked by CSS:
          a phone gets the sparkline until it asks for the full chart, a
          desktop always gets the full chart and never sees the toggle.
              */}
      <div className={showFull ? 'hidden' : 'md:hidden'}>
        <Sparkline curve={curve} />
      </div>
      <div className={showFull ? 'block' : 'hidden md:block'}>
        <Chart curve={curve} />
      </div>
      <button
        type="button"
        data-testid="accrual-chart-toggle"
        aria-expanded={showFull}
        onClick={() => setShowFull((v) => !v)}
        className="md:hidden mt-2 w-full min-h-[44px] border-2 border-edge rounded-xl bg-hover text-[10px] font-black uppercase hover:bg-yellow-400 hover:text-accent-ink active:bg-accent-soft0"
      >
        {showFull ? t('accrual.hideFull') : t('accrual.showFull')}
      </button>

      {/* The chart is decorative; every number it draws is here as text. */}
      <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <div className="bg-inv text-inv-ink p-3 md:p-4 rounded-xl border-4 border-edge">
          <div className="text-[8px] md:text-[10px] uppercase text-accent-yellow font-black">{t('accrual.accruedSoFar')}</div>
          <div className="text-lg md:text-2xl italic font-black" data-testid="accrual-total">
            {money(curve.total)}
          </div>
          <div className="text-[8px] font-black text-inv-ink-2 normal-case">
            {t('accrual.measuredLine', { covered: curve.coveredDays, elapsed: curve.daysElapsed })}
          </div>
        </div>
        <div className="bg-blue-50 p-3 md:p-4 rounded-xl border-4 border-edge">
          <div className="text-[8px] md:text-[10px] uppercase text-ink-3 font-black">{t('accrual.paceToDate')}</div>
          <div className="text-lg md:text-2xl italic font-black" data-testid="accrual-pace">
            {money(curve.paceToDate)}
          </div>
          <div className="text-[8px] font-black text-ink-3 normal-case">{money(curve.paceDaily)}{t('accrual.perDayUnit')}</div>
        </div>
        <div className="bg-yellow-400 text-accent-ink p-3 md:p-4 rounded-xl border-4 border-edge">
          <div className="text-[8px] md:text-[10px] uppercase font-black">{t('accrual.landingAt')}</div>
          <div className="text-lg md:text-2xl italic font-black" data-testid="accrual-projected">
            {money(curve.projectedTotal)}
          </div>
          <div className="text-[8px] font-black normal-case">
            {t('accrual.onDate')} {billDateLabel}{t('accrual.atRunRate')}
          </div>
        </div>
        <div
          className={`p-3 md:p-4 rounded-xl border-4 border-edge ${
            overPace === null ? 'bg-hover' : overPace ? 'bg-red-400 text-accent-ink' : 'bg-emerald-300 text-accent-ink'
          }`}
        >
          <div className="text-[8px] md:text-[10px] uppercase font-black">{t('accrual.vsPaceLine')}</div>
          <div className="text-sm md:text-xl italic font-black" data-testid="accrual-verdict">
            {verdict}
          </div>
          <div className="text-[8px] font-black normal-case">
            {t('accrual.daysInLine', { elapsed: curve.daysElapsed, total: curve.daysInPeriod })}
          </div>
        </div>
      </div>

      <p data-testid="accrual-note" className="mt-4 text-[10px] md:text-xs font-bold text-ink-2 normal-case">
        {curve.note} {t('accrual.commodityOnlyNote')}
      </p>
    </section>
  );
}
