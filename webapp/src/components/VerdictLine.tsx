/**
 * Wave R — the one-line verdict, next to the data that can change it.
 *
 * The big banner lives on Overview and the chip lives in the toolbar; this is
 * the third and last copy, and it sits at the top of Plans & Track Record
 * because that is the tab where shift advice and the switch track record can
 * qualify what the banner said. Same `buildVerdict` as the other two, so all
 * three are one computation rendered three ways — never three computations
 * that happen to agree today.
 *
 * It is a line, not a card: the section below it already has the plan cards,
 * the optimizer and the track record. Its job is to keep the answer in view
 * while you read the evidence for it.
 */

'use client';

import { buildVerdict, type PlanCosts } from '@/lib/verdict';
import { type PlanId } from '@/hooks/useSelectedPlan';
import { fmtMoney0, useTranslation } from '@/i18n';

export type VerdictLineProps = {
  comparison: PlanCosts | null;
  userPlan: PlanId;
  days: number;
};

export default function VerdictLine({ comparison, userPlan, days }: VerdictLineProps) {
  const { t } = useTranslation();
  const verdict = buildVerdict(comparison, userPlan, days);
  if (!verdict) return null;
  const deltaVsCheapest = verdict.currentCost - verdict.costs[verdict.best];
  const cheapestLabel = t(`planShort.${verdict.best}`);

  /* The reference's own rule: "slabs do not flood colour — verdicts are
     ink-coloured text plus a hairline tag". So the line sits on the quiet
     callout surface (inset + a 3px accent edge, the system's marker) and the
     eyebrow becomes a hairline tag; the accent survives only as that tag's
     dot, never as a slab behind the sentence. */
  return (
    <p
      data-testid="verdict-line"
      data-best-plan={verdict.best}
      data-current-plan={userPlan}
      data-current-cost={verdict.currentCost}
      data-best-cost={verdict.costs[verdict.best]}
      data-delta={deltaVsCheapest}
      data-direction={deltaVsCheapest > 0.005 ? 'cheaper-option' : 'already-best'}
      data-already-best={String(verdict.alreadyBest)}
      data-window-days={verdict.days}
      className="quiet-plan-callout px-4 md:px-6 py-3 text-ink font-semibold uppercase text-[11px] md:text-sm"
    >
      <span className="block mb-1.5">
        <span className="inline-flex items-center gap-1.5 border border-edge-muted rounded-full px-2 py-0.5 text-[11px] tracking-[0.18em] text-ink-2">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
          {t('verdict.eyebrow')}
        </span>
      </span>
      <span className="text-base md:text-xl">
        {t('verdict.planCost', {
          current: fmtMoney0(verdict.currentCost),
          baseline: fmtMoney0(verdict.costs[verdict.best]),
          plan: cheapestLabel,
        })}{' '}
        {deltaVsCheapest > 0 ? (
          <span data-testid="verdict-delta">▲{fmtMoney0(deltaVsCheapest)}</span>
        ) : (
          <span data-testid="verdict-delta">{fmtMoney0(0)}</span>
        )}{' '}
        {t('verdict.cheapestBaseline')}
      </span>{' '}
      {verdict.alreadyBest ? (
        <span className="font-medium normal-case text-[10px] md:text-xs">
          {t('verdict.nothingToSwitch', { count: verdict.days, days: verdict.days })}
        </span>
      ) : (
        <span className="font-medium normal-case text-[10px] md:text-xs">
          {t('verdict.winsDetail', {
            count: verdict.days,
            days: verdict.days,
            monthly: fmtMoney0(verdict.deltaPerMonth),
          })}
        </span>
      )}
    </p>
  );
}
