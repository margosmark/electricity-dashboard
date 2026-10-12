/**
 * Wave P slice 4 — the switch-decision track record.
 *
 * The app's pitch used to be forward-looking: "the best choice is X" over
 * whatever window is on screen. This panel is the other direction — an
 * AUDIT. Per billing period: what you actually paid (the bill's own payable
 * total), what the same readings would have cost on each alternative plan
 * (modeled, always labelled modeled), and the delta. Aggregated: what
 * staying on your plan has actually cost across every period we could
 * model honestly.
 *
 * Honesty rules baked into the rows:
 *  - a period whose readings cover <90% of the bill window shows the skip
 *    reason instead of a number;
 *  - a period whose plan type is known neither by the bill nor by you shows
 *    "unknown" and is excluded from the total — no saving is invented;
 *  - every row carries the model's own error bar (re-pricing the plan you
 *    WERE on should land back on the bill; when it does not, we say so).
 */

"use client";

import { useMemo } from 'react';

import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import {
  MODEL_TRUST_TOLERANCE,
  buildSwitchReport,
  type PlanType,
  type SwitchPeriodRow,
} from '@/lib/planTimeline';
import { PERIOD_MIN_COVERAGE, summaryStatesMoney, type ProcessedPoint, type UsageSummary } from '@/lib/energy';
import { fmtMoney, planLabel, useTranslation } from '@/i18n';

type Props = {
  /** Bill periods parsed out of the imported file (Wave L parser). */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the chart window. */
  allData: ProcessedPoint[];
};

const money = (n: number) => (n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n));

/** Which plans this row shows as alternatives (both non-actual, or all 3). */
function alternativePlans(row: SwitchPeriodRow): PlanType[] {
  const all: PlanType[] = ['TOU', 'Tiered', 'ULO'];
  return row.plan === 'unknown' ? all : all.filter((p) => p !== row.plan);
}

function Row({ row }: { row: SwitchPeriodRow }) {
  const { t } = useTranslation();
  const unknown = row.plan === 'unknown';
  // Captured: the narrowing from `modeled && …` does not survive into the
  // map callback below otherwise.
  const modeled = row.modeled;
  /**
   * A bill that states no charge lines sums to $0.00 without anybody quoting
   * it — the same shape the money chart hit as an unbilled row under a
   * "You paid" header. No money stated, no payment claimed.
   */
  const statesMoney = summaryStatesMoney(row.summary);
  return (
    <div
      data-testid={`switch-row-${row.summary.startDate}`}
      data-plan={row.plan}
      data-origin={row.origin}
      className="border-4 border-edge rounded-xl md:rounded-2xl bg-card p-4 md:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-black uppercase text-sm md:text-base">{row.label}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span
            data-testid="switch-plan-badge"
            className={`px-2 md:px-3 py-0.5 rounded-full border-2 border-edge text-[9px] md:text-[11px] font-black ${
              unknown ? 'bg-track' : 'bg-yellow-400 text-accent-ink'
            }`}
          >
            {row.plan === 'unknown'
              ? t('track.planUnknown')
              : t('track.onPlan', { plan: planLabel(row.plan).toUpperCase() })}
          </span>
          <span className="px-2 py-0.5 rounded border-2 border-edge text-[8px] md:text-[9px] font-black bg-hover">
            {row.origin === 'detected'
              ? t('track.fromBill')
              : row.origin === 'declared'
                ? t('track.yourEntry')
                : t('track.notInFile')}
          </span>
          {row.conflict && row.detection.plan !== 'unknown' && (
            <span
              data-testid="switch-conflict"
              className="px-2 py-0.5 rounded border-2 border-bad text-[8px] md:text-[9px] font-black text-bad"
            >
              {t('track.conflict')}
            </span>
          )}
        </span>
      </div>

      {row.skipped !== null ? (
        <div
          data-testid="switch-skip"
          className="mt-2 md:mt-3 bg-hover border-2 border-edge rounded-lg px-3 py-2 text-[10px] md:text-xs font-black text-ink-2 normal-case"
        >
          {/* No money stated, no payment asserted: "You paid $0.00" on a bill
              that never quoted a charge is the accrual card's unbilled-row bug
              wearing a period label. */}
          {statesMoney
            ? t('track.notModeled', { reason: row.skipped, amount: money(row.actual) })
            : t('track.notModeledNoMoney', { reason: row.skipped })}
        </div>
      ) : (
        <div className="mt-2 md:mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
          <div className="bg-inset border-2 border-edge rounded-lg p-2 md:p-3">
            <div className="text-ink-4 text-[8px] uppercase">
              {statesMoney ? t('track.youPaid') : t('track.noAmountInFile')}
            </div>
            <div className="italic text-base md:text-lg" data-testid="switch-actual">
              {statesMoney ? money(row.actual) : '—'}
            </div>
          </div>

          {modeled &&
            alternativePlans(row).map((plan) => (
              <div
                key={plan}
                data-testid={`switch-modeled-${plan}`}
                className={`border-2 border-edge rounded-lg p-2 md:p-3 ${
                  row.bestPlan === plan ? 'bg-good-soft' : 'bg-card'
                }`}
              >
                <div className="text-ink-4 text-[8px] uppercase">
                  {planLabel(plan)} · <span className="text-info">{t('track.modeled')}</span>
                </div>
                <div className="italic text-base md:text-lg">{money(modeled[plan])}</div>
              </div>
            ))}

          {modeled && (
            <div
              className={`border-2 border-edge rounded-lg p-2 md:p-3 ${
                (row.saving ?? 0) > 0 ? 'bg-good-soft-2' : 'bg-inset'
              }`}
            >
              <div className="text-ink-4 text-[8px] uppercase">
                {unknown ? t('track.saving') : t('track.bestSaving')}
              </div>
              <div className="italic text-base md:text-lg" data-testid="switch-saving">
                {row.saving === null ? '—' : money(row.saving)}
              </div>
              {!unknown && row.bestPlan && (
                <div className="text-[8px] text-ink-4 font-bold">{t('track.vs', { plan: planLabel(row.bestPlan) })}</div>
              )}
            </div>
          )}
        </div>
      )}

      {unknown && modeled && (
        <div className="mt-2 text-[10px] md:text-xs font-bold text-ink-3 normal-case">
          {t('track.unknownNote')}
        </div>
      )}

      {row.modelDelta !== null && (
        <div
          data-testid="switch-model-check"
          className={`mt-2 inline-block px-2 py-1 rounded border-2 text-[9px] md:text-[10px] font-black ${
            Math.abs(row.modelDelta) <= MODEL_TRUST_TOLERANCE
              ? 'border-good bg-good-soft text-good'
              : 'border-warn bg-warn-soft text-warn'
          }`}
        >
          {Math.abs(row.modelDelta) <= MODEL_TRUST_TOLERANCE
            ? t('track.modelOk', { amount: money(Math.abs(row.modelDelta)) })
            : t('track.modelOff', { delta: money(row.modelDelta), reason: row.excluded ?? '' })}
        </div>
      )}
    </div>
  );
}

export function SwitchTrackRecord({ summaries, allData }: Props) {
  const { t } = useTranslation();
  const [timeline] = usePlanTimeline();
  const report = useMemo(
    () => buildSwitchReport(summaries, allData, timeline),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
    [summaries, allData, timeline, t],
  );

  if (summaries.length === 0) return null;

  const { overpaid, byPlan, counted, untrusted, known, skipped, callouts, rows } = report;
  const unknownPlan = rows.length - known;

  return (
    <section
      data-testid="switch-track-record"
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 md:shadow-hard-16 text-ink font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4">
            {t('track.eyebrow')}
          </div>
          <h2 className="text-2xl md:text-4xl italic font-black">{t('track.title')}</h2>
        </div>
        <div className="text-[10px] md:text-xs font-bold text-ink-3 normal-case max-w-md">
          {t('track.blurb')}
        </div>
      </div>

      {/* ---- the headline: audited, not predicted ------------------------ */}
      <div className="mt-4 md:mt-6 bg-inv text-inv-ink border-4 border-edge rounded-xl md:rounded-2xl p-4 md:p-6">
        {overpaid === null ? (
          <div data-testid="switch-headline-empty" className="text-[11px] md:text-sm font-black">
            {t('track.headlineEmpty', {
              counted,
              total: rows.length,
              coverage: Math.round(PERIOD_MIN_COVERAGE * 100),
            })}
          </div>
        ) : (
          <>
            <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-accent-yellow">
              {overpaid > 0
                ? byPlan.length === 1 && byPlan[0]
                  ? t('track.overpaidOn', { plan: planLabel(byPlan[0].plan) })
                  : t('track.overpaidCourse')
                : t('track.netSaving')}
            </div>
            <div
              data-testid="switch-overpaid-total"
              className={`text-4xl md:text-6xl italic font-black ${
                overpaid > 0 ? 'text-accent-yellow' : 'text-accent-emerald'
              }`}
            >
              {/* positive = over-paid (what it cost you); negative = the
                  alternatives would have cost MORE, so show the saving as a
                  positive number instead of a confusing minus. */}
              {money(overpaid > 0 ? overpaid : -overpaid)}
            </div>
            <div className="mt-1 text-[10px] md:text-xs font-black" data-testid="switch-headline-sub">
              {t('track.headlineSub', { count: counted, counted, total: rows.length })}
              {untrusted > 0 ? ` · ${t('track.untrustedNote', { count: untrusted })}` : ''}
            </div>
            <ul className="mt-2 md:mt-3 space-y-1" data-testid="switch-by-plan">
              {byPlan.map((g) => (
                <li key={g.plan} className="text-[10px] md:text-xs font-black">
                  {planLabel(g.plan)}: {t('track.byPlanLine', { count: g.periods, periods: g.periods })}{' '}
                  <span className={g.overpaid > 0 ? 'text-accent-yellow' : 'text-accent-emerald'}>
                    {money(g.overpaid > 0 ? g.overpaid : -g.overpaid)}
                  </span>{' '}
                  {g.overpaid > 0 ? t('track.overpaid') : t('track.saved')}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* ---- biggest misses --------------------------------------------- */}
      {callouts.length > 0 && (
        <div className="mt-3 md:mt-4 grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3">
          {callouts.map((c) => (
            <div
              key={c.summary.start}
              data-testid={`switch-callout-${c.summary.startDate}`}
              className="border-2 border-edge rounded-lg bg-accent-soft p-3"
            >
              <div className="text-[8px] uppercase text-ink-4">{t('track.biggestMiss', { label: c.label })}</div>
              <div className="italic font-black text-base md:text-xl">{money(c.saving ?? 0)}</div>
              <div className="text-[9px] font-bold normal-case text-ink-2">
                {c.bestPlan
                  ? t('track.wouldHaveBeen', {
                      amount: money(c.modeled?.[c.bestPlan] ?? 0),
                      plan: planLabel(c.bestPlan),
                    })
                  : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- per-period rows -------------------------------------------- */}
      <div className="mt-4 md:mt-6 space-y-3 md:space-y-4">
        {rows.map((row) => (
          <Row key={row.summary.start} row={row} />
        ))}
      </div>

      {/* ---- what the numbers mean -------------------------------------- */}
      <div className="mt-4 md:mt-6 border-t-4 border-edge pt-3 md:pt-4 text-[10px] md:text-xs font-bold text-ink-3 normal-case space-y-1">
        <p>
          <strong className="font-black">{t('track.legendModeledWord')}</strong>{' '}
          {t('track.legendModeledB')}
        </p>
        <p>
          {t('track.legendMeta', { known, total: rows.length, counted })}
          {unknownPlan > 0 ? ` ${t('track.legendExcluded', { count: unknownPlan })}` : ''}
          {untrusted > 0 ? ` · ${t('track.legendUntrusted', { count: untrusted })}` : ''}
          {skipped > 0 ? ` · ${t('track.legendSkipped', { count: skipped })}` : ''}.
        </p>
      </div>
    </section>
  );
}

export default SwitchTrackRecord;
