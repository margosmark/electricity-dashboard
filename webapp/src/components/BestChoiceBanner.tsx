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
      className="bg-card text-ink p-4 md:p-5 rounded-lg border border-edge-muted flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 md:gap-6 font-medium normal-case"
    >
      {/* Every word on the flood is BLACK — including the small window line,
          which used to be --ink-4 (slate-400): 2.2:1 on the yellow in light
          and 2.0:1 in dark. On a surface this loud the second line steps
          DOWN IN SIZE, not in contrast — the banner's rule is 13.7:1 black on
          accent in both themes. (The receipt's own --ink-4 label is a
          different surface: it sits on --card, where dark clears 5.8:1 and
          light's 2.56:1 is the pre-existing micro-label defect the spec
          scoped out.) */}
      <div className="space-y-1 text-left">
        <div className="text-[10px] md:text-xs tracking-wide text-ink-3 font-medium uppercase">
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
        <p className="text-[10px] md:text-xs font-normal text-ink-3 normal-case">
          {t('bestChoice.window', { count: verdict.days, days: verdict.days })} · {t('legal.commodityShort')}
        </p>
      </div>
      <div className="bg-inset text-ink px-4 py-3 rounded-md border border-edge-muted flex flex-col items-start min-w-[130px]">
        <div className="text-[10px] tracking-wide text-ink-3 mb-1 font-medium text-left uppercase">
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
        <div className="text-[9px] md:text-[10px] mt-2 font-normal text-left text-ink-3">
          {t('bestChoice.vsCurrent', { plan: planLabel(userPlan) })}
        </div>
      </div>
    </section>
  );
}
