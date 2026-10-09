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
import { PLAN_LABEL, type PlanId } from '@/hooks/useSelectedPlan';

export type VerdictLineProps = {
  comparison: PlanCosts | null;
  userPlan: PlanId;
  days: number;
};

export default function VerdictLine({ comparison, userPlan, days }: VerdictLineProps) {
  const verdict = buildVerdict(comparison, userPlan, days);
  if (!verdict) return null;

  return (
    <p
      data-testid="verdict-line"
      data-best-plan={verdict.best}
      data-already-best={String(verdict.alreadyBest)}
      className="bg-yellow-400 border-4 border-black rounded-xl md:rounded-2xl px-4 md:px-6 py-3 text-black font-black uppercase text-[11px] md:text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
    >
      <span className="text-[8px] md:text-[10px] tracking-[0.2em] block text-slate-700 mb-1">
        Window verdict
      </span>
      {verdict.alreadyBest ? (
        <>
          <span className="text-base md:text-xl">{PLAN_LABEL[userPlan]} is the cheapest of the three</span>{' '}
          <span className="font-bold normal-case text-[10px] md:text-xs">
            over the {verdict.days} day{verdict.days === 1 ? '' : 's'} on screen — nothing to switch
            to. The track record below is the evidence either way.
          </span>
        </>
      ) : (
        <>
          <span className="text-base md:text-xl">
            {verdict.bestLabel} wins — ${verdict.delta.toFixed(2)} less than {PLAN_LABEL[userPlan]}
          </span>{' '}
          <span className="font-bold normal-case text-[10px] md:text-xs">
            over the {verdict.days} day{verdict.days === 1 ? '' : 's'} on screen (about $
            {verdict.deltaPerMonth.toFixed(0)}/month at that rate). Shift advice and the switch
            shift advice and the switch track record below can move this — the numbers they are built from are theirs, not the
            banner&apos;s.
          </span>
        </>
      )}
    </p>
  );
}
