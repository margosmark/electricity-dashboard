/**
 * Wave L item 2 — "Your actual bill".
 *
 * The feed already carries a full itemized bill per billing period; this
 * puts it next to what we estimated for the same period:
 *
 *   • every line item, note verbatim, in the utility's own order;
 *   • the commodity cross-check — "Off/Mid/On Peak-Summer" are exactly kWh ×
 *     the OEB rate we price with, so a covered period must land within a
 *     dollar, and when it does not we say the rate assumptions are off
 *     instead of quietly reporting a delta;
 *   • billed kWh vs the kWh our own readings add up to;
 *   • the amortized fixed-vs-variable split of each charge when the periods
 *     we hold make one derivable (and no claim at all when they don't).
 *
 * Everything is computed from localStorage-held state: no server round trip.
 */

"use client";

import { useMemo, useState } from 'react';

import {
  COMMODITY_MATCH_TOLERANCE,
  PERIOD_MIN_COVERAGE,
  billedKwh,
  billPeriodLabel,
  chargeDecomposition,
  classifyBillLine,
  commodityVerdict,
  currencyLabel,
  deliverySplit,
  reconcileBillingPeriods,
  type BillLineClass,
  type BillLineItem,
  type ChargeDecomposition,
  type PeriodReconciliation,
  type ProcessedPoint,
  type UsageSummary,
} from '@/lib/energy';

type Props = {
  /** Bill periods parsed out of the file (Wave L parser). */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the chart window. */
  allData: ProcessedPoint[];
  plan: 'TOU' | 'Tiered' | 'ULO';
};

const money = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const kwh = (n: number) => `${n.toLocaleString('en-CA', { maximumFractionDigits: 2 })} kWh`;

const CLASS_STYLE: Record<BillLineClass, string> = {
  commodity: 'border-l-8 border-blue-500',
  delivery: 'border-l-8 border-violet-500',
  regulatory: 'border-l-8 border-violet-400',
  tax: 'border-l-8 border-amber-500',
  credit: 'border-l-8 border-emerald-500',
  total: 'border-l-8 border-black bg-yellow-50',
  info: 'border-l-8 border-slate-200',
  other: 'border-l-8 border-orange-400',
};

/** What kind of number a measurement line is, by the utility's own wording. */
function measurementLabel(item: BillLineItem): string | null {
  const m = item.measurement;
  if (!m) return null;
  const note = item.note.toLowerCase();
  if (m.uom === 27) {
    const d = new Date(m.scaled * 1000);
    return d.toISOString().slice(0, 10);
  }
  if (m.uom === 114 || /days/.test(note)) return `${m.scaled} days`;
  if (/loss factor/.test(note)) return `${m.scaled.toFixed(4)} ×`;
  if (/usage|meter read/.test(note)) return kwh(m.scaled);
  return String(m.scaled);
}

/**
 * The fixed-vs-variable story behind one line, when there is one. Returns
 * null rather than a guess: a split fitted across two near-identical periods
 * would be noise dressed up as a number.
 */
function splitNote(
  item: BillLineItem,
  cls: BillLineClass,
  periodKwh: number,
  split: ReturnType<typeof deliverySplit>,
  taxBase: number,
): string | null {
  const amount = item.amount;
  if (amount === null || amount === 0) return null;
  if (cls === 'commodity' && periodKwh > 0) {
    return `${((amount / periodKwh) * 100).toFixed(2)}¢/kWh — varies with what you use`;
  }
  if (cls === 'delivery') {
    if (split && split.mode === 'split' && split.flat !== null) {
      return `≈ $${split.flat.toFixed(2)} fixed per period + ${(
        (split.perKwh * 100).toFixed(2)
      )}¢/kWh — fitted across ${split.periods} periods, ±$${(split.maxResidual ?? 0).toFixed(2)}`;
    }
    if (periodKwh > 0) return `${((amount / periodKwh) * 100).toFixed(2)}¢/kWh — blended`;
    return null;
  }
  if (cls === 'regulatory' && periodKwh > 0) {
    return `${((amount / periodKwh) * 100).toFixed(2)}¢/kWh — varies with what you use`;
  }
  if (cls === 'tax' && taxBase > 0) {
    return `${((amount / taxBase) * 100).toFixed(2)}% of the subtotal — scales with it`;
  }
  if (cls === 'credit' && taxBase > 0) {
    return `${((amount / taxBase) * 100).toFixed(2)}% of the subtotal`;
  }
  return null;
}

/**
 * Wave T slice 3 — "of your $X delivery this period, $F is fixed and $V is
 * volume-driven", or the honest reason that sentence cannot be made.
 *
 * Three states, and the middle one is the interesting one. A split that
 * passes is printed as a split. A split that was fitted and then REJECTED —
 * because its worst miss exceeds the bar we quote splits at — prints the
 * rejected numbers, the miss, and the bill it came from, because "we could
 * not split this" is only trustworthy when you can see what was tried. And
 * when there was nothing to fit (too few bills, usage that never moved) it
 * says that instead, and quotes the one blended rate that is always true.
 */
function DecompositionCard({ split }: { split: ChargeDecomposition }) {
  const tone =
    split.status === 'split'
      ? 'bg-emerald-50'
      : split.status === 'rejected'
        ? 'bg-amber-50'
        : 'bg-slate-50';
  return (
    <div
      data-testid={`charge-decomposition-${split.line}`}
      data-status={split.status}
      data-amount={split.amount.toFixed(2)}
      data-kwh={split.kwh.toFixed(1)}
      data-periods={split.periods}
      data-blended-cents={split.blendedCentsPerKwh.toFixed(2)}
      data-fixed={split.fixed === null ? '' : split.fixed.toFixed(2)}
      data-variable={split.variable === null ? '' : split.variable.toFixed(2)}
      data-max-residual={split.fit === null ? '' : split.fit.maxResidual.toFixed(2)}
      data-residual-share={split.fit === null ? '' : split.fit.residualShare.toFixed(4)}
      className={`${tone} border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6`}
    >
      <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400 font-black uppercase">
        {split.line === 'delivery'
          ? 'Delivery · fixed vs volume-driven'
          : 'Regulatory charges · fixed vs volume-driven'}
      </div>
      <div
        data-testid={`decomposition-headline-${split.line}`}
        className="text-lg md:text-2xl font-black normal-case mt-1"
      >
        {split.headline}
      </div>
      <div className="mt-1 md:mt-2 text-[11px] md:text-xs font-bold text-slate-600 normal-case">
        {split.detail}
      </div>
    </div>
  );
}

function PeriodCard({
  rec,
  split,
}: {
  rec: PeriodReconciliation;
  split: ReturnType<typeof deliverySplit>;
}) {
  const { summary, totals } = rec;
  const periodKwh = billedKwh(summary) ?? summary.consumption?.scaled ?? 0;
  const verdict = commodityVerdict(rec);
  const delta = rec.delta;
  const taxBase = totals.total;

  return (
    <div
      data-testid="actual-bill-period"
      data-period-start={summary.startDate}
      className="border-4 border-black rounded-xl md:rounded-2xl bg-white p-4 md:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-black uppercase text-base md:text-xl">
          {billPeriodLabel(summary.start, summary.duration)}
        </div>
        <div className="text-right">
          <div className="font-black italic text-xl md:text-2xl" data-testid="actual-payable">
            {money(totals.payable)}
          </div>
          <div className="text-[10px] md:text-xs text-slate-500 font-bold">
            you paid · {kwh(periodKwh)} billed
            {currencyLabel(summary.currency) ? ` · ${currencyLabel(summary.currency)}` : ''}
          </div>
        </div>
      </div>

      {/* ---- estimate vs actual, the reason this panel exists ---------- */}
      {verdict === 'match' && delta !== null ? (
        <div
          data-testid="commodity-check"
          className="mt-3 md:mt-4 bg-emerald-50 border-2 border-black rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-black"
        >
          Commodity check ✓ — our rates estimate{' '}
          <span className="italic">{money(rec.commodityEstimate ?? 0)}</span>, Oakville billed{' '}
          <span className="italic">{money(rec.commodityActual)}</span> (Δ {money(delta)}, within $
          {COMMODITY_MATCH_TOLERANCE}).
        </div>
      ) : verdict === 'off' && delta !== null ? (
        <div
          data-testid="commodity-mismatch"
          role="alert"
          className="mt-3 md:mt-4 bg-red-100 border-4 border-red-600 rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-black text-red-900"
        >
          Our rate assumptions are off — for this period our rates estimate{' '}
          <span className="italic">{money(rec.commodityEstimate ?? 0)}</span> but Oakville billed{' '}
          <span className="italic">{money(rec.commodityActual)}</span> for the same electricity (Δ{' '}
          {money(delta)}, tolerance $1). Check the OEB rate schedule in Settings before trusting
          the estimate.
        </div>
      ) : (
        <div
          data-testid="commodity-skip"
          className="mt-3 md:mt-4 bg-slate-100 border-2 border-black rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-black text-slate-600"
        >
          Not compared —{' '}
          {rec.rows.length === 0
            ? 'this browser holds no readings inside this period.'
            : `your readings cover ${rec.coveredDays} of ${rec.periodDays} days (${Math.round(
                rec.coverage * 100,
              )}%, ${Math.round(PERIOD_MIN_COVERAGE * 100)}% needed).`}
        </div>
      )}

      {rec.billedKwh !== null && rec.meteredKwh !== null && rec.coverage >= PERIOD_MIN_COVERAGE && (
        <div
          data-testid="kwh-crosscheck"
          className="mt-2 text-[10px] md:text-xs text-slate-500 font-bold"
        >
          Billed {kwh(rec.billedKwh)} · your readings add up to {kwh(rec.meteredKwh)} (Δ{' '}
          {kwh(Math.abs(rec.billedKwh - rec.meteredKwh))}).
        </div>
      )}

      {/* ---- the bill itself, line by line ---------------------------- */}
      <ul className="mt-3 md:mt-5 space-y-1 md:space-y-2">
        {summary.items.map((item, i) => {
          const cls = classifyBillLine(item);
          const note = splitNote(item, cls, periodKwh, split, taxBase);
          const measured = measurementLabel(item);
          const strong = cls === 'total' || cls === 'commodity' || cls === 'delivery';
          return (
            <li
              key={`${item.note}-${i}`}
              data-testid={`bill-line-${cls}`}
              className={`flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5 md:py-2 rounded-md ${
                CLASS_STYLE[cls]
              } ${strong ? 'font-black' : 'font-bold'} ${
                cls === 'info' ? 'text-slate-500 text-[10px] md:text-[11px]' : 'text-black text-xs md:text-sm'
              }`}
            >
              <span className="min-w-0">
                <span className="uppercase break-words">{item.note}</span>
                {note ? (
                  <span className="block text-[9px] md:text-[10px] text-slate-400 normal-case font-bold">
                    {note}
                  </span>
                ) : null}
              </span>
              <span className="whitespace-nowrap tabular-nums">
                {item.amount !== null && item.amount !== 0
                  ? money(item.amount)
                  : measured !== null
                    ? measured
                    : '—'}
                {item.itemKind !== null ? (
                  <span className="ml-2 text-[9px] text-slate-400">kind {item.itemKind}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 md:mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 text-[10px] md:text-xs font-black">
        <div className="bg-slate-50 border-2 border-black rounded-lg p-2 md:p-3">
          <div className="text-slate-400 text-[8px] uppercase">Electricity</div>
          <div className="italic">{money(totals.commodity)}</div>
        </div>
        <div className="bg-slate-50 border-2 border-black rounded-lg p-2 md:p-3">
          <div className="text-slate-400 text-[8px] uppercase">Delivery + reg</div>
          <div className="italic">{money(totals.delivery + totals.regulatory)}</div>
        </div>
        <div className="bg-slate-50 border-2 border-black rounded-lg p-2 md:p-3">
          <div className="text-slate-400 text-[8px] uppercase">HST</div>
          <div className="italic">{money(totals.tax)}</div>
        </div>
        <div className="bg-slate-50 border-2 border-black rounded-lg p-2 md:p-3">
          <div className="text-slate-400 text-[8px] uppercase">Rebate</div>
          <div className="italic text-emerald-600">{money(totals.credit)}</div>
        </div>
      </div>
    </div>
  );
}

export function ActualBillPanel({ summaries, allData, plan }: Props) {
  const [selected, setSelected] = useState<string>('all');

  const recs = useMemo(
    () => reconcileBillingPeriods(summaries, allData, plan),
    [summaries, allData, plan],
  );
  const split = useMemo(() => deliverySplit(summaries, allData), [summaries, allData]);

  // Wave T slice 3: the fixed-vs-volume answer for the two lines that invite
  // the question. Same periods, same kWh basis, same tolerance bar as the
  // per-line notes below — one fit, one truth, two places to read it.
  const decompositions = useMemo(
    () =>
      (['delivery', 'regulatory'] as const)
        .map((line) => chargeDecomposition(summaries, allData, line))
        .filter((d): d is ChargeDecomposition => d !== null),
    [summaries, allData],
  );

  if (summaries.length === 0) return null;

  const shown = selected === 'all' ? recs : recs.filter((r) => r.summary.startDate === selected);
  const anyMismatch = recs.some((r) => commodityVerdict(r) === 'off');

  return (
    <section
      data-testid="actual-bill"
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
            Straight from your XML · {summaries.length} billing period
            {summaries.length === 1 ? '' : 's'}
            {summaries[summaries.length - 1].currency !== null
              ? ` · ${currencyLabel(summaries[summaries.length - 1].currency)}`
              : ''}
          </div>
          <h2 className="text-2xl md:text-4xl italic font-black">Your actual bill</h2>
        </div>
        <div className="text-[10px] md:text-xs font-bold text-slate-500 normal-case max-w-md">
          Every line item as the utility wrote it, next to what this app estimates for the same
          period. Nothing here is retyped or fetched — it is all in the file you imported.
        </div>
      </div>

      {summaries.length > 1 && (
        <div
          className="mt-4 md:mt-6 flex flex-wrap gap-2 md:gap-3"
          data-testid="actual-bill-picker"
        >
          <button
            type="button"
            onClick={() => setSelected('all')}
            aria-pressed={selected === 'all'}
            data-testid="actual-bill-all"
            className={`min-h-[44px] px-4 border-2 border-black rounded-lg text-[10px] md:text-xs uppercase font-black ${
              selected === 'all' ? 'bg-yellow-400' : 'bg-slate-50'
            }`}
          >
            All periods
          </button>
          {recs.map((r) => (
            <button
              key={r.summary.start}
              type="button"
              onClick={() => setSelected(r.summary.startDate)}
              aria-pressed={selected === r.summary.startDate}
              data-testid={`actual-bill-pick-${r.summary.startDate}`}
              className={`min-h-[44px] px-4 border-2 border-black rounded-lg text-[10px] md:text-xs uppercase font-black ${
                selected === r.summary.startDate ? 'bg-yellow-400' : 'bg-slate-50'
              }`}
            >
              {billPeriodLabel(r.summary.start, r.summary.duration).split(' – ')[0]}
            </button>
          ))}
        </div>
      )}

      {anyMismatch && (
        <div
          data-testid="rate-assumptions-banner"
          role="alert"
          className="mt-4 md:mt-6 bg-red-600 text-white border-4 border-black rounded-xl px-4 py-3 md:px-6 md:py-4 text-xs md:text-sm font-black normal-case"
        >
          At least one billing period does not match this app&apos;s rate assumptions. The estimate
          is using the wrong price for your electricity — fix the rate schedule before trusting the
          projections below it.
        </div>
      )}

      {decompositions.length > 0 && (
        <div className="mt-4 md:mt-6 space-y-3 md:space-y-4" data-testid="charge-decompositions">
          {decompositions.map((d) => (
            <DecompositionCard key={d.line} split={d} />
          ))}
        </div>
      )}

      <div className="mt-4 md:mt-6 space-y-4 md:space-y-6">
        {shown.map((rec) => (
          <PeriodCard key={rec.summary.start} rec={rec} split={split} />
        ))}
      </div>
    </section>
  );
}

export default ActualBillPanel;
