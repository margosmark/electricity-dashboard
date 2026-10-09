/**
 * OVERVIEW — the decision-first tab.
 *
 * Wave R's answer to "the best choice is now buried": this panel is what the
 * user sees first, and it contains only the four things that answer "what is
 * the verdict, what did it cost me, how fresh is the data, what will this
 * month cost?" — in that order, with the verdict as the first element.
 *
 * Everything else moved to the tab it belongs to (Usage, Plans & Track
 * Record, Money & What-If). `fileStatus` is a slot so the Green Button chip
 * stays wired by Dashboard, which owns the sync callbacks.
 */

'use client';

import React from 'react';
import { format } from 'date-fns';
import { dataFreshness } from '@/lib/freshness';
import type { FullDataTotals } from '@/lib/energy';
import type { BillProjection } from '@/lib/billProjection';
import type { PlanId } from '@/hooks/useSelectedPlan';
import type { PlanCosts } from '@/lib/verdict';
import BestChoiceBanner from '@/components/BestChoiceBanner';
import BillProjectionBanner from '@/components/BillProjectionBanner';

export type OverviewPanelProps = {
  /** Per-plan cost of the window on screen — the banner's raw material. */
  comparison: PlanCosts | null;
  userPlan: PlanId;
  /** Day span the comparison covers. */
  days: number;
  /** Whole-dataset totals for the strip (never window-scoped). */
  totals: FullDataTotals | null;
  costMode: 'yr' | 'day';
  setCostMode: (mode: 'yr' | 'day') => void;
  /** The "$3.42/day is $1,249/yr" sentence under the strip. */
  reframe: string;
  projection: BillProjection;
  /** Green Button / file-status chip, wired by Dashboard. */
  fileStatus?: React.ReactNode;
};

export default function OverviewPanel({
  comparison,
  userPlan,
  days,
  totals,
  costMode,
  setCostMode,
  reframe,
  projection,
  fileStatus,
}: OverviewPanelProps) {
  // The strip reports the WHOLE dataset, so its unit conversions are anchored
  // on the dataset's own span — never on the visible window.
  const totalDays = totals
    ? Math.max(
        1,
        Math.round(
          (new Date(totals.lastDate + 'T00:00:00').getTime() -
            new Date(totals.firstDate + 'T00:00:00').getTime()) /
            86_400_000,
        ) + 1,
      )
    : 1;
  const money = (datasetTotal: number): string => {
    const perDay = datasetTotal / totalDays;
    return (costMode === 'yr' ? perDay * 365.25 : perDay).toFixed(2);
  };
  const freshness = totals ? dataFreshness(totals.lastDate, new Date()) : null;

  return (
    <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" className="space-y-6 md:space-y-10" data-testid="tab-panel-overview">
      {/* 1. THE ANSWER. First element, nothing above it but the tab strip. */}
      <BestChoiceBanner comparison={comparison} userPlan={userPlan} days={days} />

      {/* 2. What the whole dataset actually cost, and how old it is. */}
      {totals && (
        <div className="relative z-[100] bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black flex flex-wrap gap-4 md:gap-6 items-center text-black" data-testid="totals-strip" data-best-plan={totals.bestPlan}>
          <div className="bg-black text-white px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-black">
            <div className="text-[8px] md:text-[10px] text-yellow-400">Since {format(new Date(totals.firstDate + 'T00:00:00'), 'MMM d, yyyy')}</div>
            <div className="text-xl md:text-3xl italic font-black">{totals.totalKwh.toFixed(0)} kWh</div>
          </div>

          {/* Wave H item 7 — same numbers, either unit. */}
          <div
            data-testid="cost-toggle"
            role="group"
            aria-label="Show costs as"
            /* A printed report states one unit; the switch itself is chrome. */
            className="no-print bg-slate-100 p-1 rounded-xl md:rounded-2xl border-2 md:border-4 border-black flex gap-1"
          >
            {(['yr', 'day'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={costMode === mode}
                onClick={() => setCostMode(mode)}
                className={`inline-flex min-h-11 min-w-11 items-center justify-center px-3 md:px-5 py-2 rounded-lg md:rounded-xl text-[11px] md:text-[11px] font-black transition-all ${
                  costMode === mode ? 'bg-black text-white' : 'text-black hover:bg-white'
                }`}
              >
                {mode === 'yr' ? '$/yr' : '$/day'}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-3 md:gap-4">
            {([
              { id: 'TOU', label: 'Time-of-Use', cost: totals.costTOU },
              { id: 'Tiered', label: 'Tiered', cost: totals.costTiered },
              { id: 'ULO', label: 'Ultra-Low Overnight', cost: totals.costULO },
            ] as const).map((p) => (
              <div
                key={p.id}
                data-testid={`plan-cost-${p.id}`}
                data-unit={costMode}
                className={`px-3 md:px-5 py-2 rounded-xl md:rounded-2xl border-4 border-black ${p.id === totals.bestPlan ? 'bg-emerald-400' : p.id === totals.worstPlan ? 'bg-red-400' : 'bg-slate-100'}`}
              >
                <div className="text-[8px] md:text-[10px]">{p.label}</div>
                <div className="text-lg md:text-2xl italic font-black">
                  ${money(p.cost)}
                  <span className="text-[9px] md:text-[11px] not-italic font-black ml-1">
                    {costMode === 'yr' ? '/yr' : '/day'}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-yellow-400 px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-black">
            <div className="text-[8px] md:text-[10px]">Best vs worst plan</div>
            <div className="text-lg md:text-2xl italic font-black">
              ${money(totals.planDelta)}
              <span className="text-[9px] md:text-[11px] font-black ml-1">
                {costMode === 'yr' ? '/yr' : '/day'}
              </span>
            </div>
            <div className="text-[8px] md:text-[10px]">{totals.worstPlan} − {totals.bestPlan}</div>
          </div>

          {/* Wave H item 5 — "why is the chart empty at the end?" answered
              before it is asked. */}
          <div
            data-testid="data-freshness-chip"
            role="status"
            data-last-reading={totals.lastDate}
            data-age-days={freshness?.ageDays}
            data-stale={String(freshness?.stale ?? false)}
            className={`px-3 md:px-4 py-2 rounded-xl md:rounded-2xl border-4 border-black flex flex-col ${
              freshness?.stale ? 'bg-amber-300' : 'bg-slate-100'
            }`}
            title={
              freshness?.stale
                ? `Your newest reading is ${freshness.relative} — upload a newer export to fill the gap.`
                : undefined
            }
          >
            <div className="text-[8px] md:text-[10px] uppercase font-black">
              Data as of {format(new Date(totals.lastDate + 'T00:00:00'), 'MMM d, yyyy')}
            </div>
            <div
              className={`text-[9px] md:text-[11px] font-black normal-case ${
                freshness?.stale ? 'text-black' : 'text-slate-500'
              }`}
            >
              {freshness?.stale
                ? `${freshness.relative} — upload a newer export for a full chart`
                : freshness?.relative}
            </div>
          </div>

          <div className="text-[8px] md:text-[10px] text-slate-500 max-w-[240px] md:max-w-none">
            Whole dataset ({format(new Date(totals.firstDate + 'T00:00:00'), 'MMM d')} – {format(new Date(totals.lastDate + 'T00:00:00'), 'MMM d, yyyy')}), variable charges only.
            <span data-testid="cost-reframe" className="block mt-1 text-black font-black normal-case">
              {reframe}
            </span>
          </div>
        </div>
      )}

      {/* 3. Which file / feed this is, and whether it is connected. */}
      {fileStatus}

      {/* 4. What this month is going to cost. */}
      <BillProjectionBanner projection={projection} />
    </div>
  );
}
