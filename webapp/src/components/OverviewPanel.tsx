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
import { dataFreshness } from '@/lib/freshness';
import {
  fmtCents, fmtDateLong, fmtDay, fmtKwh, fmtMoney, planLabel, useTranslation,
} from '@/i18n';
import type { FullDataTotals } from '@/lib/energy';
import type { BillProjection } from '@/lib/billProjection';
import type { PlanId } from '@/hooks/useSelectedPlan';
import type { PlanCosts } from '@/lib/verdict';
import { EFFICIENCY_SUBTITLE_KEY, type EfficiencyReport } from '@/lib/statistics';
import BestChoiceBanner from '@/components/BestChoiceBanner';
import BillProjectionBanner from '@/components/BillProjectionBanner';
import EfficiencyCard from '@/components/EfficiencyCard';
import { daysBetweenDayKeys } from '@/lib/dateSpan';

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
  /** Wave S — ¢/kWh per bill, the all-time/in-view averages, the verdict. */
  efficiency: EfficiencyReport;
  /** Wired by Dashboard: the mini-line jumps to the MONEY tab. */
  onOpenMoney: () => void;
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
  efficiency,
  onOpenMoney,
  fileStatus,
}: OverviewPanelProps) {
  // Wave U — locale subscription; every text useMemo below lists `t`.
  const { t } = useTranslation();
  // The strip reports the WHOLE dataset, so its unit conversions are anchored
  // on the dataset's own span — never on the visible window. Shared with
  // Dashboard so the two cannot drift (lib/dateSpan.ts).
  const totalDays = totals ? daysBetweenDayKeys(totals.firstDate, totals.lastDate) : 1;
  /** The per-day/per-year figure, formatted with the locale's money rules. */
  const money = (datasetTotal: number): string => {
    const perDay = datasetTotal / totalDays;
    return fmtMoney(costMode === 'yr' ? perDay * 365.25 : perDay);
  };
  const freshness = totals ? dataFreshness(totals.lastDate, new Date()) : null;

  return (
    <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" className="space-y-6 md:space-y-10" data-testid="tab-panel-overview">
      {/* 1. THE ANSWER. First element, nothing above it but the tab strip. */}
      <BestChoiceBanner comparison={comparison} userPlan={userPlan} days={days} />

      {/* 2. What the whole dataset actually cost, and how old it is. */}
      {totals && (
        <div className="relative z-[100] bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-edge flex flex-wrap gap-4 md:gap-6 items-center text-ink" data-testid="totals-strip" data-best-plan={totals.bestPlan}>
          <div className="bg-inv text-inv-ink px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-edge">
            <div className="text-[8px] md:text-[10px] text-accent-yellow">{t('overview.since', { date: fmtDateLong(new Date(totals.firstDate + 'T00:00:00')) })}</div>
            <div className="text-xl md:text-3xl italic font-black">{fmtKwh(totals.totalKwh, 0)}</div>
          </div>

          {/* Wave S — the whole dataset as ONE price: what a kWh actually
              cost, and what it cost in the window on screen. Same math as
              the EFFICIENCY card, restated where the totals live — with the
              SAME tax honesty: the subtitle names the charges and the
              divisor, and every figure is published excl. and incl. tax so
              no view of the same bills can disagree with another. */}
          {efficiency.allTime && (
            <div
              data-testid="efficiency-strip"
              className="bg-yellow-400 text-accent-ink px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-edge"
            >
              <div className="text-[8px] md:text-[10px] font-black">
{t('overview.centsPerKwh')} {t(EFFICIENCY_SUBTITLE_KEY)}
              </div>
              <div className="flex gap-4 md:gap-6 mt-1">
                <div>
                  <div className="text-[8px] font-black uppercase">{t('overview.allTime')}</div>
                  <div className="flex gap-3 md:gap-4">
                    <div>
                      <div
                        className="text-lg md:text-2xl italic font-black"
                        data-testid="efficiency-all-time-strip"
                        data-cents={efficiency.allTime.cents.toFixed(2)}
                        data-bills={efficiency.allTime.bills}
                      >
                        {fmtCents(efficiency.allTime.cents, 1)}
                      </div>
                      <div className="text-[8px] font-black uppercase text-accent-ink">
                        {t('efficiency.exclTax')}
                      </div>
                    </div>
                    <div>
                      <div
                        className="text-lg md:text-2xl italic font-black"
                        data-testid="efficiency-all-time-strip-incl-tax"
                        data-cents={efficiency.allTime.centsInclTax.toFixed(2)}
                      >
                        {fmtCents(efficiency.allTime.centsInclTax, 1)}
                      </div>
                      <div className="text-[8px] font-black uppercase text-accent-ink">
                        {t('efficiency.inclTax')}
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <div className="text-[8px] font-black uppercase">{t('overview.inView')}</div>
                  <div className="flex gap-3 md:gap-4">
                    <div>
                      <div
                        className="text-lg md:text-2xl italic font-black"
                        data-testid="efficiency-in-view"
                        data-cents={(efficiency.inView?.cents ?? 0).toFixed(2)}
                        data-bills={efficiency.inView?.bills ?? 0}
                      >
                        {efficiency.inView ? fmtCents(efficiency.inView.cents, 1) : '—'}
                      </div>
                      <div className="text-[8px] font-black uppercase text-accent-ink">
                        {t('efficiency.exclTax')}
                      </div>
                    </div>
                    <div>
                      <div
                        className="text-lg md:text-2xl italic font-black"
                        data-testid="efficiency-in-view-incl-tax"
                        data-cents={(efficiency.inView?.centsInclTax ?? 0).toFixed(2)}
                      >
                        {efficiency.inView ? fmtCents(efficiency.inView.centsInclTax, 1) : '—'}
                      </div>
                      <div className="text-[8px] font-black uppercase text-accent-ink">
                        {t('efficiency.inclTax')}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-[8px] font-black normal-case mt-1">
                {t('overview.billsTotal', { count: efficiency.allTime.bills })}
                {efficiency.inView
                  ? ` · ${t('overview.billsInView', { count: efficiency.inView.bills })}`
                  : ` · ${t('overview.billsNone')}`}
              </div>
            </div>
          )}

          {/* Wave H item 7 — same numbers, either unit. */}
          <div
            data-testid="cost-toggle"
            role="group"
            aria-label={t('overview.costModeAria')}
            /* A printed report states one unit; the switch itself is chrome. */
            className="no-print bg-hover p-1 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge flex gap-1"
          >
            {(['yr', 'day'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={costMode === mode}
                onClick={() => setCostMode(mode)}
                className={`inline-flex min-h-11 min-w-11 items-center justify-center px-3 md:px-5 py-2 rounded-lg md:rounded-xl text-[11px] md:text-[11px] font-black transition-all ${
                  costMode === mode ? 'bg-inv text-inv-ink' : 'text-ink hover:bg-card'
                }`}
              >
                {mode === 'yr' ? t('overview.perYear') : t('overview.perDay')}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-3 md:gap-4">
            {/* Wave U — labels localize (OEB French names); `data-testid`
                keeps the canonical id, and the id itself stays English. */}
            {([
              { id: 'TOU' as const, cost: totals.costTOU },
              { id: 'Tiered' as const, cost: totals.costTiered },
              { id: 'ULO' as const, cost: totals.costULO },
            ]).map((p) => (
              <div
                key={p.id}
                data-testid={`plan-cost-${p.id}`}
                data-unit={costMode}
                /* The emerald/red chips are FIXED slabs — their colour does not
                   flip with the theme, so their ink must not either: --ink is
                   near-white in dark and would sit at 1.85:1 / 2.76:1 on them.
                   text-accent-ink is #000 in both themes, which is what these
                   chips have always painted in light. */
                className={`px-3 md:px-5 py-2 rounded-xl md:rounded-2xl border-4 border-edge ${
                  p.id === totals.bestPlan
                    ? 'bg-emerald-400 text-accent-ink'
                    : p.id === totals.worstPlan
                      ? 'bg-red-400 text-accent-ink'
                      : 'bg-hover'
                }`}
              >
                <div className="text-[8px] md:text-[10px]">{planLabel(p.id)}</div>
                <div className="text-lg md:text-2xl italic font-black">
                  {money(p.cost)}
                  <span className="text-[9px] md:text-[11px] not-italic font-black ml-1">
                    {costMode === 'yr' ? t('overview.perYear') : t('overview.perDay')}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-yellow-400 text-accent-ink px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-edge">
            <div className="text-[8px] md:text-[10px]">{t('overview.bestVsWorst')}</div>
            <div className="text-lg md:text-2xl italic font-black">
              {money(totals.planDelta)}
              <span className="text-[9px] md:text-[11px] font-black ml-1">
                {costMode === 'yr' ? t('overview.perYear') : t('overview.perDay')}
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
            className={`px-3 md:px-4 py-2 rounded-xl md:rounded-2xl border-4 border-edge flex flex-col ${
              /* amber-300 is a fixed slab: same ink rule as the chips above. */
              freshness?.stale ? 'bg-amber-300 text-accent-ink' : 'bg-hover'
            }`}
            title={
              freshness?.stale
                ? t('overview.freshnessTitle', { relative: freshness.relative })
                : undefined
            }
          >
            <div className="text-[8px] md:text-[10px] uppercase font-black">
              {t('overview.dataAsOf', { date: fmtDateLong(new Date(totals.lastDate + 'T00:00:00')) })}
            </div>
            <div
              className={`text-[9px] md:text-[11px] font-black normal-case ${
                freshness?.stale ? 'text-accent-ink' : 'text-ink-3'
              }`}
            >
              {freshness?.stale
                ? t('overview.freshnessStale', { relative: freshness.relative })
                : freshness?.relative}
            </div>
          </div>

          <div className="text-[8px] md:text-[10px] text-ink-3 max-w-[240px] md:max-w-none">
            {t('overview.wholeDataset', {
              start: fmtDay(totals.firstDate),
              end: fmtDateLong(new Date(totals.lastDate + 'T00:00:00')),
            })}
            <span data-testid="cost-reframe" className="block mt-1 text-ink font-black normal-case">
              {reframe}
            </span>
          </div>
        </div>
      )}

      {/* 3. What a kWh cost, and whether that is getting better — the
          split verdict (behaviour vs rate) plus the 24-bill mini-line.
          Only when the file actually carries bills: readings alone can
          price a plan but cannot price a kWh against a real bill. */}
      {efficiency.periods.length > 0 && (
        <EfficiencyCard report={efficiency} onOpenMoney={onOpenMoney} />
      )}

      {/* 4. Which file / feed this is, and whether it is connected. */}
      {fileStatus}

      {/* 5. What this month is going to cost. */}
      <BillProjectionBanner projection={projection} />
    </div>
  );
}
