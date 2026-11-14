/**
 * OVERVIEW — the decision-first tab.
 *
 * Wave R's answer to "the best choice is now buried": this panel is what the
 * user sees first, and it leads with period context, the projected bill,
 * rate history, and the adjacent plan/attention decisions. The detailed
 * dataset and usage analysis remain available below that decision surface.
 *
 * Everything else moved to the tab it belongs to (Usage, Plans & Track
 * Record, Money & What-If). `fileStatus` is a slot so the Green Button chip
 * stays wired by Dashboard, which owns the sync callbacks.
 */

'use client';

import React from 'react';
import { dataFreshness } from '@/lib/freshness';
import {
  fmtCents, fmtDate, fmtDateLong, fmtDay, fmtKwh, fmtMoney, fmtMoney0, fmtNumber, moneyPeriodUnit, planLabel, useTranslation,
} from '@/i18n';
import type { AlwaysOnFloor, FullDataTotals } from '@/lib/energy';
import type { BillProjection } from '@/lib/billProjection';
import type { PlanId } from '@/hooks/useSelectedPlan';
import type { PlanCosts } from '@/lib/verdict';
import { EFFICIENCY_SUBTITLE_KEY, type EfficiencyReport } from '@/lib/statistics';
import { buildVerdict } from '@/lib/verdict';
import RateByMonth from '@/components/RateByMonth';
import BillProjectionBanner from '@/components/BillProjectionBanner';
import EfficiencyCard from '@/components/EfficiencyCard';
import { daysBetweenDayKeys, dayKeyDate } from '@/lib/dateSpan';
import UsagePanel, { type UsagePanelProps } from '@/components/UsagePanel';
import type { AxisPeriod } from '@/lib/billingAxis';
import type { StalenessResult } from '@/hooks/useRateStaleness';

export type OverviewPanelProps = {
  /** Per-plan cost of the window on screen — the banner's raw material. */
  comparison: PlanCosts | null;
  /** Commodity 7 dataset: no plan widget may stand over a gas bill
   *  (epic DoD 4 — no plan-comparison surfaces on gas data). */
  gas?: boolean;
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
  onOpenPlans: () => void;
  /** Wired by Dashboard: the Analytics CTA jumps to the ANALYTICS tab. */
  onOpenAnalytics: () => void;
  /** Green Button / file-status chip, wired by Dashboard. */
  fileStatus?: React.ReactNode;
  /** Existing usage and insight tools, retained below the decision summary. */
  usage: Omit<UsagePanelProps, 'embedded'>;
  importReview: boolean;
  rateMismatch?: boolean;
  staleness?: StalenessResult;
  /** Latest file-backed billing window, never a mockup month. */
  latestPeriod: AxisPeriod | null;
  /** Source-derived always-on baseline for the same data window. */
  floor?: AlwaysOnFloor | null;
  /** Classic view keeps Usage as its own historical destination. */
  showUsage?: boolean;
};

export default function OverviewPanel({
  comparison,
  gas = false,
  userPlan,
  days,
  totals,
  costMode,
  setCostMode,
  reframe,
  projection,
  efficiency,
  onOpenMoney,
  onOpenPlans,
  onOpenAnalytics,
  fileStatus,
  usage,
  importReview,
  rateMismatch = false,
  staleness,
  latestPeriod,
  floor,
  showUsage = true,
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

  /**
   * The period unit beside every money chip, never the "$/yr" toggle label:
   * `fmtMoney` already prints the currency symbol, so a label carrying one
   * renders as the fr-CA "1 420,89 $$/AN" regression. `moneyPeriodUnit()`
   * is the catalog's symbol-FREE unit ("/yr" · "/an"), and the i18n money
   * contract test pins that shape.
   */
  const unit = moneyPeriodUnit(costMode);
  const verdict = buildVerdict(comparison, userPlan, days);
  /**
   * Every date the header paints comes from a stored day key, and an
   * undateable instant formats one as `NaN-NaN-NaN` — truthy, but no date
   * (F2/F3, t_bcc1b9c6). Resolve each once through `dayKeyDate`: null when
   * the key names none, so the sites below degrade to the panel's own `—`
   * instead of handing date-fns an Invalid Date (RangeError). The axis's
   * end day wins when it IS a date; a hostile one falls through to the
   * dataset's own last day.
   */
  const headingDate =
    dayKeyDate(latestPeriod?.endDate ?? null) ?? dayKeyDate(totals?.lastDate ?? null);
  const firstDate = totals ? dayKeyDate(totals.firstDate) : null;
  const lastDate = totals ? dayKeyDate(totals.lastDate) : null;
  const observedAverageRate = React.useMemo(() => {
    let kwh = 0;
    let cost = 0;
    for (const row of usage.processedData) {
      kwh += row.usage_kwh;
      cost += userPlan === 'TOU' ? row.costTOU : userPlan === 'Tiered' ? row.costTiered : row.costULO;
    }
    return kwh > 0 ? cost / kwh * 100 : null;
  }, [usage.processedData, userPlan]);
  const metricDeltas = React.useMemo(() => {
    const months = new Map<string, { kwh: number; cost: number; days: Set<string> }>();
    for (const row of usage.processedData) {
      const key = row.dayStr.slice(0, 7);
      const current = months.get(key) ?? { kwh: 0, cost: 0, days: new Set<string>() };
      current.kwh += row.usage_kwh;
      current.cost += userPlan === 'TOU' ? row.costTOU : userPlan === 'Tiered' ? row.costTiered : row.costULO;
      current.days.add(row.dayStr);
      months.set(key, current);
    }
    const keys = [...months.keys()].sort();
    if (keys.length < 2) return null;
    const current = months.get(keys.at(-1)!);
    const previous = months.get(keys.at(-2)!);
    if (!current || !previous || current.kwh <= 0 || previous.kwh <= 0) return null;
    const [year, month] = keys.at(-1)!.split('-').map(Number);
    const daysInCurrentMonth = new Date(year, month, 0).getDate();
    return {
      // A partial calendar month is not comparable to a whole previous one.
      // Keep the rate delta, which is independently normalized per kWh.
      usagePct: current.days.size === daysInCurrentMonth
        ? (current.kwh - previous.kwh) / previous.kwh * 100
        : null,
      rateDelta: (current.cost / current.kwh - previous.cost / previous.kwh) * 100,
    };
  }, [usage.processedData, userPlan]);

  return (
    <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" className="order-2 space-y-5 md:space-y-7" data-testid="tab-panel-overview">
      {totals && (
        <header className="border-b border-edge-muted pb-3" data-testid="overview-period-heading">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight normal-case">
            {headingDate ? fmtDate(headingDate, 'MMMM yyyy') : lastDate ? fmtDateLong(lastDate) : '—'}
          </h1>
          <p className="quiet-overview-period-meta mt-1">
            {latestPeriod
              ? t('overview.billingPeriod', { period: latestPeriod.label })
              : t('overview.wholeDataset', { start: firstDate ? fmtDay(totals.firstDate) : '—', end: lastDate ? fmtDateLong(lastDate) : '—' })}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="overview-context-pills">
            <span className="quiet-context-pill">{t('overview.planPill', { plan: planLabel(userPlan) })}</span>
            {floor && <span className="quiet-context-pill">{t('overview.floorPill', { cost: fmtMoney0(floor.annualCost) })}</span>}
            <span className="quiet-context-pill">{t('overview.dataAsOf', { date: lastDate ? fmtDateLong(lastDate) : '—' })}</span>
            {latestPeriod?.estimated && <span className="quiet-context-pill">{t('overview.provisional')}</span>}
            {fileStatus}
          </div>
        </header>
      )}

      {totals && (
        <section aria-label={t('overview.keyFigures')} className="quiet-card quiet-overview-metrics" data-testid="overview-key-figures">
          <div className="quiet-overview-metric">
            <div className="quiet-overview-label">{t('overview.usageToDate')}</div>
            <div className="quiet-overview-value tabular-nums">{fmtKwh(totals.totalKwh, 0)}</div>
            {metricDeltas?.usagePct !== null && metricDeltas?.usagePct !== undefined && <div className={`quiet-overview-meta mt-1 ${Math.abs(metricDeltas.usagePct) < 0.5 ? 'text-ink-3' : metricDeltas.usagePct < 0 ? 'text-good' : 'text-bad'}`}>{Math.abs(metricDeltas.usagePct) < 0.5 ? t('overview.deltaUnchanged') : t('overview.usageDelta', { percent: fmtNumber(Math.abs(metricDeltas.usagePct), 0), direction: metricDeltas.usagePct < 0 ? t('overview.lower') : t('overview.higher') })}</div>}
          </div>
          <div className="quiet-overview-metric">
            <div className="quiet-overview-label">{t('overview.averageRate')}</div>
            <div className="quiet-overview-value tabular-nums">{efficiency.allTime ? fmtCents(efficiency.allTime.cents, 1) : observedAverageRate !== null ? fmtCents(observedAverageRate, 1) : '—'}</div>
            {metricDeltas && <div className={`quiet-overview-meta mt-1 ${Math.abs(metricDeltas.rateDelta) < 0.05 ? 'text-ink-3' : metricDeltas.rateDelta < 0 ? 'text-good' : 'text-bad'}`}>{Math.abs(metricDeltas.rateDelta) < 0.05 ? t('overview.deltaUnchanged') : t('overview.rateDelta', { rate: fmtCents(Math.abs(metricDeltas.rateDelta), 1), direction: metricDeltas.rateDelta < 0 ? t('overview.lower') : t('overview.higher') })}</div>}
          </div>
          <div className="quiet-overview-metric">
            <div className="quiet-overview-label">{t('projection.thisMonthBill')}</div>
            <div className="quiet-overview-value tabular-nums">{projection.ready ? fmtMoney(projection.projectedCost) : '—'}</div>
            <div className="quiet-overview-meta mt-1">{projection.ready ? t('overview.projectionMeasured', { covered: projection.monthDaysCovered, days: projection.daysInMonth }) : projection.gateNote}</div>
          </div>
          <div className="quiet-overview-metric">
            <div className="quiet-overview-label">{t('overview.planCost')}</div>
            <div className="quiet-overview-value tabular-nums">{verdict ? fmtMoney(verdict.currentCost) : '—'}</div>
            {verdict && <div className="quiet-overview-meta mt-1">{t('overview.planDelta', { amount: fmtMoney(verdict.delta), plan: planLabel(verdict.best) })}</div>}
          </div>
        </section>
      )}

      <section className="quiet-bill-focus" aria-label={t('projection.thisMonthBill')} data-testid="overview-bill-focus">
        <BillProjectionBanner projection={projection} floor={floor} />
      </section>

      <RateByMonth rows={usage.processedData} plan={userPlan} />

      <section className="grid md:grid-cols-2 gap-4" aria-label={t('overview.planAndAttention')} data-testid="overview-plan-attention">
        {/* Commodity 7: the plan widget never stands over a gas bill. */}
        {!gas && (
        <div className="quiet-plan-summary p-4 md:p-5" data-testid="overview-plan-summary">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-base font-semibold">{t('overview.yourPlan')}</h2>
            <span className="quiet-overview-label">{t('overview.current')}</span>
          </div>
          <dl
            className="mt-4 space-y-2 text-sm"
            data-testid="best-choice-banner"
            data-best-plan={verdict?.best}
            data-current-plan={userPlan}
            data-already-best={String(verdict?.alreadyBest ?? false)}
            data-window-days={verdict?.days}
          >
            <div className="flex justify-between gap-4 border-t border-edge-muted pt-2"><dt className="text-ink-2">{t('overview.plan')}</dt><dd className="font-semibold">{planLabel(userPlan)}</dd></div>
            <div className="flex justify-between gap-4 border-t border-edge-muted pt-2"><dt className="text-ink-2">{t('overview.cheapestAlternative')}</dt><dd className="font-semibold">{verdict ? planLabel(verdict.best) : '—'}</dd></div>
            <div className="flex justify-between gap-4 border-t border-edge-muted pt-2"><dt className="text-ink-2">{t('overview.potentialSaving')}</dt><dd className="font-semibold tabular-nums text-good">{verdict ? fmtMoney(verdict.delta) : '—'}</dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onOpenPlans} className="quiet-action inline-flex min-h-11 items-center justify-center px-4 text-sm font-medium">{t('overview.comparePlans')}</button>
          </div>
        </div>
        )}

        <div className="quiet-attention p-4 md:p-5" data-testid="overview-attention">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-base font-semibold">{t('overview.needsAttention')}</h2>
            <span className="quiet-overview-label">{(rateMismatch ? 1 : 0) + (importReview ? 1 : 0)}</span>
          </div>
          {rateMismatch || importReview ? <ul className="divide-y divide-edge-muted">
            {rateMismatch && <li className="py-3 first:pt-0">
              <p className="text-sm font-medium">{t('staleness.title')}</p>
              {staleness?.stale && <p data-testid="overview-rate-dates" className="mt-1 text-xs text-ink-3">
                {t('staleness.datesA')}{' '}
                <span>{staleness.stale.oebEffectiveDate}</span>
                {' — '}
                {t('staleness.datesB')}{' '}
                <span>{staleness.stale.shippedEffectiveDate}</span>
              </p>}
            </li>}
            {importReview && <li className="py-3 last:pb-0">
              <p className="text-sm font-medium">{t('overview.importReviewBody')}</p>
              <a href="/import" className="quiet-action mt-2 inline-flex min-h-11 items-center px-3 text-xs font-medium">{t('overview.reviewImports')}</a>
            </li>}
          </ul> : <p className="text-sm text-ink-3">{t('overview.noAttention')}</p>}
        </div>
      </section>


      {/* The intentional door to the dense analytics: Overview stays a
          decision screen, and the usage analysis lives one deliberate step
          away. Shown with OR without data — on a fresh install it is how
          the dismissed Link Data screen gets back in. */}
      <section className="quiet-card p-4 md:p-5 flex flex-wrap items-center justify-between gap-3" data-testid="overview-analytics-cta-row">
        <div className="min-w-[200px]">
          <h2 className="text-base font-semibold">{t('overview.analyticsCtaTitle')}</h2>
          <p className="mt-1 text-xs text-ink-3 normal-case">{t('overview.analyticsCtaBody')}</p>
        </div>
        <button
          type="button"
          data-testid="overview-analytics-cta"
          onClick={onOpenAnalytics}
          className="quiet-action inline-flex min-h-11 items-center justify-center px-4 text-sm font-medium"
        >
          {t('overview.analyticsCta')}
        </button>
      </section>

      {/* 2. What the whole dataset actually cost, and how old it is. */}
      {totals && (
        <div className="quiet-dataset-summary p-4 md:p-5 flex flex-wrap gap-4 md:gap-5 items-center" data-testid="totals-strip" data-best-plan={totals.bestPlan}>
          <div className="quiet-data-stat px-4 py-3">
            <div className="quiet-overview-label">{t('overview.since', { date: firstDate ? fmtDateLong(firstDate) : '—' })}</div>
            <div className="mt-1 text-xl md:text-2xl font-semibold tabular-nums">{fmtKwh(totals.totalKwh, 0)}</div>
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
              className="quiet-data-stat px-4 py-3"
            >
              {/* Micro labels: the reference retires 8px (">=11px"), and these
                  four paint on --inset, so they carry the themed muted ink
                  rather than the fixed --accent-ink that measured 1.13:1 on
                  the dark card surface. */}
              <div className="text-[11px] md:text-[11px] font-black">
{t('overview.centsPerKwh')} {t(EFFICIENCY_SUBTITLE_KEY)}
              </div>
              <div className="flex gap-4 md:gap-6 mt-1">
                <div>
                  <div className="text-[11px] font-black uppercase">{t('overview.allTime')}</div>
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
                      <div className="text-[11px] font-black uppercase text-ink-3">
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
                      <div className="text-[11px] font-black uppercase text-ink-3">
                        {t('efficiency.inclTax')}
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-black uppercase">{t('overview.inView')}</div>
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
                      <div className="text-[11px] font-black uppercase text-ink-3">
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
                      <div className="text-[11px] font-black uppercase text-ink-3">
                        {t('efficiency.inclTax')}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-[11px] font-black normal-case mt-1">
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
            className="quiet-toggle no-print p-1 flex gap-1"
          >
            {(['yr', 'day'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={costMode === mode}
                onClick={() => setCostMode(mode)}
                className={`inline-flex min-h-11 min-w-11 items-center justify-center px-3 md:px-5 py-2 rounded-lg md:rounded-xl text-[11px] md:text-[11px] font-black transition-all ${
                  costMode === mode ? 'bg-card text-ink' : 'text-ink hover:bg-card'
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
                className="quiet-data-stat px-3 md:px-4 py-2"
              >
                <div className="text-[8px] md:text-[10px]">{planLabel(p.id)}</div>
                <div className="text-lg md:text-2xl italic font-black">
                  {money(p.cost)}
                  <span className="text-[9px] md:text-[11px] not-italic font-black ml-1">
                    {unit}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="quiet-data-stat px-4 py-3">
            <div className="text-[8px] md:text-[10px]">{t('overview.bestVsWorst')}</div>
            <div className="text-lg md:text-2xl italic font-black">
              {money(totals.planDelta)}
              <span className="text-[9px] md:text-[11px] font-black ml-1">
                {unit}
              </span>
            </div>
            <div className="text-[8px] md:text-[10px]">{planLabel(totals.worstPlan)} − {planLabel(totals.bestPlan)}</div>
          </div>

          {/* Wave H item 5 — "why is the chart empty at the end?" answered
              before it is asked. */}
          <div
            data-testid="data-freshness-chip"
            role="status"
            data-last-reading={totals.lastDate}
            data-age-days={freshness?.ageDays}
            data-stale={String(freshness?.stale ?? false)}
            className="quiet-data-stat px-3 md:px-4 py-2 flex flex-col"
            title={
              freshness?.stale
                ? t('overview.freshnessTitle', { relative: freshness.relative })
                : undefined
            }
          >
            <div className="text-[8px] md:text-[10px] uppercase font-black">
              {t('overview.dataAsOf', { date: lastDate ? fmtDateLong(lastDate) : '—' })}
            </div>
            <div
              className={`text-[9px] md:text-[11px] font-black normal-case ${
                freshness?.stale ? 'text-ink' : 'text-ink-3'
              }`}
            >
              {freshness?.stale
                ? t('overview.freshnessStale', { relative: freshness.relative })
                : freshness?.relative}
            </div>
          </div>

          <div className="text-[8px] md:text-[10px] text-ink-3 max-w-[240px] md:max-w-none">
            {t('overview.wholeDataset', {
              start: firstDate ? fmtDay(totals.firstDate) : '—',
              end: lastDate ? fmtDateLong(lastDate) : '—',
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

      {/* 4. Which file / feed this is, and whether it is connected.
          The embed is data-gated: with no readings loaded there is nothing
          to analyse, and an empty chart/heatmap here would violate the
          calm-first Overview contract — the Analytics tab carries the
          specific "add data" explanation instead. */}
      {showUsage && usage.hasData && (
        <>
          <p className="text-xs text-ink-3">{t('tab.usageOverviewNote')}</p>
          <UsagePanel {...usage} embedded />
        </>
      )}
    </div>
  );
}
