/**
 * ShiftOptimizer — ranked ToU-shift recommendations.
 *
 * Replaces the Streamlit-era "% shift" slider: instead of one vague percentage,
 * this shows concrete recurring On-Peak blocks (weekday + hours that showed up
 * in >=3 of the last 5 weeks at consistent volume) with per-destination savings
 * ranked by monthly dollar impact, each with its honest assumption.
 *
 * Empty states are explicit: no data / not enough history / no recurring
 * On-Peak blocks — never a fake number.
 */

"use client";

import React from 'react';
import { Clock, ArrowRight, CalendarClock, Sunrise } from 'lucide-react';
import type { TouShiftAnalysis, ShiftBlock, ShiftOption } from '@/lib/touShift';

const TARGET_ICON: Record<ShiftOption['target'], React.ReactNode> = {
  overnight_ulo: <Sunrise size={12} strokeWidth={4} />,
  weekend: <CalendarClock size={12} strokeWidth={4} />,
  offpeak_tou: <Clock size={12} strokeWidth={4} />,
};

function EmptyState({ analysis }: { analysis: TouShiftAnalysis }) {
  const title =
    analysis.emptyReason === 'insufficient-history'
      ? 'NEED MORE HISTORY'
      : analysis.emptyReason === 'no-recurring-onpeak'
        ? 'NO RECURRING ON-PEAK BLOCKS DETECTED'
        : 'NO DATA TO ANALYZE';

  const detail =
    analysis.emptyReason === 'insufficient-history'
      ? `Recurring patterns need at least 3 weeks of readings — loaded data covers ${analysis.dataWeeks} of the last 5 weeks. Upload a longer export to unlock shift recommendations.`
      : analysis.emptyReason === 'no-recurring-onpeak'
        ? `Checked the last 5 weeks (loaded data covers ${analysis.dataWeeks}). Nothing in your On-Peak hours repeats often enough at a consistent volume to recommend moving — a block must appear in at least 3 of 5 weeks with steady usage.`
        : 'Upload a Green Button XML export to analyze your hourly usage.';

  return (
    <div
      data-testid="shift-optimizer-empty"
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black"
    >
      <h3 className="text-2xl md:text-4xl italic mb-3 md:mb-5 font-black uppercase">
        Shift Optimizer
      </h3>
      <div className="bg-slate-100 border-2 md:border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6">
        <div className="font-black uppercase text-sm md:text-xl mb-2">{title}</div>
        <p className="font-bold text-slate-600 text-xs md:text-sm">{detail}</p>
      </div>
    </div>
  );
}

function OptionRow({ option, rank }: { option: ShiftOption; rank: number }) {
  return (
    <div
      className={`border-2 md:border-4 border-black rounded-lg md:rounded-xl p-3 md:p-4 ${
        rank === 0 ? 'bg-yellow-400' : 'bg-white'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 font-black uppercase">
        <div className="flex items-center gap-1.5 md:gap-2 text-[10px] md:text-xs">
          {TARGET_ICON[option.target]}
          <span>{option.label}</span>
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <span className="text-[10px] md:text-xs text-slate-600">
            {option.destRateCents.toFixed(1)}¢/kWh
          </span>
          <ArrowRight size={10} strokeWidth={4} className="hidden sm:block" />
          <span className="text-sm md:text-lg italic">
            ${option.monthlySavings.toFixed(2)}
            <span className="text-[8px] md:text-[10px] not-italic">/mo</span>
          </span>
        </div>
      </div>
      <p className="text-[9px] md:text-[11px] font-bold text-slate-600 mt-1.5 md:mt-2">
        {option.assumption}
      </p>
    </div>
  );
}

function BlockCard({ block, rank }: { block: ShiftBlock; rank: number }) {
  return (
    <div
      data-testid={`shift-block-${block.id}`}
      className="bg-white border-4 border-black rounded-[1.25rem] md:rounded-[2rem] shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3 md:mb-5">
        <div className="flex items-center gap-3 md:gap-4">
          <div className="bg-black text-yellow-400 w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center font-black text-sm md:text-base shrink-0">
            {rank + 1}
          </div>
          <div>
            <div className="font-black uppercase text-lg md:text-2xl leading-none">
              {block.label}
            </div>
            <div className="text-[10px] md:text-xs font-bold text-slate-500 mt-1 md:mt-2">
              {block.avgWeeklyKwh.toFixed(1)} kWh/wk · seen in {block.weeksSeen} of 5 weeks ·
              pays {block.baselineRateCents.toFixed(1)}¢ now
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[8px] md:text-[10px] font-black uppercase text-slate-400">
            Best case
          </div>
          <div className="text-xl md:text-3xl italic font-black text-emerald-600">
            ${block.bestMonthlySavings.toFixed(2)}
            <span className="text-[10px] md:text-sm not-italic">/mo</span>
          </div>
        </div>
      </div>
      <div className="space-y-2 md:space-y-3">
        {block.options.map((o, i) => (
          <OptionRow key={o.target} option={o} rank={i} />
        ))}
      </div>
    </div>
  );
}

export default function ShiftOptimizer({ analysis }: { analysis: TouShiftAnalysis }) {
  if (analysis.blocks.length === 0) {
    return (
      <div className="font-black uppercase text-black">
        <EmptyState analysis={analysis} />
      </div>
    );
  }

  return (
    <div
      data-testid="shift-optimizer"
      className="space-y-4 md:space-y-6 font-black uppercase text-black"
    >
      <div className="bg-black text-white p-5 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 border-yellow-400 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[10px] tracking-[0.25em] text-yellow-400 font-black">
            SHIFT OPTIMIZER
          </div>
          <div className="text-xl md:text-3xl italic leading-tight mt-1">
            {analysis.blocks.length} recurring On-Peak block
            {analysis.blocks.length === 1 ? '' : 's'} found
          </div>
          <div className="text-[10px] md:text-xs font-bold text-slate-400 mt-1">
            Pattern check: last 5 weeks, same weekday + hours, steady usage
          </div>
        </div>
        <div className="bg-yellow-400 text-black px-4 md:px-7 py-3 md:py-5 rounded-xl md:rounded-2xl border-4 border-white text-center">
          <div className="text-[8px] md:text-[10px] font-black uppercase">
            If every block moved
          </div>
          <div className="text-3xl md:text-5xl italic leading-none mt-1">
            ${analysis.totalMonthlySavings.toFixed(2)}
          </div>
          <div className="text-[8px] md:text-[10px] font-black uppercase">per month</div>
        </div>
      </div>

      {analysis.blocks.map((block, i) => (
        <BlockCard key={block.id} block={block} rank={i} />
      ))}
    </div>
  );
}
