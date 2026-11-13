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
import type { ReactNode } from 'react';
import type { BillProjection } from '@/lib/billProjection';
import type { PlanId } from '@/hooks/useSelectedPlan';
import BillAccrualCurve from '@/components/BillAccrualCurve';
import { expectedBillDate } from '@/lib/billAccrual';
import { TrueBillEstimate } from '@/components/TrueBillEstimate';
import EvScenarioCard from '@/components/EvScenarioCard';
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
  rateNotice?: ReactNode;
  /**
   * The GAS section is on screen (t_a775c2a3 — AC2).
   *
   * MoneySection is commodity-scoped by `summaries` (isGasFeed → gas table),
   * but every other card in here prices ELECTRIC kWh: the accrual curve and
   * the true-bill estimate take electric rows, the estimate's add-on fields
   * derive `extra_charges` from `summaries` + `allData` (a gas bill fitted
   * against electric rows — a write, not a render), the EV card prices kWh,
   * and `rateNotice` is the OEB electricity-rate banner. All of them stay
   * unmounted while this is true; the OEB refusal path in the gas table is
   * the only pricing commentary a gas surface shows.
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
  rateNotice,
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
    <div id="panel-money" role="tabpanel" aria-labelledby="tab-money" className="order-2 space-y-6 md:space-y-10" data-testid="tab-panel-money">
      {/* Wave O — the bill, itemized and compared. Under gas this is the
          gas-honest table (MoneySection branches on isGasFeed), and it gets
          NO electric rows from this panel — see `allData` at the call site. */}
      <div data-testid="money-decomposition-slot">
        <MoneySection summaries={summaries} allData={allData} plan={plan} />
      </div>

      {/* The OEB electricity-rate banner is an electric surface (t_a775c2a3). */}
      {!gasView && rateNotice && <div data-testid="money-rate-alert">{rateNotice}</div>}

      {/* Accrue-as-you-go: where the open period is heading, right now — an
          electric accrual (kWh pace x plan rate), never under Gas. */}
      {!gasView && (
        <div data-testid="money-pace-slot">
          <BillAccrualCurve
            rows={allData}
            plan={plan}
            period={openPeriod}
            projection={projection}
            summaries={summaries}
            billDate={billDate}
          />
        </div>
      )}

      {/* What your window would actually come to once the ride-alongs are on.
          Electric rows priced per kWh — and its prefill WRITES extra_charges
          from summaries+allData, so mounting it under gas would persist a
          gas-bill/electric-rows hybrid (t_a775c2a3). */}
      {!gasView && (
        <div data-testid="money-true-bill-slot">
          <TrueBillEstimate
            plan={plan}
            startDate={startDate}
            endDate={endDate}
            windowData={filteredData}
            summaries={summaries}
            allData={allData}
          />
        </div>
      )}

      {/* EV charging scenario — the household's own kWh, priced three ways.
          Never on a gas dataset (epic DoD 4: no kWh/plan surfaces on gas),
          and never while the Gas SECTION is selected either. */}
      {!gasView && !isGasFeed(summaries) && (
        <div data-testid="money-ev-slot">
          <EvScenarioCard rows={allData} rates={rates} plan={plan} />
        </div>
      )}
    </div>
  );
}
