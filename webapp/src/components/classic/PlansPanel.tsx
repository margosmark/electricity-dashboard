/**
 * PLANS & TRACK RECORD — the evidence behind the verdict.
 *
 * Everything that answers "which plan, and can I trust that?" lives here:
 * the one-line verdict (recomputed from the window, so it can disagree with
 * the shift optimizer below it — that disagreement is information, and it is
 * why the line says the track record can move it), the ranked shift advice
 * with its weekly before/after, why the window favours one plan (the
 * work-from-home share), the three plan cards, and Wave P's history in both
 * forms: the timeline picture and the audited table.
 *
 * The plan cards keep their behaviour exactly (role=button, aria-pressed,
 * keyboard-operable, rates read from the active RateSet) — only their place
 * in the page changed.
 */

'use client';

import { type ProcessedPoint, type RateSet, type UsageSummary, type WfhShare } from '@/lib/energy';
import { type PlanId } from '@/hooks/useSelectedPlan';
import type { PlanCosts } from '@/lib/verdict';
import type { TouShiftAnalysis } from '@/lib/touShift';
import type { ShiftVerification } from '@/lib/shiftVerification';
import VerdictLine from '@/components/classic/VerdictLine';
import ShiftOptimizer from '@/components/classic/ShiftOptimizer';
import ShiftVerificationCard from '@/components/classic/ShiftVerificationCard';
import PlanCards from '@/components/classic/PlanCards';
import PlanSwitchTimeline from '@/components/classic/PlanSwitchTimeline';
import { PlanTimelineEditor } from '@/components/classic/PlanTimelineEditor';
import SwitchTrackRecord from '@/components/classic/SwitchTrackRecord';
import HindsightPanel from '@/components/classic/HindsightPanel';
import { ActualBillPanel } from '@/components/classic/ActualBillPanel';
import { isGasFeed } from '@/lib/gasBillUi';
import { fmtNumber, fmtPercent, useTranslation } from '@/i18n';

export type PlansPanelProps = {
  /** Per-plan cost of the window on screen. */
  comparison: PlanCosts | null;
  userPlan: PlanId;
  setUserPlan: (plan: PlanId) => void;
  days: number;
  /** Rate schedule in force — the cards' chips and thresholds read it. */
  activeRateSet: RateSet | null;
  /** The window the costs were computed over: the tier cut-off follows its dates. */
  startDate: string;
  endDate: string;
  /** Share of the window that lands in the 07–19 weekday window. */
  wfh: WfhShare | null;
  /** Ranked ToU-shift recommendations over the full loaded dataset. */
  shiftAnalysis: TouShiftAnalysis;
  /** Weekly before/after of the shift, over the full loaded dataset. */
  verification: ShiftVerification;
  /** Bill periods parsed out of the imported file. */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the window. */
  allData: ProcessedPoint[];
};

export default function PlansPanel({
  comparison,
  userPlan,
  setUserPlan,
  days,
  activeRateSet,
  startDate,
  endDate,
  wfh,
  shiftAnalysis,
  verification,
  summaries,
  allData,
}: PlansPanelProps) {
  const { t } = useTranslation();
  // Commodity 7: no plan to compare against (epic DoD 4) — the tab shows
  // ONLY the actual bill, same as the modern skin.
  if (isGasFeed(summaries)) {
    return (
      <div
        id="panel-plans"
        role="tabpanel"
        aria-labelledby="tab-plans"
        className="space-y-6 md:space-y-10"
        data-testid="tab-panel-plans"
      >
        <ActualBillPanel summaries={summaries} allData={allData} plan={userPlan} />
      </div>
    );
  }
  return (
    <div id="panel-plans" role="tabpanel" aria-labelledby="tab-plans" className="space-y-6 md:space-y-10" data-testid="tab-panel-plans">
      {/* The verdict, restated where the evidence for it lives. */}
      <VerdictLine comparison={comparison} userPlan={userPlan} days={days} />

      {/* Ranked recommendations over the full dataset (not the window). */}
      <ShiftOptimizer analysis={shiftAnalysis} />

      {/* Did last week's shift actually show up in the numbers? */}
      <ShiftVerificationCard verification={verification} />

      {/* Context on WHY a plan wins in this window. */}
      {wfh && (
        <div
          data-testid="wfh-annotation"
          className="bg-purple-200 border-2 md:border-4 border-edge rounded-xl md:rounded-2xl px-4 md:px-6 py-3 md:py-4 flex flex-wrap items-center gap-3 md:gap-6 text-accent-ink font-black uppercase"
        >
          <span className="text-base md:text-2xl italic">{fmtPercent(wfh.share * 100)}</span>
          <span className="text-[10px] md:text-xs">{t('wfh.label')}</span>
          <span className="text-[9px] md:text-[11px] font-bold text-accent-ink normal-case">
            {t('wfh.annotation', {
              kwh: fmtNumber(wfh.kwh, 1),
              total: fmtNumber(wfh.totalKwh, 1),
              count: wfh.weekdays,
              weekdays: wfh.weekdays,
            })}
          </span>
        </div>
      )}

      <PlanCards
        comparison={comparison}
        userPlan={userPlan}
        setUserPlan={setUserPlan}
        activeRateSet={activeRateSet}
        startDate={startDate}
        endDate={endDate}
      />

      {/* Wave R — the same audit trail as a picture, then the table. */}
      <PlanSwitchTimeline summaries={summaries} allData={allData} />
      <PlanTimelineEditor summaries={summaries} />
      <SwitchTrackRecord summaries={summaries} allData={allData} />

      {/* Wave V — what should have happened: the same readings repriced across the other plans. */}
      <HindsightPanel summaries={summaries} allData={allData} />

      {/* What the utility actually billed, against what these models say. */}
      <ActualBillPanel summaries={summaries} allData={allData} plan={userPlan} />
    </div>
  );
}
