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
import { fmtMoney, t, useTranslation } from "@/i18n";
import { useMemo, useState } from 'react';
import { Car, TriangleAlert, Moon, Info, Clock } from 'lucide-react';
import { type ProcessedPoint, type RateSet } from '@/lib/energy';
import {
  buildEvScenario,
  detectEvCandidate,
  type ChargeHourSource,
  type EvChargeMove,
  type EvPlan,
} from '@/lib/evScenario';

const PLAN_ORDER: EvPlan[] = ['TOU', 'Tiered', 'ULO'];
const PLAN_LABEL: Record<EvPlan, string> = {
  TOU: 'Time-of-Use',
  Tiered: 'Tiered',
  ULO: 'Ultra-Low Overnight',
};

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
  const candidate = useMemo(() => detectEvCandidate(rows), [rows]);

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
    [rows, rates, dailyKwh, candidate, shownHour, chargeHourSource, plan],
  );

  const pc = scenario.planComparison;
  const exposure = scenario.peakExposure;
  const cm = scenario.chargeMove;

  return (
    <div
      data-testid="ev-scenario"
      data-source={scenario.source ?? 'none'}
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h3 className="text-2xl md:text-4xl italic flex items-center gap-2 md:gap-3">
          <Car size={24} className="md:w-10 md:h-10" strokeWidth={4} /> EV charging scenario
        </h3>
        {scenario.source === 'detected' && (
          <span
            data-testid="ev-detect-note"
            className="bg-emerald-400 border-2 border-black rounded-full px-3 py-1 text-[9px] md:text-[11px]"
          >
            Prefilled from your data
          </span>
        )}
      </div>
      <p className="text-[10px] md:text-xs font-bold text-slate-500 normal-case mb-4 md:mb-6">
        What a night&apos;s charge costs, and what your weekday 4–9pm window is worth at risk.
      </p>

      {/* --- The input, always visible --- */}
      <div className="flex flex-wrap items-end gap-3 md:gap-4 mb-4 md:mb-6">
        <label className="block">
          <span className="block text-[10px] md:text-xs font-black uppercase mb-1">
            Nightly EV charge (kWh)
          </span>
          <input
            data-testid="ev-kwh-input"
            type="number"
            min={0}
            step={0.1}
            inputMode="decimal"
            value={shownKwh}
            onChange={(e) => setKwhText(e.target.value)}
            placeholder={candidate ? candidate.kwhPerNight.toFixed(1) : 'e.g. 10'}
            className="w-32 md:w-40 p-3 md:p-4 border-4 border-black rounded-xl md:rounded-2xl bg-yellow-50 text-lg md:text-2xl font-black text-black"
          />
        </label>
        {/* --- The hour anchor: the question the shipped card never asked --- */}
        <label className="block">
          <span className="block text-[10px] md:text-xs font-black uppercase mb-1">
            When do you usually charge?
          </span>
          <select
            data-testid="ev-charge-hour"
            value={shownHour === null ? '' : String(shownHour)}
            onChange={(e) => setHourPicked(e.target.value === '' ? null : Number(e.target.value))}
            className="w-32 md:w-40 p-3 md:p-4 border-4 border-black rounded-xl md:rounded-2xl bg-yellow-50 text-lg md:text-2xl font-black text-black"
          >
            <option value="" disabled>
              — pick —
            </option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {`${hh(h)}:00`}
              </option>
            ))}
          </select>
        </label>
        <div className="text-[9px] md:text-[11px] font-bold text-slate-500 normal-case max-w-md">
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
          className="bg-slate-100 border-2 md:border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6 font-bold text-slate-600 text-xs md:text-sm normal-case"
        >
          Tag a nightly kWh above to price the charge under all three plans.
        </div>
      ) : (
        <div className="space-y-4 md:space-y-6">
          {/* --- $/charge and $/month, TOU vs ULO --- */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
            {PLAN_ORDER.map((plan) => (
              <div
                key={plan}
                data-testid={`ev-plan-${plan}`}
                className={`border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-5 ${
                  plan === 'ULO' ? 'bg-emerald-400' : plan === 'TOU' ? 'bg-slate-100' : 'bg-white'
                }`}
              >
                <div className="text-[10px] md:text-xs font-black uppercase">{PLAN_LABEL[plan]}</div>
                <div className="text-[8px] md:text-[10px] font-bold text-slate-600">
                  {scenario.prices[plan].rateCents.toFixed(1)}¢/kWh overnight
                </div>
                <div
                  className="text-lg md:text-xl font-black mt-2 flex justify-between items-baseline"
                  data-testid={`ev-per-charge-${plan}`}
                >
                  <span className="text-[8px] md:text-[10px]">/charge</span>
                  <span className="italic text-xl md:text-2xl">
                    ${scenario.prices[plan].perCharge.toFixed(2)}
                  </span>
                </div>
                <div
                  className="text-lg md:text-xl font-black flex justify-between items-baseline"
                  data-testid={`ev-per-month-${plan}`}
                >
                  <span className="text-[8px] md:text-[10px]">/month</span>
                  <span className="italic text-xl md:text-2xl">
                    ${scenario.prices[plan].perMonth.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div
            data-testid="ev-headline"
            className="bg-yellow-400 border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6 text-base md:text-xl leading-snug"
          >
            A night&apos;s charge on ULO costs{' '}
            <span className="italic">${scenario.prices.ULO.perCharge.toFixed(2)}</span> vs{' '}
            <span className="italic">${scenario.prices.TOU.perCharge.toFixed(2)}</span> on TOU —{' '}
            <span className="italic">
              ${scenario.chargeSavingUloVsTouPerMonth.toFixed(2)}/month
            </span>{' '}
            cheaper on the charge alone.
          </div>

          {/* --- THE question: stay at your hour on your plan, or move it --- */}
          {cm ? (
            <div
              data-testid="ev-charge-move"
              className="border-4 border-black rounded-xl md:rounded-2xl overflow-hidden bg-sky-100"
            >
              <div className="bg-black text-white px-4 py-2 text-[10px] md:text-xs font-black uppercase flex flex-wrap justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Clock size={14} strokeWidth={4} />
                  When do you charge? Stay at {cm.stayLabel} vs move to 23:00–07:00
                </span>
                <span className="text-yellow-400">Priced on {PLAN_LABEL[plan]}</span>
              </div>

              {cm.alreadyOvernight && (
                <div
                  data-testid="ev-already-overnight"
                  className="bg-emerald-300 border-b-4 border-black px-4 py-2 text-[10px] md:text-xs font-black uppercase"
                >
                  Already in the overnight window — you&apos;re optimal at this hour, nothing to shift.
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2">
                <div
                  data-testid="ev-stay-side"
                  className="p-3 md:p-4 border-b-4 md:border-b-0 md:border-r-4 border-black bg-white"
                >
                  <div className="text-[10px] md:text-xs font-black uppercase">
                    Stay put · {PLAN_LABEL[plan]}
                  </div>
                  <div className="text-[8px] md:text-[10px] font-bold text-slate-500">
                    {cm.stayLabel} · {cm.stayRateCents.toFixed(1)}¢/kWh
                    {cm.stayBasis === 'worst-case' ? ' (upper bound)' : ''}
                  </div>
                  <div
                    className="text-lg md:text-xl italic font-black mt-1 flex justify-between items-baseline"
                    data-testid="ev-stay-cost"
                  >
                    <span className="text-[8px] md:text-[10px]">/month</span>
                    <span className="italic text-xl md:text-2xl">
                      ${cm.stayCostPerMonth.toFixed(2)}
                    </span>
                  </div>
                  <div className="text-[9px] md:text-[11px] font-bold text-slate-500">
                    ${cm.stayCostPerCharge.toFixed(2)} a charge
                  </div>
                </div>
                <div data-testid="ev-move-side" className="p-3 md:p-4 bg-emerald-100">
                  <div className="text-[10px] md:text-xs font-black uppercase">
                    Move · Ultra-Low Overnight
                  </div>
                  <div className="text-[8px] md:text-[10px] font-bold text-slate-500">
                    23:00–07:00 · {cm.moveRateCents.toFixed(1)}¢/kWh
                  </div>
                  <div
                    className="text-lg md:text-xl italic font-black mt-1 flex justify-between items-baseline"
                    data-testid="ev-move-cost"
                  >
                    <span className="text-[8px] md:text-[10px]">/month</span>
                    <span className="italic text-xl md:text-2xl">
                      ${cm.moveCostPerMonth.toFixed(2)}
                    </span>
                  </div>
                  <div className="text-[9px] md:text-[11px] font-bold text-slate-500">
                    ${cm.moveCostPerCharge.toFixed(2)} a charge
                  </div>
                </div>
              </div>

              <div
                data-testid="ev-move-result"
                className="border-t-4 border-black px-3 md:px-4 py-3 bg-white"
              >
                <div className="text-sm md:text-lg italic font-black leading-snug">
                  {moveSentence(cm, PLAN_LABEL[plan])}
                </div>
                <div className="text-[9px] md:text-[11px] font-bold text-slate-600 mt-1">
                  {t('ev.ofThat', {
                    shift: signedMoney(cm.shiftSavingPerMonth),
                    plan: signedMoney(cm.planSavingPerMonth),
                  })}
                </div>
                <div className="text-[9px] md:text-[11px] font-bold text-slate-500 normal-case mt-1">
                  {cm.detail}
                </div>
              </div>
            </div>
          ) : (
            <div
              data-testid="ev-charge-move-empty"
              className="border-4 border-black rounded-xl md:rounded-2xl p-4 bg-sky-100 text-[10px] md:text-xs font-bold normal-case text-slate-700"
            >
              Answer <span className="font-black">When do you usually charge?</span> above — we will
              price staying at that hour on {PLAN_LABEL[plan]} against moving the same kWh to
              23:00–07:00 on Ultra-Low Overnight.
            </div>
          )}

          {/* --- Three-plan comparison, recomputed with the charge on overnight --- */}
          {pc && (
            <div
              data-testid="ev-plan-comparison"
              className="border-4 border-black rounded-xl md:rounded-2xl overflow-hidden"
            >
              <div className="bg-black text-white px-4 py-2 text-[10px] md:text-xs font-black uppercase flex flex-wrap justify-between gap-2">
                <span>Whole loaded dataset with {pc.evKwh.toFixed(0)} kWh of charging moved to 23:00–07:00</span>
                <span className="text-yellow-400">{pc.days} days of data</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3">
                {PLAN_ORDER.map((plan) => {
                  const delta = pc.withChargeOnOvernight[plan] - pc.baseline[plan];
                  return (
                    <div
                      key={plan}
                      className="p-3 md:p-4 border-t-4 md:border-t-0 md:border-r-4 last:md:border-r-0 border-black bg-white"
                    >
                      <div className="text-[10px] font-black uppercase">{PLAN_LABEL[plan]}</div>
                      <div className="text-[8px] md:text-[10px] font-bold text-slate-500">
                        Today ${pc.baseline[plan].toFixed(2)}
                      </div>
                      <div className="text-lg md:text-xl italic font-black">
                        ${pc.withChargeOnOvernight[plan].toFixed(2)}
                      </div>
                      <div
                        className={`text-[9px] md:text-[11px] font-black ${
                          delta < -0.005 ? 'text-emerald-600' : delta > 0.005 ? 'text-red-600' : 'text-slate-500'
                        }`}
                      >
                        {Math.abs(delta) < 0.005
                          ? 'no change from shifting'
                          : `${delta < 0 ? '−' : '+'}$${Math.abs(delta).toFixed(2)} vs today`}
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
              className="bg-red-400 border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6"
            >
              <div className="flex items-center gap-2 text-[10px] md:text-xs font-black uppercase">
                <TriangleAlert size={14} strokeWidth={4} /> ULO peak exposure · {exposure.windowLabel}
              </div>
              <div className="flex flex-wrap items-baseline gap-3 md:gap-6 mt-2">
                <div className="text-2xl md:text-4xl italic font-black">
                  {exposure.kwhPerMonth.toFixed(1)} kWh/mo
                </div>
                <div className="text-lg md:text-2xl font-black">
                  ${exposure.costPerMonth.toFixed(2)}/mo at {exposure.rateCents.toFixed(1)}¢
                </div>
                <div className="text-xs md:text-sm font-black">
                  ${exposure.atStakePerMonth.toFixed(2)}/mo more than the same energy overnight
                </div>
              </div>
              <div className="text-[9px] md:text-[11px] font-bold mt-2 normal-case">
                {exposure.hoursPerWeekday} weekday afternoon hours sit in ULO&apos;s 16:00–21:00 peak
                window. Keep using them and a ULO switch makes them the most expensive hours you buy.
              </div>
            </div>
          )}

          {/* --- Honest assumptions --- */}
          <div data-testid="ev-assumptions" className="border-2 border-black rounded-xl p-3 md:p-4 bg-slate-50">
            <div className="flex items-center gap-2 text-[10px] font-black uppercase mb-2">
              <Info size={12} strokeWidth={4} /> What these numbers assume
            </div>
            <ul className="space-y-1 text-[9px] md:text-[11px] font-bold text-slate-600 normal-case list-disc ml-4">
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
          className="mt-4 bg-red-400 border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6"
        >
          <div className="flex items-center gap-2 text-[10px] md:text-xs font-black uppercase">
            <Moon size={14} strokeWidth={4} /> ULO peak exposure · {exposure.windowLabel}
          </div>
          <div className="text-xl md:text-2xl italic font-black mt-1">
            {exposure.kwhPerMonth.toFixed(1)} kWh/mo → ${exposure.costPerMonth.toFixed(2)}/mo at{' '}
            {exposure.rateCents.toFixed(1)}¢
          </div>
        </div>
      )}
    </div>
  );
}
