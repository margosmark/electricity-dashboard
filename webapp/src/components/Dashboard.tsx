/**
 * Oakville Hydro Green Button Data Dashboard
 * 
 * This component provides an advanced, interactive analysis of electricity usage data.
 * It supports multiple Ontario pricing plans (TOU, Tiered, ULO), handles historical 
 * rate changes, and provides granular drill-downs from monthly trends to hourly profiles.
 */

"use client";

import React, { useState, useEffect, useMemo, ChangeEvent } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import { 
  format, isWeekend, getMonth, getHours, startOfWeek, 
  startOfMonth, lastDayOfMonth, startOfYear, addMonths, 
  subMonths, setDate, isBefore, addDays, subDays 
} from 'date-fns';
import { TrendingUp, DollarSign, ArrowLeft, ChevronLeft, ChevronRight, HelpCircle, Zap, Calendar, CheckCircle2, Settings2, Upload, AlertTriangle, Activity, X } from 'lucide-react';

// --- Types ---

type DataPoint = { timestamp: number, usage_kwh: number };

type RateSet = {
  effectiveDate: string,
  tou: { offPeak: number, midPeak: number, onPeak: number },
  tiered: { tier1: number, tier2: number, thresholdWinter: number, thresholdSummer: number },
  ulo: { overnight: number, weekendOffPeak: number, midPeak: number, onPeak: number }
};

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
  const [viewMode, setViewMode] = useState<'Chart' | 'Insights'>('Chart');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [granularity, setGranularity] = useState<'Daily' | 'Weekly' | 'Monthly'>('Monthly');
  const [drilldownDay, setDrilldownDay] = useState<string | null>(null);
  const [drilldownMonth, setDrilldownMonth] = useState<string | null>(null);

  const getBillingPeriod = (refDate: Date, bDay: number) => {
    let start = setDate(startOfMonth(refDate), bDay);
    if (isBefore(refDate, start)) start = subMonths(start, 1);
    const end = subDays(addMonths(start, 1), 1);
    return { start, end };
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [elecRes, ratesRes] = await Promise.all([ fetch('/api/electricity'), fetch('/api/rates') ]);
      const elecJson = await elecRes.json();
      const ratesJson = await ratesRes.json();
      
      setRawData(elecJson.data || []);
      setRateHistory(ratesJson.historicalRates || []);
      
      if (elecJson.data && elecJson.data.length > 0) {
         const last = new Date(elecJson.data[elecJson.data.length - 1].timestamp * 1000);
         const period = getBillingPeriod(last, billingDay);
         setStartDate(format(period.start, 'yyyy-MM-dd'));
         setEndDate(format(period.end, 'yyyy-MM-dd'));
      } else {
        // If no data, force show the upload modal
        setShowUploadModal(true);
      }
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, [billingDay]);

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setUploading(true);
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/electricity', { method: 'POST', body: formData });
      if (res.ok) {
        setShowUploadModal(false);
        await fetchData(); // Reload everything
      } else {
        alert("Upload failed. Please ensure it's a valid Green Button XML file.");
      }
    } catch (err) {
      alert("Error uploading file.");
    } finally {
      setUploading(false);
      // Reset file input
      e.target.value = '';
    }
  };

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

  const processedData = useMemo(() => {
    if (rateHistory.length === 0) return [];
    const sortedRates = [...rateHistory].sort((a,b) => b.effectiveDate.localeCompare(a.effectiveDate));

    return rawData.map(d => {
      const dateObj = new Date(d.timestamp * 1000);
      const m = getMonth(dateObj); const h = getHours(dateObj);
      const isWkend = isWeekend(dateObj); const isWinter = m >= 10 || m <= 3;
      const dayStr = format(dateObj, 'yyyy-MM-dd');
      const activeRateSet = sortedRates.find(r => dayStr >= r.effectiveDate) || sortedRates[sortedRates.length - 1];

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
      
      let uloCat: 'Overnight' | 'Weekend Off-Peak' | 'Mid-Peak' | 'On-Peak' = 'Mid-Peak';
      if (h >= 23 || h < 7) uloCat = 'Overnight';
      else if (isWkend) uloCat = 'Weekend Off-Peak';
      else if (h >= 16 && h < 21) uloCat = 'On-Peak';
      else uloCat = 'Mid-Peak';

      const costTOU = d.usage_kwh * (activeRateSet.tou[touCat === 'Off-Peak' ? 'offPeak' : touCat === 'Mid-Peak' ? 'midPeak' : 'onPeak'] / 100);
      const costULO = d.usage_kwh * (activeRateSet.ulo[uloCat === 'Overnight' ? 'overnight' : uloCat === 'Weekend Off-Peak' ? 'weekendOffPeak' : uloCat === 'Mid-Peak' ? 'midPeak' : 'onPeak'] / 100);
      const costTiered = d.usage_kwh * (activeRateSet.tiered.tier1 / 100);

      return { ...d, dateObj, dayStr, hourStr: format(dateObj, 'HH:mm'), touCategory: touCat, uloCategory: uloCat, isWinter, costTOU, costULO, costTiered, activeRateSet } as ProcessedPoint;
    });
  }, [rawData, rateHistory]);

  const filteredData = useMemo(() => {
    if (!startDate || !endDate) return processedData;
    const s = new Date(startDate + "T00:00:00"); const e = new Date(endDate + "T23:59:59");
    return processedData.filter(d => d.dateObj >= s && d.dateObj <= e);
  }, [processedData, startDate, endDate]);

  const activeChartData = useMemo(() => {
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
      ...val, costTiered: getActualTieredCost(val.usage, val.readings)
    })).sort((a,b) => a.key.localeCompare(b.key));
  }, [filteredData, granularity, drilldownDay, drilldownMonth]);

  // Heatmap Data (24x7 grid based on current selection)
  const heatmapData = useMemo(() => {
    // 7 days (0=Sunday), 24 hours
    const grid = Array.from({length: 7}, () => Array.from({length: 24}, () => ({ sum: 0, count: 0, avg: 0 })));
    let maxAvg = 0;
    
    filteredData.forEach(d => {
      const day = d.dateObj.getDay();
      const hour = d.dateObj.getHours();
      grid[day][hour].sum += d.usage_kwh;
      grid[day][hour].count += 1;
    });

    grid.forEach(day => day.forEach(hour => {
      if (hour.count > 0) hour.avg = hour.sum / hour.count;
      if (hour.avg > maxAvg) maxAvg = hour.avg;
    }));

    return { grid, maxAvg };
  }, [filteredData]);

  // Anomaly Detection (Spike Alerts)
  const anomalies = useMemo(() => {
    // Calculate expected usage per day of week
    const dayStats = Array.from({length: 7}, () => ({ sum: 0, days: new Set<string>() }));
    processedData.forEach(d => {
       const dayOfWeek = d.dateObj.getDay();
       dayStats[dayOfWeek].sum += d.usage_kwh;
       dayStats[dayOfWeek].days.add(d.dayStr);
    });
    const expectedAverages = dayStats.map(stat => stat.days.size > 0 ? stat.sum / stat.days.size : 0);

    // Find anomalies in the filtered dataset
    const dailyTotals = new Map<string, { dateObj: Date, usage: number }>();
    filteredData.forEach(d => {
      if (!dailyTotals.has(d.dayStr)) dailyTotals.set(d.dayStr, { dateObj: d.dateObj, usage: 0 });
      dailyTotals.get(d.dayStr)!.usage += d.usage_kwh;
    });

    const spikes: { date: Date, usage: number, expected: number, diffPct: number }[] = [];
    dailyTotals.forEach((val, dayStr) => {
      const expected = expectedAverages[val.dateObj.getDay()];
      // If usage is 50% higher than expected average AND at least 5kWh over (to ignore noise)
      if (expected > 0 && val.usage > expected * 1.5 && (val.usage - expected) > 5) {
        spikes.push({
          date: val.dateObj,
          usage: val.usage,
          expected,
          diffPct: ((val.usage - expected) / expected) * 100
        });
      }
    });

    return spikes.sort((a,b) => b.date.getTime() - a.date.getTime()).slice(0, 5); // Top 5 most recent
  }, [processedData, filteredData]);

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

  const vampire = useMemo(() => {
     if (filteredData.length === 0) return { cost: 0, watts: 0 };
     const sortedUsage = filteredData.map(d => d.usage_kwh).sort((a, b) => a - b);
     const baselineKwh = sortedUsage[Math.floor(sortedUsage.length * 0.05)] || sortedUsage[0];
     const lastRate = filteredData[filteredData.length - 1].activeRateSet.tou.offPeak;
     return { cost: baselineKwh * 24 * 30 * (lastRate / 100), watts: baselineKwh * 1000 };
  }, [filteredData]);

  const navigatePeriod = (direction: 'prev' | 'next') => {
    if (drilldownDay) {
      const current = new Date(drilldownDay + "T00:00:00"); current.setDate(current.getDate() + (direction === 'next' ? 1 : -1));
      const nextStr = format(current, 'yyyy-MM-dd');
      if (processedData.some(d => d.dayStr === nextStr)) { setDrilldownDay(nextStr); if (nextStr < startDate) setStartDate(nextStr); if (nextStr > endDate) setEndDate(nextStr); }
    } else if (drilldownMonth) {
      const [y, m] = drilldownMonth.split('-').map(Number); const current = new Date(y, m - 1, 1); current.setMonth(current.getMonth() + (direction === 'next' ? 1 : -1));
      const nextStr = format(current, 'yyyy-MM');
      if (processedData.some(d => format(d.dateObj, 'yyyy-MM') === nextStr)) { setDrilldownMonth(nextStr); if (nextStr + "-01" < startDate) setStartDate(nextStr + "-01"); }
    } else {
      const currentStart = new Date(startDate + "T00:00:00");
      const newStart = direction === 'next' ? addMonths(currentStart, 1) : subMonths(currentStart, 1);
      const period = getBillingPeriod(newStart, billingDay);
      if (processedData.some(d => d.dateObj >= period.start && d.dateObj <= period.end)) {
        setStartDate(format(period.start, 'yyyy-MM-dd'));
        setEndDate(format(period.end, 'yyyy-MM-dd'));
      }
    }
  };

  const handleBarClick = (item: any) => {
    if (!item || !item.key) return;
    if (drilldownMonth) { setDrilldownDay(item.key); } 
    else if (!drilldownDay) {
      if (granularity === 'Monthly') setDrilldownMonth(item.key);
      else setDrilldownDay(item.key);
    }
  };

  if (loading && rawData.length === 0) return <div className="p-20 text-center font-black text-black text-4xl italic animate-bounce">LOADING POWER GRID...</div>;

  return (
    <div className="space-y-10 text-black relative">
      
      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
          <div className="bg-white p-10 rounded-[2.5rem] border-8 border-black shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] max-w-xl w-full relative transform -rotate-1">
             <button onClick={() => setShowUploadModal(false)} className="absolute top-6 right-6 p-2 bg-slate-100 rounded-full border-4 border-black hover:bg-yellow-400 transition-colors"><X size={24} strokeWidth={4} /></button>
             <h2 className="text-4xl font-black uppercase tracking-tighter mb-4 flex items-center gap-4"><Upload size={36} className="text-blue-600" strokeWidth={4} /> Data Link</h2>
             <p className="font-bold text-slate-500 mb-8 leading-relaxed">Upload your official Green Button XML export from Oakville Hydro (or any standard Ontario provider) to instantly analyze your energy profile.</p>
             
             <div className="relative">
                <input type="file" accept=".xml" onChange={handleFileUpload} disabled={uploading} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                <div className={`p-12 border-8 border-dashed ${uploading ? 'border-yellow-400 bg-yellow-50' : 'border-black bg-slate-50 hover:bg-yellow-50'} rounded-3xl text-center transition-colors`}>
                   {uploading ? (
                     <div className="text-2xl font-black italic animate-pulse">PROCESSING DATA...</div>
                   ) : (
                     <div>
                       <div className="text-xl font-black uppercase mb-2">Drag & Drop XML Here</div>
                       <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Or click to browse files</div>
                     </div>
                   )}
                </div>
             </div>
          </div>
        </div>
      )}

      {/* Controls Bar - HIGHER Z-INDEX */}
      <div className="relative z-[100] bg-white p-6 rounded-3xl shadow-xl border-4 border-black flex flex-col xl:flex-row gap-6 items-center">
        
        <div className="flex w-full xl:w-auto justify-between xl:justify-start items-center gap-4">
           <button onClick={() => setShowUploadModal(true)} className="p-4 bg-black text-white border-4 border-black rounded-2xl shadow-[4px_4px_0px_0px_rgba(37,99,235,1)] hover:translate-y-1 hover:shadow-none transition-all" title="Upload New Data">
             <Upload size={20} strokeWidth={4} />
           </button>
           <div className="h-10 w-1 bg-slate-200 rounded-full hidden xl:block"></div>
           <div className="flex items-center gap-2">
             <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="p-3 border-4 border-black rounded-xl font-black text-black bg-white w-36" />
             <span className="font-black">TO</span>
             <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="p-3 border-4 border-black rounded-xl font-black text-black bg-white w-36" />
             <div className="flex gap-2 ml-2">
               <button onClick={() => setRange('billing')} className="p-3 bg-yellow-400 border-4 border-black rounded-xl font-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 active:translate-y-1 active:shadow-none transition-all text-[10px]">BILLING PERIOD</button>
               <button onClick={() => setRange('ytd')} className="p-3 bg-yellow-400 border-4 border-black rounded-xl font-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 active:translate-y-1 active:shadow-none transition-all text-[10px]">YTD</button>
             </div>
           </div>
        </div>

        <div className="flex bg-black p-1.5 rounded-2xl gap-1 w-full xl:w-auto justify-center">
          <button onClick={() => setViewMode('Chart')} className={`px-6 py-2 rounded-xl text-sm font-black transition-all flex items-center gap-2 ${viewMode === 'Chart' ? 'bg-white text-black' : 'text-slate-400 hover:text-white'}`}><TrendingUp size={16} strokeWidth={3}/> CHART</button>
          <button onClick={() => setViewMode('Insights')} className={`px-6 py-2 rounded-xl text-sm font-black transition-all flex items-center gap-2 ${viewMode === 'Insights' ? 'bg-yellow-400 text-black' : 'text-slate-400 hover:text-white'}`}><Activity size={16} strokeWidth={3}/> INSIGHTS</button>
        </div>

        <div className="ml-auto flex w-full xl:w-auto items-center justify-between xl:justify-end gap-4">
           {/* Plan Selection */}
           <div className="bg-slate-100 p-2 rounded-2xl border-4 border-black flex gap-1">
              {(['TOU', 'Tiered', 'ULO'] as const).map(p => (
                <button key={p} onClick={() => setUserPlan(p)} className={`px-4 py-2 rounded-xl text-[10px] font-black transition-all ${userPlan === p ? 'bg-black text-white' : 'text-black hover:bg-white'}`}>{p}</button>
              ))}
           </div>
           
           {/* Vampire Load Display */}
           <button onClick={() => setShowVampireHelp(!showVampireHelp)} className="bg-blue-600 text-white p-4 lg:p-6 rounded-3xl shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] border-4 border-black relative transition-transform hover:scale-105 active:rotate-1">
              <div className="text-[10px] font-black uppercase tracking-[0.2em] mb-1 flex items-center gap-1 text-white">Vampire Load <HelpCircle size={10} /></div>
              <div className="text-3xl lg:text-4xl font-black italic tracking-tighter text-white">${vampire.cost.toFixed(2)}<span className="text-xs not-italic opacity-80 ml-1">/mo</span></div>
              {showVampireHelp && (
                <div className="absolute top-full right-0 mt-4 w-72 p-6 bg-white border-4 border-black rounded-2xl shadow-2xl z-[200] text-black text-[11px] font-black leading-relaxed text-left cursor-default" onClick={e => e.stopPropagation()}>
                  <p className="mb-3 text-blue-600 uppercase border-b-2 border-slate-100 pb-2">How we calculate this:</p>
                  <p className="mb-2">We analyze your entire selected period and find your **sustained minimum usage** (the 5th percentile).</p>
                  <p className="mb-2">Your home pulls approx. <span className="text-blue-600 underline font-black">{vampire.watts.toFixed(0)} Watts</span> even when you aren't using anything.</p>
                  <p>This is the cost of fridges, standby TVs, internet routers, and clocks running 24/7.</p>
                </div>
              )}
           </button>
        </div>
      </div>

      {viewMode === 'Chart' && (
        <>
          {/* Main Chart Section */}
          <div className="bg-white p-8 rounded-[2.5rem] shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] border-4 border-black overflow-hidden relative z-10">
            
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-6">
              <div className="flex items-center gap-6">
                {(drilldownDay || drilldownMonth) && (
                  <button onClick={() => {setDrilldownDay(null); setDrilldownMonth(null);}} className="p-4 bg-white border-4 border-black rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black hover:text-white transition-all text-black" title="Back to main view"><ArrowLeft size={32} strokeWidth={4} /></button>
                )}
                <div className="flex items-center gap-4">
                  <button onClick={() => navigatePeriod('prev')} className="p-2 border-4 border-black rounded-xl hover:bg-yellow-400 transition-all text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none" title="Previous period"><ChevronLeft size={24} strokeWidth={4} /></button>
                  <h2 className="text-5xl lg:text-6xl font-black text-black tracking-tighter uppercase leading-none italic">{drilldownDay ? drilldownDay : drilldownMonth ? format(new Date(drilldownMonth + "-01T00:00:00"), 'MMMM yyyy') : granularity === 'Monthly' ? 'Monthly Trend' : `${startDate} to ${endDate}`}</h2>
                  <button onClick={() => navigatePeriod('next')} className="p-2 border-4 border-black rounded-xl hover:bg-yellow-400 transition-all text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none" title="Next period"><ChevronRight size={24} strokeWidth={4} /></button>
                </div>
              </div>

              <div className="flex items-center gap-6">
                 {!drilldownDay && (
                   <div className="flex p-1 bg-slate-100 rounded-xl border-4 border-black h-fit">
                     {['Daily', 'Weekly', 'Monthly'].map(g => (
                        <button key={g} onClick={() => {setGranularity(g as any); setDrilldownMonth(null);}} className={`px-4 py-1 rounded-lg text-xs font-black transition-all ${granularity === g && !drilldownMonth ? 'bg-black text-white' : 'text-slate-500 hover:text-black'}`}>{g}</button>
                     ))}
                   </div>
                 )}
                 <div className="text-right">
                    <div className="text-xs font-black uppercase text-slate-400 tracking-widest">Period Cost ({userPlan})</div>
                    <div className="text-5xl font-black text-black italic leading-none block mt-2">${activeChartData.reduce((acc, curr) => acc + (curr as any)[`cost${userPlan}`], 0).toFixed(2)}</div>
                 </div>
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
                    itemStyle={{color: '#000', fontWeight: 900, fontSize: '18px', padding: '2px 0'}} 
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

          {/* Pricing Comparison */}
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
              <div key={i} onClick={() => setUserPlan(plan.id as any)} className={`bg-white p-10 rounded-[2rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden transition-all cursor-pointer ${userPlan === plan.id ? 'ring-8 ring-yellow-400 ring-inset scale-[1.02]' : 'hover:scale-[1.01]'}`}>
                {userPlan === plan.id && <div className="absolute top-4 right-4 bg-yellow-400 px-3 py-1 rounded-full border-2 border-black font-black text-[10px] uppercase flex items-center gap-1 shadow-sm"><CheckCircle2 size={12} /> YOUR PLAN</div>}
                <div className="flex items-center gap-3 mb-8">
                  <div className="p-3 bg-slate-50 border-4 border-black rounded-xl">{React.cloneElement(plan.icon as any, { strokeWidth: 4 })}</div>
                  <h3 className="text-2xl font-black uppercase tracking-tighter text-black">{plan.name}</h3>
                </div>
                <div className="text-6xl font-black italic mb-10 text-black">${plan.cost?.toFixed(2)}</div>
                <div className="space-y-4 bg-slate-50 p-6 rounded-2xl border-4 border-black text-xs font-black uppercase tracking-widest text-black">
                  {plan.rates.map((r, j) => (
                    <div key={j} className={`flex justify-between ${(r as any).color || ''}`}><span>{r.label}</span> <span>{r.val}</span></div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Financial Verdict */}
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
        </>
      )}

      {/* --- Advanced Insights View --- */}
      {viewMode === 'Insights' && (
        <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
          
          {/* Anomaly Detection */}
          <div className="bg-yellow-400 p-8 rounded-[2.5rem] border-8 border-black shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] transform rotate-1">
             <div className="flex items-center gap-4 mb-8">
               <AlertTriangle size={40} strokeWidth={3} className="text-black" />
               <h3 className="text-4xl font-black uppercase tracking-tighter">Usage Anomalies</h3>
             </div>
             {anomalies.length > 0 ? (
               <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                 {anomalies.map((anom, i) => (
                   <div key={i} className="bg-white p-6 rounded-2xl border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                     <div className="text-xs font-black uppercase tracking-widest text-red-600 mb-2">{format(anom.date, 'EEEE, MMM do')}</div>
                     <div className="text-3xl font-black italic mb-4">{anom.usage.toFixed(1)} kWh</div>
                     <div className="text-sm font-bold text-slate-600">
                       This is <span className="text-black font-black bg-yellow-200 px-2 rounded-sm">+{anom.diffPct.toFixed(0)}% higher</span> than your historical average for a {format(anom.date, 'EEEE')} ({anom.expected.toFixed(1)} kWh).
                     </div>
                   </div>
                 ))}
               </div>
             ) : (
               <div className="bg-white p-8 rounded-2xl border-4 border-black font-black text-xl">No significant spikes detected in this period! Great job.</div>
             )}
          </div>

          {/* 24x7 Heatmap */}
          <div className="bg-white p-10 rounded-[2.5rem] border-4 border-black shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] overflow-x-auto">
             <h3 className="text-4xl font-black uppercase tracking-tighter mb-8 italic">Weekly Routine Heatmap</h3>
             <div className="min-w-[800px]">
               <div className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-2">
                 <div className="w-16"></div>
                 {Array.from({length:24}).map((_, i) => (
                   <div key={i} className="text-center text-[10px] font-black uppercase text-slate-400">{i}h</div>
                 ))}
               </div>
               {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, dIdx) => (
                 <div key={day} className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-1">
                   <div className="w-16 text-xs font-black uppercase flex items-center">{day}</div>
                   {heatmapData.grid[dIdx].map((hour, hIdx) => {
                      const intensity = hour.avg / heatmapData.maxAvg;
                      // Color scale: slate-100 -> yellow-400 -> red-600
                      let bgClass = 'bg-slate-100';
                      if (intensity > 0.8) bgClass = 'bg-red-600 border-red-800';
                      else if (intensity > 0.6) bgClass = 'bg-orange-500 border-orange-700';
                      else if (intensity > 0.4) bgClass = 'bg-yellow-400 border-yellow-600';
                      else if (intensity > 0.2) bgClass = 'bg-blue-300 border-blue-500';
                      
                      return (
                        <div 
                          key={hIdx} 
                          className={`h-12 rounded-md border-b-4 transition-all hover:scale-110 relative group ${bgClass}`}
                        >
                           <div className="opacity-0 group-hover:opacity-100 absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-black text-white text-xs font-black p-2 rounded-lg pointer-events-none z-50 whitespace-nowrap">
                             {hour.avg.toFixed(2)} kWh avg
                           </div>
                        </div>
                      )
                   })}
                 </div>
               ))}
             </div>
          </div>
        </div>
      )}

    </div>
  );
}
