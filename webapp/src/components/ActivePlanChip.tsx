/**
 * Wave H item 2 — the header's "which plan is active" chip.
 *
 * Split out only because `app/page.tsx` is a server component: the chip reads
 * the SAME `useSelectedPlan` store the nav switcher writes to, so the two can
 * never disagree — click Tiered below and this updates without prop drilling
 * or a state-lifting refactor of the shell.
 */

"use client";

import { PLAN_LABEL, useSelectedPlan } from '@/hooks/useSelectedPlan';

export default function ActivePlanChip() {
  const [plan] = useSelectedPlan();
  return (
    <span
      data-testid="active-plan-chip"
      data-plan={plan}
      className="inline-flex items-center gap-2 px-3 py-1 mt-3 bg-yellow-400 border-2 border-black rounded-lg text-[10px] md:text-xs font-black uppercase text-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
      title="The plan every cost on this page is priced under. Change it in the switcher below."
    >
      <span aria-hidden="true">▸</span>
      Plan: {PLAN_LABEL[plan]}
    </span>
  );
}
