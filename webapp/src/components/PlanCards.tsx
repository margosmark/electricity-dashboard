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
import { fmtCentsAuto, fmtDateLong, fmtDay, fmtMoney, fmtNumber, periodLabel, t, useTranslation } from '@/i18n';

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

/** One labelled rate chip on a card. */
type PlanRate = { l: string; v: string; c?: string };

/**
 * The rate chips for one plan, straight from the RateSet in force — the same
 * schedule the cost above was priced with, so the card cannot display a
 * different number than the one it charged.
 *
 * Display SSOT, two halves:
 * - values go through `fmtCentsAuto`, the rate-table formatter (the one
 *   RateStalenessBanner already uses): source precision, max 2 digits. A
 *   forced single digit would print 9.75 as 9.8¢ while the bill on the same
 *   card still used 9.75, and this card's own test rebuilds the dollar figure
 *   from the chips alone.
 * - names go through the i18n keys / `periodLabel`, so Wave U's EN↔FR toggle
 *   still reaches this card.
 *
 * Formatting only — never a source of rate values.
 */
function planRates(planId: (typeof PLANS)[number]['id'], rates: RateSet): PlanRate[] {
  return planId === 'Tiered'
    ? [
        { l: t('rate.tier1'), v: fmtCentsAuto(rates.tiered.tier1) },
        { l: t('rate.tier2'), v: fmtCentsAuto(rates.tiered.tier2) },
      ]
    : planId === 'TOU'
      ? [
          { l: periodLabel('Off-Peak'), v: fmtCentsAuto(rates.tou.offPeak), c: 'text-good' },
          { l: periodLabel('Mid-Peak'), v: fmtCentsAuto(rates.tou.midPeak), c: 'text-warn' },
          { l: periodLabel('On-Peak'), v: fmtCentsAuto(rates.tou.onPeak), c: 'text-bad' },
        ]
      : [
          { l: t('rate.overnight'), v: fmtCentsAuto(rates.ulo.overnight), c: 'text-ulo' },
          { l: t('rate.weekendOff'), v: fmtCentsAuto(rates.ulo.weekendOffPeak), c: 'text-good' },
          { l: periodLabel('Mid-Peak'), v: fmtCentsAuto(rates.ulo.midPeak), c: 'text-warn' },
          { l: periodLabel('On-Peak'), v: fmtCentsAuto(rates.ulo.onPeak), c: 'text-bad' },
        ];
}

/** `May 25 – Jun 23` / `25 mai – 23 juin` from two `yyyy-MM-dd` window
 *  edges; the edges verbatim when they will not parse — a reformatted string
 *  is still more honest than a dropped one. */
function windowSpan(startDate: string, endDate: string): string {
  const startYear = startDate.slice(0, 4);
  const endYear = endDate.slice(0, 4);
  if (startYear !== endYear) {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return `${fmtDateLong(start)} – ${fmtDateLong(end)}`;
    }
  }
  const fmt = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    return fmtDay(iso);
  };
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6 text-ink">
      {PLANS.map((plan, i) => {
        // Single source of truth for the displayed rates: the RateSet in
        // force, the same one that priced the cost above. No RateSet loaded
        // -> no rate rows: an honest gap beats a stale literal copy of last
        // November's schedule.
        const rates = activeRateSet ? planRates(plan.id, activeRateSet) : [];

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
            className={`bg-card p-4 md:p-6 rounded-xl md:rounded-2xl border border-edge relative transition-all cursor-pointer ${userPlan === plan.id ? 'border-accent' : ''}`}
          >
            {/* The mockup marks the current plan with a 3px accent band across
                the top edge — the quiet equivalent of the old yellow ring: it
                reads as state without a shadow, a 8px radius or a scale bump. */}
            {userPlan === plan.id && <span aria-hidden="true" className="absolute -top-px -left-px -right-px h-[3px] bg-accent rounded-t-xl md:rounded-t-2xl" />}
            {userPlan === plan.id && <div className="absolute top-2 right-2 md:top-4 md:right-4 bg-accent px-2.5 md:px-3 py-1 rounded border border-edge font-semibold text-[10px] md:text-[11px] uppercase tracking-[0.05em] text-accent-ink flex items-center gap-1 md:gap-2"><CheckCircle2 size={10} className="md:w-3 md:h-3" /> <span className="hidden sm:inline">{t('planCard.yourPlan')}</span><span className="sm:hidden">{t('planCard.active')}</span></div>}
            <h3 className="text-base md:text-lg mb-1 md:mb-2 font-semibold tracking-[0.02em]">{t(plan.nameKey)}</h3>
            {/* The card's headline number used to stand alone: a 6xl dollar
                figure with nothing saying whether it is a bill, a projection,
                or commodity alone. It is the cost of the window on screen,
                commodity only — the same scope the Overview banner declares —
                so the card declares it too. */}
            <div
              data-testid="plan-card-cost"
              data-plan-id={plan.id}
              data-cost={comparison?.[plan.id] ?? ''}
              className="text-3xl md:text-4xl mb-1 md:mb-2 font-semibold tabular-nums text-ink"
            >
              {comparison ? fmtMoney(comparison[plan.id]) : '—'}
            </div>
            <div
              data-testid="plan-card-scope"
              className="text-xs font-medium text-ink-3 normal-case mb-4 md:mb-6"
            >
              {t('planCard.scope', { range: windowSpan(startDate, endDate) })}
            </div>
            <div className="space-y-2 md:space-y-4 bg-inset p-4 md:p-6 rounded-xl md:rounded-2xl border border-edge text-[10px] md:text-xs font-semibold text-ink">
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
                className="mt-3 md:mt-5 bg-accent-soft p-3 md:p-5 rounded-xl md:rounded-2xl border border-edge text-[9px] md:text-xs font-semibold"
              >
                <div className="flex justify-between">
                  <span>{t('tier.cutoff')}</span>
                  <span>{t('tier.kwhPerMonth', { kwh: fmtNumber(tierThreshold) })}</span>
                </div>
                <div className="mt-1 text-ink-2 font-medium normal-case">
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
