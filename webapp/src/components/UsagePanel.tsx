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
import { fmtDateLong, fmtKwh, fmtPercent, fmtWeekdayDate, useTranslation } from '@/i18n';
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
};

/**
 * `Oct 6, 2024 – Oct 6, 2026` for the rows on screen, or null when empty.
 * Wave U — `fmtDateLong` is date-fns bound to the active locale, so the
 * caption follows the toggle (`6 oct. 2024 – 6 oct. 2026` in French).
 */
function windowLabel(rows: ProcessedPoint[]): string | null {
  if (rows.length === 0) return null;
  const first = fmtDateLong(new Date(rows[0].timestamp * 1000));
  const last = fmtDateLong(new Date(rows[rows.length - 1].timestamp * 1000));
  return first === last ? first : `${first} – ${last}`;
}

export default function UsagePanel({
  staleness,
  anomalies,
  heatmapData,
  processedData,
  temps,
  ...chart
}: UsagePanelProps) {
  const bandReport = useMemo(
    () => buildTempBandReport(chart.filteredData, temps.temps, chart.userPlan),
    [chart.filteredData, temps.temps, chart.userPlan],
  );
  // Wave U — `t`/`locale` in deps so the window caption recomputes on a
  // language switch (fmtDateLong reads the module-level locale).
  const { t, locale } = useTranslation();
  const spanLabel = useMemo(() => windowLabel(chart.filteredData), [chart.filteredData, locale]);
  return (
    <div id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" className="space-y-6 md:space-y-10" data-testid="tab-panel-usage">
      {/* Are the rates this chart prices with still the current ones? */}
      <RateStalenessBanner result={staleness} />

      <ChartView {...chart} />

      {/* Wave T: same readings, binned by the temperature of that hour. */}
      <TempBandCard
        report={bandReport}
        status={temps.status}
        loading={temps.loading}
        source={temps.source}
        spanLabel={spanLabel}
      />

      <div className="bg-yellow-400 p-6 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black">
        <div className="flex items-center gap-2 md:gap-4 mb-4 md:mb-8 text-black font-black uppercase">
          <AlertTriangle size={24} className="md:w-10 md:h-10" strokeWidth={3} />
          <h3 className="text-2xl md:text-4xl">{t('anomalies.title')}</h3>
        </div>
        {anomalies.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 font-black text-black">
            {anomalies.map((anom, i) => (
              <div key={i} className="bg-white p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-black font-black uppercase">
                <div className="text-red-600 text-[8px] md:text-[10px] mb-1 md:mb-2 font-black">{fmtWeekdayDate(anom.date)}</div>
                <div className="text-2xl md:text-3xl italic font-black text-black">{fmtKwh(anom.usage)}</div>
                <div className="text-[8px] md:text-[10px] text-slate-500 mt-1 md:mt-2 font-black">{t('anomalies.vsAverage', { pct: fmtPercent(anom.diffPct) })}</div>
                {/* The SHAPE of the day, not just the size of the bill. */}
                <div
                  data-testid={`anomaly-signature-${i}`}
                  data-signature={anom.signature.id}
                  className="mt-2 md:mt-3 pt-2 md:pt-3 border-t-2 border-black"
                >
                  <div className="text-[8px] md:text-[10px] font-black">{anom.signature.label}</div>
                  <div className="text-[8px] font-bold text-slate-500 normal-case mt-0.5">
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
                    className="mt-2 md:mt-3 pt-2 md:pt-3 border-t-2 border-black text-[9px] md:text-[11px] font-black"
                  >
                    {anom.context.kind === 'mild' && anom.context.tempC !== null
                      ? `${Math.round(anom.context.tempC)}°C · ${anom.context.text}`
                      : anom.context.text}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white p-6 md:p-8 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black text-lg md:text-xl text-black">
            {t('anomalies.none')}
          </div>
        )}
      </div>

      <DualHeatmap heatmapData={heatmapData} />

      <YearOverYearPanel processedData={processedData} />
    </div>
  );
}
