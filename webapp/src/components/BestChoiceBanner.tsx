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
      className="bg-accent text-accent-ink p-6 md:p-12 rounded-[2rem] md:rounded-[3.5rem] border-4 md:border-8 border-accent-ink shadow-hard-12 md:shadow-hard-24 flex flex-col lg:flex-row items-center justify-between gap-6 md:gap-10 font-black uppercase"
    >
      {/* Every word on the flood is BLACK — including the small window line,
          which used to be --ink-4 (slate-400): 2.2:1 on the yellow in light
          and 2.0:1 in dark. On a surface this loud the second line steps
          DOWN IN SIZE, not in contrast — the banner's rule is 13.7:1 black on
          accent in both themes. (The receipt's own --ink-4 label is a
          different surface: it sits on --card, where dark clears 5.8:1 and
          light's 2.56:1 is the pre-existing micro-label defect the spec
          scoped out.) */}
      <div className="space-y-2 md:space-y-4 text-center lg:text-left">
        <div className="text-[10px] md:text-xs tracking-[0.2em] md:tracking-[0.5em] text-accent-ink font-black">
          {t('bestChoice.eyebrow')}
        </div>
        <h4 id="best-choice-heading" className="text-3xl md:text-5xl italic leading-tight">
          {t('bestChoice.headline')} <br />
          <span className="text-4xl sm:text-6xl md:text-8xl text-accent-ink not-italic block mt-1 md:mt-2 font-black">
            {planLabel(verdict.best)}
          </span>
        </h4>
        {!verdict.alreadyBest && (
          <p data-testid="cheaper-alternative" className="text-base md:text-xl font-black text-accent-ink normal-case">
            {t('bestChoice.cheaperAlternative', { plan: t(`planShort.${verdict.best}`) })}
          </p>
        )}
        <p className="text-[9px] md:text-[11px] font-bold text-accent-ink normal-case">
          {t('bestChoice.window', { count: verdict.days, days: verdict.days })} · {t('legal.commodityShort')}
        </p>
      </div>
      <div className="bg-card text-ink p-6 md:p-10 rounded-2xl md:rounded-[2.5rem] border-4 border-edge shadow-xl lg:rotate-3 flex flex-col items-center min-w-[200px] md:min-w-[300px]">
        <div className="text-[10px] tracking-widest text-ink-4 mb-1 md:mb-2 font-black text-center uppercase">
          {t('bestChoice.impact')}
        </div>
        <div className="text-4xl md:text-7xl italic text-ink whitespace-nowrap leading-none text-center font-black">
          {verdict.alreadyBest ? (
            <span className="text-good text-2xl md:text-5xl not-italic block">
              {t('bestChoice.optimumA')}
              <br />
              {t('bestChoice.optimumB')}
            </span>
          ) : (
            <span className="text-bad">-{formatDelta(verdict.delta)}</span>
          )}
        </div>
        <div className="text-[8px] md:text-[10px] mt-2 md:mt-4 font-black text-center text-ink">
          {t('bestChoice.vsCurrent', { plan: planLabel(userPlan) })}
        </div>
      </div>
    </section>
  );
}
