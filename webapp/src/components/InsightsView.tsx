/**
 * Insights tab: usage anomalies + weekday × hour routine heatmap.
 *
 * Markup only — every piece of state lives in src/hooks/useDashboard.ts and is
 * handed in as props by Dashboard, so extracting this file is a pure render
 * split (styling and data-testids unchanged).
 */

"use client";

import { format } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { type Anomaly, type HeatmapData, type ProcessedPoint, type RateSet } from '@/lib/energy';
import { ExportCsvButton } from '@/components/ExportCsvButton';
import YearOverYearPanel from '@/components/YearOverYearPanel';
import ShiftOptimizer from '@/components/ShiftOptimizer';
import ShiftVerificationCard from '@/components/ShiftVerificationCard';
import EvScenarioCard from '@/components/EvScenarioCard';
import type { TouShiftAnalysis } from '@/lib/touShift';
import type { ShiftVerification } from '@/lib/shiftVerification';

export type InsightsViewProps = {
  anomalies: Anomaly[];
  heatmapData: HeatmapData;
  /** Current window rows: the CSV export downloads these. */
  filteredData: ProcessedPoint[];
  /**
   * Whole loaded dataset — the year-over-year panel gates and computes on
   * ALL history, never the visible window (a zoom must not change whether
   * "12+ months" of data exists).
   */
  processedData: ProcessedPoint[];
  /** Ranked ToU-shift recommendations over the full loaded dataset. */
  shiftAnalysis: TouShiftAnalysis;
  /** Weekly before/after of the shift, over the full loaded dataset. */
  verification: ShiftVerification;
  /** Rate schedule in force — the EV card prices three plans with it. */
  rates: RateSet | null;
};

export default function InsightsView({
  anomalies,
  heatmapData,
  filteredData,
  processedData,
  shiftAnalysis,
  verification,
  rates,
}: InsightsViewProps) {
  return (
    <div className="print-compact space-y-6 md:space-y-10 animate-in fade-in duration-500 font-black text-black uppercase" data-testid="insights-view">
      <div className="flex justify-end no-print">
        <ExportCsvButton rows={filteredData} />
      </div>

      {/* Ranked ToU-shift recommendations (recurring On-Peak blocks) */}
      <ShiftOptimizer analysis={shiftAnalysis} />

      {/* Did the last week's shift actually show up? */}
      <ShiftVerificationCard verification={verification} />

      {/* EV charging scenario — the household's own kWh, priced three ways. */}
      <EvScenarioCard rows={processedData} rates={rates} />

      <div className="bg-yellow-400 p-6 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black">
         <div className="flex items-center gap-2 md:gap-4 mb-4 md:mb-8 text-black font-black uppercase"><AlertTriangle size={24} className="md:w-10 md:h-10" strokeWidth={3} /><h3 className="text-2xl md:text-4xl">Usage Anomalies</h3></div>
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
         ) : <div className="bg-white p-6 md:p-8 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black text-lg md:text-xl text-black">No significant spikes detected!</div>}
      </div>

      <div className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] overflow-x-auto text-black">
         <h3 className="text-2xl md:text-4xl mb-4 md:mb-8 italic text-black font-black uppercase">Weekly Routine Heatmap</h3>
         {/* Wave H item 3: grid semantics + a title on every cell, so the
             hover tooltip also exists as text for keyboard/AT users. */}
         <div className="min-w-[600px] md:min-w-[800px] text-black" role="grid" aria-label="Average kWh by weekday and hour">
           <div role="row" className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-2 text-black font-black uppercase">
             <div role="presentation" className="w-12 md:w-16 font-black"></div>
             {Array.from({length:24}).map((_, i) => <div key={i} role="columnheader" className="text-center text-[8px] md:text-[10px] text-black font-black">{i}h</div>)}
           </div>
           {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, dIdx) => (
             <div key={day} role="row" className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-1 text-black font-black uppercase">
               <div role="rowheader" className="w-12 md:w-16 text-[10px] md:text-xs flex items-center font-black uppercase">{day}</div>
               {heatmapData.grid[dIdx].map((hour, hIdx) => {
                  const int = hour.avg / heatmapData.maxAvg;
                  let bg = 'bg-slate-100';
                  if (int > 0.8) bg = 'bg-red-600 border-red-800'; else if (int > 0.6) bg = 'bg-orange-500 border-orange-700'; else if (int > 0.4) bg = 'bg-yellow-400 border-yellow-600'; else if (int > 0.2) bg = 'bg-blue-300 border-blue-500';
                  const cellLabel = `${day} ${String(hIdx).padStart(2, '0')}:00 — ${hour.avg.toFixed(2)} kWh average`;
                  return <div key={hIdx} role="gridcell" aria-label={cellLabel} title={cellLabel} className={`heatmap-cell h-8 md:h-12 rounded-sm md:rounded-md border-b-2 md:border-b-4 ${bg} hover:scale-110 relative group transition-all font-black`}><div className="opacity-0 group-hover:opacity-100 absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-black text-white text-[8px] md:text-[10px] p-2 rounded pointer-events-none z-50 whitespace-nowrap font-black">{hour.avg.toFixed(2)} kWh</div></div>
               })}
             </div>
           ))}
         </div>
         <div className="mt-4 text-[8px] md:text-[10px] text-slate-400 font-black text-center md:hidden">Scroll horizontally to see all hours →</div>
         </div>

         {/* Year-over-year: gated on full-dataset span, not this window. */}
         <YearOverYearPanel processedData={processedData} />
         </div>
         );
         }
