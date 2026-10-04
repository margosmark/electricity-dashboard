/**
 * EV charging scenario — the most-asked-for view from user research.
 *
 * The household types (or accepts the prefilled) nightly kWh and gets:
 *   • $/charge and $/month under TOU vs ULO vs Tiered, charged 23:00–07:00;
 *   • the three-plan comparison RECOMPUTED with that energy moved into the
 *     ULO overnight window;
 *   • their weekday 16:00–21:00 exposure — the hours a ULO switch puts at
 *     39.1¢/kWh — in kWh and dollars;
 *   • every assumption the numbers rest on, in plain language.
 *
 * The kWh field is prefilled from an overnight block found in their OWN data,
 * and the card always says that is what happened — we never claim it is a car.
 */

"use client";

import { useMemo, useState } from 'react';
import { Car, TriangleAlert, Moon, Info } from 'lucide-react';
import { type ProcessedPoint, type RateSet } from '@/lib/energy';
import { buildEvScenario, detectEvCandidate, type EvPlan } from '@/lib/evScenario';

const PLAN_ORDER: EvPlan[] = ['TOU', 'Tiered', 'ULO'];
const PLAN_LABEL: Record<EvPlan, string> = {
  TOU: 'Time-of-Use',
  Tiered: 'Tiered',
  ULO: 'Ultra-Low Overnight',
};

export default function EvScenarioCard({
  rows,
  rates,
}: {
  rows: ProcessedPoint[];
  rates: RateSet | null;
}) {
  const candidate = useMemo(() => detectEvCandidate(rows), [rows]);

  // `kwhText` stays null until the household types — before that we show the
  // block we found, so the field tracks the data without an effect.
  const [kwhText, setKwhText] = useState<string | null>(null);
  const shownKwh = kwhText ?? (candidate ? candidate.kwhPerNight.toFixed(1) : '');

  const parsed = Number(shownKwh.replace(/[^0-9.]/g, ''));
  const dailyKwh = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  const scenario = useMemo(
    () => buildEvScenario({ rows, rates, dailyKwh, candidate }),
    [rows, rates, dailyKwh, candidate],
  );

  const pc = scenario.planComparison;
  const exposure = scenario.peakExposure;

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
        <div className="text-[9px] md:text-[11px] font-bold text-slate-500 normal-case max-w-md">
          {scenario.source === 'detected' && candidate
            ? `From your own data: ${candidate.label}, ${candidate.detail}.`
            : dailyKwh > 0
              ? 'Using the number you typed.'
              : 'We could not find an overnight charging block in your data — type yours and we will price it.'}
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
