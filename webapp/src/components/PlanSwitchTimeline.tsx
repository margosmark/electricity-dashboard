/**
 * Wave R — the switch track record as a timeline, not a table.
 *
 * Wave P's `SwitchTrackRecord` answers "what did each period cost me, and
 * what would the alternatives have cost?" one row at a time. This draws the
 * same report as a horizontal bar: one segment per billing period, tinted
 * with the plan that period was actually on (the same fills the money chart's
 * bands use), a hatched segment for any stretch no bill covers, and a delta
 * bubble at every point where the plan actually changed.
 *
 * Same inputs, same function: `buildSwitchReport` is Wave P's, so the
 * picture and the table beside it can never disagree about a period's plan or
 * its saving. A period whose model could not reproduce its bill keeps its
 * segment and loses its bubble — an untrusted number is not drawn as fact.
 *
 * The bubbles live OUTSIDE the bar: the bar clips to its rounded corners, so
 * an overlay above it would be cut in half. They are anchored to the same
 * flex shares the bar uses, which is why both layers compute one cumulative
 * offset array instead of measuring the DOM.
 */

'use client';

import { useMemo } from 'react';
import { GitBranch } from 'lucide-react';
import { buildSwitchReport } from '@/lib/planTimeline';
import { buildSwitchTimeline, type SwitchTimeline } from '@/lib/switchTimeline';
import { PLAN_BAND_STYLE, UNKNOWN_PLAN_FILL } from '@/lib/planStyles';
import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import type { ProcessedPoint, UsageSummary } from '@/lib/energy';
// Wave U — the timeline's captions translate; the segment PLAN labels stay
// the canonical TOU/TIERED/ULO codes (they are data keys shared with the
// money chart's bands).
import { fmtMoney, useTranslation } from '@/i18n';

export type PlanSwitchTimelineProps = {
  /** Bill periods parsed out of the imported file (Wave L). */
  summaries: UsageSummary[];
  /** Every priced reading — the report models a period from these. */
  allData: ProcessedPoint[];
};

function money(n: number): string {
  return n < 0 ? `-${fmtMoney(Math.abs(n))}` : fmtMoney(n);
}

export function PlanSwitchTimeline({ summaries, allData }: PlanSwitchTimelineProps) {
  const { t } = useTranslation();
  const [timeline] = usePlanTimeline();
  const report = useMemo(
    () => buildSwitchReport(summaries, allData, timeline),
    [summaries, allData, timeline],
  );
  const model: SwitchTimeline = useMemo(() => buildSwitchTimeline(report), [report]);

  // Left edge of each segment, as a share of the whole bar. A fold, not a
  // running variable: this runs during render, and mutating a captured
  // binding across iterations is exactly the shape the compiler refuses to
  // reason about.
  const offsets = useMemo(() => {
    const shares = model.segments.map((segment) => segment.share);
    // lefts[i] = Σ shares of every segment before i — a fold expressed as
    // maps, so nothing captured from a previous pass is mutated during render.
    return shares.map((_, index) => shares.slice(0, index).reduce((sum, share) => sum + share, 0));
  }, [model.segments]);

  if (model.segments.length === 0) {
    return (
      <section
        data-testid="plan-switch-timeline"
        aria-labelledby="switch-timeline-heading"
        className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-dashed border-black text-black"
      >
        <h3 id="switch-timeline-heading" className="text-xl md:text-3xl italic font-black uppercase mb-2">
          {t('switchTimeline.title')}
        </h3>
        <p data-testid="switch-timeline-empty" className="text-[11px] md:text-sm font-bold text-slate-600 normal-case">
          {model.note}
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="plan-switch-timeline"
      aria-labelledby="switch-timeline-heading"
      data-switches={model.switches}
      data-periods={model.segments.length}
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-4 md:mb-6">
        <span aria-hidden className="bg-black text-yellow-400 p-2 md:p-3 rounded-xl border-2 md:border-4 border-black">
          <GitBranch size={22} strokeWidth={4} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-slate-400 font-black uppercase">
            {t('switchTimeline.eyebrow')}
          </div>
          <h3 id="switch-timeline-heading" className="text-xl md:text-3xl italic font-black uppercase text-black">
            {t('switchTimeline.title')}
          </h3>
        </div>
      </div>

      <div className="overflow-x-auto pt-8 pb-2" data-testid="switch-timeline-bar">
        <div className="min-w-[560px]">
          {/* The bar: flex shares, so a 30-day period is genuinely wider than
              a 29-day one and the axis is real time, not equal blocks. */}
          <div className="flex h-14 md:h-16 border-4 border-black rounded-xl overflow-hidden">
            {model.segments.map((segment) => {
              const style = segment.plan === 'unknown' ? null : PLAN_BAND_STYLE[segment.plan];
              const known = style !== null;
              const summary = [
                segment.label,
                known ? style!.label : t('switchTimeline.planUnknown'),
                t('switchTimeline.days', { count: segment.days, days: segment.days }),
                segment.saving !== null ? t('switchTimeline.saving', { amount: money(segment.saving) }) : null,
                segment.reason,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <div
                  key={segment.key}
                  data-testid={`switch-segment-${segment.start}`}
                  data-plan={segment.plan}
                  data-switch={String(segment.isSwitch)}
                  data-counted={String(segment.counted)}
                  title={summary}
                  style={{
                    flexGrow: segment.share,
                    flexBasis: 0,
                    background: style
                      ? style!.fill
                      : `repeating-linear-gradient(45deg, ${UNKNOWN_PLAN_FILL} 0 8px, #cbd5e1 8px 16px)`,
                  }}
                  className="relative min-w-0 border-r-2 border-black last:border-r-0 flex items-center justify-center"
                >
                  <span className="text-[9px] md:text-[11px] font-black uppercase truncate px-1">
                    {style ? style.label : '?'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Boundary layer: the tick and the delta bubble for each switch,
              both anchored to the cumulative share of the segments above. */}
          <div className="relative h-10">
            {model.segments.map((segment, index) => {
              if (index === 0) return null;
              return (
                <div
                  key={`boundary-${segment.key}`}
                  className="absolute top-0"
                  style={{ left: `${offsets[index] * 100}%` }}
                >
                  {segment.isSwitch && (
                    <span
                      data-testid={`switch-tick-${segment.start}`}
                      className="absolute left-0 top-0 -translate-x-1/2 block w-0.5 h-4 bg-black"
                    />
                  )}
                  {segment.isSwitch && segment.saving !== null && (
                    <span
                      data-testid={`switch-bubble-${segment.start}`}
                      data-counted={String(segment.counted)}
                      className={`absolute left-0 top-3 -translate-x-1/2 whitespace-nowrap px-2 py-1 rounded-lg border-2 border-black text-[8px] md:text-[10px] font-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ${
                        segment.counted ? 'bg-yellow-400 text-black' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {money(segment.saving)}
                      {!segment.counted && ` ${t('switchTimeline.untrusted')}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend + the sentence the picture is making. */}
      <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-3">
        {(['TOU', 'Tiered', 'ULO'] as const).map((plan) => (
          <span
            key={plan}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border-2 border-black text-[9px] md:text-[10px] font-black uppercase"
            style={{ background: PLAN_BAND_STYLE[plan].fill }}
          >
            <span className="w-3 h-3 border-2 border-black" style={{ background: PLAN_BAND_STYLE[plan].fill }} />
            {PLAN_BAND_STYLE[plan].label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border-2 border-black text-[9px] md:text-[10px] font-black uppercase bg-slate-100">
          <span
            className="w-3 h-3 border-2 border-black"
            style={{ background: `repeating-linear-gradient(45deg, ${UNKNOWN_PLAN_FILL} 0 4px, #cbd5e1 4px 8px)` }}
          />
          {t('switchTimeline.noBill')}
        </span>
      </div>

      <p data-testid="switch-timeline-note" className="text-[10px] md:text-xs font-bold text-slate-600 normal-case">
        {model.note} {t('switchTimeline.footnote')}
      </p>
    </section>
  );
}

export default PlanSwitchTimeline;
