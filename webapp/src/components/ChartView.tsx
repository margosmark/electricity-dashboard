/**
 * Chart tab: zoom navigation, the bar chart, the three plan cards and the
 * "winning economic plan" banner.
 *
 * Markup only — every piece of state lives in src/hooks/useDashboard.ts and is
 * handed in as props by Dashboard, so extracting this file is a pure render
 * split (styling and data-testids unchanged).
 */

"use client";

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft, ChevronLeft, ChevronRight, CheckCircle2 } from 'lucide-react';
import { type ChartDataItem, type ProcessedPoint, type RateSet, type UsageSummary } from '@/lib/energy';
import { type ZoomLevel } from '@/hooks/useDashboard';
import { ExportCsvButton } from '@/components/ExportCsvButton';
import { TrueBillEstimate } from '@/components/TrueBillEstimate';
import { ActualBillPanel } from '@/components/ActualBillPanel';
import BillProjectionBanner from '@/components/BillProjectionBanner';
import type { BillProjection } from '@/lib/billProjection';
import type { WfhShare } from '@/lib/energy';
import { chartSegments, distinctSeasons, SEASON_INFO, type Season } from '@/lib/season';

export type PlanId = 'TOU' | 'Tiered' | 'ULO';
export type Comparison = { TOU: number; Tiered: number; ULO: number };

export type ChartViewProps = {
  zoomLevel: ZoomLevel;
  zoomTarget: string | null;
  goBack: () => void;
  navigatePeriod: (dir: 'prev' | 'next') => void;
  setZoomLevelAndClear: (l: ZoomLevel) => void;
  activeChartData: ChartDataItem[];
  handleBarClick: (item: { key?: string } | null) => void;
  selectionCost: number;
  userPlan: PlanId;
  setUserPlan: (p: PlanId) => void;
  comparison: Comparison | null;
  activeRateSet: RateSet | null;
  /** Current window rows: CSV export + the true-bill estimate read these. */
  filteredData: ProcessedPoint[];
  /**
   * Every priced reading (Wave L). A billing period is wider than whatever
   * window is on screen, so the actual-bill panel reconciles against the
   * whole dataset instead of the zoom.
   */
  allData?: ProcessedPoint[];
  /** Bill periods parsed out of the imported file; empty = no bills. */
  summaries?: UsageSummary[];
  startDate: string;
  endDate: string;
  /** "This month's bill" projection (gated — see lib/billProjection). */
  projection: BillProjection;
  /** Share of the visible window that lands in the 07–19 weekday window. */
  wfh: WfhShare | null;
};

/**
 * Wave H item 4 — the skeleton that covers Recharts' empty first frame.
 *
 * The bars animate in over ~500 ms (Wave B evidence), so for half a second
 * after data ARRIVES the chart area is a blank white box — exactly what a
 * first-time user reads as "broken". The shimmer shows instead, keyed on the
 * 0 -> N rows transition (upload, sample button, restore) so it never flashes
 * on a zoom or a tab switch, where the bars are already on screen.
 */
const CHART_ANIMATION_MS = 520;

function ChartSkeleton({ bars }: { bars?: number }) {
  const columns = Math.min(Math.max(bars ?? 12, 6), 16);
  return (
    <div
      data-testid="chart-skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Drawing the chart"
      className="absolute inset-0 z-20 bg-white px-4 md:px-8 pt-4 pb-6 flex flex-col"
    >
      <div className="text-[8px] md:text-[10px] font-black uppercase text-slate-400 mb-3">
        Drawing {bars} bar{bars === 1 ? '' : 's'}…
      </div>
      <div className="flex-1 flex items-end gap-[2px] md:gap-2 border-b-4 border-black min-h-0">
        {Array.from({ length: columns }).map((_, i) => (
          <div
            key={i}
            className="skeleton-bar flex-1 border-2 border-black/10 rounded-t-sm"
            style={{ height: `${28 + ((i * 37) % 62)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Wave I item 4 — Recharts only ships when there is something to draw.
 *
 * `next/dynamic` pulls the chart panel (and with it the ~651 KB vendor chunk:
 * recharts, date-fns, fast-xml-parser) onto its own request, and the render
 * below is gated on there being at least one bar — so a first visit, whose
 * chart area is the "no readings in this window" panel, never downloads or
 * parses it. Lighthouse measured 74.7% of that chunk as unused on exactly that
 * visit; under mobile throttling every byte on the critical path is simulated
 * main-thread time. The Wave H shimmer covers the fetch just as it covers
 * Recharts' own grow-in.
 */
const BarChartPanel = dynamic(() => import('@/components/BarChartPanel'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

export default function ChartView({
  zoomLevel, zoomTarget, goBack, navigatePeriod, setZoomLevelAndClear,
  activeChartData, handleBarClick, selectionCost,
  userPlan, setUserPlan, comparison, activeRateSet,
  filteredData, allData = [], summaries = [], startDate, endDate, projection, wfh,
}: ChartViewProps) {
  const [skeleton, setSkeleton] = useState(false);
  const rowCountRef = useRef(activeChartData.length);

  useEffect(() => {
    const previous = rowCountRef.current;
    rowCountRef.current = activeChartData.length;
    // Only a cold 0 -> N transition (data just landed) earns a skeleton.
    if (previous === 0 && activeChartData.length > 0) {
      setSkeleton(true);
      const timer = setTimeout(() => setSkeleton(false), CHART_ANIMATION_MS);
      return () => clearTimeout(timer);
    }
    setSkeleton(false);
  }, [activeChartData]);
  /**
   * Rate-season bands (Wave G item 6): Ontario flips its rate windows on
   * May 1 / Nov 1, and a window that straddles a boundary would otherwise
   * render as one undifferentiated row of bars.
   */
  const segments = chartSegments(zoomLevel, activeChartData, zoomTarget ?? startDate);
  // ReferenceArea anchors on axis LABELS; they must be unique or a band would
  // span the wrong bars, so shading degrades to the chips below when they are not.
  const labelsUnique = new Set(activeChartData.map((d) => d.label)).size === activeChartData.length;
  const seasonsInView = distinctSeasons(segments.map((s) => s.season));
  const seasonOfView: Season =
    filteredData.length > 0
      ? filteredData[filteredData.length - 1].isWinter
        ? 'winter'
        : 'summer'
      : seasonsInView[seasonsInView.length - 1] ?? 'summer';
  const tierThreshold =
    activeRateSet && (seasonOfView === 'winter'
      ? activeRateSet.tiered.thresholdWinter
      : activeRateSet.tiered.thresholdSummer);
  const otherTierThreshold =
    activeRateSet && (seasonOfView === 'winter'
      ? activeRateSet.tiered.thresholdSummer
      : activeRateSet.tiered.thresholdWinter);

  return (
    <div className="space-y-6 md:space-y-10" data-testid="chart-view">
      {/* This month's bill — month-to-date + recent average, gated on day 5. */}
      <BillProjectionBanner projection={projection} />

      {/* Context on WHY a plan wins in this window. */}
      {wfh && (
        <div
          data-testid="wfh-annotation"
          className="bg-purple-200 border-2 md:border-4 border-black rounded-xl md:rounded-2xl px-4 md:px-6 py-3 md:py-4 flex flex-wrap items-center gap-3 md:gap-6 text-black font-black uppercase"
        >
          <span className="text-base md:text-2xl italic">{(wfh.share * 100).toFixed(0)}%</span>
          <span className="text-[10px] md:text-xs">{wfh.label}</span>
          <span className="text-[9px] md:text-[11px] font-bold text-slate-600 normal-case">
            {wfh.kwh.toFixed(1)} of {wfh.totalKwh.toFixed(1)} kWh in view fall on {wfh.weekdays}{' '}
            weekday{wfh.weekdays === 1 ? '' : 's'} — the hours a daytime-heavy home spends either
            working or not. Context for the plan cards below, not a forecast.
          </span>
        </div>
      )}
      {/* Main Graph */}
      <div className="bg-white p-4 md:p-8 rounded-[1.5rem] md:rounded-[3rem] shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] border-4 border-black overflow-hidden relative z-10 text-black font-black uppercase">
        <div className="flex flex-col lg:flex-row justify-between items-center mb-6 md:mb-12 gap-4 md:gap-6 text-black font-black">
          <div className="flex items-center gap-3 md:gap-6 w-full lg:w-auto justify-between lg:justify-start">
            {zoomLevel !== 'monthly' && <button type="button" aria-label="Back to wider view" onClick={goBack} className="no-print min-h-11 min-w-11 inline-flex items-center justify-center p-2 md:p-4 bg-white border-2 md:border-4 border-black rounded-xl md:rounded-2xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black hover:text-white active:bg-black active:text-white transition-all"><ArrowLeft size={20} className="md:w-8 md:h-8" strokeWidth={4} /></button>}
            <div className="flex items-center gap-2 md:gap-4">
              <button type="button" aria-label="Previous period" onClick={() => navigatePeriod('prev')} className="no-print min-h-11 min-w-11 inline-flex items-center justify-center p-1 md:p-2 border-2 md:border-4 border-black rounded-lg md:rounded-xl hover:bg-yellow-400 active:bg-yellow-400 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none"><ChevronLeft size={16} className="md:w-6 md:h-6" strokeWidth={4} /></button>
              <h2 className="min-w-0 flex-1 text-xl sm:text-3xl md:text-6xl tracking-tighter italic truncate">{zoomTarget || (zoomLevel === 'monthly' ? "Monthly Overview" : zoomLevel)}</h2>
              <button type="button" aria-label="Next period" onClick={() => navigatePeriod('next')} className="no-print min-h-11 min-w-11 inline-flex items-center justify-center p-1 md:p-2 border-2 md:border-4 border-black rounded-lg md:rounded-xl hover:bg-yellow-400 active:bg-yellow-400 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none"><ChevronRight size={16} className="md:w-6 md:h-6" strokeWidth={4} /></button>
            </div>
          </div>
          <div className="no-print flex bg-slate-100 p-1 rounded-lg md:rounded-xl border-2 md:border-4 border-black text-black" role="group" aria-label="Zoom level">
             {(['monthly', 'weekly', 'daily'] as const).map((l) => <button key={l} type="button" aria-pressed={zoomLevel === l && !zoomTarget} onClick={() => setZoomLevelAndClear(l)} className={`inline-flex min-h-11 items-center px-3 md:px-6 py-1 md:py-2 rounded-md md:rounded-lg text-[11px] md:text-xs font-black transition-all ${zoomLevel === l && !zoomTarget ? 'bg-black text-white' : 'text-slate-500'}`}>{l}</button>)}
          </div>
          <div className="text-center lg:text-right text-black font-black">
             <div className="text-[8px] md:text-[10px]">Total selection cost ({userPlan})</div>
              <div className="text-2xl md:text-5xl italic mt-1 md:mt-2 font-black">${selectionCost.toFixed(2)}</div>
          </div>
        </div>

        <div className="relative h-[300px] md:h-[500px] -ml-4 md:-ml-6" data-testid="chart-area">
          {activeChartData.length === 0 ? (
            /* Nothing in this window yet: say so, instead of drawing an
               empty axis frame that reads as a rendering failure. */
            <div
              data-testid="chart-empty-window"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6"
            >
              <div className="text-lg md:text-2xl font-black uppercase text-black">
                No readings in this window
              </div>
              <div className="text-[10px] md:text-xs font-bold text-slate-500 normal-case max-w-sm">
                Widen the date range above, or load another export — the chart
                draws as soon as the window holds data.
              </div>
            </div>
          ) : (
            <>
          <BarChartPanel
            data={activeChartData}
            zoomLevel={zoomLevel}
            segments={segments}
            labelsUnique={labelsUnique}
            onBarClick={handleBarClick}
          />
              {/* Wave H item 4: shimmer over Recharts' ~500 ms grow-in. */}
              {skeleton && <ChartSkeleton bars={activeChartData.length} />}
            </>
          )}
        </div>

        <div className="mt-4 md:mt-6 flex flex-wrap items-center justify-between gap-3">
          {/* Which rate window(s) the visible bars fall in — the band above
              shades them, this says what the shading means. */}
          <div className="flex flex-wrap gap-2 md:gap-3" data-testid="season-band">
            {segments.map((s, i) => (
              <span
                key={`chip-${s.season}-${i}`}
                data-testid="season-chip"
                className={`px-2 md:px-3 py-1 rounded-full border-2 border-black text-[8px] md:text-[10px] font-black ${s.season === 'winter' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}
              >
                {s.season === 'winter' ? '❄' : '☀'} {SEASON_INFO[s.season].label} · {SEASON_INFO[s.season].range}
                {segments.length > 1 ? ` · ${s.bars} bars` : ''}
              </span>
            ))}
          </div>
          <ExportCsvButton rows={filteredData} printHidden />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-10 text-black font-black uppercase">
        {[
          { id: 'Tiered', name: 'Tiered Pricing', cost: comparison?.Tiered, rates: [{ l: 'Tier 1', v: `${activeRateSet ? activeRateSet.tiered.tier1.toFixed(1) : '12.0'}¢` }, { l: 'Tier 2', v: `${activeRateSet ? activeRateSet.tiered.tier2.toFixed(1) : '14.2'}¢` }] },
          { id: 'TOU', name: 'Time-of-Use', cost: comparison?.TOU, rates: [{ l: 'Off-Peak', v: `${activeRateSet ? activeRateSet.tou.offPeak.toFixed(1) : '9.8'}¢`, c: 'text-emerald-600' }, { l: 'Mid-Peak', v: `${activeRateSet ? activeRateSet.tou.midPeak.toFixed(1) : '15.7'}¢`, c: 'text-yellow-600' }, { l: 'On-Peak', v: `${activeRateSet ? activeRateSet.tou.onPeak.toFixed(1) : '20.3'}¢`, c: 'text-red-600' }] },
          { id: 'ULO', name: 'Ultra-Low Overnight', cost: comparison?.ULO, rates: [{ l: 'Overnight', v: `${activeRateSet ? activeRateSet.ulo.overnight.toFixed(1) : '3.9'}¢`, c: 'text-purple-600' }, { l: 'Weekend Off', v: `${activeRateSet ? activeRateSet.ulo.weekendOffPeak.toFixed(1) : '9.8'}¢`, c: 'text-emerald-600' }, { l: 'Mid-Peak', v: `${activeRateSet ? activeRateSet.ulo.midPeak.toFixed(1) : '15.7'}¢`, c: 'text-yellow-600' }, { l: 'On-Peak', v: `${activeRateSet ? activeRateSet.ulo.onPeak.toFixed(1) : '39.1'}¢`, c: 'text-red-600' }] }
        ].map((plan, i) => (
          <div
            key={i}
            role="button"
            tabIndex={0}
            aria-pressed={userPlan === plan.id}
            aria-label={`Use the ${plan.name} plan`}
            onClick={() => setUserPlan(plan.id as PlanId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setUserPlan(plan.id as PlanId);
              }
            }}
            className={`bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[2rem] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative transition-all cursor-pointer ${userPlan === plan.id ? 'ring-4 md:ring-8 ring-yellow-400 ring-inset scale-[1.02]' : ''}`}>
            {userPlan === plan.id && <div className="absolute top-2 right-2 md:top-4 md:right-4 bg-yellow-400 px-3 md:px-6 py-1 rounded-full border-2 border-black font-black text-[8px] md:text-[10px] uppercase text-black shadow-sm flex items-center gap-1 md:gap-2"><CheckCircle2 size={10} className="md:w-3 md:h-3" /> <span className="hidden sm:inline">YOUR PLAN</span><span className="sm:hidden">ACTIVE</span></div>}
            <h3 className="text-xl md:text-2xl mb-2 md:mb-4 font-black">{plan.name}</h3>
            <div className="text-4xl md:text-6xl italic mb-6 md:mb-10 font-black text-black">${plan.cost?.toFixed(2)}</div>
            <div className="space-y-2 md:space-y-4 bg-slate-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-[10px] md:text-xs font-black text-black">
              {plan.rates.map((r: { l: string; v: string; c?: string }, j: number) => <div key={j} className={`flex justify-between ${r.c || ''}`}><span>{r.l}</span> <span>{r.v}</span></div>)}
            </div>
            {/* Tier thresholds are season-aware (Wave A aggregation already
                sums against the right one); say which one is in force. */}
            {plan.id === 'Tiered' && tierThreshold != null && (
              <div
                data-testid="tier-threshold"
                className="mt-3 md:mt-5 bg-yellow-50 p-3 md:p-5 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-[9px] md:text-xs font-black"
              >
                <div className="flex justify-between">
                  <span>Tier 1 cut-off</span>
                  <span>{tierThreshold.toLocaleString()} kWh/mo</span>
                </div>
                <div className="mt-1 text-slate-600 font-bold normal-case">
                  {SEASON_INFO[seasonOfView].long}
                  {seasonsInView.length > 1 ? ' — window spans both seasons' : ''}
                  {otherTierThreshold != null
                    ? ` · other window: ${otherTierThreshold.toLocaleString()} kWh/mo`
                    : ''}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <TrueBillEstimate
        plan={userPlan}
        startDate={startDate}
        endDate={endDate}
        windowData={filteredData}
        summaries={summaries}
        allData={allData}
      />

      <ActualBillPanel summaries={summaries} allData={allData} plan={userPlan} />

      {comparison && (
        <div className="bg-black text-white p-6 md:p-12 rounded-[2rem] md:rounded-[3.5rem] border-4 md:border-8 border-yellow-400 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] md:shadow-[24px_24px_0px_0px_rgba(0,0,0,1)] flex flex-col lg:flex-row items-center justify-between gap-6 md:gap-10 font-black uppercase">
           <div className="space-y-2 md:space-y-4 text-center lg:text-left">
              <div className="text-[10px] md:text-xs tracking-[0.2em] md:tracking-[0.5em] text-yellow-400 font-black">Winning Economic Plan</div>
              <h4 className="text-3xl md:text-5xl italic leading-tight">THE BEST CHOICE IS <br/><span className="text-4xl sm:text-6xl md:text-8xl text-yellow-400 not-italic block mt-1 md:mt-2 font-black">{comparison.TOU < comparison.Tiered && comparison.TOU < comparison.ULO ? 'Time-of-Use' : comparison.Tiered < comparison.TOU && comparison.Tiered < comparison.ULO ? 'Tiered Pricing' : 'Ultra-Low Overnight'}</span></h4>
           </div>
           <div className="bg-white text-black p-6 md:p-10 rounded-2xl md:rounded-[2.5rem] border-4 border-black shadow-xl lg:rotate-3 flex flex-col items-center min-w-[200px] md:min-w-[300px]">
              <div className="text-[10px] tracking-widest text-slate-400 mb-1 md:mb-2 font-black text-center uppercase">Plan Impact</div>
              <div className="text-4xl md:text-7xl italic text-black whitespace-nowrap leading-none text-center font-black">
                {userPlan === (comparison.TOU < comparison.Tiered && comparison.TOU < comparison.ULO ? 'TOU' : comparison.Tiered < comparison.TOU && comparison.Tiered < comparison.ULO ? 'Tiered' : 'ULO') ? (
                     <span className="text-emerald-600 text-2xl md:text-5xl not-italic block">Optimum<br/>Choice!</span>
                    ) : ( <span className="text-red-600">-${Math.abs((comparison[userPlan as keyof Comparison] as number) - Math.min(comparison.TOU, comparison.Tiered, comparison.ULO)).toFixed(2)}</span> )}
              </div>
              <div className="text-[8px] md:text-[10px] mt-2 md:mt-4 font-black text-center text-black">vs. your current {userPlan} plan</div>
           </div>
        </div>
      )}
    </div>
  );
}
