/**
 * The three plan cards — cost, live rate chips and the season-aware Tiered
 * cut-off.
 *
 * Extracted in Wave R out of ChartView, because the card that answers "what
 * would each plan cost?" belongs on Plans & Track Record with the evidence
 * behind it, while the chart belongs on Usage. The markup, the
 * role=button/aria-pressed keyboard contract and the rate-chip sourcing are
 * unchanged — this is a move, not a redesign.
 */

'use client';

import { CheckCircle2 } from 'lucide-react';
import { type RateSet } from '@/lib/energy';
import { distinctSeasons, seasonForDay, seasonForMonthIndex, type Season } from '@/lib/season';
import type { PlanId } from '@/hooks/useSelectedPlan';
import type { PlanCosts } from '@/lib/verdict';
import { fmtCents, fmtMoney, fmtNumber, periodLabel, useTranslation } from '@/i18n';

export type PlanCardsProps = {
  /** Per-plan cost of the window on screen. */
  comparison: PlanCosts | null;
  userPlan: PlanId;
  setUserPlan: (plan: PlanId) => void;
  /** Rate schedule in force — the chips read it, never a hardcoded number. */
  activeRateSet: RateSet | null;
  /** The window these costs were computed over (`yyyy-MM-dd`). */
  startDate: string;
  endDate: string;
};

/**
 * Which rate seasons the WINDOW crosses, from its own dates.
 *
 * Not from the bars on screen and not from the rows that happen to be loaded:
 * the Tiered cut-off is a property of the days being priced, so a window
 * whose chart is currently aggregated to one bar still spans two seasons if
 * its dates do. Bounded at 120 months — a corrupt date range must not turn
 * this into a spin loop.
 */
export function seasonsInWindow(startDate: string, endDate: string): Season[] {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const seen = new Set<Season>();
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  let guard = 0;
  while (cursor <= last && guard++ < 120) {
    seen.add(seasonForMonthIndex(cursor.getMonth()));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return distinctSeasons([...seen]);
}

/**
 * Wave U — `nameKey` renders the localized plan name (OEB French terms in
 * French); `name` stays the canonical English for anything that needs the
 * untranslated form. `Tiered Pricing` is this card's own display name — the
 * chip label ("Tiered"/"Paliers") is the shorter switcher form.
 */
const PLANS = [
  { id: 'Tiered', name: 'Tiered Pricing', nameKey: 'planCard.Tiered' },
  { id: 'TOU', name: 'Time-of-Use', nameKey: 'planCard.TOU' },
  { id: 'ULO', name: 'Ultra-Low Overnight', nameKey: 'planCard.ULO' },
] as const;

export default function PlanCards({
  comparison,
  userPlan,
  setUserPlan,
  activeRateSet,
  startDate,
  endDate,
}: PlanCardsProps) {
  const { t } = useTranslation();
  const seasonOfView: Season = seasonForDay(endDate);
  const seasonsInView = seasonsInWindow(startDate, endDate);
  const tierThreshold =
    activeRateSet && (seasonOfView === 'winter'
      ? activeRateSet.tiered.thresholdWinter
      : activeRateSet.tiered.thresholdSummer);
  const otherTierThreshold =
    activeRateSet && (seasonOfView === 'winter'
      ? activeRateSet.tiered.thresholdSummer
      : activeRateSet.tiered.thresholdWinter);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-10 text-black font-black uppercase">
      {PLANS.map((plan, i) => {
        // Wave U: the period NAMES localize (OEB French), the ¢ values go
        // through fmtCents so the decimal comma follows the toggle.
        const rates =
          plan.id === 'Tiered'
            ? [
                { l: t('rate.tier1'), v: fmtCents(activeRateSet ? activeRateSet.tiered.tier1 : 12.0) },
                { l: t('rate.tier2'), v: fmtCents(activeRateSet ? activeRateSet.tiered.tier2 : 14.2) },
              ]
            : plan.id === 'TOU'
              ? [
                  { l: periodLabel('Off-Peak'), v: fmtCents(activeRateSet ? activeRateSet.tou.offPeak : 9.8), c: 'text-emerald-600' },
                  { l: periodLabel('Mid-Peak'), v: fmtCents(activeRateSet ? activeRateSet.tou.midPeak : 15.7), c: 'text-yellow-600' },
                  { l: periodLabel('On-Peak'), v: fmtCents(activeRateSet ? activeRateSet.tou.onPeak : 20.3), c: 'text-red-600' },
                ]
              : [
                  { l: t('rate.overnight'), v: fmtCents(activeRateSet ? activeRateSet.ulo.overnight : 3.9), c: 'text-purple-600' },
                  { l: t('rate.weekendOff'), v: fmtCents(activeRateSet ? activeRateSet.ulo.weekendOffPeak : 9.8), c: 'text-emerald-600' },
                  { l: periodLabel('Mid-Peak'), v: fmtCents(activeRateSet ? activeRateSet.ulo.midPeak : 15.7), c: 'text-yellow-600' },
                  { l: periodLabel('On-Peak'), v: fmtCents(activeRateSet ? activeRateSet.ulo.onPeak : 39.1), c: 'text-red-600' },
                ];

        return (
          <div
            key={i}
            role="button"
            tabIndex={0}
            aria-pressed={userPlan === plan.id}
            aria-label={t('planCard.useAria', { plan: t(plan.nameKey) })}
            onClick={() => setUserPlan(plan.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setUserPlan(plan.id);
              }
            }}
            className={`bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[2rem] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative transition-all cursor-pointer ${userPlan === plan.id ? 'ring-4 md:ring-8 ring-yellow-400 ring-inset scale-[1.02]' : ''}`}
          >
            {userPlan === plan.id && <div className="absolute top-2 right-2 md:top-4 md:right-4 bg-yellow-400 px-3 md:px-6 py-1 rounded-full border-2 border-black font-black text-[8px] md:text-[10px] uppercase text-black shadow-sm flex items-center gap-1 md:gap-2"><CheckCircle2 size={10} className="md:w-3 md:h-3" /> <span className="hidden sm:inline">{t('planCard.yourPlan')}</span><span className="sm:hidden">{t('planCard.active')}</span></div>}
            <h3 className="text-xl md:text-2xl mb-2 md:mb-4 font-black">{t(plan.nameKey)}</h3>
            <div className="text-4xl md:text-6xl italic mb-6 md:mb-10 font-black text-black">
              {comparison ? fmtMoney(comparison[plan.id]) : '—'}
            </div>
            <div className="space-y-2 md:space-y-4 bg-slate-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-[10px] md:text-xs font-black text-black">
              {rates.map((r: { l: string; v: string; c?: string }, j: number) => (
                <div key={j} className={`flex justify-between ${r.c || ''}`}>
                  <span>{r.l}</span> <span>{r.v}</span>
                </div>
              ))}
            </div>
            {/* Tier thresholds are season-aware (Wave A aggregation already
                sums against the right one); say which one is in force. */}
            {plan.id === 'Tiered' && tierThreshold != null && (
              <div
                data-testid="tier-threshold"
                className="mt-3 md:mt-5 bg-yellow-50 p-3 md:p-5 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-[9px] md:text-xs font-black"
              >
                <div className="flex justify-between">
                  <span>{t('tier.cutoff')}</span>
                  <span>{t('tier.kwhPerMonth', { kwh: fmtNumber(tierThreshold) })}</span>
                </div>
                <div className="mt-1 text-slate-600 font-bold normal-case">
                  {t(`season.long.${seasonOfView}`)}
                  {seasonsInView.length > 1 ? ` — ${t('tier.spansBoth')}` : ''}
                  {otherTierThreshold != null
                    ? ` · ${t('tier.otherWindow', { kwh: fmtNumber(otherTierThreshold) })}`
                    : ''}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
