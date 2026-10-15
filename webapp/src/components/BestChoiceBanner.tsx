/**
 * Wave R — the answer, at the top of Overview.
 *
 * This is the banner that used to sit at line ~301 of 316, below the plan
 * cards, the true-bill card, the actual-bill panel and both Wave P tables —
 * i.e. the thing the user opened the page for, buried under everything else.
 * Same markup, same numbers, moved to the first element of the Overview tab
 * (decision-first information architecture).
 *
 * It renders the WINDOW on screen, exactly as the old banner did: this is
 * "which plan would the days I am looking at have cost least", not a
 * whole-dataset claim. The chip in the toolbar repeats the same verdict so
 * the answer is never more than one glance away, on any tab.
 */

'use client';

import { buildVerdict, formatDelta, type PlanCosts } from '@/lib/verdict';
import type { PlanId } from '@/hooks/useSelectedPlan';
import { planLabel, useTranslation } from '@/i18n';

export type BestChoiceBannerProps = {
  /** Per-plan cost of the visible window; null when the window is empty. */
  comparison: PlanCosts | null;
  /** The plan the household has selected — the one being judged. */
  userPlan: PlanId;
  /** Day span the comparison covers (used for the caption, never invented). */
  days: number;
};

export default function BestChoiceBanner({ comparison, userPlan, days }: BestChoiceBannerProps) {
  // Wave U — `t` here also re-renders the banner on a locale switch.
  const { t } = useTranslation();
  const verdict = buildVerdict(comparison, userPlan, days);
  if (!verdict) return null;

  return (
    /* Shared accent fill/ink tokens keep the headline pairing identical in both themes. */
    <section
      data-testid="best-choice-banner"
      data-best-plan={verdict.best}
      data-current-plan={userPlan}
      data-already-best={String(verdict.alreadyBest)}
      data-window-days={verdict.days}
      aria-labelledby="best-choice-heading"
      className="quiet-plan-callout p-4 md:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 md:gap-6"
    >
      {/* The plan recommendation is a quiet detail of the real plan surface;
          its hierarchy comes from placement and type, not a full-bleed slab. */}
      <div className="space-y-1 text-left">
        <div className="quiet-overview-label tracking-wide">
          {t('bestChoice.eyebrow')}
        </div>
        <h4 id="best-choice-heading" className="text-sm md:text-base leading-tight font-medium">
          {t('bestChoice.headline')}{' '}
          <span className="text-lg md:text-xl text-ink not-italic font-semibold">
            {planLabel(verdict.best)}
          </span>
        </h4>
        {!verdict.alreadyBest && (
          <p data-testid="cheaper-alternative" className="text-xs md:text-sm font-normal text-ink-2 normal-case">
            {t('bestChoice.cheaperAlternative', { plan: t(`planShort.${verdict.best}`) })}
          </p>
        )}
        <p className="text-xs text-ink-3">
          {t('bestChoice.window', { count: verdict.days, days: verdict.days })} · {t('legal.commodityShort')}
        </p>
      </div>
      <div className="quiet-plan-impact px-4 py-3 flex flex-col items-start min-w-[130px]">
        <div className="quiet-overview-label tracking-wide mb-1 text-left">
          {t('bestChoice.impact')}
        </div>
        <div className="text-xl md:text-2xl text-ink whitespace-nowrap leading-none text-left font-semibold">
          {verdict.alreadyBest ? (
            <span className="text-good text-base md:text-lg not-italic block">
              {t('bestChoice.optimumA')}
              <br />
              {t('bestChoice.optimumB')}
            </span>
          ) : (
            <span className="text-bad">-{formatDelta(verdict.delta)}</span>
          )}
        </div>
        <div className="text-xs mt-2 text-left text-ink-3">
          {t('bestChoice.vsCurrent', { plan: planLabel(userPlan) })}
        </div>
      </div>
    </section>
  );
}
