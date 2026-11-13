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
import BillAccrualCurve from '@/components/classic/BillAccrualCurve';
import { expectedBillDate } from '@/lib/billAccrual';
import { TrueBillEstimate } from '@/components/classic/TrueBillEstimate';
import EvScenarioCard from '@/components/classic/EvScenarioCard';
import { isGasFeed } from '@/lib/gasBillUi';

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
  /**
   * The GAS section is on screen (t_a775c2a3 — AC2): the electric cards in
   * this panel (accrual curve, true-bill estimate + add-on fields, EV card)
   * stay unmounted, so a gas surface never prices or persists electric math.
   * MoneySection itself branches on isGasFeed(summaries) → the gas table.
   */
  gasView?: boolean;
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
  gasView = false,
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
      {/* Accrue-as-you-go: where the open period is heading, right now — an
          electric accrual, so never while the Gas section is on screen. */}
      {!gasView && (
        <BillAccrualCurve
          rows={allData}
          plan={plan}
          period={openPeriod}
          projection={projection}
          summaries={summaries}
          billDate={billDate}
        />
      )}

      {/* Wave O — the bill, itemized and compared. Under gas this resolves to
          the gas-honest table (MoneySection branches on isGasFeed), fed NO
          electric rows — see allData at the call site (t_a775c2a3). */}
      <MoneySection summaries={summaries} allData={allData} plan={plan} />

      {/* What your window would actually come to once the ride-alongs are on.
          Electric rows priced per kWh, and its prefill WRITES extra_charges
          from summaries+allData — never mounted on a gas surface. */}
      {!gasView && (
        <TrueBillEstimate
          plan={plan}
          startDate={startDate}
          endDate={endDate}
          windowData={filteredData}
          summaries={summaries}
          allData={allData}
        />
      )}

      {/* EV charging scenario — the household's own kWh, priced three ways.
          Never on a gas dataset (epic DoD 4), gas SECTION included. */}
      {!gasView && !isGasFeed(summaries) && <EvScenarioCard rows={allData} rates={rates} plan={plan} />}
    </div>
  );
}
