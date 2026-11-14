/**
 * The GAS section's own surfaces (t_8a9038d6, chart t_78f788b3).
 *
 * The dashboard's Overview and Analytics are built from ELECTRICITY inputs —
 * `rawData` kWh, plan comparisons, ¢/kWh, heatmaps. Painting those under a
 * Gas tab would be the same defect this card exists to close, in the other
 * direction: electric numbers labelled as gas. So the gas section renders
 * only what a gas document actually supports:
 *
 *  - `GasOverviewPanel` — the bill itself (the caller passes the variant's
 *    `ActualBillPanel`, which branches to the gas card list: amount due, m³
 *    per period, feed-stated charges) plus one honest note about where the
 *    electricity analytics live.
 *  - `GasAnalyticsPanel` — the m³ interval chart (one bar per stored reading,
 *    unit on the axis/tooltip/sr-only table, zero conversions), with the
 *    honest "No interval data in this import" state for bill-only files that
 *    carry no volume series; below it the MONTHLY overview (bars + table per
 *    calendar month, both m³ figures side by side with each bill's stated
 *    Amount Due) and the YEAR-OVER-YEAR panel (monthly m³ per year, delta row,
 *    full-year totals) — t_a2343a2f's electricity-parity charts. None is
 *    priced or converted (no m³ → kWh anywhere); electricity analytics live
 *    in the Electricity tab.
 *  - `GasEmptyState` — no gas data in this browser at all: an upload CTA,
 *    never a zeroed chart that looks like an import that produced nothing.
 *
 * Every figure here comes from the feed; none is derived, priced or
 * converted (no m³ → kWh anywhere — see `lib/commodity.ts`).
 */

"use client";

import { useMemo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { FileDown, Fuel } from 'lucide-react';
import type { GasPoint } from '@/lib/storage';
import type { UsageSummary } from '@/lib/energy';
import { buildGasMonthly, buildGasYearOverYear } from '@/lib/gasMonthly';
import { useTranslation } from '@/i18n';

// The charts load on demand like ChartView → BarChartPanel: recharts stays
// off the main chunk until a gas tab with interval data actually renders.
// The card chrome (title, footnote, empty state) is static and paints first.
const GasChartPanel = dynamic(() => import('@/components/GasChartPanel'), {
  ssr: false,
  loading: () => null,
});
const GasMonthlyPanel = dynamic(() => import('@/components/GasMonthlyPanel'), {
  ssr: false,
  loading: () => null,
});
const GasYearOverYearPanel = dynamic(
  () => import('@/components/GasYearOverYearPanel'),
  { ssr: false, loading: () => null },
);

export function GasOverviewPanel({
  intervalCount,
  billPanel,
}: {
  /** Gas intervals stored in this browser (0 when the file carried none). */
  intervalCount: number;
  /** The variant's bill panel, already fed the gas summaries by the shell. */
  billPanel: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      id="panel-overview"
      role="tabpanel"
      aria-labelledby="tab-overview"
      className="order-2 space-y-5 md:space-y-7"
      data-testid="gas-overview-panel"
    >
      {billPanel}
      <p
        data-testid="gas-overview-note"
        className="text-[10px] md:text-xs font-bold text-ink-3 normal-case"
      >
        {intervalCount > 0
          ? t('commodity.gasOverviewNote')
          : t('commodity.gasBillsOnly')}
      </p>
    </div>
  );
}

/**
 * Analytics tab (gas): the m³ interval chart — one bar per stored reading,
 * unit on the axis, tooltip and sr-only table (a11y), zero conversions —
 * then the monthly overview and the year-over-year panel (t_a2343a2f).
 *
 * Feed scope: `points` and `summaries` arrive as props from the dashboard's
 * gas bucket (storage keys `energy_gas_v2` / `gas_usage_summaries`, read by
 * `useDashboard`). This component and the charts it renders never read a
 * storage key themselves, so neither can be fed the other commodity's
 * numbers (source-asserted in `GasChart.test.tsx`).
 *
 * Honest empty states: an Enbridge export with billing periods but no
 * volume series (bill-only files are common) says so — "No interval data in
 * this import" — instead of painting a chart-less frame or a zero baseline
 * that would read as measured silence; the monthly and year-over-year
 * panels below carry their own honest empties (no rows / no chartable
 * volume / fewer than 13 months of span).
 */
export function GasAnalyticsPanel({
  points,
  summaries,
}: {
  points: readonly GasPoint[];
  summaries: readonly UsageSummary[];
}) {
  const { t, locale } = useTranslation();
  const hasData = points.length > 0;
  // `locale` on the yoy memo: buildGasYearOverYear composes its month
  // labels and empty-state copy through the module `t()`/monthLabelsFor,
  // which read the language at call time — the language is a real input.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
  const monthly = useMemo(() => buildGasMonthly(points, summaries), [
    points,
    summaries,
    locale,
  ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the language is a real input
  const yoy = useMemo(() => buildGasYearOverYear(monthly), [monthly, locale]);
  return (
    <div
      id="panel-analytics"
      role="tabpanel"
      aria-labelledby="tab-analytics"
      className="order-2 space-y-5 md:space-y-7"
      data-testid="gas-analytics-panel"
    >
      <div className="quiet-card p-4 md:p-6 text-ink">
        <h2 className="flex items-center gap-2 text-base font-black uppercase tracking-tight mb-2">
          <Fuel size={18} strokeWidth={3} aria-hidden="true" />
          {t(hasData ? 'commodity.gasChartTitle' : 'commodity.gasChartNoData')}
        </h2>
        {hasData ? (
          <>
            <p className="text-xs md:text-sm font-bold text-ink-2 normal-case mb-4">
              {t('commodity.gasChartFootnote', { count: points.length })}
            </p>
            <GasChartPanel points={points} />
          </>
        ) : (
          <p
            data-testid="gas-chart-empty"
            className="text-xs md:text-sm font-bold text-ink-2 normal-case"
          >
            {t('commodity.gasBillsOnly')}
          </p>
        )}
      </div>

      <GasMonthlyPanel monthly={monthly} />
      <GasYearOverYearPanel yoy={yoy} />
    </div>
  );
}

export function GasEmptyState({ onImport }: { onImport: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="gas-empty-state"
      className="order-2 quiet-card p-5 md:p-8 text-ink text-center space-y-4"
    >
      <h2 className="text-base md:text-xl font-black uppercase tracking-tight flex items-center justify-center gap-2">
        <Fuel size={20} strokeWidth={3} aria-hidden="true" />
        {t('commodity.gasEmptyTitle')}
      </h2>
      <p className="text-xs md:text-sm font-bold text-ink-2 normal-case max-w-xl mx-auto">
        {t('commodity.gasEmptyBody')}
      </p>
      <button
        type="button"
        data-testid="gas-empty-upload"
        onClick={onImport}
        className="min-h-11 inline-flex items-center justify-center gap-2 px-5 py-3 bg-accent text-accent-ink border border-accent rounded-lg font-semibold text-[11px] md:text-xs transition-colors hover:brightness-95"
      >
        <FileDown size={14} strokeWidth={3} aria-hidden="true" />
        {t('commodity.gasEmptyAction')}
      </button>
    </div>
  );
}
