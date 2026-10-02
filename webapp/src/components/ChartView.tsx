/**
 * Chart tab: zoom navigation, the bar chart, the three plan cards and the
 * "winning economic plan" banner.
 *
 * Markup only — every piece of state lives in src/hooks/useDashboard.ts and is
 * handed in as props by Dashboard, so extracting this file is a pure render
 * split (styling and data-testids unchanged).
 */

"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { ArrowLeft, ChevronLeft, ChevronRight, CheckCircle2 } from 'lucide-react';
import { type ChartDataItem, type ProcessedPoint, type RateSet, getBarColor } from '@/lib/energy';
import { type ZoomLevel } from '@/hooks/useDashboard';
import { ExportCsvButton } from '@/components/ExportCsvButton';
import { TrueBillEstimate } from '@/components/TrueBillEstimate';

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
  startDate: string;
  endDate: string;
};

export default function ChartView({
  zoomLevel, zoomTarget, goBack, navigatePeriod, setZoomLevelAndClear,
  activeChartData, handleBarClick, selectionCost,
  userPlan, setUserPlan, comparison, activeRateSet,
  filteredData, startDate, endDate,
}: ChartViewProps) {
  return (
    <div className="space-y-6 md:space-y-10" data-testid="chart-view">
      {/* Main Graph */}
      <div className="bg-white p-4 md:p-8 rounded-[1.5rem] md:rounded-[3rem] shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] border-4 border-black overflow-hidden relative z-10 text-black font-black uppercase">
        <div className="flex flex-col lg:flex-row justify-between items-center mb-6 md:mb-12 gap-4 md:gap-6 text-black font-black">
          <div className="flex items-center gap-3 md:gap-6 w-full lg:w-auto justify-between lg:justify-start">
            {zoomLevel !== 'monthly' && <button onClick={goBack} className="p-2 md:p-4 bg-white border-2 md:border-4 border-black rounded-xl md:rounded-2xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black hover:text-white transition-all"><ArrowLeft size={20} className="md:w-8 md:h-8" strokeWidth={4} /></button>}
            <div className="flex items-center gap-2 md:gap-4">
              <button onClick={() => navigatePeriod('prev')} className="p-1 md:p-2 border-2 md:border-4 border-black rounded-lg md:rounded-xl hover:bg-yellow-400 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none"><ChevronLeft size={16} className="md:w-6 md:h-6" strokeWidth={4} /></button>
              <h2 className="text-xl sm:text-3xl md:text-6xl tracking-tighter italic truncate max-w-[150px] sm:max-w-none">{zoomTarget || (zoomLevel === 'monthly' ? "Monthly Overview" : zoomLevel)}</h2>
              <button onClick={() => navigatePeriod('next')} className="p-1 md:p-2 border-2 md:border-4 border-black rounded-lg md:rounded-xl hover:bg-yellow-400 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none"><ChevronRight size={16} className="md:w-6 md:h-6" strokeWidth={4} /></button>
            </div>
          </div>
          <div className="flex bg-slate-100 p-1 rounded-lg md:rounded-xl border-2 md:border-4 border-black text-black">
             {(['monthly', 'weekly', 'daily'] as const).map((l) => <button key={l} onClick={() => setZoomLevelAndClear(l)} className={`px-3 md:px-6 py-1 md:py-2 rounded-md md:rounded-lg text-[10px] md:text-xs font-black transition-all ${zoomLevel === l && !zoomTarget ? 'bg-black text-white' : 'text-slate-500'}`}>{l}</button>)}
          </div>
          <div className="text-center lg:text-right text-black font-black">
             <div className="text-[8px] md:text-[10px]">Total selection cost ({userPlan})</div>
              <div className="text-2xl md:text-5xl italic mt-1 md:mt-2 font-black">${selectionCost.toFixed(2)}</div>
          </div>
        </div>

        <div className="h-[300px] md:h-[500px] -ml-4 md:-ml-6">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={activeChartData}>
              <CartesianGrid vertical={false} stroke="#000" strokeWidth={1} opacity={0.1} />
              <XAxis dataKey="label" tick={{fontSize: 12, fill: '#000', fontWeight: 900}} stroke="#000" strokeWidth={4} />
              <YAxis tick={{fontSize: 12, fill: '#000', fontWeight: 900}} stroke="#000" strokeWidth={4} />
              <Tooltip
                cursor={{fill: '#000', opacity: 0.05}}
                contentStyle={{borderRadius: '0px', border: '4px solid #000', boxShadow: '12px 12px 0px 0px #000', padding: '24px', background: '#FFF', pointerEvents: 'none'}}
                itemStyle={{color: '#000', fontWeight: 900, fontSize: '18px'}}
                labelStyle={{fontWeight: 900, color: '#000', marginBottom: '8px', textTransform: 'uppercase'}}
                formatter={(v, name) => {
                   if (name === 'usage') return [`${Number(v).toFixed(2)} kWh`, 'Power'];
                   return [`$${Number(v).toFixed(2)}`, String(name).replace('cost', '') + ' Cost'];
                }}
              />
              <Bar
                dataKey="usage"
                fill="#2563EB"
                stroke="#000"
                strokeWidth={3}
                radius={0}
                activeBar={{ fill: '#FFD600' }}
                onClick={(d) => handleBarClick(d as { key?: string } | null)}
                className="cursor-pointer"
              >
                {activeChartData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={getBarColor(zoomLevel, entry.key)}
                    style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                  />
                ))}
              </Bar>
              <Bar dataKey="costTOU" hide /> <Bar dataKey="costTiered" hide /> <Bar dataKey="costULO" hide />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-4 md:mt-6 flex justify-end">
          <ExportCsvButton rows={filteredData} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-10 text-black font-black uppercase">
        {[
          { id: 'Tiered', name: 'Tiered Pricing', cost: comparison?.Tiered, rates: [{ l: 'Tier 1', v: `${activeRateSet ? activeRateSet.tiered.tier1.toFixed(1) : '12.0'}¢` }, { l: 'Tier 2', v: `${activeRateSet ? activeRateSet.tiered.tier2.toFixed(1) : '14.2'}¢` }] },
          { id: 'TOU', name: 'Time-of-Use', cost: comparison?.TOU, rates: [{ l: 'Off-Peak', v: `${activeRateSet ? activeRateSet.tou.offPeak.toFixed(1) : '9.8'}¢`, c: 'text-emerald-600' }, { l: 'Mid-Peak', v: `${activeRateSet ? activeRateSet.tou.midPeak.toFixed(1) : '15.7'}¢`, c: 'text-yellow-600' }, { l: 'On-Peak', v: `${activeRateSet ? activeRateSet.tou.onPeak.toFixed(1) : '20.3'}¢`, c: 'text-red-600' }] },
          { id: 'ULO', name: 'Ultra-Low Over', cost: comparison?.ULO, rates: [{ l: 'Overnight', v: `${activeRateSet ? activeRateSet.ulo.overnight.toFixed(1) : '3.9'}¢`, c: 'text-purple-600' }, { l: 'Weekend Off', v: `${activeRateSet ? activeRateSet.ulo.weekendOffPeak.toFixed(1) : '9.8'}¢`, c: 'text-emerald-600' }, { l: 'Mid-Peak', v: `${activeRateSet ? activeRateSet.ulo.midPeak.toFixed(1) : '15.7'}¢`, c: 'text-yellow-600' }, { l: 'On-Peak', v: `${activeRateSet ? activeRateSet.ulo.onPeak.toFixed(1) : '39.1'}¢`, c: 'text-red-600' }] }
        ].map((plan, i) => (
          <div key={i} onClick={() => setUserPlan(plan.id as PlanId)} className={`bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[2rem] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative transition-all cursor-pointer ${userPlan === plan.id ? 'ring-4 md:ring-8 ring-yellow-400 ring-inset scale-[1.02]' : ''}`}>
            {userPlan === plan.id && <div className="absolute top-2 right-2 md:top-4 md:right-4 bg-yellow-400 px-3 md:px-6 py-1 rounded-full border-2 border-black font-black text-[8px] md:text-[10px] uppercase text-black shadow-sm flex items-center gap-1 md:gap-2"><CheckCircle2 size={10} className="md:w-3 md:h-3" /> <span className="hidden sm:inline">YOUR PLAN</span><span className="sm:hidden">ACTIVE</span></div>}
            <h3 className="text-xl md:text-2xl mb-2 md:mb-4 font-black">{plan.name}</h3>
            <div className="text-4xl md:text-6xl italic mb-6 md:mb-10 font-black text-black">${plan.cost?.toFixed(2)}</div>
            <div className="space-y-2 md:space-y-4 bg-slate-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-[10px] md:text-xs font-black text-black">
              {plan.rates.map((r: { l: string; v: string; c?: string }, j: number) => <div key={j} className={`flex justify-between ${r.c || ''}`}><span>{r.l}</span> <span>{r.v}</span></div>)}
            </div>
          </div>
        ))}
      </div>

      <TrueBillEstimate
        plan={userPlan}
        startDate={startDate}
        endDate={endDate}
        windowData={filteredData}
      />

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
