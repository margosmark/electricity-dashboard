/**
 * MONEY & WHAT-IF — what the bill is made of, and what changing it costs.
 *
 * Wave O's money section (stacked composition, period deltas, the ¢/kWh
 * histogram, the attribution waterfall and the plan overlay) is the spine;
 * Wave R adds the accrual curve at the TOP because it is the one chart that
 * answers a question you have TODAY ("is this month heading somewhere bad?")
 * rather than one you have at month end, then the true-bill estimate and the
 * EV scenario.
 *
 * MoneySection stays behind `next/dynamic` for the reason it always was: it
 * pulls the Recharts chunk, and a first visit to this tab with no bill
 * imported has nothing to draw.
 */

'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { type ProcessedPoint, type RateSet, type UsageSummary } from '@/lib/energy';
import type { BillProjection } from '@/lib/billProjection';
import type { PlanId } from '@/hooks/useSelectedPlan';
import BillAccrualCurve from '@/components/BillAccrualCurve';
import { expectedBillDate } from '@/lib/billAccrual';
import { TrueBillEstimate } from '@/components/TrueBillEstimate';
import EvScenarioCard from '@/components/EvScenarioCard';

const MoneySection = dynamic(() => import('@/components/MoneySection'), {
  ssr: false,
  loading: () => null,
});

export type MoneyPanelProps = {
  /** Bill periods parsed out of the imported file. Empty = no bills yet. */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the chart window. */
  allData: ProcessedPoint[];
  /** Current window rows: the true-bill estimate prices this window. */
  filteredData: ProcessedPoint[];
  plan: PlanId;
  /** Rate schedule in force — the EV card prices three plans with it. */
  rates: RateSet | null;
  startDate: string;
  endDate: string;
  projection: BillProjection;
  /** Wave Q's open (unbilled) tail; null when the file ends at a bill. */
  openPeriod: { start: number; end: number } | null;
  /** The user's billing-day setting — the no-bills fallback for the bill date. */
  billingDay: number;
};

export default function MoneyPanel({
  summaries,
  allData,
  filteredData,
  plan,
  rates,
  startDate,
  endDate,
  projection,
  openPeriod,
  billingDay,
}: MoneyPanelProps) {
  /**
   * When this open period will be billed through — the accrual's pace line
   * needs a DESTINATION, and "the newest reading" is not one (a chart that
   * stops at today can only ever say what already happened). The cadence is
   * the file's own: median billed duration stepped forward from the last
   * bill. No bills → the user's billing day, same as the axis fallback.
   */
  const billDate = useMemo(() => {
    if (!openPeriod) return null;
    const billed = summaries.map((s) => ({
      end: s.start + s.duration,
      duration: s.duration,
    }));
    const { date, source } = expectedBillDate(billed, openPeriod.end, billingDay);
    return { at: date, source };
  }, [openPeriod, summaries, billingDay]);

  return (
    <div id="panel-money" role="tabpanel" aria-labelledby="tab-money" className="space-y-6 md:space-y-10" data-testid="tab-panel-money">
      {/* Accrue-as-you-go: where the open period is heading, right now. */}
      <BillAccrualCurve
        rows={allData}
        plan={plan}
        period={openPeriod}
        projection={projection}
        summaries={summaries}
        billDate={billDate}
      />

      {/* Wave O — the bill, itemized and compared. */}
      <MoneySection summaries={summaries} allData={allData} plan={plan} />

      {/* What your window would actually come to once the ride-alongs are on. */}
      <TrueBillEstimate
        plan={plan}
        startDate={startDate}
        endDate={endDate}
        windowData={filteredData}
        summaries={summaries}
        allData={allData}
      />

      {/* EV charging scenario — the household's own kWh, priced three ways. */}
      <EvScenarioCard rows={allData} rates={rates} plan={plan} />
    </div>
  );
}
