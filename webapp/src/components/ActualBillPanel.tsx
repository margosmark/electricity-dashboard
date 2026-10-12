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
  summaryStatesMoney,
  type BillLineClass,
  type BillLineItem,
  type ChargeDecomposition,
  type PeriodReconciliation,
  type ProcessedPoint,
  type UsageSummary,
} from '@/lib/energy';
// Wave U — the receipt translates; the utility's own line notes (item.note)
// stay verbatim, because they ARE the file's data.
// `t` (module-level) is used by the pure label helpers above the components;
// `useTranslation` subscribes the components to locale switches.
import { fmtCents, fmtKwh, fmtMoney, fmtNumberAuto, fmtPercent, t, useTranslation } from '@/i18n';

type Props = {
  /** Bill periods parsed out of the file (Wave L parser). */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the chart window. */
  allData: ProcessedPoint[];
  plan: 'TOU' | 'Tiered' | 'ULO';
};

const money = (n: number) => (n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n));
const kwh = (n: number) => fmtKwh(n, 2);

const CLASS_STYLE: Record<BillLineClass, string> = {
  commodity: 'border-l-8 border-blue-500',
  delivery: 'border-l-8 border-violet-500',
  regulatory: 'border-l-8 border-violet-400',
  tax: 'border-l-8 border-amber-500',
  credit: 'border-l-8 border-emerald-500',
  total: 'border-l-8 border-edge bg-accent-soft',
  info: 'border-l-8 border-track',
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
  if (m.uom === 114 || /days/.test(note))
    return t('actualBill.days', { count: m.scaled, days: m.scaled });
  if (/loss factor/.test(note)) return `${fmtNumberAuto(m.scaled, 4)} ×`;
  if (/usage|meter read/.test(note)) return kwh(m.scaled);
  return fmtNumberAuto(m.scaled, 4);
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
    return t('actualBill.perKwhVaries', { cents: fmtCents((amount / periodKwh) * 100, 2) });
  }
  if (cls === 'delivery') {
    if (split && split.mode === 'split' && split.flat !== null) {
      return t('actualBill.deliveryFit', {
        flat: fmtMoney(split.flat),
        cents: fmtCents(split.perKwh * 100, 2),
        periods: split.periods,
        residual: fmtMoney(split.maxResidual ?? 0),
      });
    }
    if (periodKwh > 0) return t('actualBill.perKwhBlended', { cents: fmtCents((amount / periodKwh) * 100, 2) });
    return null;
  }
  if (cls === 'regulatory' && periodKwh > 0) {
    return t('actualBill.perKwhVaries', { cents: fmtCents((amount / periodKwh) * 100, 2) });
  }
  if (cls === 'tax' && taxBase > 0) {
    return t('actualBill.pctOfSubtotalScales', { pct: fmtPercent((amount / taxBase) * 100, 2) });
  }
  if (cls === 'credit' && taxBase > 0) {
    return t('actualBill.pctOfSubtotal', { pct: fmtPercent((amount / taxBase) * 100, 2) });
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
      ? 'bg-good-soft'
      : split.status === 'rejected'
        ? 'bg-amber-50'
        : 'bg-inset';
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
      className={`${tone} border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6`}
    >
      <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4 font-black uppercase">
        {split.line === 'delivery'
          ? t('actualBill.deliverySplit')
          : t('actualBill.regulatorySplit')}
      </div>
      <div
        data-testid={`decomposition-headline-${split.line}`}
        className="text-lg md:text-2xl font-black normal-case mt-1"
      >
        {split.headline}
      </div>
      <div className="mt-1 md:mt-2 text-[11px] md:text-xs font-bold text-ink-2 normal-case">
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
  const { t } = useTranslation();
  const { summary, totals } = rec;
  const periodKwh = billedKwh(summary) ?? summary.consumption?.scaled ?? 0;
  const verdict = commodityVerdict(rec);
  const delta = rec.delta;
  const taxBase = totals.total;
  /**
   * The bill states no money at all (a bare ElectricPowerUsageSummary — the
   * Green Button Alliance sample is exactly this shape). `billTotals` then
   * hands back a clean $0.00 that nobody quoted, so every figure derived from
   * it drops to a dash and the panel says why, the same way the money chart
   * badged its unbilled row. A "you paid $0.00" over a bill with no charges is
   * a payment asserted from the absence of data.
   */
  const statesMoney = summaryStatesMoney(summary);
  const shownMoney = (n: number) => (statesMoney ? money(n) : '—');

  return (
    <div
      data-testid="actual-bill-period"
      data-period-start={summary.startDate}
      className="border-4 border-edge rounded-xl md:rounded-2xl bg-card p-4 md:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-black uppercase text-base md:text-xl">
          {billPeriodLabel(summary.start, summary.duration)}
        </div>
        <div className="text-right">
          <div className="font-black italic text-xl md:text-2xl" data-testid="actual-payable">
            {statesMoney ? money(totals.payable) : '—'}
          </div>
          <div className="text-[10px] md:text-xs text-ink-3 font-bold">
            {statesMoney ? t('actualBill.youPaid') : t('actualBill.noChargeLines')} ·{' '}
            {t('actualBill.billedKwh', { kwh: kwh(periodKwh) })}
            {currencyLabel(summary.currency) ? ` · ${currencyLabel(summary.currency)}` : ''}
          </div>
        </div>
      </div>

      {/* ---- estimate vs actual, the reason this panel exists ---------- */}
      {!statesMoney ? (
        <div
          data-testid="commodity-skip"
          className="mt-3 md:mt-4 bg-hover border-2 border-edge rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-black text-ink-2"
        >
          {t('actualBill.commoditySkip')}
        </div>
      ) : verdict === 'match' && delta !== null ? (
        <div
          data-testid="commodity-check"
          className="mt-3 md:mt-4 bg-good-soft border-2 border-edge rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-black"
        >
          {t('actualBill.checkOkA')}{' '}
          <span className="italic">{money(rec.commodityEstimate ?? 0)}</span>,{' '}
          {t('actualBill.checkOkB')}{' '}
          <span className="italic">{money(rec.commodityActual)}</span> ({t('actualBill.delta', { delta: money(delta) })}, {t('actualBill.within', { tolerance: fmtMoney(COMMODITY_MATCH_TOLERANCE) })}).
        </div>
      ) : verdict === 'off' && delta !== null ? (
        <div
          data-testid="commodity-mismatch"
          role="alert"
          className="mt-3 md:mt-4 bg-bad-soft border-4 border-bad rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-black text-bad"
        >
          {t('actualBill.checkOffA')}{' '}
          <span className="italic">{money(rec.commodityEstimate ?? 0)}</span>{' '}
          {t('actualBill.checkOffB')}{' '}
          <span className="italic">{money(rec.commodityActual)}</span>{' '}
          {t('actualBill.checkOffC', { delta: money(delta) })}
          {t('actualBill.checkOffAdvice')}
        </div>
      ) : (
        <div
          data-testid="commodity-skip"
          className="mt-3 md:mt-4 bg-hover border-2 border-edge rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-black text-ink-2"
        >
          {t('actualBill.notCompared')}{' '}
          {rec.rows.length === 0
            ? t('actualBill.noReadings')
            : t('actualBill.coverage', {
                covered: rec.coveredDays,
                days: rec.periodDays,
                pct: fmtPercent(Math.round(rec.coverage * 100)),
                needed: fmtPercent(Math.round(PERIOD_MIN_COVERAGE * 100)),
              })}
        </div>
      )}

      {rec.billedKwh !== null && rec.meteredKwh !== null && rec.coverage >= PERIOD_MIN_COVERAGE && (
        <div
          data-testid="kwh-crosscheck"
          className="mt-2 text-[10px] md:text-xs text-ink-3 font-bold"
        >
          {t('actualBill.crosscheck', {
            billed: kwh(rec.billedKwh),
            metered: kwh(rec.meteredKwh),
            delta: kwh(Math.abs(rec.billedKwh - rec.meteredKwh)),
          })}
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
                cls === 'info' ? 'text-ink-3 text-[10px] md:text-[11px]' : 'text-ink text-xs md:text-sm'
              }`}
            >
              <span className="min-w-0">
                <span className="uppercase break-words">{item.note}</span>
                {note ? (
                  <span className="block text-[9px] md:text-[10px] text-ink-4 normal-case font-bold">
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
                  <span className="ml-2 text-[9px] text-ink-4">{t('actualBill.kind', { kind: item.itemKind })}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 md:mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 text-[10px] md:text-xs font-black">
        <div className="bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
          <div className="text-ink-4 text-[8px] uppercase">{t('actualBill.electricity')}</div>
          <div className="italic">{shownMoney(totals.commodity)}</div>
        </div>
        <div className="bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
          <div className="text-ink-4 text-[8px] uppercase">{t('actualBill.deliveryReg')}</div>
          <div className="italic">{shownMoney(totals.delivery + totals.regulatory)}</div>
        </div>
        <div className="bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
          <div className="text-ink-4 text-[8px] uppercase">{t('actualBill.hst')}</div>
          <div className="italic">{shownMoney(totals.tax)}</div>
        </div>
        <div className="bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
          <div className="text-ink-4 text-[8px] uppercase">{t('actualBill.rebate')}</div>
          <div className="italic text-good">{shownMoney(totals.credit)}</div>
        </div>
      </div>
    </div>
  );
}

export function ActualBillPanel({ summaries, allData, plan }: Props) {
  const { t } = useTranslation();
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
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 md:shadow-hard-16 text-ink font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4">
            {t('actualBill.straightFromXml', { count: summaries.length })}
            {summaries[summaries.length - 1].currency !== null
              ? ` · ${currencyLabel(summaries[summaries.length - 1].currency)}`
              : ''}
          </div>
          <h2 className="text-2xl md:text-4xl italic font-black">{t('actualBill.title')}</h2>
        </div>
        <div className="text-[10px] md:text-xs font-bold text-ink-3 normal-case max-w-md">
          {t('actualBill.blurb')}
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
            className={`min-h-[44px] px-4 border-2 border-edge rounded-lg text-[10px] md:text-xs uppercase font-black ${
              selected === 'all' ? 'bg-yellow-400 text-accent-ink' : 'bg-inset'
            }`}
          >
            {t('actualBill.allPeriods')}
          </button>
          {recs.map((r) => (
            <button
              key={r.summary.start}
              type="button"
              onClick={() => setSelected(r.summary.startDate)}
              aria-pressed={selected === r.summary.startDate}
              data-testid={`actual-bill-pick-${r.summary.startDate}`}
              className={`min-h-[44px] px-4 border-2 border-edge rounded-lg text-[10px] md:text-xs uppercase font-black ${
                selected === r.summary.startDate ? 'bg-yellow-400 text-accent-ink' : 'bg-inset'
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
          className="mt-4 md:mt-6 bg-red-600 text-white border-4 border-edge rounded-xl px-4 py-3 md:px-6 md:py-4 text-xs md:text-sm font-black normal-case"
        >
          {t('actualBill.rateBanner')}
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
