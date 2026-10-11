/**
 * ShiftOptimizer — ranked ToU-shift recommendations, written for the person
 * reading it rather than for the analyst who computed it.
 *
 * What Wave E changed:
 *  - every block carries a RECOGNIZABLE classification ("looks like an EV
 *    timer", "looks like HVAC", or an honest "unidentified") plus the numbers
 *    behind that label;
 *  - when one destination owns the majority of the money the card says it
 *    ONCE as a headline and demotes the blocks to supporting rows, instead of
 *    repeating the same conclusion eight times;
 *  - every block and the headline carry a confidence chip (Very consistent /
 *    Somewhat / Irregular) derived from recurrence + week-to-week spread;
 *  - every option carries an effort chip ("no plan switch" vs "plan switch
 *    required"), so the cost of acting is visible before the fine print;
 *  - TOU Mid-Peak hours ship as a LOWER tier behind the On-Peak blocks;
 *  - every ¢/kWh these rows quote from the RateSet (baseline and move
 *    destination) prints at SOURCE precision via `fmtCentsAuto`, so a row
 *    never rounds a rate the plan card on the same tab printed exactly
 *    (the display contract lives on `fmtCents` in `i18n`).
 *
 * Empty states are explicit: no data / not enough history / no recurring
 * blocks — never a fake number.
 */

"use client";

import React from 'react';
import { Clock, ArrowRight, CalendarClock, Sunrise } from 'lucide-react';
import { fmtCentsAuto, fmtMoney, fmtPercent, useTranslation } from '@/i18n';
import { collapseHeadline } from '@/lib/touShift';
import type {
  TouShiftAnalysis,
  ShiftBlock,
  ShiftOption,
  ShiftHeadline,
  ConfidenceBadge,
  ConfidenceLevel,
  Effort,
} from '@/lib/touShift';

const TARGET_ICON: Record<ShiftOption['target'], React.ReactNode> = {
  overnight_ulo: <Sunrise size={12} strokeWidth={4} />,
  weekend: <CalendarClock size={12} strokeWidth={4} />,
  offpeak_tou: <Clock size={12} strokeWidth={4} />,
};

const CONFIDENCE_STYLE: Record<ConfidenceLevel, string> = {
  'very-consistent': 'bg-emerald-400 text-black',
  // slate, not yellow: the badge has to stay legible ON the yellow headline card
  somewhat: 'bg-slate-200 text-black',
  irregular: 'bg-red-400 text-black',
};

const EFFORT_STYLE: Record<Effort, string> = {
  'no-plan-switch': 'bg-white text-black',
  'plan-switch-required': 'bg-orange-400 text-black',
};

function EmptyState({ analysis }: { analysis: TouShiftAnalysis }) {
  const { t } = useTranslation();
  const title =
    analysis.emptyReason === 'insufficient-history'
      ? t('shift.emptyHistory')
      : analysis.emptyReason === 'no-recurring-onpeak'
        ? t('shift.emptyNoBlocks')
        : t('shift.emptyNoData');

  const detail =
    analysis.emptyReason === 'insufficient-history'
      ? t('shift.emptyHistoryDetail', { weeks: analysis.dataWeeks })
      : analysis.emptyReason === 'no-recurring-onpeak'
        ? t('shift.emptyNoBlocksDetail', { weeks: analysis.dataWeeks })
        : t('shift.emptyNoDataDetail');

  return (
    <div
      data-testid="shift-optimizer-empty"
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black"
    >
      <h3 className="text-2xl md:text-4xl italic mb-3 md:mb-5 font-black uppercase">
        {t('shift.title')}
      </h3>
      <div className="bg-slate-100 border-2 md:border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6">
        <div className="font-black uppercase text-sm md:text-xl mb-2">{title}</div>
        <p className="font-bold text-slate-600 text-xs md:text-sm">{detail}</p>
      </div>
    </div>
  );
}

function ConfidenceChip({ badge }: { badge: ConfidenceBadge }) {
  return (
    <span
      data-testid="confidence-badge"
      data-level={badge.level}
      title={badge.detail}
      className={`inline-flex items-center border-2 border-black rounded-full px-2 md:px-2.5 py-0.5 text-[9px] md:text-[10px] font-black uppercase whitespace-nowrap ${CONFIDENCE_STYLE[badge.level]}`}
    >
      {badge.label}
    </span>
  );
}

function EffortChip({ effort }: { effort: Effort }) {
  const { t } = useTranslation();
  return (
    <span
      data-testid="effort-chip"
      data-effort={effort}
      className={`inline-flex items-center border-2 border-black rounded-full px-2 md:px-2.5 py-0.5 text-[9px] md:text-[10px] font-black uppercase whitespace-nowrap ${EFFORT_STYLE[effort]}`}
    >
      {effort === 'no-plan-switch' ? t('shift.effortNone') : t('shift.effortSwitch')}
    </span>
  );
}

function TierChip({ tier }: { tier: ShiftBlock['tier'] }) {
  const { t } = useTranslation();
  if (tier !== 'mid-peak') return null;
  return (
    <span
      data-testid="shift-tier-chip"
      className="inline-flex items-center border-2 border-black rounded-full px-2 md:px-2.5 py-0.5 text-[9px] md:text-[10px] font-black uppercase whitespace-nowrap bg-blue-300 text-black"
    >
      {t('shift.tierChip')}
    </span>
  );
}

/** The label we dare to put on a block, with the evidence underneath it. */
function ClassificationRow({ block }: { block: ShiftBlock }) {
  return (
    <div data-testid="block-classification" className="mt-2 md:mt-3">
      <div className="text-[10px] md:text-xs font-black uppercase text-black">
        {block.classification.label}
      </div>
      <div className="text-[9px] md:text-[11px] font-bold text-slate-500">
        {block.classification.detail}
      </div>
    </div>
  );
}

function OptionRow({ option, rank }: { option: ShiftOption; rank: number }) {
  const { t } = useTranslation();
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
          <EffortChip effort={option.effort} />
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <span className="text-[10px] md:text-xs text-slate-600">
            {fmtCentsAuto(option.destRateCents)}/kWh
          </span>
          <ArrowRight size={10} strokeWidth={4} className="hidden sm:block" />
          <span className="text-sm md:text-lg italic">
            {fmtMoney(option.monthlySavings)}
            <span className="text-[8px] md:text-[10px] not-italic">{t('common.perMonth')}</span>
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
  const { t } = useTranslation();
  return (
    <div
      data-testid={`shift-block-${block.id}`}
      data-tier={block.tier}
      className="bg-white border-4 border-black rounded-[1.25rem] md:rounded-[2rem] shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3 md:mb-5">
        <div className="flex items-center gap-3 md:gap-4">
          <div className="bg-black text-yellow-400 w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center font-black text-sm md:text-base shrink-0">
            {rank + 1}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-black uppercase text-lg md:text-2xl leading-none">
                {block.label}
              </div>
              <ConfidenceChip badge={block.confidence} />
              <TierChip tier={block.tier} />
            </div>
            <div className="text-[10px] md:text-xs font-bold text-slate-500 mt-1 md:mt-2">
              {t('shift.blockMeta', {
                kwh: block.avgWeeklyKwh.toFixed(1),
                seen: block.weeksSeen,
                rate: fmtCentsAuto(block.baselineRateCents),
              })}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[8px] md:text-[10px] font-black uppercase text-slate-400">
            {t('shift.bestCase')}
          </div>
          <div className="text-xl md:text-3xl italic font-black text-emerald-600">
            {fmtMoney(block.bestMonthlySavings)}
            <span className="text-[10px] md:text-sm not-italic">{t('common.perMonth')}</span>
          </div>
        </div>
      </div>
      <ClassificationRow block={block} />
      <div className="space-y-2 md:space-y-3 mt-3 md:mt-4">
        {block.options.map((o, i) => (
          <OptionRow key={o.target} option={o} rank={i} />
        ))}
      </div>
    </div>
  );
}

/** Collapsed form: the block demoted to one line of evidence + its options. */
function SupportingRow({ block, rank }: { block: ShiftBlock; rank: number }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`shift-block-${block.id}`}
      data-tier={block.tier}
      className="bg-white border-2 md:border-4 border-black rounded-xl md:rounded-2xl p-3 md:p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-1.5 md:space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        <div className="bg-black text-yellow-400 w-6 h-6 md:w-8 md:h-8 rounded-md md:rounded-lg flex items-center justify-center font-black text-[10px] md:text-xs shrink-0">
          {rank + 1}
        </div>
        <div className="font-black uppercase text-sm md:text-base">{block.label}</div>
        <ConfidenceChip badge={block.confidence} />
        <TierChip tier={block.tier} />
        <div className="ml-auto flex items-center gap-2 md:gap-3">
          <span className="text-[9px] md:text-[11px] font-black uppercase text-slate-500">
            {t('shift.bestCase')}
          </span>
          <span className="text-sm md:text-lg italic font-black text-emerald-600">
            {fmtMoney(block.bestMonthlySavings)}
            <span className="text-[8px] md:text-[10px] not-italic">{t('common.perMonth')}</span>
          </span>
        </div>
      </div>
      <div className="text-[9px] md:text-[11px] font-bold text-black">
        {block.classification.label} ·{' '}
        <span className="text-slate-500">{block.classification.detail}</span>
      </div>
      <div className="text-[9px] md:text-[11px] font-bold text-slate-500">
        {t('shift.blockMeta', {
          kwh: block.avgWeeklyKwh.toFixed(1),
          seen: block.weeksSeen,
          rate: fmtCentsAuto(block.baselineRateCents),
        })}
      </div>
      <div className="flex flex-wrap gap-1.5 md:gap-2">
        {block.options.map((o, i) => (
          <span
            key={o.target}
            className={`inline-flex flex-wrap items-center gap-1 md:gap-1.5 border-2 border-black rounded-lg px-1.5 md:px-2 py-1 text-[9px] md:text-[10px] font-black uppercase ${
              i === 0 ? 'bg-yellow-400' : 'bg-white'
            }`}
          >
            {TARGET_ICON[o.target]}
            <span>{o.label}</span>
            <span className="text-slate-600">{fmtCentsAuto(o.destRateCents)}</span>
            <ArrowRight size={9} strokeWidth={4} className="hidden sm:block" />
            <span className="italic">{fmtMoney(o.monthlySavings)}{t('common.perMonthShort')}</span>
            <EffortChip effort={o.effort} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** One sentence for the whole household, with the worst badge we can stand behind. */
function HeadlineCard({ headline }: { headline: ShiftHeadline }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="shift-headline"
      className="bg-yellow-400 border-4 border-black rounded-[1.25rem] md:rounded-[2rem] shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-7 text-black"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[10px] tracking-[0.25em] font-black uppercase">
          {t('shift.oneMove')}
        </div>
        <ConfidenceChip badge={headline.confidence} />
      </div>
      <div className="text-xl md:text-4xl font-black uppercase leading-tight mt-2 md:mt-3">
        {headline.headline}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:gap-3 mt-3 md:mt-4">
        <span
          data-testid="shift-headline-share"
          className="bg-black text-white border-2 border-black rounded-full px-2.5 md:px-3 py-1 text-[9px] md:text-[11px] font-black uppercase"
        >
          {t('shift.shareLine', {
            pct: fmtPercent(Math.round(headline.share * 100)),
            blocks: headline.blockCount,
            total: headline.totalCount,
          })}
        </span>
        <EffortChip effort={headline.effort} />
        <span className="text-[10px] md:text-xs font-black uppercase">
          {headline.optionLabel}
        </span>
      </div>
      <p className="text-[10px] md:text-[12px] font-bold mt-2 md:mt-3">{headline.assumption}</p>
      <div className="text-[9px] md:text-[11px] font-bold text-slate-700 mt-1 md:mt-2">
        {t('shift.supportingNote')}
      </div>
    </div>
  );
}

function TierHeading({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="shift-tier-midpeak"
      className="bg-blue-300 border-4 border-black rounded-xl md:rounded-2xl px-4 md:px-6 py-3 md:py-4 text-black"
    >
      <div className="text-[10px] md:text-xs font-black uppercase tracking-[0.2em]">
        {t('shift.tierHeading')}
      </div>
      <div className="text-sm md:text-lg font-black uppercase mt-1">
        {t('shift.tierCount', { count, blocks: count })}
      </div>
      <div className="text-[9px] md:text-[11px] font-bold text-slate-700">
        {t('shift.tierNote')}
      </div>
    </div>
  );
}

export default function ShiftOptimizer({ analysis }: { analysis: TouShiftAnalysis }) {
  const { t } = useTranslation();
  if (analysis.blocks.length === 0) {
    return (
      <div className="font-black uppercase text-black">
        <EmptyState analysis={analysis} />
      </div>
    );
  }

  const { blocks } = analysis;
  const headline = collapseHeadline(blocks, analysis.totalMonthlySavings);
  const onPeak = blocks.filter((b) => b.tier === 'on-peak');
  const midPeak = blocks.filter((b) => b.tier === 'mid-peak');

  const countLine =
    midPeak.length > 0
      ? t('shift.countBoth', { on: onPeak.length, mid: midPeak.length })
      : t('shift.countOnOnly', { count: blocks.length, blocks: blocks.length });

  return (
    <div
      data-testid="shift-optimizer"
      className="space-y-4 md:space-y-6 font-black uppercase text-black"
    >
      <div className="bg-black text-white p-5 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 border-yellow-400 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[10px] tracking-[0.25em] text-yellow-400 font-black">
            {t('shift.eyebrow')}
          </div>
          <div className="text-xl md:text-3xl italic leading-tight mt-1">{countLine}</div>
          <div className="text-[10px] md:text-xs font-bold text-slate-400 mt-1">
            {t('shift.patternCheck')}
          </div>
        </div>
        <div className="bg-yellow-400 text-black px-4 md:px-7 py-3 md:py-5 rounded-xl md:rounded-2xl border-4 border-white text-center">
          <div className="text-[8px] md:text-[10px] font-black uppercase">
            {t('shift.ifEveryMoved')}
          </div>
          <div className="text-3xl md:text-5xl italic leading-none mt-1">
            {fmtMoney(analysis.totalMonthlySavings)}
          </div>
          <div className="text-[8px] md:text-[10px] font-black uppercase">{t('shift.perMonth')}</div>
        </div>
      </div>

      {headline ? (
        <>
          <HeadlineCard headline={headline} />
          <div className="space-y-2 md:space-y-3">
            {blocks.map((block, i) => (
              <SupportingRow key={block.id} block={block} rank={i} />
            ))}
          </div>
        </>
      ) : (
        <>
          {onPeak.map((block, i) => (
            <BlockCard key={block.id} block={block} rank={i} />
          ))}
          {midPeak.length > 0 && <TierHeading count={midPeak.length} />}
          {midPeak.map((block, i) => (
            <BlockCard key={block.id} block={block} rank={onPeak.length + i} />
          ))}
        </>
      )}
    </div>
  );
}
