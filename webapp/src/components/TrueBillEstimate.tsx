/**
 * Bill estimate card: the variable-charges figure the plan cards already
 * imply, plus optional LOCAL add-ons (delivery, regulatory, HST) that turn it
 * into a true-bill estimate.
 *
 * With all four fields empty the card is exactly the old behavior —
 * variable-only figure plus the "does not include …" caption. The numbers
 * are user inputs kept in this browser; they are deliberately NOT read from
 * /api/rates, which only carries OEB commodity rates.
 *
 * Wave L: when the imported file carries a UsageSummary bill, the four fields
 * are pre-filled from the newest period once (and only while they remain
 * untouched — see applyDerivedIfPristine), with the provenance shown so the
 * value is never a mystery.
 */

"use client";

import { useEffect, useMemo } from 'react';

import {
  type ProcessedPoint,
  type UsageSummary,
  type ExtraChargeField,
  billTotals,
  billWindow,
  buildActiveChartData,
  calculateComparison,
  calculateTrueBill,
  chargesArePristine,
  countMonthsInView,
  deriveExtraCharges,
  hasExtraCharges,
  planCostFor,
  BASELINE_ESTIMATE_CAPTION,
} from '@/lib/energy';
import { useExtraCharges } from '@/hooks/useDashboard';

const FIELD_CLASS =
  'w-full p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl ' +
  'bg-slate-50 font-black text-base md:text-xs text-black outline-none ' +
  'focus:bg-yellow-50 focus:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]';

type FieldProps = {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
};

function ChargeField({ id, label, placeholder, value, onChange }: FieldProps) {
  return (
    <label
      htmlFor={id}
      className="flex flex-col gap-1 text-[8px] md:text-[10px] uppercase text-slate-500 font-black"
    >
      <span>{label}</span>
      <input
        id={id}
        data-testid={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={FIELD_CLASS}
      />
    </label>
  );
}

type Props = {
  plan: 'TOU' | 'Tiered' | 'ULO';
  startDate: string;
  endDate: string;
  /** The window on screen — the estimate is for exactly this range. */
  windowData: ProcessedPoint[];
  /**
   * Bill periods parsed out of the same file (Wave L item 3): when present,
   * the four fields above are pre-filled from the newest one instead of
   * staying empty, and the card shows what that period actually cost.
   * Every field stays editable — a typed value always wins.
   */
  summaries?: UsageSummary[];
  /** Every priced reading, so a billing period can be priced on its own. */
  allData?: ProcessedPoint[];
};

export function TrueBillEstimate({
  plan,
  startDate,
  endDate,
  windowData,
  summaries = [],
  allData,
}: Props) {
  const { charges, setCharge, applyDerivedIfPristine } = useExtraCharges();

  // Wave L: the file's own bill, newest period first. Null when the feed
  // carried no bill (or one with no charges) — then nothing changes at all.
  const derived = useMemo(
    () => (summaries.length > 0 ? deriveExtraCharges(summaries, allData) : null),
    [summaries, allData],
  );

  /**
   * Pre-fill the four fields from the file — once. The hook only applies the
   * values while the stored ones are still pristine (never typed in, or still
   * byte-identical to what an earlier file produced), so editing a field, or
   * clearing it, sticks: the user's version outlives every later sync.
   */
  useEffect(() => {
    if (derived?.charges.xmlSource) applyDerivedIfPristine(derived.charges.xmlSource);
  }, [derived, applyDerivedIfPristine]);

  /**
   * Estimate vs actual for the period the prefill came from: same basis as
   * the bill (everything before the rebate — Wave B has no rebate field, so
   * the rebate is reported underneath rather than silently ignored).
   */
  const vsActual = useMemo(() => {
    if (!derived || !allData || allData.length === 0) return null;
    const s = derived.source;
    // The billed window, not the coarse billingPeriod stamp — see billWindow.
    const window = billWindow(s);
    const rows = allData.filter((r) => r.timestamp >= window.start && r.timestamp < window.end);
    if (rows.length === 0) return null;
    const totals = billTotals(s);
    const months = Math.max(1, Math.round((window.end - window.start) / 86400 / 30.44));
    const estimate = calculateTrueBill({
      variableCost: planCostFor(rows, plan),
      totalKwh: rows.reduce((n, r) => n + r.usage_kwh, 0),
      months,
      charges,
    });
    if (!estimate) return null;
    return {
      label: derived.label,
      estimate: estimate.total,
      actual: totals.preRebate,
      delta: estimate.total - totals.preRebate,
      credit: totals.credit,
      payable: totals.payable,
    };
  }, [derived, allData, plan, charges]);

  if (windowData.length === 0) return null;

  // Same aggregation the plan cards use, but anchored to the window instead of
  // the current zoom target: a bill is for the period, not for one bar.
  const comparison = calculateComparison(buildActiveChartData(windowData, 'monthly', null));
  const variableCost = comparison ? comparison[plan] : 0;
  const totalKwh = windowData.reduce((sum, d) => sum + d.usage_kwh, 0);
  const months = countMonthsInView(windowData);
  const bill = calculateTrueBill({ variableCost, totalKwh, months, charges });
  const active = hasExtraCharges(charges) && bill !== null;

  const set = (field: ExtraChargeField) => (value: string) => setCharge(field, value);

  /** Still exactly what the file produced (vs. typed over or cleared). */
  const xmlIntact = !!charges.xmlSource && chargesArePristine(charges);

  return (
    <section
      data-testid="bill-estimate"
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="flex flex-col xl:flex-row gap-6 xl:gap-12 justify-between">
        <div className="xl:min-w-[320px]">
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
            Estimate · {startDate} to {endDate} · {plan} plan
          </div>
          <div className="text-4xl md:text-6xl italic font-black mt-1 md:mt-2" data-testid="variable-estimate">
            ${variableCost.toFixed(2)}
          </div>
          <p
            data-testid="estimate-caption"
            className="mt-3 md:mt-5 text-[10px] md:text-xs text-slate-600 normal-case font-bold max-w-2xl leading-relaxed"
          >
            {bill ? bill.caption : BASELINE_ESTIMATE_CAPTION}
          </p>
        </div>

        <div className="xl:max-w-[560px]">
          <div className="text-[8px] md:text-[10px] text-slate-400 mb-2 md:mb-3">
            Your bill add-ons — optional, kept in this browser
          </div>
          <div className="grid grid-cols-2 gap-3 md:gap-4">
            <ChargeField
              id="charge-delivery-per-kwh"
              label="Delivery $/kWh"
              placeholder="e.g. 0.0125"
              value={charges.deliveryPerKwh}
              onChange={set('deliveryPerKwh')}
            />
            <ChargeField
              id="charge-delivery-flat"
              label="Delivery $/month"
              placeholder="e.g. 15.00"
              value={charges.deliveryFlat}
              onChange={set('deliveryFlat')}
            />
            <ChargeField
              id="charge-regulatory-per-kwh"
              label="Regulatory $/kWh"
              placeholder="e.g. 0.0005"
              value={charges.regulatoryPerKwh}
              onChange={set('regulatoryPerKwh')}
            />
            <ChargeField
              id="charge-hst-pct"
              label="HST % (ON default 13)"
              placeholder="13"
              value={charges.hstPct}
              onChange={set('hstPct')}
            />
          </div>
          {charges.xmlSource ? (
            <div
              data-testid="xml-charge-source"
              className="mt-2 text-[8px] md:text-[10px] text-slate-500 normal-case font-bold"
            >
              {xmlIntact ? (
                <>
                  Pre-filled from your XML&apos;s{' '}
                  <strong>{charges.xmlSource.label}</strong> bill
                  {derived
                    ? ` ($${derived.delivery.toFixed(2)} delivery · $${derived.regulatory.toFixed(2)} regulatory · ${derived.hstPct}% HST)`
                    : ''}
                  . Type in any field to override it — your version sticks, even after the next
                  sync.
                  {derived?.fit.mode === 'split' && derived.fit.flat !== null
                    ? ` Delivery fits $${derived.fit.flat.toFixed(2)} fixed + $${derived.fit.perKwh.toFixed(4)}/kWh across ${derived.fit.periods} periods (±$${(derived.fit.maxResidual ?? 0).toFixed(2)}).`
                    : ''}
                </>
              ) : (
                <>
                  Originally from your XML&apos;s <strong>{charges.xmlSource.label}</strong> bill —
                  you&apos;ve edited these. Clear a field to drop that charge from the estimate.
                </>
              )}
            </div>
          ) : (
            <div className="mt-2 text-[8px] md:text-[10px] text-slate-400 normal-case">
              Local inputs — not derived from the OEB commodity rates in /api/rates.
            </div>
          )}
        </div>
      </div>

      {bill && active && (
        <div
          data-testid="true-bill"
          className="mt-6 md:mt-10 border-t-4 border-black pt-6 md:pt-8 flex flex-col md:flex-row md:items-end justify-between gap-5 md:gap-10"
        >
          <div>
            <div className="text-[10px] md:text-xs tracking-[0.2em] text-yellow-600">True Bill Estimate</div>
            <div className="text-4xl md:text-6xl italic font-black text-emerald-600 mt-1 md:mt-2" data-testid="true-bill-total">
              ${bill.total.toFixed(2)}
            </div>
            <div className="mt-2 text-[10px] text-slate-500 normal-case">
              {bill.months} month{bill.months === 1 ? '' : 's'} · {bill.totalKwh.toFixed(1)} kWh in the window
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-6 text-[10px] md:text-xs">
            <div className="bg-slate-50 border-2 border-black rounded-lg p-3">
              <div className="text-slate-400 text-[8px]">Variable</div>
              <div className="italic">${bill.variable.toFixed(2)}</div>
            </div>
            {bill.deliveryPerKwh !== null || bill.deliveryFlat !== null ? (
              <div className="bg-slate-50 border-2 border-black rounded-lg p-3">
                <div className="text-slate-400 text-[8px]">Delivery</div>
                <div className="italic">${bill.delivery.toFixed(2)}</div>
              </div>
            ) : null}
            {bill.regulatoryPerKwh !== null ? (
              <div className="bg-slate-50 border-2 border-black rounded-lg p-3">
                <div className="text-slate-400 text-[8px]">Regulatory</div>
                <div className="italic">${bill.regulatory.toFixed(2)}</div>
              </div>
            ) : null}
            {bill.hstPct !== null ? (
              <div className="bg-slate-50 border-2 border-black rounded-lg p-3">
                <div className="text-slate-400 text-[8px]">HST</div>
                <div className="italic">${bill.hst.toFixed(2)}</div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Wave L: the same period, as Oakville actually billed it. */}
      {vsActual && (
        <div
          data-testid="true-bill-vs-actual"
          className="mt-4 md:mt-6 border-t-4 border-black pt-4 md:pt-6"
        >
          <div className="text-[10px] md:text-xs tracking-[0.2em] text-slate-400 uppercase font-black">
            Estimated vs actual · {vsActual.label}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2 text-black">
            <div>
              <div className="text-[8px] md:text-[10px] text-slate-400 uppercase font-black">
                Your estimate
              </div>
              <div className="text-2xl md:text-3xl italic font-black">
                ${vsActual.estimate.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-[8px] md:text-[10px] text-slate-400 uppercase font-black">
                Oakville billed
              </div>
              <div className="text-2xl md:text-3xl italic font-black text-emerald-600">
                ${vsActual.actual.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-[8px] md:text-[10px] text-slate-400 uppercase font-black">
                Difference
              </div>
              <div
                className={`text-2xl md:text-3xl italic font-black ${
                  Math.abs(vsActual.delta) <= 1 ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {vsActual.delta < 0 ? '−' : ''}
                ${Math.abs(vsActual.delta).toFixed(2)}
              </div>
            </div>
          </div>
          <div className="mt-2 text-[10px] md:text-xs text-slate-500 font-bold normal-case">
            Compared before the Ontario Electricity Rebate (this estimate has no rebate field):
            the rebate took{' '}
            <strong>
              {vsActual.credit < 0 ? '−' : ''}${Math.abs(vsActual.credit).toFixed(2)}
            </strong>{' '}
            off, so Oakville actually asked for{' '}
            <strong>${vsActual.payable.toFixed(2)}</strong> for that period.
          </div>
        </div>
      )}
    </section>
  );
}

export default TrueBillEstimate;
