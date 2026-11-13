/**
 * Wave H item 2 — the header's "which plan is active" chip.
 *
 * Split out only because `app/page.tsx` is a server component: the chip reads
 * the SAME `useSelectedPlan` store the nav switcher writes to, so the two can
 * never disagree — click Tiered below and this updates without prop drilling
 * or a state-lifting refactor of the shell.
 */

"use client";

import { useSelectedPlan } from '@/hooks/useSelectedPlan';
import { useSectionCommodity } from '@/hooks/useDashboard';
import { planLabel, useTranslation } from '@/i18n';

export default function ActivePlanChip() {
  const [plan] = useSelectedPlan();
  // Wave U — subscribes to the locale so the chip re-labels on toggle;
  // `data-plan` keeps the canonical id (data stays untranslated).
  const { t } = useTranslation();
  // t_a775c2a3 — AC2: an ELECTRICITY fact (which plan prices your ¢/kWh) —
  // never shown while the Gas section is on screen, same rule as the plan
  // switcher it points at. Same contract as the classic twin.
  const commodity = useSectionCommodity();
  if (commodity === 'gas') return null;
  return (
    <span
      data-testid="active-plan-chip"
      data-plan={plan}
      className="inline-flex items-center gap-2 px-3 py-1 mt-3 bg-accent border-2 border-edge rounded-lg text-[10px] md:text-xs font-black uppercase text-accent-ink shadow-hard-3"
      title={t('plan.chip.title')}
    >
      <span aria-hidden="true">▸</span>
      {t('plan.chip.prefix')} {planLabel(plan)}
    </span>
  );
}
