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
 *  - TOU Mid-Peak hours ship as a LOWER tier behind the On-Peak blocks.
 *
 * Empty states are explicit: no data / not enough history / no recurring
 * blocks — never a fake number.
 */

"use client";

import React from 'react';
import { Clock, ArrowRight, CalendarClock, Sunrise } from 'lucide-react';
import { fmtCents, fmtMoney, fmtNumber, fmtPercent, useTranslation } from '@/i18n';
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
  'very-consistent': 'bg-good-slab text-accent-ink',
  // slate, not yellow: the badge has to stay legible ON the yellow headline card
  somewhat: 'bg-track text-ink',
  irregular: 'bg-bad-slab text-accent-ink',
};

const EFFORT_STYLE: Record<Effort, string> = {
  'no-plan-switch': 'bg-card text-ink',
  'plan-switch-required': 'bg-inset text-ink',
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
      className="bg-card p-6 md:p-10 rounded-xl md:rounded-2xl border border-edge text-ink"
    >
      <h3 className="text-base md:text-lg mb-2 md:mb-3 font-semibold uppercase tracking-[0.08em]">
        {t('shift.title')}
      </h3>
      <div className="bg-hover border border-edge rounded-xl md:rounded-2xl p-4 md:p-6">
        <div className="font-semibold uppercase text-sm md:text-xl mb-2">{title}</div>
        <p className="font-medium text-ink-2 text-xs md:text-sm">{detail}</p>
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
      className={`inline-flex items-center border border-edge-muted rounded-full px-2 md:px-2.5 py-0.5 text-[9px] md:text-[10px] font-semibold uppercase whitespace-nowrap ${CONFIDENCE_STYLE[badge.level]}`}
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
      className={`inline-flex items-center border border-edge-muted rounded-full px-2 md:px-2.5 py-0.5 text-[9px] md:text-[10px] font-semibold uppercase whitespace-nowrap ${EFFORT_STYLE[effort]}`}
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
      className="inline-flex items-center border border-edge-muted rounded-full px-2 md:px-2.5 py-0.5 text-[9px] md:text-[10px] font-semibold uppercase whitespace-nowrap bg-info-slab-soft text-accent-ink"
    >
      {t('shift.tierChip')}
    </span>
  );
}

/** The label we dare to put on a block, with the evidence underneath it. */
function ClassificationRow({ block }: { block: ShiftBlock }) {
  return (
    <div data-testid="block-classification" className="mt-2 md:mt-3">
      <div className="text-[10px] md:text-xs font-semibold uppercase text-ink">
        {block.classification.label}
      </div>
      <div className="text-[9px] md:text-[11px] font-medium text-ink-3">
        {block.classification.detail}
      </div>
    </div>
  );
}

function OptionRow({ option, rank }: { option: ShiftOption; rank: number }) {
  const { t } = useTranslation();
  /* Rank 0 keeps a MARKER (the accent edge), not an accent slab: the
     reference reserves fills for one primary action and marks the
     recommendation with hairlines. */
  return (
    <div
      className={`border border-edge rounded-lg md:rounded-xl p-3 md:p-4 bg-card ${
        rank === 0 ? 'border-l-[3px] border-l-accent' : ''
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 font-semibold uppercase">
        <div className="flex items-center gap-1.5 md:gap-2 text-[10px] md:text-xs">
          {TARGET_ICON[option.target]}
          <span>{option.label}</span>
          <EffortChip effort={option.effort} />
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <span className="text-[10px] md:text-xs text-ink-2">
            {fmtCents(option.destRateCents)}{t('efficiency.perKwh')}
          </span>
          <ArrowRight size={10} strokeWidth={4} className="hidden sm:block" />
          <span className="text-sm md:text-lg">
            {fmtMoney(option.monthlySavings)}
            <span className="text-[8px] md:text-[10px] not-italic">{t('common.perMonth')}</span>
          </span>
        </div>
      </div>
      <p className="text-[9px] md:text-[11px] font-medium mt-1.5 md:mt-2 text-ink-2">
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
      className="bg-card border border-edge rounded-xl md:rounded-2xl p-4 md:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3 md:mb-5">
        <div className="flex items-center gap-3 md:gap-4">
          <div className="bg-inv text-accent-yellow w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl flex items-center justify-center font-semibold text-sm md:text-base shrink-0">
            {rank + 1}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-semibold uppercase text-lg md:text-2xl leading-none">
                {block.label}
              </div>
              <ConfidenceChip badge={block.confidence} />
              <TierChip tier={block.tier} />
            </div>
            <div className="text-[10px] md:text-xs font-medium text-ink-3 mt-1 md:mt-2">
              {t('shift.blockMeta', {
                kwh: fmtNumber(block.avgWeeklyKwh, 1),
                seen: block.weeksSeen,
                rate: fmtCents(block.baselineRateCents),
              })}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[8px] md:text-[10px] font-semibold uppercase text-ink-4">
            {t('shift.bestCase')}
          </div>
          <div className="text-lg md:text-xl font-semibold tabular-nums text-good">
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
      className="bg-card border border-edge rounded-xl md:rounded-2xl p-3 md:p-4 space-y-1.5 md:space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        <div className="bg-inv text-accent-yellow w-6 h-6 md:w-8 md:h-8 rounded-md md:rounded-lg flex items-center justify-center font-semibold text-[10px] md:text-xs shrink-0">
          {rank + 1}
        </div>
        <div className="font-semibold uppercase text-sm md:text-base">{block.label}</div>
        <ConfidenceChip badge={block.confidence} />
        <TierChip tier={block.tier} />
        <div className="ml-auto flex items-center gap-2 md:gap-3">
          <span className="text-[9px] md:text-[11px] font-semibold uppercase text-ink-3">
            {t('shift.bestCase')}
          </span>
          <span className="text-sm md:text-lg font-semibold tabular-nums text-good">
            {fmtMoney(block.bestMonthlySavings)}
            <span className="text-[8px] md:text-[10px] not-italic">{t('common.perMonth')}</span>
          </span>
        </div>
      </div>
      <div className="text-[9px] md:text-[11px] font-medium text-ink">
        {block.classification.label} ·{' '}
        <span className="text-ink-3">{block.classification.detail}</span>
      </div>
      <div className="text-[9px] md:text-[11px] font-medium text-ink-3">
        {t('shift.blockMeta', {
          kwh: fmtNumber(block.avgWeeklyKwh, 1),
          seen: block.weeksSeen,
          rate: fmtCents(block.baselineRateCents),
        })}
      </div>
      <div className="flex flex-wrap gap-1.5 md:gap-2">
        {block.options.map((o, i) => (
          <span
            key={o.target}
            className={`inline-flex flex-wrap items-center gap-1 md:gap-1.5 border rounded-lg px-1.5 md:px-2 py-1 text-[9px] md:text-[10px] font-semibold uppercase ${
              i === 0 ? 'bg-card border-accent' : 'bg-card border-edge-muted'
            }`}
          >
            {TARGET_ICON[o.target]}
            <span>{o.label}</span>
            <span className="text-ink-2">{fmtCents(o.destRateCents)}</span>
            <ArrowRight size={9} strokeWidth={4} className="hidden sm:block" />
            <span>{fmtMoney(o.monthlySavings)}{t('common.perMonthShort')}</span>
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
  /* Was a full accent slab. The reference paints verdicts as ink text on a
     calm surface with an accent EDGE — so the card moves onto --inset and
     keeps only a 3px accent rule down its left side. */
  return (
    <div
      data-testid="shift-headline"
      className="bg-inset border border-edge border-l-[3px] border-l-accent rounded-lg p-4 md:p-7 text-ink"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[10px] tracking-[0.25em] font-semibold uppercase text-ink-3">
          {t('shift.oneMove')}
        </div>
        <ConfidenceChip badge={headline.confidence} />
      </div>
      <div className="text-xl md:text-2xl font-semibold leading-tight mt-2 md:mt-3">
        {headline.headline}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:gap-3 mt-3 md:mt-4">
        <span
          data-testid="shift-headline-share"
          className="bg-inv text-inv-ink border border-edge-muted rounded-full px-2.5 md:px-3 py-1 text-[9px] md:text-[11px] font-semibold uppercase"
        >
          {t('shift.shareLine', {
            pct: fmtPercent(Math.round(headline.share * 100)),
            blocks: headline.blockCount,
            total: headline.totalCount,
          })}
        </span>
        <EffortChip effort={headline.effort} />
        <span className="text-[10px] md:text-xs font-semibold uppercase">
          {headline.optionLabel}
        </span>
      </div>
      <p className="text-[10px] md:text-[12px] font-medium mt-2 md:mt-3">{headline.assumption}</p>
      <div className="text-[9px] md:text-[11px] font-medium text-ink-3 mt-1 md:mt-2">
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
      className="bg-info-slab-soft border border-edge rounded-xl md:rounded-2xl px-4 md:px-6 py-3 md:py-4 text-accent-ink"
    >
      <div className="text-[10px] md:text-xs font-semibold uppercase tracking-[0.2em]">
        {t('shift.tierHeading')}
      </div>
      <div className="text-sm md:text-lg font-semibold uppercase mt-1">
        {t('shift.tierCount', { count, blocks: count })}
      </div>
      <div className="text-[9px] md:text-[11px] font-medium text-ink-2">
        {t('shift.tierNote')}
      </div>
    </div>
  );
}

export default function ShiftOptimizer({ analysis }: { analysis: TouShiftAnalysis }) {
  const { t } = useTranslation();
  if (analysis.blocks.length === 0) {
    return (
      <div className="font-semibold uppercase text-ink">
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
      className="space-y-4 md:space-y-6 font-semibold uppercase text-ink"
    >
      <div className="bg-inv text-inv-ink p-5 md:p-8 rounded-xl md:rounded-2xl border border-accent flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[10px] tracking-[0.25em] text-accent-yellow font-semibold">
            {t('shift.eyebrow')}
          </div>
          <div className="text-lg md:text-xl leading-tight mt-1 tabular-nums">{countLine}</div>
          <div className="text-[10px] md:text-xs font-medium text-inv-ink-2 mt-1">
            {t('shift.patternCheck')}
          </div>
        </div>
        <div className="bg-page text-ink px-4 md:px-7 py-3 md:py-5 rounded-xl md:rounded-2xl border border-edge-muted text-center">
          <div className="text-[8px] md:text-[10px] font-semibold uppercase text-ink-3">
            {t('shift.ifEveryMoved')}
          </div>
          <div className="text-2xl md:text-3xl leading-none mt-1 tabular-nums">
            {fmtMoney(analysis.totalMonthlySavings)}
          </div>
          <div className="text-[8px] md:text-[10px] font-semibold uppercase text-ink-3">{t('shift.perMonth')}</div>
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
