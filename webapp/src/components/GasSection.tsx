/**
 * The GAS section's own surfaces (t_8a9038d6).
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
 *  - `GasAnalyticsNote` — the interval-chart tab's honest state: gas
 *    intervals ARE stored, but nothing charts them yet, and a file that
 *    carried only bill periods says exactly that instead of implying
 *    readings exist.
 *  - `GasEmptyState` — no gas data in this browser at all: an upload CTA,
 *    never a zeroed chart that looks like an import that produced nothing.
 *
 * Every figure here comes from the feed; none is derived, priced or
 * converted (no m³ → kWh anywhere — see `lib/commodity.ts`).
 */

"use client";

import type { ReactNode } from 'react';
import { FileDown, Fuel } from 'lucide-react';
import { useTranslation } from '@/i18n';

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

export function GasAnalyticsNote({ intervalCount }: { intervalCount: number }) {
  const { t } = useTranslation();
  return (
    <div
      id="panel-analytics"
      role="tabpanel"
      aria-labelledby="tab-analytics"
      className="order-2 space-y-5 md:space-y-7"
      data-testid="gas-analytics-note"
    >
      <div className="quiet-card p-4 md:p-6 text-ink">
        <h2 className="flex items-center gap-2 text-base font-black uppercase tracking-tight mb-2">
          <Fuel size={18} strokeWidth={3} aria-hidden="true" />
          {t('commodity.gasAnalyticsTitle')}
        </h2>
        <p className="text-xs md:text-sm font-bold text-ink-2 normal-case">
          {intervalCount > 0
            ? t('commodity.gasAnalyticsBody', { count: intervalCount })
            : t('commodity.gasBillsOnly')}
        </p>
      </div>
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
