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
  const worseVsCurrent = verdict.costs[verdict.worst] - verdict.currentCost;
  const cheapestLabel = t(`planShort.${verdict.best}`);

  return (
    <p
      data-testid="verdict-line"
      data-best-plan={verdict.best}
      data-already-best={String(verdict.alreadyBest)}
      className="bg-accent border border-edge rounded-xl md:rounded-2xl px-4 md:px-6 py-3 text-accent-ink font-semibold uppercase text-[11px] md:text-sm"
    >
      <span className="text-[8px] md:text-[10px] tracking-[0.2em] block text-accent-ink mb-1">
        {t('verdict.eyebrow')}
      </span>
      <span className="text-base md:text-xl">
        {t('verdict.planCost', {
          current: fmtMoney0(verdict.currentCost),
          baseline: fmtMoney0(verdict.costs[verdict.best]),
          plan: cheapestLabel,
        })}{' '}
        {deltaVsCheapest > 0 ? (
          <span data-testid="verdict-delta" className="text-accent-ink">▲{fmtMoney0(deltaVsCheapest)}</span>
        ) : (
          <span data-testid="verdict-delta">{fmtMoney0(0)}</span>
        )}{' '}
        {t('verdict.cheapestBaseline')}
      </span>{' '}
      {worseVsCurrent > 0.005 && (
        <span className="text-accent-ink">{fmtMoney0(worseVsCurrent)} {t('verdict.worse')}</span>
      )}{' '}
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
