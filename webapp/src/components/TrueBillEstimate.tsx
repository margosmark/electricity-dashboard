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
} from '@/lib/energy';
import { useExtraCharges } from '@/hooks/useDashboard';
// Wave U — labels, captions and the vs-actual receipt translate with the
// toggle; every money figure goes through the locale-aware formatters.
import { fmtKwh, fmtMoney, fmtNumber, fmtPercent, planLabel, useTranslation } from '@/i18n';

const FIELD_CLASS =
  'w-full p-2 md:p-3 border-2 md:border-4 border-edge rounded-lg md:rounded-xl ' +
  'bg-inset font-black text-base md:text-xs text-ink outline-none ' +
  'focus:bg-accent-soft focus:shadow-hard-2';

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
      className="flex flex-col gap-1 text-[8px] md:text-[10px] uppercase text-ink-3 font-black"
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
  const { t } = useTranslation();
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
  }, [derived, allData, plan, charges, t]);

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
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 md:shadow-hard-16 text-ink font-black uppercase"
    >
      <div className="flex flex-col xl:flex-row gap-6 xl:gap-12 justify-between">
        <div className="xl:min-w-[320px]">
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4">
            {t('trueBill.header', { start: startDate, end: endDate, plan: planLabel(plan) })}
          </div>
          <div className="text-4xl md:text-6xl italic font-black mt-1 md:mt-2" data-testid="variable-estimate">
            {fmtMoney(variableCost)}
          </div>
          <p
            data-testid="estimate-caption"
            className="mt-3 md:mt-5 text-[10px] md:text-xs text-ink-2 normal-case font-bold max-w-2xl leading-relaxed"
          >
            {/* Wave U: the English constant stays exported (it is pinned by
                lib/energy.test.ts); the displayed text translates. */}
            {bill ? bill.caption : t('trueBill.baselineCaption')}
          </p>
        </div>

        <div className="xl:max-w-[560px]">
          <div className="text-[8px] md:text-[10px] text-ink-4 mb-2 md:mb-3">
            {t('trueBill.addOns')}
          </div>
          <div className="grid grid-cols-2 gap-3 md:gap-4">
            <ChargeField
              id="charge-delivery-per-kwh"
              label={t('trueBill.field.deliveryPerKwh')}
              placeholder={t('trueBill.ph.example4')}
              value={charges.deliveryPerKwh}
              onChange={set('deliveryPerKwh')}
            />
            <ChargeField
              id="charge-delivery-flat"
              label={t('trueBill.field.deliveryFlat')}
              placeholder={t('trueBill.ph.example2')}
              value={charges.deliveryFlat}
              onChange={set('deliveryFlat')}
            />
            <ChargeField
              id="charge-regulatory-per-kwh"
              label={t('trueBill.field.regulatoryPerKwh')}
              placeholder={t('trueBill.ph.example4')}
              value={charges.regulatoryPerKwh}
              onChange={set('regulatoryPerKwh')}
            />
            <ChargeField
              id="charge-hst-pct"
              label={t('trueBill.field.hst')}
              placeholder="13"
              value={charges.hstPct}
              onChange={set('hstPct')}
            />
          </div>
          {charges.xmlSource ? (
            <div
              data-testid="xml-charge-source"
              className="mt-2 text-[8px] md:text-[10px] text-ink-3 normal-case font-bold"
            >
              {xmlIntact ? (
                <>
                  {t('trueBill.xmlPrefilled', {
                    label: charges.xmlSource.label,
                    delivery: fmtMoney(derived?.delivery ?? 0),
                    regulatory: fmtMoney(derived?.regulatory ?? 0),
                    hst: derived ? fmtPercent(derived.hstPct) : '',
                  })}
                  {derived?.fit.mode === 'split' && derived.fit.flat !== null
                    ? t('trueBill.xmlFit', {
                        flat: fmtMoney(derived.fit.flat),
                        perKwh: fmtNumber(derived.fit.perKwh, 4),
                        periods: derived.fit.periods,
                        residual: fmtMoney(derived.fit.maxResidual ?? 0),
                      })
                    : ''}
                </>
              ) : (
                <>{t('trueBill.xmlEdited', { label: charges.xmlSource.label })}</>
              )}
            </div>
          ) : (
            <div className="mt-2 text-[8px] md:text-[10px] text-ink-4 normal-case">
              {t('trueBill.localInputs')}
            </div>
          )}
        </div>
      </div>

      {bill && active && (
        <div
          data-testid="true-bill"
          className="mt-6 md:mt-10 border-t-4 border-edge pt-6 md:pt-8 flex flex-col md:flex-row md:items-end justify-between gap-5 md:gap-10"
        >
          <div>
            <div className="text-[10px] md:text-xs tracking-[0.2em] text-warn">{t('trueBill.title')}</div>
            <div className="text-4xl md:text-6xl italic font-black text-good mt-1 md:mt-2" data-testid="true-bill-total">
              {fmtMoney(bill.total)}
            </div>
            <div className="mt-2 text-[10px] text-ink-3 normal-case">
              {t('trueBill.monthsKwh', { count: bill.months, kwh: fmtKwh(bill.totalKwh) })}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-6 text-[10px] md:text-xs">
            <div className="bg-inset border-2 border-edge rounded-lg p-3">
              <div className="text-ink-4 text-[8px]">{t('trueBill.variable')}</div>
              <div className="italic">{fmtMoney(bill.variable)}</div>
            </div>
            {bill.deliveryPerKwh !== null || bill.deliveryFlat !== null ? (
              <div className="bg-inset border-2 border-edge rounded-lg p-3">
                <div className="text-ink-4 text-[8px]">{t('trueBill.delivery')}</div>
                <div className="italic">{fmtMoney(bill.delivery)}</div>
              </div>
            ) : null}
            {bill.regulatoryPerKwh !== null ? (
              <div className="bg-inset border-2 border-edge rounded-lg p-3">
                <div className="text-ink-4 text-[8px]">{t('trueBill.regulatory')}</div>
                <div className="italic">{fmtMoney(bill.regulatory)}</div>
              </div>
            ) : null}
            {bill.hstPct !== null ? (
              <div className="bg-inset border-2 border-edge rounded-lg p-3">
                <div className="text-ink-4 text-[8px]">{t('trueBill.hst')}</div>
                <div className="italic">{fmtMoney(bill.hst)}</div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Wave L: the same period, as Oakville actually billed it. */}
      {vsActual && (
        <div
          data-testid="true-bill-vs-actual"
          className="mt-4 md:mt-6 border-t-4 border-edge pt-4 md:pt-6"
        >
          <div className="text-[10px] md:text-xs tracking-[0.2em] text-ink-4 uppercase font-black">
            {t('trueBill.vsActualHeader', { label: vsActual.label })}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2 text-ink">
            <div>
              <div className="text-[8px] md:text-[10px] text-ink-4 uppercase font-black">
                {t('trueBill.yourEstimate')}
              </div>
              <div className="text-2xl md:text-3xl italic font-black">
                {fmtMoney(vsActual.estimate)}
              </div>
            </div>
            <div>
              <div className="text-[8px] md:text-[10px] text-ink-4 uppercase font-black">
                {t('trueBill.oakvilleBilled')}
              </div>
              <div className="text-2xl md:text-3xl italic font-black text-good">
                {fmtMoney(vsActual.actual)}
              </div>
            </div>
            <div>
              <div className="text-[8px] md:text-[10px] text-ink-4 uppercase font-black">
                {t('trueBill.difference')}
              </div>
              <div
                className={`text-2xl md:text-3xl italic font-black ${
                  Math.abs(vsActual.delta) <= 1 ? 'text-good' : 'text-bad'
                }`}
              >
                {vsActual.delta < 0 ? '−' : ''}
                {fmtMoney(Math.abs(vsActual.delta))}
              </div>
            </div>
          </div>
          <div className="mt-2 text-[10px] md:text-xs text-ink-3 font-bold normal-case">
            {t('trueBill.rebateIntro')}{' '}
            <strong>
              {vsActual.credit < 0 ? '−' : ''}{fmtMoney(Math.abs(vsActual.credit))}
            </strong>{' '}
            {t('trueBill.rebateOutro')}{' '}
            <strong>{fmtMoney(vsActual.payable)}</strong>
          </div>
        </div>
      )}
    </section>
  );
}

export default TrueBillEstimate;
