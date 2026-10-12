/**
 * Wave V — the HINDSIGHT panel: what SHOULD have happened, per closed bill.
 *
 * Two verdicts per period, one row each, worst-first:
 *
 *  - PLAN — Wave P's audited alternative: "would have saved $X on Tiered".
 *    The modeled figures come straight off the switch row; this panel does
 *    not re-price anything.
 *  - BEHAVIOUR — the counterfactual the meter can support: the recurring
 *    block that ran in an expensive window and could have run in the plan's
 *    own cheap window instead. Always worded as IF, never as advice.
 *
 * The three headline numbers are plan-miss, behaviour-miss and their sum.
 * The two levers are disjoint and are never merged into a single
 * "you could have saved" claim — the sum is labelled as the sum of two.
 */

'use client';

import { useMemo } from 'react';

import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import { buildHindsight, type HindsightMove, type HindsightPeriod } from '@/lib/hindsight';
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

/** The per-block move list inside one period row. */
function MoveList({ period }: { period: HindsightPeriod }) {
  const { t } = useTranslation();
  return (
    <details
      data-testid={`hindsight-moves-${period.summary.startDate}`}
      className="mt-2 md:mt-3 border-2 border-edge rounded-lg bg-inset"
    >
      <summary className="cursor-pointer px-3 py-2 text-[10px] md:text-xs font-black uppercase">
        {t('hindsight.movesSummary', { count: period.moves.length, moves: period.moves.length })}
      </summary>
      <ul className="px-3 pb-3 space-y-2">
        {period.moves.map((move: HindsightMove) => (
          <li
            key={move.id}
            data-testid={`hindsight-move-${move.id}`}
            className="border-t-2 border-edge pt-2 text-[10px] md:text-xs normal-case"
          >
            <div className="font-black uppercase text-ink-2">
              {t('hindsight.moveIf', { block: move.label, window: move.destination.label })}
            </div>
            <div className="mt-0.5 grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-0.5 font-bold text-ink-3">
              <span>{fmtKwh(move.kwh)}</span>
              <span>{t('hindsight.movePaid', { cents: fmtNumber(move.actualRateCents, 1) })}</span>
              <span>{t('hindsight.moveWouldPay', { cents: fmtNumber(move.destRateCents, 1) })}</span>
              <span className="font-black text-good">{t('hindsight.moveSaved', { amount: money(move.saving) })}</span>
            </div>
            <div className="text-[9px] md:text-[10px] font-bold text-ink-4">
              {t('hindsight.moveEvidence', {
                weeks: move.weeksSeen,
                of: move.weeksAvailable,
                cv: `${Math.round(move.consistencyCv * 100)}%`,
                confidence: move.confidence.label,
              })}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The "nothing claimed" / "not priced" reason chips (PlanChip's skipped and
 * unknown, BehaviourChip's three) all ride `bg-track` — a THEMED surface — so
 * their ink must be a themed step that clears AA on it: `--ink-3` measured
 * 3.86:1 in light and 4.04:1 in dark on `--track` (10px, 4.5 floor), and
 * `--ink-2` is 6.15 / 6.97. Fixed here under t_3e571ddb, whose dark walk
 * asserts an EMPTY contrast ledger (the row could not be pinned, and the
 * ledger may only shrink) — it is not part of the colour call, which never
 * measured `--track`.
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

function BehaviourChip({ period }: { period: HindsightPeriod }) {
  const { t } = useTranslation();
  const move = period.topMove;
  if (period.behaviourVerdict === 'moveable' && move) {
    return (
      <span
        data-testid="hindsight-behaviour-chip"
        className="px-2 py-1 rounded border-2 border-good bg-good-soft text-good text-[9px] md:text-[10px] font-black"
      >
        {t('hindsight.behaviourChipMoveable', {
          amount: money(period.behaviourMiss ?? 0),
          block: move.label,
        })}
      </span>
    );
  }
  if (period.behaviourVerdict === 'flat-rate') {
    return (
      <span
        data-testid="hindsight-behaviour-chip"
        className="px-2 py-1 rounded border-2 border-edge bg-track text-ink-2 text-[9px] md:text-[10px] font-black"
      >
        {t('hindsight.behaviourChipFlat')}
      </span>
    );
  }
  if (period.behaviourVerdict === 'nothing-to-shift') {
    return (
      <span
        data-testid="hindsight-behaviour-chip"
        className="px-2 py-1 rounded border-2 border-edge bg-track text-ink-2 text-[9px] md:text-[10px] font-black"
      >
        {t('hindsight.behaviourChipNothing')}
      </span>
    );
  }
  return (
    <span
      data-testid="hindsight-behaviour-chip"
      className="px-2 py-1 rounded border-2 border-edge bg-track text-ink-2 text-[9px] md:text-[10px] font-black"
    >
      {t('hindsight.behaviourChipUnknown')}
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
              unknown ? 'bg-track' : 'bg-yellow-400 text-accent-ink'
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
        <div className="mt-2 md:mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-3">
          <div className="bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
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

          <div className="bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
            <div className="text-ink-4 text-[8px] uppercase">{t('hindsight.rowBehaviour')}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <BehaviourChip period={period} />
            </div>
            {period.behaviourReason && (
              <div className="mt-1 text-[9px] md:text-[10px] font-bold text-ink-4 normal-case">
                {period.behaviourReason}
              </div>
            )}
          </div>
        </div>
      )}

      {period.planReason && period.planVerdict !== 'skipped' && (
        <div className="mt-1 text-[9px] md:text-[10px] font-bold text-ink-4 normal-case">
          {period.planReason}
        </div>
      )}

      {period.moves.length > 0 && <MoveList period={period} />}
    </div>
  );
}

export function HindsightPanel({ summaries, allData }: Props) {
  const { t } = useTranslation();
  const [timeline] = usePlanTimeline();
  const report = useMemo(
    () => buildHindsight(summaries, allData, timeline),
    [summaries, allData, timeline],
  );

  if (summaries.length === 0) return null;

  const { planMiss, behaviourMiss, totalMiss, leverNote, worstPeriod, periods } = report;

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

      {/* ---- the headline: two levers, one sum ---------------------------- */}
      <div
        data-testid="hindsight-headline"
        className="mt-4 md:mt-6 bg-inv text-inv-ink border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6"
      >
        {totalMiss === null ? (
          <div data-testid="hindsight-empty" className="text-[11px] md:text-sm font-black">
            {t('hindsight.headlineEmpty', {
              total: periods.length,
              coverage: 90,
            })}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              <div data-testid="hindsight-plan-total-card">
                <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-inv-ink-2">
                  {planMiss !== null && planMiss < 0
                    ? t('hindsight.planLeverSaved')
                    : t('hindsight.planLever')}
                </div>
                <div
                  data-testid="hindsight-plan-total"
                  className="text-3xl md:text-5xl italic font-black text-accent-yellow"
                >
                  <Money value={planMiss} />
                </div>
              </div>
              <div data-testid="hindsight-behaviour-total-card">
                <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-inv-ink-2">
                  {t('hindsight.behaviourLever')}
                </div>
                <div
                  data-testid="hindsight-behaviour-total"
                  className="text-3xl md:text-5xl italic font-black text-accent-emerald"
                >
                  <Money value={behaviourMiss} />
                </div>
              </div>
              <div data-testid="hindsight-total-card">
                <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-inv-ink-2">
                  {t('hindsight.totalLever')}
                </div>
                <div data-testid="hindsight-total" className="text-3xl md:text-5xl italic font-black">
                  <Money value={totalMiss} />
                </div>
              </div>
            </div>
            <div data-testid="hindsight-lever" className="mt-2 md:mt-3 text-[10px] md:text-xs font-black normal-case">
              {leverNote}
            </div>
            <div className="mt-1 text-[9px] md:text-[10px] font-bold text-ink-4 normal-case">
              {t('hindsight.totalNote')}
            </div>
          </>
        )}
      </div>

      {/* ---- biggest hindsight loss -------------------------------------- */}
      {worstPeriod && worstPeriod.missTotal > 0 && (
        <div
          data-testid={`hindsight-worst-${worstPeriod.summary.startDate}`}
          className="mt-3 md:mt-4 border-4 border-edge rounded-xl md:rounded-2xl bg-accent-soft p-3 md:p-4"
        >
          <div className="text-[8px] uppercase text-ink-4">
            {t('hindsight.worstPeriod', { label: worstPeriod.label })}
          </div>
          <div className="text-xl md:text-3xl italic font-black">{money(worstPeriod.missTotal)}</div>
          <div className="text-[9px] md:text-[10px] font-bold normal-case text-ink-2">
            {t('hindsight.worstSplit', {
              plan: money(worstPeriod.planMiss ?? 0),
              behaviour: money(worstPeriod.behaviourMiss ?? 0),
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
        <p>{t('hindsight.legendCounterfactual')}</p>
        <p>{t('hindsight.legendPlanSide')}</p>
        <p>
          {t('hindsight.legendMeta', {
            periods: periods.length,
            plan: report.planPeriods,
            behaviour: report.behaviourPeriods,
            kwh: fmtNumber(report.shiftableKwh, 1),
          })}
        </p>
      </div>
    </section>
  );
}

export default HindsightPanel;
