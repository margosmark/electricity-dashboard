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
 * This file is dynamically imported from the Money & What-If tab for the same
 * reason YearOverYearPanel is: it pulls the Recharts chunk, which on a first
 * visit has nothing to draw.
 */

'use client';

import { useMemo } from 'react';
import { Banknote } from 'lucide-react';

import { deriveExtraCharges, hasExtraCharges, type ProcessedPoint, type UsageSummary } from '@/lib/energy';
import { buildBillingAxis } from '@/lib/billingAxis';
import { useExtraCharges } from '@/hooks/useDashboard';
import { useTranslation } from '@/i18n';
import { useEstimateLedger, type OpenClaim } from '@/hooks/useEstimateLedger';
import { usePlanTimeline } from '@/hooks/usePlanTimeline';
import { planAnnotations } from '@/lib/planTimeline';
import { buildAxisStacks, periodDeltaRows, planOverlay, type PlanId } from '@/lib/moneyViz';
import MoneyStackedChart from '@/components/MoneyStackedChart';
import OpenPeriodPanel from '@/components/OpenPeriodPanel';
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
  const { t } = useTranslation();
  const { charges: storedCharges } = useExtraCharges();
  // Wave P: which plan each period was billed under (detected from the bill,
  // filled in by the timeline) — the chart's background bands + table column.
  const [timeline] = usePlanTimeline();
  const annotations = useMemo(
    () => planAnnotations(summaries, timeline),
    // Plan names and the timeline captions come from the catalog at call
    // time, so the switch has to recompute them.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
    [summaries, timeline, t],
  );

  // Charges the overlay models with: whatever the user has typed wins, and
  // the file's own derived rates are the fallback — the same precedence the
  // True Bill card uses, so two panels can never model different bills.
  const charges = useMemo(() => {
    if (hasExtraCharges(storedCharges)) return storedCharges;
    return deriveExtraCharges(summaries, allData)?.charges ?? null;
  }, [storedCharges, summaries, allData]);

  // The timeline itself: the file's OWN billing periods (de-duped across
  // exports, holes between them kept visible) plus the open tail past the
  // last bill. Everything below — the stacks, the deltas, the panel — reads
  // this one list, so the chart and the table can never disagree about what
  // a period is.
  const axis = useMemo(
    () => buildBillingAxis({ summaries, rows: allData }),
    // buildBillingAxis writes every period label and note in the active
    // language.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
    [summaries, allData, t],
  );
  const stacks = useMemo(() => buildAxisStacks(axis, allData, plan), [axis, allData, plan]);
  const openStack = useMemo(
    () => stacks.find((s) => s.kind === 'open') ?? null,
    [stacks],
  );
  const lastBilled = useMemo(
    () => [...stacks].reverse().find((s) => s.kind === 'billed') ?? null,
    [stacks],
  );
  // What this browser is claiming about the unbilled tail — the ledger keeps
  // it so a later export can score it (see lib/estimateLedger).
  const claim: OpenClaim | null = useMemo(() => {
    if (!openStack || openStack.totals.payable <= 0) return null;
    return {
      windowStart: openStack.start,
      windowEnd: openStack.end,
      plan,
      estimated: openStack.totals.payable,
      meteredKwh: openStack.usageTotal ?? 0,
    };
  }, [openStack, plan]);
  const ledger = useEstimateLedger(claim, summaries);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
  const deltaTable = useMemo(() => periodDeltaRows(stacks), [stacks, t]);
  const overlay = useMemo(
    () => planOverlay(summaries, allData, charges),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
    [summaries, allData, charges, t],
  );

  const hasBill = summaries.length > 0;

  return (
    <section
      data-testid="money-section"
      data-decomposition-block="true"
      className="print-compact space-y-6 md:space-y-8"
      aria-labelledby="money-heading"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4">
        <span
          aria-hidden
          className="bg-inv text-accent-yellow p-2 md:p-3 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge"
        >
          <Banknote size={24} className="md:w-10 md:h-10" strokeWidth={3} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-ink-4 font-black uppercase">
            {t('money.eyebrow')}
          </div>
          <h2 id="money-heading" className="text-2xl md:text-4xl italic font-black uppercase text-ink">
            {t('tab.money')}
          </h2>
        </div>
      </div>

      {!hasBill ? (
        <div
          data-testid="money-empty"
          className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-dashed border-edge text-ink font-black uppercase"
        >
          <p className="text-lg md:text-2xl">
            {t('money.emptyTitle')}
          </p>
          <p className="mt-3 text-[11px] md:text-sm font-bold normal-case text-ink-2 max-w-2xl">
            {t('money.emptyBlurb')}
          </p>
        </div>
      ) : (
        <>
          <OpenPeriodPanel
            open={openStack}
            lastBilled={lastBilled}
            ledger={ledger}
            axisNote={axis.note}
          />
          <MoneyStackedChart
            stacks={stacks}
            overlay={overlay}
            planAnnotations={annotations}
            charges={charges}
          />
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
