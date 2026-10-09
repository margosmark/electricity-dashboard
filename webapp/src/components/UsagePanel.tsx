/**
 * USAGE — the data itself: the chart, the rate-staleness warning that
 * explains a stale axis, the anomalies and the routine heatmap.
 *
 * Wave R moved two things INTO this tab from the old global chrome: the OEB
 * rate-staleness banner (rates only matter where the chart prices them) and
 * the heatmap/anomaly/YoY panels that used to live at the bottom of the
 * Insights view. The full single-grid heatmap is replaced by the weekday /
 * weekend split — see DualHeatmap for why the merged grid hid the pattern.
 */

'use client';

import dynamic from 'next/dynamic';
import { AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import { type Anomaly, type HeatmapData, type ProcessedPoint } from '@/lib/energy';
import RateStalenessBanner from '@/components/RateStalenessBanner';
import ChartView, { type ChartViewProps } from '@/components/ChartView';
import DualHeatmap from '@/components/DualHeatmap';

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
};

export default function UsagePanel({
  staleness,
  anomalies,
  heatmapData,
  processedData,
  ...chart
}: UsagePanelProps) {
  return (
    <div id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" className="space-y-6 md:space-y-10" data-testid="tab-panel-usage">
      {/* Are the rates this chart prices with still the current ones? */}
      <RateStalenessBanner result={staleness} />

      <ChartView {...chart} />

      <div className="bg-yellow-400 p-6 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black">
        <div className="flex items-center gap-2 md:gap-4 mb-4 md:mb-8 text-black font-black uppercase">
          <AlertTriangle size={24} className="md:w-10 md:h-10" strokeWidth={3} />
          <h3 className="text-2xl md:text-4xl">Usage Anomalies</h3>
        </div>
        {anomalies.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 font-black text-black">
            {anomalies.map((anom, i) => (
              <div key={i} className="bg-white p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-black font-black uppercase">
                <div className="text-red-600 text-[8px] md:text-[10px] mb-1 md:mb-2 font-black">{format(anom.date, 'EEEE, MMM do')}</div>
                <div className="text-2xl md:text-3xl italic font-black text-black">{anom.usage.toFixed(1)} kWh</div>
                <div className="text-[8px] md:text-[10px] text-slate-500 mt-1 md:mt-2 font-black">+{anom.diffPct.toFixed(0)}% vs average</div>
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
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white p-6 md:p-8 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black text-lg md:text-xl text-black">
            No significant spikes detected!
          </div>
        )}
      </div>

      <DualHeatmap heatmapData={heatmapData} />

      <YearOverYearPanel processedData={processedData} />
    </div>
  );
}
