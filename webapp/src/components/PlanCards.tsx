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
import { distinctSeasons, SEASON_INFO, seasonForDay, seasonForMonthIndex, type Season } from '@/lib/season';
import type { PlanId } from '@/hooks/useSelectedPlan';
import type { PlanCosts } from '@/lib/verdict';

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

const PLANS = [
  { id: 'Tiered', name: 'Tiered Pricing' },
  { id: 'TOU', name: 'Time-of-Use' },
  { id: 'ULO', name: 'Ultra-Low Overnight' },
] as const;

/** One labelled rate chip on a card. */
type PlanRate = { l: string; v: string; c?: string };

/**
 * Render one rate from the active RateSet as displayed cents
 * (9.75 -> '9.75¢', 10 -> '10.0¢'). Formatting only — never a source of
 * rate values. Two decimals because that is what the cost math uses: the
 * cents on the card must rebuild the dollar figure on the same card exactly,
 * and one decimal quietly rounds 9.75 to 9.8 while the bill still uses 9.75.
 */
function formatRate(centsPerKwh: number): string {
  return `${centsPerKwh.toFixed(2).replace(/0$/, '')}¢`;
}

/** The rate chips for one plan, straight from the RateSet in force. */
function planRates(planId: (typeof PLANS)[number]['id'], rates: RateSet): PlanRate[] {
  return planId === 'Tiered'
    ? [
        { l: 'Tier 1', v: formatRate(rates.tiered.tier1) },
        { l: 'Tier 2', v: formatRate(rates.tiered.tier2) },
      ]
    : planId === 'TOU'
      ? [
          { l: 'Off-Peak', v: formatRate(rates.tou.offPeak), c: 'text-emerald-600' },
          { l: 'Mid-Peak', v: formatRate(rates.tou.midPeak), c: 'text-yellow-600' },
          { l: 'On-Peak', v: formatRate(rates.tou.onPeak), c: 'text-red-600' },
        ]
      : [
          { l: 'Overnight', v: formatRate(rates.ulo.overnight), c: 'text-purple-600' },
          { l: 'Weekend Off', v: formatRate(rates.ulo.weekendOffPeak), c: 'text-emerald-600' },
          { l: 'Mid-Peak', v: formatRate(rates.ulo.midPeak), c: 'text-yellow-600' },
          { l: 'On-Peak', v: formatRate(rates.ulo.onPeak), c: 'text-red-600' },
        ];
}

export default function PlanCards({
  comparison,
  userPlan,
  setUserPlan,
  activeRateSet,
  startDate,
  endDate,
}: PlanCardsProps) {
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
        // Single source of truth for the displayed rates: the RateSet in
        // force, the same one that priced the cost above. No RateSet loaded
        // -> no rate rows: an honest gap beats a stale literal copy of
        // last November's schedule.
        const rates = activeRateSet ? planRates(plan.id, activeRateSet) : [];

        return (
          <div
            key={i}
            role="button"
            tabIndex={0}
            aria-pressed={userPlan === plan.id}
            aria-label={`Use the ${plan.name} plan`}
            onClick={() => setUserPlan(plan.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setUserPlan(plan.id);
              }
            }}
            className={`bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[2rem] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative transition-all cursor-pointer ${userPlan === plan.id ? 'ring-4 md:ring-8 ring-yellow-400 ring-inset scale-[1.02]' : ''}`}
          >
            {userPlan === plan.id && <div className="absolute top-2 right-2 md:top-4 md:right-4 bg-yellow-400 px-3 md:px-6 py-1 rounded-full border-2 border-black font-black text-[8px] md:text-[10px] uppercase text-black shadow-sm flex items-center gap-1 md:gap-2"><CheckCircle2 size={10} className="md:w-3 md:h-3" /> <span className="hidden sm:inline">YOUR PLAN</span><span className="sm:hidden">ACTIVE</span></div>}
            <h3 className="text-xl md:text-2xl mb-2 md:mb-4 font-black">{plan.name}</h3>
            <div className="text-4xl md:text-6xl italic mb-6 md:mb-10 font-black text-black">
              {comparison ? `$${comparison[plan.id].toFixed(2)}` : '—'}
            </div>
            <div className="space-y-2 md:space-y-4 bg-slate-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-[10px] md:text-xs font-black text-black">
              {rates.map((r, j) => (
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
                  <span>Tier 1 cut-off</span>
                  <span>{tierThreshold.toLocaleString()} kWh/mo</span>
                </div>
                <div className="mt-1 text-slate-600 font-bold normal-case">
                  {SEASON_INFO[seasonOfView].long}
                  {seasonsInView.length > 1 ? ' — window spans both seasons' : ''}
                  {otherTierThreshold != null
                    ? ` · other window: ${otherTierThreshold.toLocaleString()} kWh/mo`
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
