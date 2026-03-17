/**
 * Oakville Hydro Green Button Data Dashboard
 * 
 * This component provides an advanced, interactive analysis of electricity usage data.
 * It supports multiple Ontario pricing plans (TOU, Tiered, ULO), handles historical 
 * rate changes, and provides granular drill-downs from monthly trends to hourly profiles.
 */

"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import { 
  format, isWeekend, getMonth, getHours, startOfWeek, 
  startOfMonth, lastDayOfMonth, startOfYear, addMonths, 
  subMonths, setDate, isBefore, addDays, subDays 
} from 'date-fns';
import { TrendingUp, DollarSign, ArrowLeft, ChevronLeft, ChevronRight, HelpCircle, Zap, Calendar, CheckCircle2, Settings2 } from 'lucide-react';

// --- Types ---

type DataPoint = { timestamp: number, usage_kwh: number };

/**
 * Represents a set of Ontario electricity rates effective from a specific date.
 */
type RateSet = {
  effectiveDate: string,
  tou: { offPeak: number, midPeak: number, onPeak: number },
  tiered: { tier1: number, tier2: number, thresholdWinter: number, thresholdSummer: number },
  ulo: { overnight: number, weekendOffPeak: number, midPeak: number, onPeak: number }
};

/**
 * An enriched data point with calculated costs and categories.
 */
type ProcessedPoint = DataPoint & {
  dateObj: Date,
  dayStr: string,
  hourStr: string,
  touCategory: 'Off-Peak' | 'Mid-Peak' | 'On-Peak',
  uloCategory: 'Overnight' | 'Weekend Off-Peak' | 'Mid-Peak' | 'On-Peak',
  isWinter: boolean,
  costTOU: number,
  costTiered: number,
  costULO: number,
  activeRateSet: RateSet
};

export default function Dashboard() {
  // --- State ---
  const [rawData, setRawData] = useState<DataPoint[]>([]);
  const [rateHistory, setRateHistory] = useState<RateSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [showVampireHelp, setShowVampireHelp] = useState(false);
  const [userPlan, setUserPlan] = useState<'TOU' | 'Tiered' | 'ULO'>('TOU');
  const [billingDay, setBillingDay] = useState<number>(1);
  
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [granularity, setGranularity] = useState<'Daily' | 'Weekly' | 'Monthly'>('Monthly');
  const [drilldownDay, setDrilldownDay] = useState<string | null>(null);
  const [drilldownMonth, setDrilldownMonth] = useState<string | null>(null);

  /**
   * Helper: Calculates the start and end dates of a billing period
   * given a reference date and the billing cycle start day.
   */
  const getBillingPeriod = (refDate: Date, bDay: number) => {
    let start = setDate(startOfMonth(refDate), bDay);
    if (isBefore(refDate, start)) {
      start = subMonths(start, 1);
    }
    const end = subDays(addMonths(start, 1), 1);
    return { start, end };
  };

  // --- Data Fetching ---
  useEffect(() => {
    async function fetchData() {
      try {
        const [elecRes, ratesRes] = await Promise.all([ 
          fetch('/api/electricity'), 
          fetch('/api/rates') 
        ]);
        const elecJson = await elecRes.json();
        const ratesJson = await ratesRes.json();
        
        setRawData(elecJson.data || []);
        setRateHistory(ratesJson.historicalRates || []);
        
        // Initialize with the most recent billing period available in the data
        if (elecJson.data && elecJson.data.length > 0) {
           const last = new Date(elecJson.data[elecJson.data.length - 1].timestamp * 1000);
           const period = getBillingPeriod(last, billingDay);
           setStartDate(format(period.start, 'yyyy-MM-dd'));
           setEndDate(format(period.end, 'yyyy-MM-dd'));
        }
      } catch (e) { 
        console.error("Critical error in Dashboard data fetching:", e); 
      } finally { 
        setLoading(false); 
      }
    }
    fetchData();
  }, [billingDay]);

  /**
   * Quick-jump range selectors
   */
  const setRange = (type: 'billing' | 'ytd') => {
    if (rawData.length === 0) return;
    const lastDate = new Date(rawData[rawData.length - 1].timestamp * 1000);
    if (type === 'billing') {
      const period = getBillingPeriod(lastDate, billingDay);
      setStartDate(format(period.start, 'yyyy-MM-dd'));
      setEndDate(format(period.end, 'yyyy-MM-dd'));
    } else {
      setStartDate(format(startOfYear(lastDate), 'yyyy-MM-dd'));
      setEndDate(format(lastDate, 'yyyy-MM-dd'));
    }
    setDrilldownDay(null); setDrilldownMonth(null);
  };

  /**
   * Core Processing Memo
   * Converts raw timestamps into human-readable dates and applies 
   * Ontario Time-of-Use (TOU) and Ultra-Low Overnight (ULO) logic.
   * Also matches every record to its historically accurate rate set.
   */
  const processedData = useMemo(() => {
    if (rateHistory.length === 0) return [];
    const sortedRates = [...rateHistory].sort((a,b) => b.effectiveDate.localeCompare(a.effectiveDate));

    return rawData.map(d => {
      const dateObj = new Date(d.timestamp * 1000);
      const m = getMonth(dateObj); 
      const h = getHours(dateObj);
      const isWkend = isWeekend(dateObj); 
      const isWinter = m >= 10 || m <= 3; // Ontario Winter is Nov 1 - Apr 30
      const dayStr = format(dateObj, 'yyyy-MM-dd');
      
      // Match the correct historical rate set for this date
      const activeRateSet = sortedRates.find(r => dayStr >= r.effectiveDate) || sortedRates[sortedRates.length - 1];

      // Standard TOU Classification
      let touCat: 'Off-Peak' | 'Mid-Peak' | 'On-Peak' = 'Off-Peak';
      if (!isWkend) {
        if (h >= 19 || h < 7) touCat = 'Off-Peak';
        else if (isWinter) {
          if ((h >= 7 && h < 11) || (h >= 17 && h < 19)) touCat = 'On-Peak';
          else touCat = 'Mid-Peak';
        } else {
          if (h >= 11 && h < 17) touCat = 'On-Peak';
          else touCat = 'Mid-Peak';
        }
      }
      
      // ULO (Ultra-Low Overnight) Classification
      let uloCat: 'Overnight' | 'Weekend Off-Peak' | 'Mid-Peak' | 'On-Peak' = 'Mid-Peak';
      if (h >= 23 || h < 7) uloCat = 'Overnight';
      else if (isWkend) uloCat = 'Weekend Off-Peak';
      else if (h >= 16 && h < 21) uloCat = 'On-Peak';
      else uloCat = 'Mid-Peak';

      const costTOU = d.usage_kwh * (activeRateSet.tou[touCat === 'Off-Peak' ? 'offPeak' : touCat === 'Mid-Peak' ? 'midPeak' : 'onPeak'] / 100);
      const costULO = d.usage_kwh * (activeRateSet.ulo[uloCat === 'Overnight' ? 'overnight' : uloCat === 'Weekend Off-Peak' ? 'weekendOffPeak' : uloCat === 'Mid-Peak' ? 'midPeak' : 'onPeak'] / 100);
      
      // Hourly tiered cost (approximated for per-reading metrics using Tier 1)
      const costTiered = d.usage_kwh * (activeRateSet.tiered.tier1 / 100);

      return { ...d, dateObj, dayStr, hourStr: format(dateObj, 'HH:mm'), touCategory: touCat, uloCategory: uloCat, isWinter, costTOU, costULO, costTiered, activeRateSet } as ProcessedPoint;
    });
  }, [rawData, rateHistory]);

  /**
   * Filtered dataset based on the current date range picker.
   */
  const filteredData = useMemo(() => {
    if (!startDate || !endDate) return processedData;
    const s = new Date(startDate + "T00:00:00"); const e = new Date(endDate + "T23:59:59");
    return processedData.filter(d => d.dateObj >= s && d.dateObj <= e);
  }, [processedData, startDate, endDate]);

  /**
   * Chart Aggregation Logic
   * Groups filtered data by the selected granularity (Day, Week, Month)
   * and calculates pro-rated tiered costs for each bar.
   */
  const activeChartData = useMemo(() => {
    // Pro-rates the Tiered pricing threshold across a set of days
    const getActualTieredCost = (usage: number, readings: ProcessedPoint[]) => {
      if (readings.length === 0) return 0;
      const first = readings[0];
      const days = new Set(readings.map(r => r.dayStr)).size;
      const thresh = (first.isWinter ? first.activeRateSet.tiered.thresholdWinter : first.activeRateSet.tiered.thresholdSummer) * (days / 30.4);
      return usage <= thresh ? usage * (first.activeRateSet.tiered.tier1 / 100) : (thresh * (first.activeRateSet.tiered.tier1 / 100)) + ((usage - thresh) * (first.activeRateSet.tiered.tier2 / 100));
    };

    if (drilldownDay) {
       return filteredData.filter(d => d.dayStr === drilldownDay).map(d => ({ 
         label: d.hourStr, usage: d.usage_kwh, key: d.hourStr, 
         costTOU: d.costTOU, costULO: d.costULO, costTiered: d.costTiered 
       })).sort((a,b) => a.key.localeCompare(b.key));
    }
    
    const map = new Map<string, { label: string, usage: number, key: string, costTOU: number, costULO: number, readings: ProcessedPoint[] }>();
    filteredData.forEach(d => {
      let label = d.dayStr; let key = d.dayStr;
      if (drilldownMonth) { 
        if (format(d.dateObj, 'yyyy-MM') !== drilldownMonth) return;
        label = format(d.dateObj, 'MMM dd'); key = d.dayStr; 
      }
      else if (granularity === 'Monthly') { label = format(d.dateObj, 'MMM yyyy'); key = format(d.dateObj, 'yyyy-MM'); }
      else if (granularity === 'Weekly') { const monday = startOfWeek(d.dateObj, { weekStartsOn: 1 }); label = "Week of " + format(monday, 'MMM dd'); key = format(monday, 'yyyy-MM-dd'); }
      
      if (!map.has(key)) map.set(key, { label, usage: 0, key, costTOU: 0, costULO: 0, readings: [] });
      const obj = map.get(key)!;
      obj.usage += d.usage_kwh;
      obj.costTOU += d.costTOU;
      obj.costULO += d.costULO;
      obj.readings.push(d);
    });

    return Array.from(map.values()).map(val => ({
      ...val,
      costTiered: getActualTieredCost(val.usage, val.readings)
    })).sort((a,b) => a.key.localeCompare(b.key));
  }, [filteredData, granularity, drilldownDay, drilldownMonth]);

  /**
   * Final Cost Comparison Summary
   * Compares the total spending across all three plans for the visible range.
   */
  const comparison = useMemo(() => {
    if (filteredData.length === 0) return null;
    const totalTOU = filteredData.reduce((a, b) => a + b.costTOU, 0);
    const totalULO = filteredData.reduce((a, b) => a + b.costULO, 0);
    let totalTiered = 0;
    const dailyData = new Map<string, { usage: number, rateSet: RateSet, isWinter: boolean }>();
    filteredData.forEach(d => { if (!dailyData.has(d.dayStr)) dailyData.set(d.dayStr, { usage: 0, rateSet: d.activeRateSet, isWinter: d.isWinter }); dailyData.get(d.dayStr)!.usage += d.usage_kwh; });
    dailyData.forEach((val) => {
      const thresh = (val.isWinter ? val.rateSet.tiered.thresholdWinter : val.rateSet.tiered.thresholdSummer) / 30.4;
      if (val.usage <= thresh) totalTiered += val.usage * (val.rateSet.tiered.tier1 / 100);
      else totalTiered += (thresh * (val.rateSet.tiered.tier1 / 100)) + ((val.usage - thresh) * (val.rateSet.tiered.tier2 / 100));
    });
    return { TOU: totalTOU, Tiered: totalTiered, ULO: totalULO };
  }, [filteredData]);

  /**
   * Vampire Load Calculation
   * Finds the "Sustained Minimum" usage. We use the 5th percentile of 
   * hourly usage to avoid absolute minimum outliers (like a power outage)
   * while accurately identifying the true baseline load of always-on devices.
   */
  const vampire = useMemo(() => {
     if (filteredData.length === 0) return { cost: 0, watts: 0 };
     const sortedUsage = filteredData.map(d => d.usage_kwh).sort((a, b) => a - b);
     // 5th percentile calculation
     const baselineKwh = sortedUsage[Math.floor(sortedUsage.length * 0.05)] || sortedUsage[0];
     const lastRate = filteredData[filteredData.length - 1].activeRateSet.tou.offPeak;
     return { 
       cost: baselineKwh * 24 * 30 * (lastRate / 100), 
       watts: baselineKwh * 1000 
     };
  }, [filteredData]);

  /**
   * Pagination: Jumps to the next or previous billing period.
   */
  const navigatePeriod = (direction: 'prev' | 'next') => {
    const currentStart = new Date(startDate + "T00:00:00");
    const newStart = direction === 'next' ? addMonths(currentStart, 1) : subMonths(currentStart, 1);
    const period = getBillingPeriod(newStart, billingDay);
    
    if (processedData.some(d => d.dateObj >= period.start && d.dateObj <= period.end)) {
      setStartDate(format(period.start, 'yyyy-MM-dd'));
      setEndDate(format(period.end, 'yyyy-MM-dd'));
      setDrilldownDay(null); setDrilldownMonth(null);
    }
  };

  /**
   * Chart Interaction: Drilling down from Month to Day or Day to Hour.
   */
  const handleBarClick = (item: any) => {
    if (!item || !item.key) return;
    if (drilldownMonth) { 
      setDrilldownDay(item.key);
    } else if (!drilldownDay) {
      if (granularity === 'Monthly') setDrilldownMonth(item.key);
      else setDrilldownDay(item.key);
    }
  };

  if (loading) return <div className="p-20 text-center font-black text-black text-4xl italic animate-bounce uppercase">Analyzing Power Grid...</div>;

  return (
    <div className="space-y-10 text-black">
      
      {/* Controls Bar - HIGHER Z-INDEX to prevent popups from being hidden */}
      <div className="relative z-[100] bg-white p-6 rounded-3xl shadow-xl border-4 border-black flex flex-wrap gap-6 items-center">
        <div className="flex items-center gap-2">
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="p-3 border-4 border-black rounded-xl font-black text-black bg-white" />
          <span className="font-black">TO</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="p-3 border-4 border-black rounded-xl font-black text-black bg-white" />
          <div className="flex gap-2 ml-2">
            <button onClick={() => setRange('billing')} className="p-3 bg-yellow-400 border-4 border-black rounded-xl font-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 active:translate-y-1 active:shadow-none transition-all text-[10px]">BILLING PERIOD</button>
            <button onClick={() => setRange('ytd')} className="p-3 bg-yellow-400 border-4 border-black rounded-xl font-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 active:translate-y-1 active:shadow-none transition-all text-[10px]">YTD</button>
          </div>
        </div>

        <div className="flex p-1.5 bg-black rounded-2xl gap-1">
          {['Daily', 'Weekly', 'Monthly'].map(g => (
            <button key={g} onClick={() => {setGranularity(g as any); setDrilldownDay(null); setDrilldownMonth(null);}}
              className={`px-6 py-2 rounded-xl text-sm font-black transition-all ${granularity === g && !drilldownMonth ? 'bg-white text-black' : 'text-slate-400 hover:text-white'}`}>{g}</button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-4">
           {/* Billing Settings */}
           <div className="bg-slate-100 p-3 rounded-2xl border-4 border-black flex items-center gap-3">
              <Settings2 size={20} className="text-slate-500" />
              <div className="flex flex-col">
                <span className="text-[8px] font-black uppercase text-slate-500">Billing Day</span>
                <input type="number" min="1" max="31" value={billingDay} onChange={e => setBillingDay(parseInt(e.target.value))} 
                       className="w-12 bg-transparent font-black text-sm outline-none" title="Billing Cycle Start Day" />
              </div>
           </div>
           
           {/* Plan Selection */}
           <div className="bg-slate-100 p-2 rounded-2xl border-4 border-black flex gap-1">
              {(['TOU', 'Tiered', 'ULO'] as const).map(p => (
                <button key={p} onClick={() => setUserPlan(p)} className={`px-4 py-2 rounded-xl text-[10px] font-black transition-all ${userPlan === p ? 'bg-black text-white' : 'text-black hover:bg-white'}`}>{p}</button>
              ))}
           </div>
           
           {/* Vampire Load Display */}
           <button onClick={() => setShowVampireHelp(!showVampireHelp)} className="bg-blue-600 text-white p-6 rounded-3xl shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] border-4 border-black relative transition-transform hover:scale-105 active:rotate-1">
              <div className="text-[10px] font-black uppercase tracking-[0.2em] mb-1 flex items-center gap-1 text-white">Vampire Load <HelpCircle size={10} /></div>
              <div className="text-4xl font-black italic tracking-tighter text-white">${vampire.cost.toFixed(2)}<span className="text-xs not-italic opacity-80 ml-1">/mo</span></div>
              {showVampireHelp && (
                <div className="absolute top-full right-0 mt-4 w-72 p-6 bg-white border-4 border-black rounded-2xl shadow-2xl z-[200] text-black text-[11px] font-black leading-relaxed text-left">
                  <p className="mb-3 text-blue-600 uppercase border-b-2 border-slate-100 pb-2">How we calculate this:</p>
                  <p className="mb-2">We analyze your entire selected period and find your **sustained minimum usage** (the 5th percentile).</p>
                  <p className="mb-2">Your home pulls approx. <span className="text-blue-600 underline font-black">{vampire.watts.toFixed(0)} Watts</span> even when you aren't using anything.</p>
                  <p>This is the cost of fridges, standby TVs, internet routers, and clocks running 24/7.</p>
                </div>
              )}
           </button>
        </div>
      </div>

      {/* Main Chart Section */}
      <div className="bg-white p-8 rounded-[2.5rem] shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] border-4 border-black overflow-hidden relative z-10">
        <div className="flex justify-between items-center mb-12">
          <div className="flex items-center gap-6">
            {(drilldownDay || drilldownMonth) && (
              <button onClick={() => {setDrilldownDay(null); setDrilldownMonth(null);}} className="p-4 bg-white border-4 border-black rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black hover:text-white transition-all text-black" title="Back to main view"><ArrowLeft size={32} strokeWidth={4} /></button>
            )}
            <div className="flex items-center gap-4">
              <button onClick={() => navigatePeriod('prev')} className="p-2 border-4 border-black rounded-xl hover:bg-yellow-400 transition-all text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none" title="Previous period"><ChevronLeft size={24} strokeWidth={4} /></button>
              <h2 className="text-6xl font-black text-black tracking-tighter uppercase leading-none italic">{drilldownDay ? drilldownDay : drilldownMonth ? format(new Date(drilldownMonth + "-01T00:00:00"), 'MMMM yyyy') : granularity === 'Monthly' ? 'Monthly Trend' : `${startDate} to ${endDate}`}</h2>
              <button onClick={() => navigatePeriod('next')} className="p-2 border-4 border-black rounded-xl hover:bg-yellow-400 transition-all text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none" title="Next period"><ChevronRight size={24} strokeWidth={4} /></button>
            </div>
          </div>
          <div className="text-right">
             <div className="text-xs font-black uppercase text-slate-400 tracking-widest">Selected Period Cost ({userPlan})</div>
             <div className="text-5xl font-black text-black italic leading-none block mt-2">${activeChartData.reduce((acc, curr) => acc + (curr as any)[`cost${userPlan}`], 0).toFixed(2)}</div>
          </div>
        </div>

        <div className="h-[500px] -ml-6">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={activeChartData as any[]}>
              <CartesianGrid vertical={false} stroke="#000" strokeWidth={1} opacity={0.1} />
              <XAxis dataKey="label" tick={{fontSize: 12, fill: '#000', fontWeight: 900}} stroke="#000" strokeWidth={4} />
              <YAxis tick={{fontSize: 12, fill: '#000', fontWeight: 900}} stroke="#000" strokeWidth={4} />
              <Tooltip cursor={{fill: '#000', opacity: 0.05}} 
                contentStyle={{borderRadius: '0px', border: '4px solid #000', boxShadow: '12px 12px 0px 0px #000', padding: '24px', background: '#FFF'}} 
                itemStyle={{color: '#000', fontWeight: 900, fontSize: '16px', padding: '2px 0'}} 
                labelStyle={{fontWeight: 900, color: '#000', marginBottom: '12px', textTransform: 'uppercase', borderBottom: '2px solid #000', paddingBottom: '8px'}} 
                formatter={(v: any, name: any) => {
                   if (name === 'usage') return [`${Number(v).toFixed(2)} kWh`, 'TOTAL POWER'];
                   if (name === 'costTOU') return [`$${Number(v).toFixed(2)}`, 'TIME-OF-USE COST'];
                   if (name === 'costTiered') return [`$${Number(v).toFixed(2)}`, 'TIERED COST'];
                   if (name === 'costULO') return [`$${Number(v).toFixed(2)}`, 'ULO COST'];
                   return [`$${Number(v).toFixed(2)}`, name];
                }}
              />
              <Bar dataKey="usage" fill="#2563EB" stroke="#000" strokeWidth={3} radius={0} activeBar={{ fill: '#FFD600' }} onClick={(d: any) => handleBarClick(d)} className="cursor-pointer">
                {activeChartData.map((entry, index) => <Cell key={`cell-${index}`} />)}
              </Bar>
              <Bar dataKey="costTOU" hide />
              <Bar dataKey="costTiered" hide />
              <Bar dataKey="costULO" hide />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Pricing Plan Comparison Details */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-10">
        {[
          { id: 'Tiered', name: 'Tiered Pricing', cost: comparison?.Tiered, icon: <Zap className="text-emerald-600" />, rates: [
            { label: 'Tier 1 (Up to 1000kWh)', val: '12.0¢' }, { label: 'Tier 2 (Over Limit)', val: '14.2¢' }
          ]},
          { id: 'TOU', name: 'Time-of-Use', cost: comparison?.TOU, icon: <Zap className="text-blue-600" />, rates: [
            { label: 'Off-Peak', val: '9.8¢', color: 'text-emerald-600' }, { label: 'Mid-Peak', val: '15.7¢', color: 'text-yellow-600' }, { label: 'On-Peak', val: '20.3¢', color: 'text-red-600' }
          ]},
          { id: 'ULO', name: 'Ultra-Low Over', cost: comparison?.ULO, icon: <Zap className="text-purple-600" />, rates: [
            { label: 'Overnight (11pm-7am)', val: '3.9¢', color: 'text-purple-600' }, { label: 'Weekend Off-Peak', val: '9.8¢', color: 'text-emerald-600' }, { label: 'Mid-Peak', val: '15.7¢', color: 'text-yellow-600' }, { label: 'On-Peak', val: '39.1¢', color: 'text-red-600' }
          ]}
        ].map((plan, i) => (
          <div key={i} className={`bg-white p-10 rounded-[2rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden transition-all ${userPlan === plan.id ? 'ring-8 ring-yellow-400 ring-inset scale-[1.02]' : 'hover:scale-[1.01]'}`}>
            {userPlan === plan.id && <div className="absolute top-4 right-4 bg-yellow-400 px-3 py-1 rounded-full border-2 border-black font-black text-[10px] uppercase flex items-center gap-1 shadow-sm"><CheckCircle2 size={12} /> YOUR PLAN</div>}
            <div className="flex items-center gap-3 mb-8">
              <div className="p-3 bg-slate-50 border-4 border-black rounded-xl">{React.cloneElement(plan.icon as any, { strokeWidth: 4 })}</div>
              <h3 className="text-2xl font-black uppercase tracking-tighter text-black">{plan.name}</h3>
            </div>
            <div className="text-6xl font-black italic mb-10 text-black">${plan.cost?.toFixed(2)}</div>
            <div className="space-y-4 bg-slate-50 p-6 rounded-2xl border-4 border-black text-xs font-black uppercase tracking-widest text-black">
              {plan.rates.map((r, j) => (
                <div key={j} className={`flex justify-between ${r.color || ''}`}><span>{r.label}</span> <span>{r.val}</span></div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Financial Verdict Section */}
      {comparison && (
        <div className="bg-black text-white p-12 rounded-[3.5rem] border-8 border-yellow-400 shadow-[24px_24px_0px_0px_rgba(0,0,0,1)] flex flex-col lg:flex-row items-center justify-between gap-10 transform -rotate-1 hover:rotate-0 transition-transform">
           <div className="space-y-4 text-center lg:text-left">
              <div className="text-xs font-black uppercase tracking-[0.5em] text-yellow-400">Winning Economic Plan</div>
              <h4 className="text-5xl font-black italic leading-tight text-white uppercase tracking-tighter">
                THE BEST CHOICE IS <br/>
                <span className="text-8xl text-yellow-400 not-italic uppercase block mt-2">
                  {comparison.TOU < comparison.Tiered && comparison.TOU < comparison.ULO ? 'Time-of-Use' : 
                   comparison.Tiered < comparison.TOU && comparison.Tiered < comparison.ULO ? 'Tiered Pricing' : 'Ultra-Low Overnight'}
                </span>
              </h4>
           </div>
           <div className="bg-white text-black p-10 rounded-[2.5rem] border-4 border-black shadow-2xl rotate-3 flex flex-col items-center">
              <div className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2 text-center font-black">Plan Impact</div>
              <div className="text-8xl font-black leading-none italic text-black">
                {userPlan === (comparison.TOU < comparison.Tiered && comparison.TOU < comparison.ULO ? 'TOU' : 
                   comparison.Tiered < comparison.TOU && comparison.Tiered < comparison.ULO ? 'Tiered' : 'ULO') ? (
                     <span className="text-emerald-600 text-4xl uppercase not-italic font-black leading-none block text-center">Optimum<br/>Choice!</span>
                   ) : (
                     <span className="text-red-600 font-black">-${Math.abs((comparison as any)[userPlan] - Math.min(comparison.TOU, comparison.Tiered, comparison.ULO)).toFixed(2)}</span>
                   )}
              </div>
              <div className="text-[10px] font-black uppercase mt-4 text-center text-black">vs. your current {userPlan} plan</div>
           </div>
        </div>
      )}
    </div>
  );
}
