/**
 * USAGE — the data itself: the chart, the rate-staleness warning that
 * explains a stale axis, the anomalies and the routine heatmap.
 *
 * Wave R moved two things INTO this tab from the old global chrome: the OEB
 * rate-staleness banner (rates only matter where the chart prices them) and
 * the heatmap/anomaly/YoY panels that used to live at the bottom of the
 * Insights view. The full single-grid heatmap is replaced by the weekday /
 * weekend split — see DualHeatmap for why the merged grid hid the pattern.
 *
 * Wave T added the weather: the temperature-banded usage curve (the shape of
 * an air-conditioning signature, drawn from this household's own readings),
 * and the context line on each anomaly card ("31°C — that's AC"). Both read
 * ONE client-side Open-Meteo fetch owned by the dashboard — this panel never
 * fetches anything itself, and renders its honest "no data" states when the
 * temperatures are not there.
 */

'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { type Anomaly, type HeatmapData, type ProcessedPoint } from '@/lib/energy';
import { buildTempBandReport } from '@/lib/tempBands';
// Wave U — the anomalies card translates; the day label uses the locale's
// weekday/month names (fmtDate is date-fns bound to it).
import { fmtDate, fmtKwh, fmtPercent, fmtWeekdayDate, useTranslation } from '@/i18n';
import RateStalenessBanner from '@/components/RateStalenessBanner';
import ChartView, { type ChartViewProps } from '@/components/ChartView';
import DualHeatmap from '@/components/DualHeatmap';
import TempBandCard from '@/components/TempBandCard';
import type { HourlyTempsState } from '@/hooks/useHourlyTemps';

/**
 * Wave I item 4 — the second Recharts entry point.
 *
 * `ChartView` already loads its bars behind `next/dynamic`; this panel is the
 * only other module that imports Recharts, and it is reachable purely through
 * this tab. Splitting it too takes the ~465 KB Recharts chunk off the first
 * visit entirely, which under Lighthouse's mobile throttling is measured in
 * simulated seconds on the LCP critical path.
 */
const YearOverYearPanel = dynamic(() => import('@/components/YearOverYearPanel'), {
  ssr: false,
  loading: () => null,
});

export type UsagePanelProps = ChartViewProps & {
  /** Rate-staleness probe result; the banner decides itself whether to show. */
  staleness: React.ComponentProps<typeof RateStalenessBanner>['result'];
  anomalies: Anomaly[];
  heatmapData: HeatmapData;
  /** Whole loaded dataset — year-over-year gates on ALL history. */
  processedData: ProcessedPoint[];
  /** The dashboard's one Open-Meteo fetch (Wave T). */
  temps: HourlyTempsState;
  /** Rendered as a section inside the Overview tab after relocation. */
  embedded?: boolean;
  /**
   * Whether ANY readings are loaded. Without them the panel explains how to
   * add data instead of rendering empty charts, zero grids and orphan axes —
   * the calm-Overview contract's other half (the Overview tab hides this
   * panel entirely when there is nothing to show).
   */
  hasData: boolean;
  /** Opens the import front door from the empty state's call to action. */
  onImport: () => void;
  /**
   * Which destination identity a STANDALONE render carries: the quiet
   * Analytics tab (default) or the classic-variant Usage panel, whose tab
   * strip still spells this destination `usage` and owns those element ids.
   */
  panel?: 'analytics' | 'usage';
  /** Commodity 7: the whole panel is hourly/electric — render the skip card. */
  gas?: boolean;
};

/**
 * `Oct 6, 2024 – Oct 6, 2026` for the rows on screen, or null when empty.
 * Wave U — `locale` is taken as a parameter (and used to pick the pattern)
 * so the memo's dependency is real: the caption recomputes on a toggle.
 *
 * A row whose instant is not a DATE is skipped (t_7ce07989): these rows come
 * from `loadEnergyData`, whose `isDataPoint` checks only `Number.isFinite` —
 * a stored timestamp past ±8.64e15 ms is finite but makes
 * `new Date(ts * 1000)` Invalid, and date-fns `format()` then THROWS
 * `RangeError: Invalid time value`. Same rule as `gasWindowLabel` and
 * `UsagePointPicker`'s own bound: an unrenderable instant degrades to null
 * (the caller's fallback) rather than taking the panel down. Returns null
 * when NO row is renderable.
 */

function windowLabel(rows: ProcessedPoint[], locale: string): string | null {
  if (rows.length === 0) return null;
  const pattern = locale === 'fr' ? 'd MMM yyyy' : 'MMM d, yyyy';
  // First/last RENDERABLE row: the array is ordered, so scanning from each
  // end keeps the real caption byte-identical when every row is a date.
  let first: ProcessedPoint | undefined;
  let last: ProcessedPoint | undefined;
  for (const r of rows) {
    if (!Number.isFinite(new Date(r.timestamp * 1000).getTime())) continue;
    first ??= r;
    last = r;
  }
  if (!first || !last) return null;
  const a = fmtDate(new Date(first.timestamp * 1000), pattern);
  const b = fmtDate(new Date(last.timestamp * 1000), pattern);
  return a === b ? a : `${a} – ${b}`;
}

export default function UsagePanel({
  staleness,
  anomalies,
  heatmapData,
  processedData,
  temps,
  embedded = false,
  hasData,
  onImport,
  panel = 'analytics',
  gas = false,
  ...chart
}: UsagePanelProps) {
  const bandReport = useMemo(
    () => buildTempBandReport(chart.filteredData, temps.temps, chart.userPlan),
    [chart.filteredData, temps.temps, chart.userPlan],
  );
  // Wave U — `t`/`locale` in deps so the window caption recomputes on a
  // language switch (fmtDate reads the module locale for month names).
  const { t, locale } = useTranslation();
  const spanLabel = useMemo(() => windowLabel(chart.filteredData, locale), [chart.filteredData, locale]);
  // Commodity 7 (UX spec t_860756c3 principle 4): every view here is an
  // hourly/electricity view — heatmap, TOU cost, temperature bins, kWh
  // year-over-year. Gas never enters them; the panel says so explicitly.
  if (gas) {
    return (
      <div
        id={embedded ? 'overview-usage' : panel === 'usage' ? 'panel-usage' : 'panel-analytics'}
        role={embedded ? undefined : 'tabpanel'}
        aria-labelledby={embedded ? undefined : panel === 'usage' ? 'tab-usage' : 'tab-analytics'}
        className="space-y-6 md:space-y-10"
        data-testid={embedded ? 'overview-usage' : panel === 'usage' ? 'tab-panel-usage' : 'tab-panel-analytics'}
      >
        <section
          data-testid="gas-analytics-skip"
          className="bg-card border border-edge rounded-xl md:rounded-2xl p-4 md:p-6 max-w-3xl"
        >
          <h2 className="text-[10px] md:text-xs tracking-[0.2em] text-ink-4 font-semibold uppercase">
            {t('gasBill.analyticsTitle')}
          </h2>
          <p className="mt-3 text-[10px] md:text-xs text-ink-3 normal-case font-medium leading-relaxed">
            {t('gasBill.analyticsBody', { plans: t('tab.plans'), money: t('tab.money') })}
          </p>
        </section>
      </div>
    );
  }
  return (
    <div
      id={embedded ? 'overview-usage' : panel === 'usage' ? 'panel-usage' : 'panel-analytics'}
      role={embedded ? undefined : 'tabpanel'}
      aria-labelledby={embedded ? undefined : panel === 'usage' ? 'tab-usage' : 'tab-analytics'}
      className="space-y-6 md:space-y-10"
      data-testid={embedded ? 'overview-usage' : panel === 'usage' ? 'tab-panel-usage' : 'tab-panel-analytics'}
    >
      {/* What this destination is for, in the homeowner's own question —
          the frame that lets the dense views below be progressive
          disclosure instead of a wall. Rendered in Overview too, so the
          embedded copy is labelled the same way. */}
      <header className="bg-card p-5 md:p-8 rounded-xl md:rounded-2xl border-4 border-edge">
        <h2 className="text-xl md:text-3xl font-black">{t('analytics.title')}</h2>
        <p className="mt-2 normal-case font-bold text-ink-2">{t('analytics.intro')}</p>
      </header>

      {!hasData ? (
        /* No readings: say so specifically and offer the way in. Empty
           charts, zero grids and orphan axes are worse than no chart. */
        <section data-testid="analytics-empty-state" className="bg-card p-5 md:p-8 rounded-xl md:rounded-2xl border-2 border-edge">
          <h3 className="font-black text-lg md:text-xl">{t('analytics.noData')}</h3>
          <p className="mt-2 normal-case font-bold text-ink-2">{t('analytics.noDataHint')}</p>
          <button
            type="button"
            onClick={onImport}
            className="mt-4 min-h-11 px-5 py-3 bg-inv text-inv-ink rounded-xl border-2 border-edge font-black uppercase text-xs hover:bg-hover focus-visible:outline focus-visible:outline-4 focus-visible:outline-blue-600"
          >
            {t('analytics.import')}
          </button>
        </section>
      ) : (
        <>
      {/* 1. WHEN — the readings themselves, over time and by hour. */}
      <section aria-labelledby="analytics-when-heading">
        <h3 id="analytics-when-heading" className="mb-3 text-lg md:text-2xl font-black">{t('analytics.when.title')}</h3>
        <p className="mb-4 normal-case font-bold text-ink-2">{t('analytics.when.body')}</p>

      {/* Are the rates this chart prices with still the current ones? */}
      <RateStalenessBanner result={staleness} />

      <ChartView {...chart} />
      </section>

      {/* Wave T: same readings, binned by the temperature of that hour. */}
      {/* 2. WEATHER — the same readings against the temperature outside. */}
      <section aria-labelledby="analytics-weather-heading">
        <h3 id="analytics-weather-heading" className="mb-3 text-lg md:text-2xl font-black">{t('analytics.weather.title')}</h3>
        <p className="mb-4 normal-case font-bold text-ink-2">{t('analytics.weather.body')}</p>
      <TempBandCard
        report={bandReport}
        status={temps.status}
        loading={temps.loading}
        source={temps.source}
        spanLabel={spanLabel}
      />
      </section>

      {/* 3. UNUSUAL — the days that broke the pattern, the weekday routine
          and the year-over-year shape. */}
      <section aria-labelledby="analytics-unusual-heading">
      <h3 id="analytics-unusual-heading" className="mb-3 text-lg md:text-2xl font-black">{t('analytics.unusual.title')}</h3>
      <p className="mb-4 normal-case font-bold text-ink-2">{t('analytics.unusual.body')}</p>

      {/* Spec §3.5, with the polarity carried by an explicit data attribute:
          LIGHT keeps the yellow flood (nothing else on that view is yellow);
          DARK de-escalates to `bg-inset` + accent border + accent heading,
          because the banner above owns the yellow-flood monopoly. The ⚠ icon
          and the title text carry the flag in both themes, so colour is never
          the only channel (§2 #9) — which is also why the light flood is safe
          to keep while the dark heading goes accent-on-inset at 9.55:1 (the
          same heading in light would be 1.46:1 on the flood, hence the split). */}
      {/* Spec §3.5, expressed as tokens rather than `dark:` variants — the
          whole point of the token layer is that dark needs ZERO per-site
          variants. LIGHT keeps the yellow flood (nothing else on this view is
          yellow); DARK de-escalates to an inset surface with an accent border
          and accent heading, because the best-choice banner owns the
          yellow-flood monopoly and two maximum-loudness surfaces would
          destroy that hierarchy. Measured: ink-on-flood 13.7:1 light,
          accent-on-inset 9.55:1 dark. The ⚠ icon and the title text carry the
          flag in both themes, so colour is never the only channel (§2 #9). */}
      <div className="bg-anomaly-slab border-anomaly-slab-edge text-ink p-6 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 md:border-8 shadow-hard-8 md:shadow-hard-16">
        <div className="flex items-center gap-2 md:gap-4 mb-4 md:mb-8 text-anomaly-slab-ink font-black uppercase">
          <AlertTriangle size={24} className="md:w-10 md:h-10" strokeWidth={3} />
          <h3 className="text-2xl md:text-4xl">{t('anomalies.title')}</h3>
        </div>
        {anomalies.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 font-black text-ink">
            {anomalies.map((anom, i) => (
              <div key={i} className="bg-card p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge text-ink font-black uppercase">
                <div className="text-bad text-[8px] md:text-[10px] mb-1 md:mb-2 font-black">{fmtWeekdayDate(anom.date)}</div>
                <div className="text-2xl md:text-3xl italic font-black text-ink">{fmtKwh(anom.usage)}</div>
                <div className="text-[8px] md:text-[10px] text-ink-3 mt-1 md:mt-2 font-black">{t('anomalies.vsAverage', { pct: fmtPercent(anom.diffPct) })}</div>
                {/* The SHAPE of the day, not just the size of the bill. */}
                <div
                  data-testid={`anomaly-signature-${i}`}
                  data-signature={anom.signature.id}
                  className="mt-2 md:mt-3 pt-2 md:pt-3 border-t-2 border-edge"
                >
                  <div className="text-[8px] md:text-[10px] font-black">{anom.signature.label}</div>
                  <div className="text-[8px] font-bold text-ink-3 normal-case mt-0.5">
                    {anom.signature.detail}
                  </div>
                </div>
                {/* ...and the weather it happened in — computed with detection,
                    rendered in the same box, absent entirely when we hold no
                    temperatures (in which case the text is just "no data"). */}
                {anom.context && (
                  <div
                    data-testid={`anomaly-context-${i}`}
                    data-kind={anom.context.kind}
                    data-temp={anom.context.tempC === null ? '' : String(Math.round(anom.context.tempC))}
                    className="mt-2 md:mt-3 pt-2 md:pt-3 border-t-2 border-edge text-[9px] md:text-[11px] font-black"
                  >
                    {anom.context.kind === 'mild' && anom.context.tempC !== null
                      ? `${Math.round(anom.context.tempC)}${t('anomalies.tempSuffix')}${anom.context.text}`
                      : anom.context.text}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-card p-6 md:p-8 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge font-black text-lg md:text-xl text-ink">
            {t('anomalies.none')}
          </div>
        )}
      </div>

      <DualHeatmap heatmapData={heatmapData} />

      <YearOverYearPanel processedData={processedData} />
      </section>
      </>
      )}
    </div>
  );
}
