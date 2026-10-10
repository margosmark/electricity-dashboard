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
import { planLabel, useTranslation } from '@/i18n';

export default function ActivePlanChip() {
  const [plan] = useSelectedPlan();
  // Wave U — subscribes to the locale so the chip re-labels on toggle;
  // `data-plan` keeps the canonical id (data stays untranslated).
  const { t } = useTranslation();
  return (
    <span
      data-testid="active-plan-chip"
      data-plan={plan}
      className="inline-flex items-center gap-2 px-3 py-1 mt-3 bg-yellow-400 border-2 border-black rounded-lg text-[10px] md:text-xs font-black uppercase text-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
      title={t('plan.chip.title')}
    >
      <span aria-hidden="true">▸</span>
      {t('plan.chip.prefix')} {planLabel(plan)}
    </span>
  );
}
