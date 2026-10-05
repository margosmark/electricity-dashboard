/**
 * Bill estimate card: the variable-charges figure the plan cards already
 * imply, plus optional LOCAL add-ons (delivery, regulatory, HST) that turn it
 * into a true-bill estimate.
 *
 * Every field is seeded empty. With all four empty the card is exactly the
 * old behavior — variable-only figure plus the "does not include …" caption.
 * These numbers are user inputs kept in this browser; they are deliberately
 * NOT read from /api/rates, which only carries OEB commodity rates.
 */

"use client";

import {
  type ProcessedPoint,
  buildActiveChartData,
  calculateComparison,
  calculateTrueBill,
  countMonthsInView,
  hasExtraCharges,
  BASELINE_ESTIMATE_CAPTION,
} from '@/lib/energy';
import { useExtraCharges, type ExtraCharges } from '@/hooks/useDashboard';

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
};

export function TrueBillEstimate({ plan, startDate, endDate, windowData }: Props) {
  const { charges, setCharge } = useExtraCharges();

  if (windowData.length === 0) return null;

  // Same aggregation the plan cards use, but anchored to the window instead of
  // the current zoom target: a bill is for the period, not for one bar.
  const comparison = calculateComparison(buildActiveChartData(windowData, 'monthly', null));
  const variableCost = comparison ? comparison[plan] : 0;
  const totalKwh = windowData.reduce((sum, d) => sum + d.usage_kwh, 0);
  const months = countMonthsInView(windowData);
  const bill = calculateTrueBill({ variableCost, totalKwh, months, charges });
  const active = hasExtraCharges(charges) && bill !== null;

  const set = (field: keyof ExtraCharges) => (value: string) => setCharge(field, value);

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
          <div className="mt-2 text-[8px] text-slate-400 normal-case">
            Local inputs — not derived from the OEB commodity rates in /api/rates.
          </div>
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
    </section>
  );
}

export default TrueBillEstimate;
