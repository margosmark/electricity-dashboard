/**
 * Wave P slice 2 — the user-editable plan timeline.
 *
 * Two halves in one surface:
 *
 *  • the DETECTED strip — every billing period in the imported file, the plan
 *    its own charge lines fingerprint (or an honest "unknown" with the lines
 *    we did recognize), plus the utility's verbatim notes as evidence;
 *  • YOUR ENTRIES — "I was on {plan} from {date} to {date}" for the periods
 *    no export can speak for (wording we don't recognize, ranges outside the
 *    file). Stored next to `billing_day`, so a backup carries them too.
 *
 * A confident detection always wins over a declaration — the bill is
 * evidence, the declaration is memory — and when they disagree the row says
 * so instead of quietly picking one.
 */

"use client";

import { useMemo, useState } from 'react';

import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import { planLabel, useTranslation } from '@/i18n';
import {
  PLAN_TYPES,
  assignPeriodPlan,
  detectPlanType,
  type PeriodPlan,
  type PlanType,
} from '@/lib/planTimeline';
import { billPeriodLabel, type UsageSummary } from '@/lib/energy';

type Props = {
  /** Bill periods parsed out of the imported file (Wave L parser). */
  summaries: UsageSummary[];
};

/**
 * Wave U — origin captions are catalog keys (the map stays a lookup so the
 * style/label pairs cannot drift apart).
 */
const ORIGIN_KEY: Record<PeriodPlan['origin'], string> = {
  detected: 'timeline.originDetected',
  declared: 'timeline.originDeclared',
  unknown: 'timeline.originUnknown',
};

const ORIGIN_STYLE: Record<PeriodPlan['origin'], string> = {
  detected: 'bg-yellow-400 text-accent-ink',
  declared: 'bg-blue-200 text-accent-ink',
  unknown: 'bg-track',
};

const FIELD_CLASS =
  'min-h-11 p-2 md:p-2.5 border-2 border-edge rounded-lg bg-inset ' +
  'font-black text-sm md:text-xs text-ink outline-none focus:bg-accent-soft';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function PlanTimelineEditor({ summaries }: Props) {
  const { t } = useTranslation();
  const [entries, { add, update, remove }] = usePlanTimeline();
  const [error, setError] = useState<string | null>(null);

  const periods = useMemo(
    () =>
      summaries.map((summary) => {
        const detection = detectPlanType(summary.items);
        return {
          summary,
          detection,
          assignment: assignPeriodPlan(detection, entries, {
            start: summary.startDate,
            end: summary.endDate,
          }),
        };
      }),
    [summaries, entries],
  );

  // No bills and nothing declared: this surface has nothing to say yet.
  if (summaries.length === 0 && entries.length === 0) return null;

  const patch = (id: string, next: Parameters<typeof update>[1]) => {
    if (update(id, next)) setError(null);
    else setError(t('timeline.errorInvalid'));
  };

  return (
    <section
      data-testid="plan-timeline"
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 md:shadow-hard-16 text-ink font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4">
            {t('timeline.eyebrow')}
          </div>
          <h2 className="text-2xl md:text-4xl italic font-black">{t('timeline.title')}</h2>
        </div>
        <div className="text-[10px] md:text-xs font-bold text-ink-3 normal-case max-w-md">
          {t('timeline.blurb')}
        </div>
      </div>

      {/* ---- detected periods ------------------------------------------ */}
      {periods.length > 0 && (
        <ul className="mt-4 md:mt-6 space-y-2 md:space-y-3" data-testid="plan-timeline-periods">
          {periods.map(({ summary, detection, assignment }) => (
            <li
              key={summary.start}
              data-testid={`plan-timeline-period-${summary.startDate}`}
              data-plan={assignment.plan}
              data-origin={assignment.origin}
              className="border-2 border-edge rounded-lg md:rounded-xl bg-inset px-3 py-2 md:px-4 md:py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="font-black text-xs md:text-sm">
                  {billPeriodLabel(summary.start, summary.duration)}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    data-testid="plan-timeline-plan-badge"
                    className="px-2 md:px-3 py-0.5 rounded-full border-2 border-edge text-[9px] md:text-[11px] font-black"
                  >
                    {assignment.plan === 'unknown'
                      ? t('timeline.originUnknown')
                      : planLabel(assignment.plan)}
                  </span>
                  <span
                    data-testid="plan-timeline-origin"
                    className={`px-2 py-0.5 rounded border-2 border-edge text-[8px] md:text-[9px] font-black ${ORIGIN_STYLE[assignment.origin]}`}
                  >
                    {t(ORIGIN_KEY[assignment.origin])}
                  </span>
                </span>
              </div>

              {detection.evidence.length > 0 && (
                <div
                  data-testid="plan-timeline-evidence"
                  className="mt-1 text-[9px] md:text-[10px] text-ink-3 font-bold normal-case"
                >
                  {t('timeline.evidence')}{' '}
                  {detection.evidence.slice(0, 3).join(' · ')}
                  {detection.evidence.length > 3 ? ` · ${t('timeline.evidenceMore', { count: detection.evidence.length - 3 })}` : ''}
                </div>
              )}
              {assignment.origin === 'unknown' && (
                <div className="mt-1 text-[9px] md:text-[10px] text-ink-3 font-bold normal-case">
                  {t('timeline.noGuess', { reason: detection.reason ?? '' })}
                </div>
              )}
              {assignment.conflict && assignment.declared && (
                <div
                  data-testid="plan-timeline-conflict"
                  className="mt-1 text-[9px] md:text-[10px] font-bold normal-case text-bad"
                >
                  {t('timeline.conflict', {
                    declared: planLabel(assignment.declared.plan),
                    detected: planLabel(detection.plan as PlanType),
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ---- the user's own entries ------------------------------------- */}
      <div className="mt-6 md:mt-8 border-t-4 border-edge pt-4 md:pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg md:text-2xl italic font-black">{t('timeline.yourEntries')}</h3>
          <button
            type="button"
            data-testid="plan-timeline-add"
            onClick={() => {
              const day = todayIso();
              if (add({ plan: 'TOU', from: day, to: day })) setError(null);
              else setError(t('timeline.errorAdd'));
            }}
            className="min-h-11 px-4 md:px-6 py-2 bg-yellow-400 text-accent-ink border-2 border-edge rounded-lg font-black text-[10px] md:text-xs uppercase hover:bg-yellow-300 active:bg-accent-soft0 transition-colors"
          >
            {t('timeline.addEntry')}
          </button>
        </div>
        <p className="mt-1 md:mt-2 text-[10px] md:text-xs font-bold text-ink-3 normal-case">
          {t('timeline.entriesBlurb')}
        </p>

        {entries.length === 0 ? (
          <div
            data-testid="plan-timeline-empty"
            className="mt-3 md:mt-4 bg-inset border-2 border-edge rounded-lg px-3 py-3 md:px-4 text-[10px] md:text-xs font-black text-ink-3 normal-case"
          >
            {t('timeline.empty')}
          </div>
        ) : (
          <ul className="mt-3 md:mt-4 space-y-2 md:space-y-3">
            {entries.map((e) => (
              <li
                key={e.id}
                data-testid="plan-timeline-entry"
                className="flex flex-wrap items-center gap-2 md:gap-3 border-2 border-edge rounded-lg bg-card px-3 py-2 md:px-4"
              >
                <span className="text-[9px] md:text-[10px] font-black text-ink-4">{t('timeline.iWasOn')}</span>
                <select
                  data-testid="plan-timeline-entry-plan"
                  aria-label={t('timeline.planAria')}
                  value={e.plan}
                  onChange={(ev) => {
                    const v = ev.target.value;
                    if (v === 'TOU' || v === 'Tiered' || v === 'ULO') patch(e.id, { plan: v });
                  }}
                  className={`${FIELD_CLASS} uppercase`}
                >
                  {PLAN_TYPES.map((p) => (
                    <option key={p} value={p}>
                      {planLabel(p)}
                    </option>
                  ))}
                </select>
                <span className="text-[9px] md:text-[10px] font-black text-ink-4">{t('timeline.from')}</span>
                <input
                  data-testid="plan-timeline-entry-from"
                  aria-label={t('timeline.fromAria')}
                  type="date"
                  value={e.from}
                  onChange={(ev) => {
                    if (ev.target.value === '') return;
                    patch(e.id, { from: ev.target.value });
                  }}
                  className={FIELD_CLASS}
                />
                <span className="text-[9px] md:text-[10px] font-black text-ink-4">{t('timeline.to')}</span>
                <input
                  data-testid="plan-timeline-entry-to"
                  aria-label={t('timeline.toAria')}
                  type="date"
                  value={e.to}
                  onChange={(ev) => {
                    if (ev.target.value === '') return;
                    patch(e.id, { to: ev.target.value });
                  }}
                  className={FIELD_CLASS}
                />
                <button
                  type="button"
                  data-testid="plan-timeline-entry-remove"
                  aria-label={t('timeline.removeAria')}
                  onClick={() => {
                    remove(e.id);
                    setError(null);
                  }}
                  className="ml-auto min-h-11 min-w-11 px-3 border-2 border-edge rounded-lg bg-card hover:bg-red-100 active:bg-red-200 font-black text-xs uppercase"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <div
            data-testid="plan-timeline-error"
            role="alert"
            className="mt-2 md:mt-3 bg-bad-soft border-2 border-bad rounded-lg px-3 py-2 text-[10px] md:text-xs font-black text-bad normal-case"
          >
            {error}
          </div>
        )}
      </div>
    </section>
  );
}

export default PlanTimelineEditor;
