/**
 * Wave V — the HINDSIGHT panel: what another PLAN would have cost, per closed
 * bill, on the readings that were actually metered.
 *
 * One verdict per period, worst-first: Wave P's audited alternative — "would
 * have saved $X on Tiered", read straight off the switch row, never re-priced
 * here. The comparison is the same metered readings at the same timestamps and
 * quantities, repriced across TOU / Tiered / ULO for the period's own bill
 * window with the rate set in force on each reading's day.
 *
 * Nothing on this surface models or claims a change in behaviour: no load
 * shifting, no appliance moves, no hypothetical usage and no combined
 * plan+behaviour total. The forward-looking What-If / EV tools are separate
 * cards and stay separate.
 */

'use client';

import { useMemo } from 'react';

import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import { buildHindsight, type HindsightPeriod } from '@/lib/hindsight';
import type { ProcessedPoint, UsageSummary } from '@/lib/energy';
import { fmtKwh, fmtMoney, fmtNumber, planLabel, useTranslation } from '@/i18n';

type Props = {
  /** Bill periods parsed out of the imported file (Wave L parser). */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the chart window. */
  allData: ProcessedPoint[];
};

const money = (n: number) => (n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n));

function Money({ value }: { value: number | null }) {
  return <>{value === null ? '—' : money(value)}</>;
}

/**
 * The "nothing claimed" / "not priced" reason chips (skipped, unknown and
 * untrusted) all ride `bg-track` — a THEMED surface — so their ink must be a
 * themed step that clears AA on it: `--ink-3` measured 3.86:1 in light and
 * 4.04:1 in dark on `--track` (10px, 4.5 floor), and `--ink-2` is 6.15 / 6.97.
 * Fixed here under t_3e571ddb, whose dark walk asserts an EMPTY contrast
 * ledger (the row could not be pinned, and the ledger may only shrink) — it is
 * not part of the colour call, which never measured `--track`.
 */
function PlanChip({ period }: { period: HindsightPeriod }) {
  const { t } = useTranslation();
  if (period.planVerdict === 'skipped') {
    return (
      <span className="px-2 py-1 rounded border-2 border-edge bg-track text-ink-2 text-[9px] md:text-[10px] font-black">
        {t('hindsight.planChipSkipped')}
      </span>
    );
  }
  if (period.planVerdict === 'unknown') {
    return (
      <span
        data-testid="hindsight-plan-chip"
        className="px-2 py-1 rounded border-2 border-edge bg-track text-ink-2 text-[9px] md:text-[10px] font-black"
      >
        {t('hindsight.planChipUnknown')}
      </span>
    );
  }
  if (period.planVerdict === 'untrusted') {
    return (
      <span
        data-testid="hindsight-plan-chip"
        className="px-2 py-1 rounded border-2 border-warn bg-warn-soft text-warn text-[9px] md:text-[10px] font-black"
      >
        {t('hindsight.planChipUntrusted', { amount: money(period.planExcluded ?? 0) })}
      </span>
    );
  }
  if (period.planVerdict === 'overpaid' && period.planBest) {
    return (
      <span
        data-testid="hindsight-plan-chip"
        className="px-2 py-1 rounded border-2 border-bad bg-bad-soft text-bad text-[9px] md:text-[10px] font-black"
      >
        {t('hindsight.planChipOverpaid', {
          amount: money(period.planMiss ?? 0),
          plan: planLabel(period.planBest),
        })}
      </span>
    );
  }
  return (
    <span
      data-testid="hindsight-plan-chip"
      className="px-2 py-1 rounded border-2 border-good bg-good-soft text-good text-[9px] md:text-[10px] font-black"
    >
      {t('hindsight.planChipBest')}
    </span>
  );
}

function Row({ period }: { period: HindsightPeriod }) {
  const { t } = useTranslation();
  const plan = period.plan;
  const unknown = plan === 'unknown';
  const statesMoney = period.switchRow.skipped === null;
  return (
    <div
      data-testid={`hindsight-period-${period.summary.startDate}`}
      data-plan={period.plan}
      data-origin={period.origin}
      className="border-4 border-edge rounded-xl md:rounded-2xl bg-card p-4 md:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-black uppercase text-sm md:text-base">{period.label}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span
            data-testid="hindsight-plan-badge"
            className={`px-2 md:px-3 py-0.5 rounded-full border-2 border-edge text-[9px] md:text-[11px] font-black ${
              unknown ? 'bg-track' : 'bg-accent text-accent-ink'
            }`}
          >
            {unknown
              ? t('track.planUnknown')
              : t('track.onPlan', { plan: planLabel(plan).toUpperCase() })}
          </span>
          {period.origin === 'detected' && (
            <span className="px-2 py-0.5 rounded border-2 border-edge text-[8px] md:text-[9px] font-black bg-hover">
              {t('hindsight.detectedBadge')}
            </span>
          )}
          <span className="px-2 py-0.5 rounded border-2 border-edge text-[8px] md:text-[9px] font-black bg-hover">
            {period.season === 'winter' ? t('season.winter') : t('season.summer')}
            {period.straddlesSeason ? ` · ${t('hindsight.straddle')}` : ''}
          </span>
          {period.conflict && (
            <span className="px-2 py-0.5 rounded border-2 border-bad text-[8px] md:text-[9px] font-black text-bad">
              {t('track.conflict')}
            </span>
          )}
          <span className="px-2 py-0.5 rounded border-2 border-edge text-[8px] md:text-[9px] font-black bg-hover">
            {fmtKwh(period.kwh)}
          </span>
        </span>
      </div>

      {period.switchRow.skipped !== null ? (
        <div
          data-testid="hindsight-skip"
          className="mt-2 md:mt-3 bg-hover border-2 border-edge rounded-lg px-3 py-2 text-[10px] md:text-xs font-black text-ink-2 normal-case"
        >
          {t('hindsight.periodSkipped', { reason: period.switchRow.skipped })}
        </div>
      ) : (
        <div className="mt-2 md:mt-3 bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
          <div className="text-ink-4 text-[8px] uppercase">{t('hindsight.rowPlan')}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <PlanChip period={period} />
          </div>
          {statesMoney && !unknown && period.switchRow.modeled && (
            <div className="mt-1 text-[9px] md:text-[10px] font-bold text-ink-4 normal-case">
              {t('hindsight.planBasis', {
                paid: money(period.switchRow.actual),
                plan: planLabel(plan),
              })}
            </div>
          )}
        </div>
      )}

      {period.planReason && period.planVerdict !== 'skipped' && (
        <div className="mt-1 text-[9px] md:text-[10px] font-bold text-ink-4 normal-case">
          {period.planReason}
        </div>
      )}
    </div>
  );
}

export function HindsightPanel({ summaries, allData }: Props) {
  const { t } = useTranslation();
  const [timeline] = usePlanTimeline();
  const report = useMemo(
    () => buildHindsight(summaries, allData, timeline),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
    [summaries, allData, timeline, t],
  );

  if (summaries.length === 0) return null;

  const { planMiss, worstPeriod, periods } = report;
  const worstPlan =
    worstPeriod && worstPeriod.planMiss !== null && worstPeriod.planMiss > 0 && worstPeriod.plan !== 'unknown'
      ? worstPeriod
      : null;

  return (
    <section
      data-testid="hindsight-panel"
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 md:shadow-hard-16 text-ink font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4">
            {t('hindsight.eyebrow')}
          </div>
          <h2 className="text-2xl md:text-4xl italic font-black">{t('hindsight.title')}</h2>
        </div>
        <div className="text-[10px] md:text-xs font-bold text-ink-3 normal-case max-w-md">
          {t('hindsight.blurb')}
        </div>
      </div>

      {/* ---- the headline: the plan, on the same readings ---------------- */}
      <div
        data-testid="hindsight-headline"
        className="mt-4 md:mt-6 bg-inv text-inv-ink border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6"
      >
        {planMiss === null ? (
          <div data-testid="hindsight-empty" className="text-[11px] md:text-sm font-black">
            {t('hindsight.headlineEmpty', {
              total: periods.length,
              coverage: 90,
            })}
          </div>
        ) : (
          <>
            <div data-testid="hindsight-plan-total-card">
              <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-inv-ink-2">
                {planMiss < 0 ? t('hindsight.planLeverSaved') : t('hindsight.planLever')}
              </div>
              <div
                data-testid="hindsight-plan-total"
                className="text-3xl md:text-5xl italic font-black text-accent-yellow"
              >
                <Money value={planMiss} />
              </div>
            </div>
            {/* The clamp that used to decide this copy is gone (t_97f4c904): on a
                net SAVING the subtitle used to interpolate `Math.max(0, planMiss)`
                and printed "cost you $0.00 more" under the headline "the
                alternatives would have cost more". The sign picks the sentence;
                the magnitude is the headline's own, read without a clamp. */}
            <div
              data-testid="hindsight-headline-note"
              className="mt-2 md:mt-3 text-[10px] md:text-xs font-black normal-case"
            >
              {planMiss < 0
                ? t('hindsight.headlineNoteSaved', { plan: money(-planMiss) })
                : t('hindsight.headlineNote', { plan: money(planMiss) })}
            </div>
            <div className="mt-1 text-[9px] md:text-[10px] font-bold text-ink-4 normal-case">
              {t('hindsight.totalNote')}
            </div>
          </>
        )}
      </div>

      {/* ---- biggest hindsight loss -------------------------------------- */}
      {worstPlan && (
        <div
          data-testid={`hindsight-worst-${worstPlan.summary.startDate}`}
          className="mt-3 md:mt-4 border-4 border-edge rounded-xl md:rounded-2xl bg-accent-soft p-3 md:p-4"
        >
          <div className="text-[8px] uppercase text-ink-4">
            {t('hindsight.worstPeriod', { label: worstPlan.label })}
          </div>
          <div className="text-xl md:text-3xl italic font-black">{money(worstPlan.planMiss ?? 0)}</div>
          <div className="text-[9px] md:text-[10px] font-bold normal-case text-ink-2">
            {t('hindsight.worstBasis', {
              paid: money(worstPlan.switchRow.actual),
              plan: planLabel(worstPlan.plan === 'unknown' ? 'TOU' : worstPlan.plan),
            })}
          </div>
        </div>
      )}

      {/* ---- per-period rows, worst first -------------------------------- */}
      <div className="mt-4 md:mt-6 space-y-3 md:space-y-4">
        {periods.map((period) => (
          <Row key={period.summary.start} period={period} />
        ))}
      </div>

      <div className="mt-4 md:mt-6 border-t-4 border-edge pt-3 md:pt-4 text-[10px] md:text-xs font-bold text-ink-3 normal-case space-y-1">
        <p>{t('hindsight.legendScope')}</p>
        <p>{t('hindsight.legendPlanSide')}</p>
        <p>
          {t('hindsight.legendMeta', {
            periods: periods.length,
            plan: report.planPeriods,
            kwh: fmtNumber(report.auditedKwh, 1),
          })}
        </p>
      </div>
    </section>
  );
}

export default HindsightPanel;
