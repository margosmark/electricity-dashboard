/**
 * Ontario Energy Optimizer - Interaction Fix Edition
 *
 * Flow: Monthly ➔ Weekly ➔ Daily ➔ Hourly
 * State and handlers live in src/hooks/useDashboard.ts; the tab bodies live in
 * ChartView.tsx / InsightsView.tsx; this file renders the shell around them.
 */

"use client";

import React, { useMemo, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { HelpCircle, Zap, Upload, X, Trash2, Settings2 } from 'lucide-react';
import {
  type ChartDataItem,
  processRawData, filterByDateRange,
  buildActiveChartData, calculateComparison, calculateVampire,
  detectAnomalies, buildHeatmapData, calculateFullDataTotals,
} from '@/lib/energy';
import {
  useEnergyData, useActiveRateSet, useZoomNavigation, type ViewScope,
} from '@/hooks/useDashboard';
import { UsagePointPicker } from '@/components/UsagePointPicker';
import RateStalenessBanner from '@/components/RateStalenessBanner';
import { useRateStaleness } from '@/hooks/useRateStaleness';
import ChartView, { type PlanId } from '@/components/ChartView';
import InsightsView from '@/components/InsightsView';

export default function Dashboard() {
  const {
    rawData, rateHistory, loading, parsing,
    showUploadModal, setShowUploadModal,
    billingDay, startDate, endDate, setStartDate, setEndDate,
    viewScope, setViewScope,
    handleFileUpload, emergencyReset, updateBillingDay, applyViewScope,
    pendingUpload, chooseUsagePoint, cancelUsagePoint,
  } = useEnergyData();

  const [showVampireHelp, setShowVampireHelp] = React.useState(false);
  const [userPlan, setUserPlan] = React.useState<PlanId>('TOU');
  const [viewMode, setViewMode] = React.useState<'Chart' | 'Insights'>('Chart');

  // Keep navigatePeriod free of stale closures: getters read live state via
  // refs synced after render (lint-safe, no stale closures).
  const viewScopeRef = useRef<ViewScope>('BillingPeriod');
  const billingDayRef = useRef<number>(1);
  useEffect(() => {
    viewScopeRef.current = viewScope;
    billingDayRef.current = billingDay;
  }, [viewScope, billingDay]);

  const { zoomLevel, setZoomLevelAndClear, zoomTarget, handleBarClick, goBack, navigatePeriod } =
    useZoomNavigation(startDate, endDate, setStartDate, setEndDate,
      () => viewScopeRef.current, () => billingDayRef.current);

  // --- Calculations ---

  const processedData = useMemo(() => processRawData(rawData, rateHistory), [rawData, rateHistory]);

  const filteredData = useMemo(() => filterByDateRange(processedData, startDate, endDate), [processedData, startDate, endDate]);

  const activeChartData = useMemo(() => buildActiveChartData(filteredData, zoomLevel, zoomTarget), [filteredData, zoomLevel, zoomTarget]);

  const comparison = useMemo(() => calculateComparison(activeChartData), [activeChartData]);

  const vampire = useMemo(() => calculateVampire(filteredData), [filteredData]);

  const anomalies = useMemo(() => detectAnomalies(processedData, filteredData), [processedData, filteredData]);

  const heatmapData = useMemo(() => buildHeatmapData(filteredData), [filteredData]);

  // Whole-dataset totals for the strip — deliberately NOT filtered by the
  // visible window: this row answers "what would all my data have cost?".
  const totals = useMemo(() => calculateFullDataTotals(processedData), [processedData]);

  // Rate schedule in force for the plan cards — read live, never hardcoded.
  const activeRateSet = useActiveRateSet(processedData);

  // Once-per-session OEB staleness check (client-side, degrades silently).
  const staleness = useRateStaleness(rateHistory, processedData);

  const selectionCost = useMemo(() => {
    const costKey = `cost${userPlan}` as keyof ChartDataItem;
    return activeChartData.reduce((acc, curr) => acc + (curr[costKey] as number), 0);
  }, [activeChartData, userPlan]);

  if (loading) return <div className="p-20 text-center font-black text-black text-4xl animate-pulse bg-slate-50 min-screen h-screen flex items-center justify-center">PREPARING OPTIMIZER...</div>;

  return (
    <div className="space-y-10 text-black relative font-black uppercase">
      {/* Persistent OEB rate-staleness alert: rendered in both views until
          /api/rates ships the newer effectiveDate. */}
      <RateStalenessBanner result={staleness} />

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[300] flex items-center justify-center p-4">
          <div className="bg-white p-6 md:p-12 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] md:shadow-[20px_20px_0px_0px_rgba(0,0,0,1)] max-w-2xl w-full text-black">
             <h2 className="text-2xl md:text-5xl uppercase tracking-tighter mb-4 md:mb-6 flex items-center gap-2 md:gap-4 text-black font-black"><Upload size={24} className="md:w-12 md:h-12" strokeWidth={4} /> Link Data</h2>
             <p className="font-bold text-slate-600 text-sm md:text-lg mb-6 md:mb-10 text-black">Privacy-First: Data stays in your browser. <span className="underline decoration-blue-500">Upload your XML to begin.</span></p>
             <div className="relative">
                <input type="file" accept=".xml" onChange={handleFileUpload} disabled={parsing} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className={`p-8 md:p-16 border-4 md:border-8 border-dashed ${parsing ? 'border-yellow-400 bg-yellow-50' : 'border-black bg-slate-50'} rounded-xl md:rounded-[2rem] text-center`}><div className="text-lg md:text-2xl font-black uppercase text-black">{parsing ? "ANALYZING..." : "Drop XML Here"}</div></div>
             </div>
             {!parsing && <button onClick={() => setShowUploadModal(false)} className="mt-4 w-full py-3 bg-slate-100 border-2 border-black rounded-xl font-black uppercase text-xs md:hidden">Cancel</button>}
          </div>
        </div>
      )}

      {/* Multi-UsagePoint picker: only when the feed carried more than one meter */}
      {pendingUpload && (
        <UsagePointPicker
          fileName={pendingUpload.fileName}
          groups={pendingUpload.groups}
          onChoose={chooseUsagePoint}
          onCancel={cancelUsagePoint}
        />
      )}

      {/* Nav Controls */}
      <div className="relative z-[100] bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black flex flex-wrap gap-4 md:gap-6 items-center text-black">
        <div className="flex flex-wrap items-center gap-2 md:gap-4">
           <button onClick={() => setShowUploadModal(true)} title="Upload XML" className="p-3 md:p-4 bg-black text-white border-4 border-black rounded-xl md:rounded-2xl shadow-[4px_4px_0px_0px_rgba(37,99,235,1)] hover:translate-y-1 transition-all"><Upload size={18} strokeWidth={4} /></button>
           <button onClick={emergencyReset} title="Reset Data" className="p-3 md:p-4 bg-white text-red-600 border-4 border-black rounded-xl md:rounded-2xl shadow-[4px_4px_0px_0px_rgba(220,38,38,1)] hover:translate-y-1 transition-all"><Trash2 size={18} strokeWidth={4} /></button>

           <div className="flex items-center gap-1 md:gap-2">
             <input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); setViewScope('Custom'); }} className="p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[10px] md:text-sm text-black bg-white" />
             <span className="opacity-40 font-black text-[10px]">TO</span>
             <input type="date" value={endDate} onChange={e => { setEndDate(e.target.value); setViewScope('Custom'); }} className="p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[10px] md:text-sm text-black bg-white" />
           </div>

           <div className="flex gap-1">
             <button onClick={() => { applyViewScope('BillingPeriod'); setZoomLevelAndClear('monthly'); }} className={`p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[8px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'BillingPeriod' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>Billing Period</button>

             <button onClick={() => { applyViewScope('Month'); setZoomLevelAndClear('monthly'); }} className={`p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[8px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'Month' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>Month</button>

             <button onClick={() => { applyViewScope('YTD'); setZoomLevelAndClear('monthly'); }} className={`p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[8px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'YTD' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>YTD</button>
           </div>
        </div>

        <div className="flex bg-black p-1 rounded-xl gap-1 lg:ml-auto">
          <button onClick={() => setViewMode('Chart')} className={`px-4 md:px-6 py-2 rounded-lg text-[10px] md:text-xs font-black transition-all ${viewMode === 'Chart' ? 'bg-white text-black' : 'text-slate-400'}`}>CHART</button>
          <button onClick={() => setViewMode('Insights')} className={`px-4 md:px-6 py-2 rounded-lg text-[10px] md:text-xs font-black transition-all ${viewMode === 'Insights' ? 'bg-yellow-400 text-black' : 'text-slate-400'}`}>INSIGHTS</button>
        </div>

        <div className="flex flex-wrap items-center gap-3 md:gap-4 lg:ml-auto">
           <div className="bg-slate-100 p-2 md:p-3 rounded-xl md:rounded-2xl border-2 md:border-4 border-black flex items-center gap-2 md:gap-3">
              <Settings2 size={16} className="text-slate-500" />
              <input type="number" min="1" max="31" value={billingDay} onChange={e => updateBillingDay(parseInt(e.target.value), startDate)} className="w-8 md:w-12 bg-transparent text-xs md:text-sm outline-none text-black font-black" />
           </div>
           <div data-testid="plan-switcher" className="bg-slate-100 p-1 md:p-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-black flex gap-1">
               {(['Tiered', 'TOU', 'ULO'] as const).map((p) => <button key={p} onClick={() => setUserPlan(p)} className={`px-3 md:px-6 py-1 md:py-2 rounded-lg md:rounded-xl text-[8px] md:text-[10px] font-black transition-all ${userPlan === p ? 'bg-black text-white shadow-lg' : 'text-black hover:bg-white'}`}>{p}</button>)}
           </div>
           <button onClick={() => setShowVampireHelp(true)} className="bg-blue-600 text-white p-3 md:p-6 rounded-2xl md:rounded-3xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] border-2 md:border-4 border-black text-center font-black relative hover:scale-105 transition-all group min-w-[120px]">
              <div className="text-[8px] md:text-[10px] uppercase flex items-center justify-center gap-1">Vampire Load <HelpCircle size={8} className="opacity-50 md:size-10 group-hover:opacity-100" /></div>
              <div className="text-xl md:text-4xl italic">${vampire.cost.toFixed(2)}</div>
           </button>
        </div>
      </div>

      {/* Full-data totals strip: every reading ever loaded, not just the window above. */}
      {totals && (
        <div className="relative z-[100] bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black flex flex-wrap gap-4 md:gap-6 items-center text-black" data-testid="totals-strip">
          <div className="bg-black text-white px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-black">
            <div className="text-[8px] md:text-[10px] text-yellow-400">Since {format(new Date(totals.firstDate + 'T00:00:00'), 'MMM d, yyyy')}</div>
            <div className="text-xl md:text-3xl italic font-black">{totals.totalKwh.toFixed(0)} kWh</div>
          </div>

          <div className="flex flex-wrap gap-3 md:gap-4">
            {([
              { id: 'TOU', label: 'Time-of-Use', cost: totals.costTOU },
              { id: 'Tiered', label: 'Tiered', cost: totals.costTiered },
              { id: 'ULO', label: 'Ultra-Low Overnight', cost: totals.costULO },
            ] as const).map((p) => (
              <div key={p.id} className={`px-3 md:px-5 py-2 rounded-xl md:rounded-2xl border-4 border-black ${p.id === totals.bestPlan ? 'bg-emerald-400' : p.id === totals.worstPlan ? 'bg-red-400' : 'bg-slate-100'}`}>
                <div className="text-[8px] md:text-[10px]">{p.label}</div>
                <div className="text-lg md:text-2xl italic font-black">${p.cost.toFixed(2)}</div>
              </div>
            ))}
          </div>

          <div className="bg-yellow-400 px-4 md:px-6 py-3 rounded-xl md:rounded-2xl border-4 border-black">
            <div className="text-[8px] md:text-[10px]">Best vs worst plan</div>
            <div className="text-lg md:text-2xl italic font-black">${totals.planDelta.toFixed(2)}</div>
            <div className="text-[8px] md:text-[10px]">{totals.worstPlan} − {totals.bestPlan}</div>
          </div>

          <div className="text-[8px] md:text-[10px] text-slate-500 max-w-[240px] md:max-w-none">
            Whole dataset ({format(new Date(totals.firstDate + 'T00:00:00'), 'MMM d')} – {format(new Date(totals.lastDate + 'T00:00:00'), 'MMM d, yyyy')}), variable charges only.
          </div>
        </div>
      )}

      {/* Vampire Load Help Modal */}
      {showVampireHelp && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[400] flex items-center justify-center p-4">
          <div className="bg-white p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] md:shadow-[20px_20px_0px_0px_rgba(0,0,0,1)] max-w-xl w-full text-black relative">
             <button onClick={() => setShowVampireHelp(false)} className="absolute top-4 right-4 md:top-6 md:right-6 p-2 hover:bg-slate-100 rounded-full transition-all"><X size={24} className="md:w-8 md:h-8" strokeWidth={4} /></button>
             <h2 className="text-2xl md:text-4xl uppercase tracking-tighter mb-4 md:mb-6 flex items-center gap-2 md:gap-4 font-black"><Zap size={24} className="text-blue-600 md:w-10 md:h-10" strokeWidth={4} /> What is Vampire Load?</h2>
             <div className="space-y-4 md:space-y-6 font-bold text-slate-700">
                <p className="text-xs md:text-base">Vampire load (or standby power) is the electricity consumed by appliances and electronics while they are switched off or in standby mode.</p>
                <div className="bg-blue-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-blue-200 text-blue-900">
                   <h4 className="font-black uppercase text-[10px] md:text-sm mb-2">How we calculate it:</h4>
                   <ul className="list-disc ml-4 md:ml-5 space-y-1 md:space-y-2 text-[10px] md:text-sm">
                       <li>We analyze your entire dataset to find your <strong>&quot;Baseline&quot;</strong> usage (the lowest 5% of your hourly readings).</li>
                      <li>This baseline represents the constant power draw that never turns off (fridges, clocks, chargers, smart devices).</li>
                      <li>Your current baseline is approximately <span className="font-black text-blue-600">{vampire.watts.toFixed(0)} Watts</span>.</li>
                   </ul>
                </div>
                <p className="text-[10px] md:text-sm">The cost is estimated by multiplying this constant draw by 24 hours a day for 30 days, using your current <strong>Off-Peak</strong> rate.</p>
                <button onClick={() => setShowVampireHelp(false)} className="w-full py-3 md:py-4 bg-black text-white rounded-xl md:rounded-2xl font-black uppercase hover:bg-blue-600 transition-colors mt-2 md:mt-4">Got it</button>
             </div>
          </div>
        </div>
      )}

      {viewMode === 'Chart' && (
        <ChartView
          zoomLevel={zoomLevel}
          zoomTarget={zoomTarget}
          goBack={goBack}
          navigatePeriod={navigatePeriod}
          setZoomLevelAndClear={setZoomLevelAndClear}
          activeChartData={activeChartData}
          handleBarClick={handleBarClick}
          selectionCost={selectionCost}
          userPlan={userPlan}
          setUserPlan={setUserPlan}
          comparison={comparison}
          activeRateSet={activeRateSet}
          filteredData={filteredData}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {viewMode === 'Insights' && (
        <InsightsView
          anomalies={anomalies}
          heatmapData={heatmapData}
          filteredData={filteredData}
          processedData={processedData}
        />
      )}
    </div>
  );
}
