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

import { PLAN_LABEL } from '@/hooks/useSelectedPlan';
import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import {
  buildSwitchReport,
  type PlanType,
  type SwitchPeriodRow,
} from '@/lib/planTimeline';
import { PERIOD_MIN_COVERAGE, type ProcessedPoint, type UsageSummary } from '@/lib/energy';

type Props = {
  /** Bill periods parsed out of the imported file (Wave L parser). */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the chart window. */
  allData: ProcessedPoint[];
};

const money = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);

/** Which plans this row shows as alternatives (both non-actual, or all 3). */
function alternativePlans(row: SwitchPeriodRow): PlanType[] {
  const all: PlanType[] = ['TOU', 'Tiered', 'ULO'];
  return row.plan === 'unknown' ? all : all.filter((p) => p !== row.plan);
}

function Row({ row }: { row: SwitchPeriodRow }) {
  const unknown = row.plan === 'unknown';
  // Captured: the narrowing from `modeled && …` does not survive into the
  // map callback below otherwise.
  const modeled = row.modeled;
  return (
    <div
      data-testid={`switch-row-${row.summary.startDate}`}
      data-plan={row.plan}
      data-origin={row.origin}
      className="border-4 border-black rounded-xl md:rounded-2xl bg-white p-4 md:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-black uppercase text-sm md:text-base">{row.label}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span
            data-testid="switch-plan-badge"
            className={`px-2 md:px-3 py-0.5 rounded-full border-2 border-black text-[9px] md:text-[11px] font-black ${
              unknown ? 'bg-slate-200' : 'bg-yellow-400'
            }`}
          >
            {row.plan === 'unknown' ? 'PLAN UNKNOWN' : `ON ${PLAN_LABEL[row.plan].toUpperCase()}`}
          </span>
          <span className="px-2 py-0.5 rounded border-2 border-black text-[8px] md:text-[9px] font-black bg-slate-100">
            {row.origin === 'detected'
              ? 'FROM BILL LINES'
              : row.origin === 'declared'
                ? 'YOUR ENTRY'
                : 'NOT IN FILE'}
          </span>
          {row.conflict && row.detection.plan !== 'unknown' && (
            <span
              data-testid="switch-conflict"
              className="px-2 py-0.5 rounded border-2 border-red-600 text-[8px] md:text-[9px] font-black text-red-700"
            >
              YOUR ENTRY DISAGREES — BILL WINS
            </span>
          )}
        </span>
      </div>

      {row.skipped !== null ? (
        <div
          data-testid="switch-skip"
          className="mt-2 md:mt-3 bg-slate-100 border-2 border-black rounded-lg px-3 py-2 text-[10px] md:text-xs font-black text-slate-600 normal-case"
        >
          Not modeled — {row.skipped}. You paid {money(row.actual)}.
        </div>
      ) : (
        <div className="mt-2 md:mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
          <div className="bg-slate-50 border-2 border-black rounded-lg p-2 md:p-3">
            <div className="text-slate-400 text-[8px] uppercase">You paid</div>
            <div className="italic text-base md:text-lg" data-testid="switch-actual">
              {money(row.actual)}
            </div>
          </div>

          {modeled &&
            alternativePlans(row).map((plan) => (
              <div
                key={plan}
                data-testid={`switch-modeled-${plan}`}
                className={`border-2 border-black rounded-lg p-2 md:p-3 ${
                  row.bestPlan === plan ? 'bg-emerald-50' : 'bg-white'
                }`}
              >
                <div className="text-slate-400 text-[8px] uppercase">
                  {PLAN_LABEL[plan]} · <span className="text-blue-600">modeled</span>
                </div>
                <div className="italic text-base md:text-lg">{money(modeled[plan])}</div>
              </div>
            ))}

          {modeled && (
            <div
              className={`border-2 border-black rounded-lg p-2 md:p-3 ${
                (row.saving ?? 0) > 0 ? 'bg-emerald-100' : 'bg-slate-50'
              }`}
            >
              <div className="text-slate-400 text-[8px] uppercase">
                {unknown ? 'Saving' : 'Best saving'}
              </div>
              <div className="italic text-base md:text-lg" data-testid="switch-saving">
                {row.saving === null ? '—' : money(row.saving)}
              </div>
              {!unknown && row.bestPlan && (
                <div className="text-[8px] text-slate-400 font-bold">vs {PLAN_LABEL[row.bestPlan]}</div>
              )}
            </div>
          )}
        </div>
      )}

      {unknown && modeled && (
        <div className="mt-2 text-[10px] md:text-xs font-bold text-slate-500 normal-case">
          No plan is known for this period, so no saving is claimed — the numbers above are what
          each plan WOULD have cost. Declare the period in the timeline above to count it.
        </div>
      )}

      {row.modelDelta !== null && (
        <div
          data-testid="switch-model-check"
          className={`mt-2 inline-block px-2 py-1 rounded border-2 text-[9px] md:text-[10px] font-black ${
            Math.abs(row.modelDelta) <= 1
              ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
              : 'border-amber-600 bg-amber-50 text-amber-800'
          }`}
        >
          {Math.abs(row.modelDelta) <= 1
            ? `Model check ✓ — re-pricing your plan lands back on this bill within ${money(Math.abs(row.modelDelta))}`
            : `Model check Δ ${money(row.modelDelta)} — the reconstruction misses this bill, treat the modeled figures as approximate`}
        </div>
      )}
    </div>
  );
}

export function SwitchTrackRecord({ summaries, allData }: Props) {
  const [timeline] = usePlanTimeline();
  const report = useMemo(
    () => buildSwitchReport(summaries, allData, timeline),
    [summaries, allData, timeline],
  );

  if (summaries.length === 0) return null;

  const { overpaid, byPlan, modeled, known, skipped, callouts, rows } = report;
  const excluded = rows.length - known;

  return (
    <section
      data-testid="switch-track-record"
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
            Audited history · not a forecast
          </div>
          <h2 className="text-2xl md:text-4xl italic font-black">Switch track record</h2>
        </div>
        <div className="text-[10px] md:text-xs font-bold text-slate-500 normal-case max-w-md">
          Period by period: what you actually paid, what the same readings would have cost on each
          other plan, and what staying put has cost over the whole file.
        </div>
      </div>

      {/* ---- the headline: audited, not predicted ------------------------ */}
      <div className="mt-4 md:mt-6 bg-black text-white border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6">
        {overpaid === null ? (
          <div data-testid="switch-headline-empty" className="text-[11px] md:text-sm font-black">
            Not enough covered periods to audit yet — {modeled} of {rows.length} periods have both
            a known plan type and {Math.round(PERIOD_MIN_COVERAGE * 100)}% readings coverage.
          </div>
        ) : (
          <>
            <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-yellow-400">
              {overpaid > 0
                ? byPlan.length === 1 && byPlan[0]
                  ? `Over-paid by staying on ${PLAN_LABEL[byPlan[0].plan]}`
                  : 'Over-paid by staying the course'
                : 'Held the cheapest plan — net saving'}
            </div>
            <div
              data-testid="switch-overpaid-total"
              className={`text-4xl md:text-6xl italic font-black ${
                overpaid > 0 ? 'text-yellow-400' : 'text-emerald-400'
              }`}
            >
              {money(overpaid)}
            </div>
            <div className="mt-1 text-[10px] md:text-xs font-black" data-testid="switch-headline-sub">
              across {modeled} modeled period{modeled === 1 ? '' : 's'} of {rows.length} in this
              file
            </div>
            <ul className="mt-2 md:mt-3 space-y-1" data-testid="switch-by-plan">
              {byPlan.map((g) => (
                <li key={g.plan} className="text-[10px] md:text-xs font-black">
                  {PLAN_LABEL[g.plan]}: {g.periods} period{g.periods === 1 ? '' : 's'} ·{' '}
                  <span className={g.overpaid > 0 ? 'text-yellow-400' : 'text-emerald-400'}>
                    {money(g.overpaid)}
                  </span>{' '}
                  {g.overpaid > 0 ? 'over-paid' : 'saved'}
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
              className="border-2 border-black rounded-lg bg-yellow-50 p-3"
            >
              <div className="text-[8px] uppercase text-slate-400">Biggest miss · {c.label}</div>
              <div className="italic font-black text-base md:text-xl">{money(c.saving ?? 0)}</div>
              <div className="text-[9px] font-bold normal-case text-slate-600">
                {c.bestPlan ? `would have been ${money(c.modeled?.[c.bestPlan] ?? 0)} on ${PLAN_LABEL[c.bestPlan]} (modeled)` : ''}
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
      <div className="mt-4 md:mt-6 border-t-4 border-black pt-3 md:pt-4 text-[10px] md:text-xs font-bold text-slate-500 normal-case space-y-1">
        <p>
          <strong className="font-black">Modeled</strong> = your own interval readings repriced with
          the OEB rate set in force during that period; delivery, regulatory, HST and the Ontario
          Electricity Rebate are held and scaled exactly as your bill states them — only the
          commodity moves with the plan.
        </p>
        <p>
          {known} of {rows.length} periods have a known plan type
          {excluded > 0 ? ` (${excluded} excluded from the total — declare them above)` : ''}
          {skipped > 0 ? ` · ${skipped} skipped for low readings coverage` : ''}.
        </p>
      </div>
    </section>
  );
}

export default SwitchTrackRecord;
