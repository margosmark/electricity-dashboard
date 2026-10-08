/**
 * Wave O — the MONEY section of the Insights tab.
 *
 * Everything below is driven by the UsageSummary bills Wave L parses out of
 * the Green Button file (they live in localStorage next to the readings), so
 * the whole section appears only when a bill exists — and when it does not,
 * the empty state says what to upload rather than showing a wall of zeros.
 *
 * Contents, in order:
 *   1. stacked composition per period, with the % share and kWh states and
 *      the plan-overlay lines (MoneyStackedChart);
 *   2. period → period deltas (PeriodDeltaTable);
 *   3. ¢/kWh by hour of day + the attribution waterfall for one period.
 *
 * This file is dynamically imported from InsightsView for the same reason
 * YearOverYearPanel is: it pulls the Recharts chunk, which on a first visit
 * has nothing to draw.
 */

'use client';

import { useMemo } from 'react';
import { Banknote } from 'lucide-react';

import { deriveExtraCharges, hasExtraCharges, type ProcessedPoint, type UsageSummary } from '@/lib/energy';
import { useExtraCharges } from '@/hooks/useDashboard';
import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import { planAnnotations } from '@/lib/planTimeline';
import { buildPeriodStacks, periodDeltaRows, planOverlay, type PlanId } from '@/lib/moneyViz';
import MoneyStackedChart from '@/components/MoneyStackedChart';
import PeriodDeltaTable from '@/components/PeriodDeltaTable';
import HourCostHistogram from '@/components/HourCostHistogram';
import BillWaterfall from '@/components/BillWaterfall';

export type MoneySectionProps = {
  /** Bill periods parsed out of the imported file. Empty = no bills yet. */
  summaries: UsageSummary[];
  /** Every priced reading — a billing period is wider than the chart window. */
  allData: ProcessedPoint[];
  /** The plan on screen: the ¢/kWh histogram prices with it. */
  plan: PlanId;
};

export default function MoneySection({ summaries, allData, plan }: MoneySectionProps) {
  const { charges: storedCharges } = useExtraCharges();
  // Wave P: which plan each period was billed under (detected from the bill,
  // filled in by the timeline) — the chart's background bands + table column.
  const [timeline] = usePlanTimeline();
  const annotations = useMemo(
    () => planAnnotations(summaries, timeline),
    [summaries, timeline],
  );

  // Charges the overlay models with: whatever the user has typed wins, and
  // the file's own derived rates are the fallback — the same precedence the
  // True Bill card uses, so two panels can never model different bills.
  const charges = useMemo(() => {
    if (hasExtraCharges(storedCharges)) return storedCharges;
    return deriveExtraCharges(summaries, allData)?.charges ?? null;
  }, [storedCharges, summaries, allData]);

  const stacks = useMemo(
    () => buildPeriodStacks(summaries, allData),
    [summaries, allData],
  );
  const deltaTable = useMemo(() => periodDeltaRows(stacks), [stacks]);
  const overlay = useMemo(
    () => planOverlay(summaries, allData, charges),
    [summaries, allData, charges],
  );

  const hasBill = summaries.length > 0;

  return (
    <section
      data-testid="money-section"
      className="print-compact space-y-6 md:space-y-8"
      aria-labelledby="money-heading"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4">
        <span
          aria-hidden
          className="bg-black text-yellow-400 p-2 md:p-3 rounded-xl md:rounded-2xl border-2 md:border-4 border-black"
        >
          <Banknote size={24} className="md:w-10 md:h-10" strokeWidth={3} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-slate-400 font-black uppercase">
            Your bill, visualized
          </div>
          <h2 id="money-heading" className="text-2xl md:text-4xl italic font-black uppercase text-black">
            Money
          </h2>
        </div>
      </div>

      {!hasBill ? (
        <div
          data-testid="money-empty"
          className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-dashed border-black text-black font-black uppercase"
        >
          <p className="text-lg md:text-2xl">
            Upload a Green Button export with billing periods to unlock the money views.
          </p>
          <p className="mt-3 text-[11px] md:text-sm font-bold normal-case text-slate-600 max-w-2xl">
            The utility&apos;s own file carries an itemized bill for every billing period — commodity
            split into off/mid/on-peak, delivery, regulatory, the Ontario Electricity Rebate and
            HST. Once one is imported this section shows what each period was made of, what changed
            between periods, what each hour of the day costs, where one period&apos;s money goes, and
            how the three plans compare against what you actually paid.
          </p>
        </div>
      ) : (
        <>
          <MoneyStackedChart stacks={stacks} overlay={overlay} planAnnotations={annotations} />
          <PeriodDeltaTable table={deltaTable} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8">
            <HourCostHistogram rows={allData} plan={plan} />
            <BillWaterfall summaries={summaries} />
          </div>
        </>
      )}
    </section>
  );
}
