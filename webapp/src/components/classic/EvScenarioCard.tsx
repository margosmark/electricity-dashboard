/**
 * EV charging scenario — the most-asked-for view from user research.
 *
 * The household types (or accepts the prefilled) nightly kWh, answers WHEN
 * they charge, and gets:
 *   • $/charge and $/month under TOU vs ULO vs Tiered, charged 23:00–07:00;
 *   • STAY vs MOVE: what their own charge costs at their own hour on their
 *     own plan, against the same kWh moved to 23:00–07:00 on ULO — the
 *     question a 7 PM charger actually asked, and the one a single "savings"
 *     number cannot answer, because at 19:00 ULO itself is On-Peak;
 *   • the three-plan comparison RECOMPUTED with that energy moved into the
 *     ULO overnight window;
 *   • their weekday 16:00–21:00 exposure — the hours a ULO switch puts at
 *     39.1¢/kWh — in kWh and dollars;
 *   • every assumption the numbers rest on, in plain language.
 *
 * The kWh field is prefilled from an overnight block found in their OWN data
 * and the hour wheel from that same block's first hour — we never claim the
 * block is a car, and we never invent an hour the household did not give us
 * or that their data did not show.
 */

"use client";

/* Wave U — user-visible copy translates; lib code reads the module locale. */
import { fmtCents, fmtMoney, fmtNumber, fmtNumberAuto, fmtSignedMoney, planLabel, t, useTranslation } from "@/i18n";
import { useMemo, useState } from 'react';
import { Car, TriangleAlert, Moon, Info, Clock } from 'lucide-react';
import { type ProcessedPoint, type RateSet } from '@/lib/energy';
import {
  buildEvScenario,
  detectEvCandidate,
  type ChargeHourSource,
  type EvChargeMove,
  type EvPeakExposure,
  type EvPlan,
} from '@/lib/evScenario';

const PLAN_ORDER: EvPlan[] = ['TOU', 'Tiered', 'ULO'];

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => String(h).padStart(2, '0');

/**
 * "+$12.34" / "−$5.67" — a signed money delta, never a bare number.
 * Anything below half a cent renders as +$0.00: float noise from blending
 * two identical rates must never show up as a phantom "−$0.00" saving.
 */
function signedMoney(v: number): string {
  const cents = Math.abs(v) < 0.005 ? 0 : v;
  return cents < 0
    ? t('ev.signedNegative', { amount: fmtMoney(Math.abs(cents)) })
    : t('ev.signedPositive', { amount: fmtMoney(Math.abs(cents)) });
}

/**
 * The one line the household asked for: what staying at their hour costs on
 * THEIR plan, what the same charge costs moved to 23:00–07:00 on ULO, and
 * which way the difference runs. When the anchor already sits overnight the
 * hour is not the story, and the sentence says so instead of implying a shift.
 */
function moveSentence(cm: EvChargeMove, planLabel: string): string {
  // Wave U — the money strings below are locale-aware, so the sentence
  // reads "12,34 $/mois" in French.
  const stay = fmtMoney(cm.stayCostPerMonth) + t('ev.perMonth');
  const move = fmtMoney(cm.moveCostPerMonth) + t('ev.perMonth');
  const delta = fmtMoney(Math.abs(cm.totalSavingPerMonth)) + t('ev.perMonth');
  if (cm.alreadyOvernight) {
    return Math.abs(cm.totalSavingPerMonth) < 0.005
      ? t('ev.alreadyOvernightSame', { label: cm.stayLabel, stay, move })
      : t('ev.alreadyOvernightDiff', { label: cm.stayLabel, stay, plan: planLabel, move, delta });
  }
  return cm.totalSavingPerMonth >= 0
    ? t('ev.betterOff', { label: cm.stayLabel, plan: planLabel, stay, move, delta })
    : t('ev.worseOff', { label: cm.stayLabel, plan: planLabel, stay, move, delta });
}

/**
 * The two things a "/mo" figure has to declare: what is inside the price, and
 * that the month is a run-rate scaled from the window on screen rather than a
 * month of metering. Both peak-exposure blocks render it — the empty state
 * used to declare neither, which is how a scaled guess gets read as a
 * measured month.
 */
function ExposureBasis({ exposure }: { exposure: EvPeakExposure }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="ev-exposure-basis"
      className="text-[9px] md:text-[11px] font-bold mt-2 normal-case"
    >
      {t('ev.exposureBasis', { count: exposure.days, days: exposure.days })}
    </div>
  );
}

export default function EvScenarioCard({
  rows,
  rates,
  plan = 'TOU',
}: {
  rows: ProcessedPoint[];
  rates: RateSet | null;
  /**
   * The plan the household has selected (Dashboard's plan switcher). The
   * "stay put" side of the counterfactual is priced on THIS plan, because
   * "what am I paying today?" has exactly one right answer.
   */
  plan?: EvPlan;
}) {
  const { t } = useTranslation();
  // `detectEvCandidate` writes the "we found this window" sentence in the
  // active language, so the memo has to re-derive on a toggle.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
  const candidate = useMemo(() => detectEvCandidate(rows), [rows, t]);

  // `kwhText` stays null until the household types — before that we show the
  // block we found, so the field tracks the data without an effect.
  const [kwhText, setKwhText] = useState<string | null>(null);
  const shownKwh = kwhText ?? (candidate ? candidate.kwhPerNight.toFixed(1) : '');

  const parsed = Number(shownKwh.replace(/[^0-9.]/g, ''));
  const dailyKwh = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  // "When do you usually charge?" — same null-until-touched pattern: the
  // wheel PREFILLS from the block we detected (reuse the winning candidate
  // rather than asking blind) and only becomes the household's own answer
  // once they move it.
  const [hourPicked, setHourPicked] = useState<number | null>(null);
  const shownHour = hourPicked ?? (candidate ? candidate.startHour : null);
  const chargeHourSource: ChargeHourSource | null =
    hourPicked !== null ? 'user' : candidate ? 'detected' : null;

  const scenario = useMemo(
    () =>
      buildEvScenario({
        rows,
        rates,
        dailyKwh,
        candidate,
        chargeHour: shownHour,
        chargeHourSource,
        currentPlan: plan,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
    [rows, rates, dailyKwh, candidate, shownHour, chargeHourSource, plan, t],
  );

  const pc = scenario.planComparison;
  const exposure = scenario.peakExposure;
  const cm = scenario.chargeMove;

  return (
    <div
      data-testid="ev-scenario"
      data-source={scenario.source ?? 'none'}
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 text-ink font-black uppercase"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h3 className="text-2xl md:text-4xl italic flex items-center gap-2 md:gap-3">
          <Car size={24} className="md:w-10 md:h-10" strokeWidth={4} /> {t('ev.title')}
        </h3>
        {scenario.source === 'detected' && (
          <span
            data-testid="ev-detect-note"
            className="bg-emerald-400 text-accent-ink border-2 border-edge rounded-full px-3 py-1 text-[9px] md:text-[11px]"
          >
            {t('ev.prefilled')}
          </span>
        )}
      </div>
      <p className="text-[10px] md:text-xs font-bold text-ink-3 normal-case mb-4 md:mb-6">
        {t('ev.blurb')}
      </p>

      {/* --- The input, always visible --- */}
      <div className="flex flex-wrap items-end gap-3 md:gap-4 mb-4 md:mb-6">
        <label className="block">
          <span className="block text-[10px] md:text-xs font-black uppercase mb-1">
            {t('ev.kwhLabel')}
          </span>
          <input
            data-testid="ev-kwh-input"
            type="number"
            min={0}
            step={0.1}
            inputMode="decimal"
            value={shownKwh}
            onChange={(e) => setKwhText(e.target.value)}
            placeholder={candidate ? fmtNumberAuto(candidate.kwhPerNight, 1) : t('ev.kwhPlaceholder')}
            className="w-32 md:w-40 p-3 md:p-4 border-4 border-edge rounded-xl md:rounded-2xl bg-accent-soft text-lg md:text-2xl font-black text-ink"
          />
        </label>
        {/* --- The hour anchor: the question the shipped card never asked --- */}
        <label className="block">
          <span className="block text-[10px] md:text-xs font-black uppercase mb-1">
            {t('ev.hourQuestion')}
          </span>
          <select
            data-testid="ev-charge-hour"
            value={shownHour === null ? '' : String(shownHour)}
            onChange={(e) => setHourPicked(e.target.value === '' ? null : Number(e.target.value))}
            className="w-32 md:w-40 p-3 md:p-4 border-4 border-edge rounded-xl md:rounded-2xl bg-accent-soft text-lg md:text-2xl font-black text-ink"
          >
            <option value="" disabled>
              {t('ev.pickPlaceholder')}
            </option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {`${hh(h)}:00`}
              </option>
            ))}
          </select>
        </label>
        <div className="text-[9px] md:text-[11px] font-bold text-ink-3 normal-case max-w-md">
          {scenario.source === 'detected' && candidate
            ? t('ev.fromData', { label: candidate.label, detail: candidate.detail })
            : dailyKwh > 0
              ? t('ev.usingTyped')
              : t('ev.noBlock')}
          {' '}
          {shownHour === null
            ? t('ev.pickHour')
            : chargeHourSource === 'detected'
              ? t('ev.hourPrefilled', { label: candidate?.label ?? `${hh(shownHour)}:00` })
              : t('ev.usingHour', { hour: hh(shownHour) })}
        </div>
      </div>

      {!scenario.ready ? (
        <div
          data-testid="ev-scenario-empty"
          className="bg-hover border-2 md:border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6 font-bold text-ink-2 text-xs md:text-sm normal-case"
        >
          {t('ev.notReady')}
        </div>
      ) : (
        <div className="space-y-4 md:space-y-6">
          {/* --- $/charge and $/month, TOU vs ULO --- */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
            {PLAN_ORDER.map((plan) => (
              <div
                key={plan}
                data-testid={`ev-plan-${plan}`}
                className={`border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-5 ${
                  plan === 'ULO' ? 'bg-emerald-400 text-accent-ink' : plan === 'TOU' ? 'bg-hover' : 'bg-card'
                }`}
              >
                <div className="text-[10px] md:text-xs font-black uppercase">{planLabel(plan)}</div>
                <div className={`text-[8px] md:text-[10px] font-bold ${plan === 'ULO' ? 'text-accent-ink' : 'text-ink-2'}`}>
                  {fmtNumber(scenario.prices[plan].rateCents, 1)}{t('ev.rateOvernight')}
                </div>
                <div
                  className="text-lg md:text-xl font-black mt-2 flex justify-between items-baseline"
                  data-testid={`ev-per-charge-${plan}`}
                >
                  <span className="text-[8px] md:text-[10px]">{t('ev.perChargeUnit')}</span>
                  <span className="italic text-xl md:text-2xl">
                    {fmtMoney(scenario.prices[plan].perCharge)}
                  </span>
                </div>
                <div
                  className="text-lg md:text-xl font-black flex justify-between items-baseline"
                  data-testid={`ev-per-month-${plan}`}
                >
                  <span className="text-[8px] md:text-[10px]">{t('ev.perMonthLong')}</span>
                  <span className="italic text-xl md:text-2xl">
                    {fmtMoney(scenario.prices[plan].perMonth)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div
            data-testid="ev-headline"
            className="bg-yellow-400 text-accent-ink border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6 text-base md:text-xl leading-snug"
          >
            {t('ev.headlineLead')}{' '}
            <span className="italic">{fmtMoney(scenario.prices.ULO.perCharge)}</span> {t('ev.vs')}{' '}
            <span className="italic">{fmtMoney(scenario.prices.TOU.perCharge)}</span> {t('ev.onTouDash')}{' '}
            <span className="italic">
              {fmtMoney(scenario.chargeSavingUloVsTouPerMonth)}{t('ev.perMonthLong')}
            </span>{' '}
            {t('ev.cheaperOnCharge')}
          </div>

          {/* --- THE question: stay at your hour on your plan, or move it --- */}
          {cm ? (
            <div
              data-testid="ev-charge-move"
              className="border-4 border-edge rounded-xl md:rounded-2xl overflow-hidden bg-sky-100"
            >
              <div className="bg-inv text-inv-ink px-4 py-2 text-[10px] md:text-xs font-black uppercase flex flex-wrap justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Clock size={14} strokeWidth={4} />
                  {t('ev.stayAtTitle')} {cm.stayLabel} {t('ev.vsMoveTo')}
                </span>
                <span className="text-accent-yellow">{t('ev.pricedOn')} {planLabel(plan)}</span>
              </div>

              {cm.alreadyOvernight && (
                <div
                  data-testid="ev-already-overnight"
                  className="bg-emerald-300 text-accent-ink border-b-4 border-edge px-4 py-2 text-[10px] md:text-xs font-black uppercase"
                >
                  {t('ev.alreadyOptimal')}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2">
                <div
                  data-testid="ev-stay-side"
                  className="p-3 md:p-4 border-b-4 md:border-b-0 md:border-r-4 border-edge bg-card"
                >
                  <div className="text-[10px] md:text-xs font-black uppercase">
                    {t('ev.stayPut')} {planLabel(plan)}
                  </div>
                  <div className="text-[8px] md:text-[10px] font-bold text-ink-3">
                    {cm.stayLabel} · {fmtNumber(cm.stayRateCents, 1)}{t('ev.perKwh')}
                    {cm.stayBasis === 'worst-case' ? ` ${t('ev.upperBound')}` : ''}
                  </div>
                  <div
                    className="text-lg md:text-xl italic font-black mt-1 flex justify-between items-baseline"
                    data-testid="ev-stay-cost"
                  >
                    <span className="text-[8px] md:text-[10px]">{t('ev.perMonthLong')}</span>
                    <span className="italic text-xl md:text-2xl">
                      {fmtMoney(cm.stayCostPerMonth)}
                    </span>
                  </div>
                  <div className="text-[9px] md:text-[11px] font-bold text-ink-3">
                    {fmtMoney(cm.stayCostPerCharge)} {t('ev.perChargeWord')}
                  </div>
                </div>
                <div data-testid="ev-move-side" className="p-3 md:p-4 bg-good-soft-2">
                  <div className="text-[10px] md:text-xs font-black uppercase">
                    {t('ev.moveUlo')}
                  </div>
                  <div className="text-[8px] md:text-[10px] font-bold text-ink-3">
                    23:00–07:00 · {fmtNumber(cm.moveRateCents, 1)}{t('ev.perKwh')}
                  </div>
                  <div
                    className="text-lg md:text-xl italic font-black mt-1 flex justify-between items-baseline"
                    data-testid="ev-move-cost"
                  >
                    <span className="text-[8px] md:text-[10px]">{t('ev.perMonthLong')}</span>
                    <span className="italic text-xl md:text-2xl">
                      {fmtMoney(cm.moveCostPerMonth)}
                    </span>
                  </div>
                  <div className="text-[9px] md:text-[11px] font-bold text-ink-3">
                    {fmtMoney(cm.moveCostPerCharge)} {t('ev.perChargeWord')}
                  </div>
                </div>
              </div>

              <div
                data-testid="ev-move-result"
                className="border-t-4 border-edge px-3 md:px-4 py-3 bg-card"
              >
                <div className="text-sm md:text-lg italic font-black leading-snug">
                  {moveSentence(cm, planLabel(plan))}
                </div>
                <div className="text-[9px] md:text-[11px] font-bold text-ink-2 mt-1">
                  {t('ev.ofThat', {
                    shift: signedMoney(cm.shiftSavingPerMonth),
                    plan: signedMoney(cm.planSavingPerMonth),
                  })}
                </div>
                <div className="text-[9px] md:text-[11px] font-bold text-ink-3 normal-case mt-1">
                  {cm.detail}
                </div>
              </div>
            </div>
          ) : (
            <div
              data-testid="ev-charge-move-empty"
              className="border-4 border-edge rounded-xl md:rounded-2xl p-4 bg-sky-100 text-[10px] md:text-xs font-bold normal-case text-accent-ink-2"
            >
              {t('ev.answerLead')} <span className="font-black">{t('ev.hourQuestion')}</span> {t('ev.priceAtHour')} {planLabel(plan)} {t('ev.againstMoving')}
            </div>
          )}

          {/* --- Three-plan comparison, recomputed with the charge on overnight --- */}
          {pc && (
            <div
              data-testid="ev-plan-comparison"
              className="border-4 border-edge rounded-xl md:rounded-2xl overflow-hidden"
            >
              <div className="bg-inv text-inv-ink px-4 py-2 text-[10px] md:text-xs font-black uppercase flex flex-wrap justify-between gap-2">
                <span>{t('ev.wholeDataset')} {fmtNumber(pc.evKwh)} {t('ev.kwhMoved')}</span>
                <span className="text-accent-yellow">{pc.days} {t('ev.daysOfData', { count: pc.days })}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3">
                {PLAN_ORDER.map((plan) => {
                  const delta = pc.withChargeOnOvernight[plan] - pc.baseline[plan];
                  return (
                    <div
                      key={plan}
                      className="p-3 md:p-4 border-t-4 md:border-t-0 md:border-r-4 last:md:border-r-0 border-edge bg-card"
                    >
                      <div className="text-[10px] font-black uppercase">{planLabel(plan)}</div>
                      {/* The baseline is the WHOLE loaded file repriced on
                          this plan — never "today". Calling it today (as the
                          first draft did) is the same lie as a "You paid" row
                          over days nobody has billed: the word claims a day the
                          number never measured. The header above carries the
                          day count; this line names the basis. */}
                      <div
                        className="text-[8px] md:text-[10px] font-bold text-ink-3"
                        data-testid={`ev-plan-baseline-${plan}`}
                      >
                        {t('ev.baseline')} {fmtMoney(pc.baseline[plan])}
                      </div>
                      <div className="text-lg md:text-xl italic font-black">
                        {fmtMoney(pc.withChargeOnOvernight[plan])}
                      </div>
                      <div
                        className={`text-[9px] md:text-[11px] font-black ${
                          delta < -0.005 ? 'text-good' : delta > 0.005 ? 'text-bad' : 'text-ink-3'
                        }`}
                      >
                        {Math.abs(delta) < 0.005
                          ? t('ev.noChange')
                          : `${fmtSignedMoney(delta)} ${t('ev.vsBaseline')}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* --- Weekday 4–9pm exposure --- */}
          {exposure && (
            <div
              data-testid="ev-peak-exposure"
              className="bg-red-400 text-accent-ink border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6"
            >
              <div className="flex items-center gap-2 text-[10px] md:text-xs font-black uppercase">
                <TriangleAlert size={14} strokeWidth={4} /> {t('ev.peakExposureTitle')} {exposure.windowLabel}
              </div>
              <div className="flex flex-wrap items-baseline gap-3 md:gap-6 mt-2">
                <div className="text-2xl md:text-4xl italic font-black">
                  {fmtNumber(exposure.kwhPerMonth, 1)} {t('ev.kwhPerMonth')}
                </div>
                <div className="text-lg md:text-2xl font-black">
                  {fmtMoney(exposure.costPerMonth)}{t('ev.perMonthAt')} {fmtCents(exposure.rateCents, 1)}
                </div>
                <div className="text-xs md:text-sm font-black">
                  {fmtMoney(exposure.atStakePerMonth)}{t('ev.perMonthMore')}
                </div>
              </div>
              <div className="text-[9px] md:text-[11px] font-bold mt-2 normal-case">
                {exposure.hoursPerWeekday} {t('ev.peakExposureBody', { count: exposure.hoursPerWeekday })}
              </div>
              <ExposureBasis exposure={exposure} />
            </div>
          )}

          {/* --- Honest assumptions --- */}
          <div data-testid="ev-assumptions" className="border-2 border-edge rounded-xl p-3 md:p-4 bg-inset">
            <div className="flex items-center gap-2 text-[10px] font-black uppercase mb-2">
              <Info size={12} strokeWidth={4} /> {t('ev.assumptionsTitle')}
            </div>
            <ul className="space-y-1 text-[9px] md:text-[11px] font-bold text-ink-2 normal-case list-disc ml-4">
              {scenario.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Peak exposure is a property of the data — show it even with no EV tagged. */}
      {!scenario.ready && exposure && (
        <div
          data-testid="ev-peak-exposure"
          className="mt-4 bg-red-400 text-accent-ink border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6"
        >
          <div className="flex items-center gap-2 text-[10px] md:text-xs font-black uppercase">
            <Moon size={14} strokeWidth={4} /> {t('ev.peakExposureTitle')} {exposure.windowLabel}
          </div>
          <div className="text-xl md:text-2xl italic font-black mt-1">
            {fmtNumber(exposure.kwhPerMonth, 1)} {t('ev.kwhPerMonthArrow')}{fmtMoney(exposure.costPerMonth)}{t('ev.perMonthAt')}{' '}
            {fmtCents(exposure.rateCents, 1)}
          </div>
          <ExposureBasis exposure={exposure} />
        </div>
      )}
    </div>
  );
}
