/**
 * Wave R — the verdict that never leaves the screen.
 *
 * The banner only exists on Overview; this chip lives in the toolbar on every
 * tab, so the answer to "which plan should I be on?" is one glance away even
 * while you are reading the money tables. Click jumps to the banner — on
 * Overview it scrolls it into view instead of re-selecting the same tab.
 *
 * The number is the window's plan gap scaled to a month (see
 * `buildVerdict`), and the tooltip says exactly that, because "$45/mo" from
 * a two-day window is a two-day measurement and must not pretend otherwise.
 */

'use client';

import { Award, ArrowRight } from 'lucide-react';
import { buildVerdict, type PlanCosts } from '@/lib/verdict';
import { PLAN_LABEL, type PlanId } from '@/hooks/useSelectedPlan';

export type BestChoiceChipProps = {
  comparison: PlanCosts | null;
  userPlan: PlanId;
  days: number;
  /** Called on click: jump to (or within) the Overview tab. */
  onJump: () => void;
  /** True while Overview is the active tab — the chip then scrolls, not switches. */
  active: boolean;
};

export default function BestChoiceChip({ comparison, userPlan, days, onJump, active }: BestChoiceChipProps) {
  const verdict = buildVerdict(comparison, userPlan, days);
  if (!verdict) return null;

  const perMonth = verdict.deltaPerMonth;
  const short = verdict.alreadyBest
    ? 'Best: ' + verdict.best + ' ✓'
    : `Best: ${verdict.best} -$${perMonth.toFixed(0)}/mo`;

  const label = verdict.alreadyBest
    ? `Best choice: ${verdict.bestLabel}. You are already on it. Show the Overview.`
    : `Best choice: ${verdict.bestLabel} — $${perMonth.toFixed(2)} per month less than ${PLAN_LABEL[userPlan]}, scaled from the ${verdict.days}-day window on screen. Show the Overview.`;

  const jump = () => {
    if (!active) {
      onJump();
      return;
    }
    const banner = document.querySelector<HTMLElement>('[data-testid="best-choice-banner"]');
    banner?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <button
      type="button"
      data-testid="best-choice-chip"
      data-best-plan={verdict.best}
      data-already-best={String(verdict.alreadyBest)}
      data-delta-per-month={perMonth.toFixed(2)}
      data-window-days={verdict.days}
      onClick={jump}
      title={`${label} Click to jump to the full answer.`}
      aria-label={label}
      className={`inline-flex min-h-11 items-center gap-1.5 px-3 md:px-4 py-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black uppercase text-[10px] md:text-xs transition-all ${
        verdict.alreadyBest
          ? 'bg-emerald-400 text-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]'
          : 'bg-yellow-400 text-black shadow-[3px_3px_0px_0px_rgba(37,99,235,1)]'
      } hover:translate-y-0.5 active:translate-y-1 active:shadow-none`}
    >
      <Award size={14} strokeWidth={4} aria-hidden="true" className="shrink-0" />
      <span className="whitespace-nowrap">{short}</span>
      <ArrowRight size={12} strokeWidth={4} aria-hidden="true" className="shrink-0 opacity-50" />
    </button>
  );
}
