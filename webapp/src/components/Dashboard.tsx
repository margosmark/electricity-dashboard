/**
 * Ontario Energy Optimizer - Interaction Fix Edition
 * 
 * Flow: Monthly ➔ Weekly ➔ Daily ➔ Hourly
 * Fixed: Browser-native click detection using direct Bar component handlers.
 */

"use client";

import React, { useState, useEffect, useMemo, ChangeEvent } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { 
  format, isWeekend, getMonth, getHours, startOfWeek, 
  startOfMonth, lastDayOfMonth, startOfYear, addMonths, 
  subMonths, setDate, isBefore, subDays, addDays 
} from 'date-fns';
import { TrendingUp, DollarSign, ArrowLeft, ChevronLeft, ChevronRight, HelpCircle, Zap, Calendar, CheckCircle2, Settings2, Upload, AlertTriangle, Activity, X, Trash2, RefreshCw } from 'lucide-react';
import { XMLParser } from 'fast-xml-parser';

// --- Types ---
type DataPoint = { timestamp: number, usage_kwh: number };
type RateSet = {
  effectiveDate: string,
  tou: { offPeak: number, midPeak: number, onPeak: number },
  tiered: { tier1: number, tier2: number, thresholdWinter: number, thresholdSummer: number },
  ulo: { overnight: number, weekendOffPeak: number, midPeak: number, onPeak: number }
};
type ProcessedPoint = DataPoint & {
  dateObj: Date, dayStr: string, hourStr: string,
  touCategory: string, uloCategory: string,
  isWinter: boolean, costTOU: number, costTiered: number, costULO: number,
  activeRateSet: RateSet
};

export default function Dashboard() {


  // --- State ---
  const [rawData, setRawData] = useState<DataPoint[]>([]);
  const [rateHistory, setRateHistory] = useState<RateSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [stuck, setStuck] = useState(false);
  const [showVampireHelp, setShowVampireHelp] = useState(false);
  const [userPlan, setUserPlan] = useState<'TOU' | 'Tiered' | 'ULO'>('TOU');
  const [billingDay, setBillingDay] = useState<number>(1);
  const [viewMode, setViewMode] = useState<'Chart' | 'Insights'>('Chart');
  const [viewScope, setViewScope] = useState<'Month' | 'YTD' | 'BillingPeriod' | 'Custom'>('BillingPeriod');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [parsing, setParsing] = useState(false);
  
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  
  // monthly ➔ weekly ➔ daily ➔ hourly
  const [zoomLevel, setZoomLevel] = useState<'monthly' | 'weekly' | 'daily' | 'hourly'>('monthly');
  const [zoomTarget, setZoomTarget] = useState<string | null>(null);

  // --- Helpers ---

  const getBillingPeriod = (refDate: Date, bDay: number) => {
    let start = setDate(startOfMonth(refDate), bDay);
    if (isBefore(refDate, start)) start = subMonths(start, 1);
    const end = subDays(addMonths(start, 1), 1);
    return { start, end };
  };

  const parseGreenButtonXML = (xmlText: string) => {
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, isArray: (n) => ['IntervalReading', 'entry', 'IntervalBlock'].includes(n)});
    const parsed = parser.parse(xmlText);
    const readings: any[] = [];
    const stack = [parsed];
    while (stack.length > 0) {
      const obj = stack.pop();
      if (!obj || typeof obj !== 'object') continue;
      if (Array.isArray(obj)) obj.forEach(i => stack.push(i));
      else {
        if (obj.IntervalReading) {
          const arr = Array.isArray(obj.IntervalReading) ? obj.IntervalReading : [obj.IntervalReading];
          arr.forEach((ir: any) => {
            const s = parseInt(ir.timePeriod?.start || "0", 10);
            const v = parseInt(ir.value || "0", 10);
            if (s > 0) readings.push({ timestamp: s, usage_kwh: v / 1000.0 });
          });
        }
        for (const k in obj) if (k !== 'IntervalReading' && typeof obj[k] === 'object') stack.push(obj[k]);
      }
    }
    return readings.sort((a,b) => a.timestamp - b.timestamp);
  };

  // --- Start Sequence ---
  useEffect(() => {
    let mounted = true;
    let stuckTimer: NodeJS.Timeout;

    async function init() {
      try {
        const res = await fetch('/api/rates');
        const json = await res.json();
        if (mounted) setRateHistory(json.historicalRates || []);
      } catch (e) {}
      try {
        const savedBDay = localStorage.getItem('billing_day');
        if (savedBDay && mounted) setBillingDay(parseInt(savedBDay));
        const savedData = localStorage.getItem('energy_data');
        if (savedData) {
          const parsed = JSON.parse(savedData);
          if (mounted && parsed.length > 0) {
            setRawData(parsed);
            const last = new Date(parsed[parsed.length - 1].timestamp * 1000);
            const period = getBillingPeriod(last, savedBDay ? parseInt(savedBDay) : 1);
            setStartDate(format(period.start, 'yyyy-MM-dd'));
            setEndDate(format(period.end, 'yyyy-MM-dd'));
          }
        } else if (mounted) { setShowUploadModal(true); }
      } catch (e) {}
      if (mounted) setLoading(false);
    }
    init();
    stuckTimer = setTimeout(() => { if (loading && mounted) setStuck(true); }, 5000);
    return () => { mounted = false; if (stuckTimer) clearTimeout(stuckTimer); };
  }, []);

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setParsing(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = parseGreenButtonXML(ev.target?.result as string);
        if (data.length > 0) {
          setRawData(data);
          localStorage.setItem('energy_data', JSON.stringify(data));
          const last = new Date(data[data.length-1].timestamp * 1000);
          const period = getBillingPeriod(last, billingDay);
          setStartDate(format(period.start, 'yyyy-MM-dd'));
          setEndDate(format(period.end, 'yyyy-MM-dd'));
          setShowUploadModal(false);
        }
      } catch (err) { alert("Parse Error"); }
      finally { setParsing(false); }
    };
    reader.readAsText(file);
  };

  // --- Calculations ---

  const processedData = useMemo(() => {
    if (rateHistory.length === 0) return [];
    const sorted = [...rateHistory].sort((a,b) => b.effectiveDate.localeCompare(a.effectiveDate));
    return rawData.map(d => {
      const dt = new Date(d.timestamp * 1000);
      const h = dt.getHours(); const isW = isWeekend(dt); const isWin = dt.getMonth() >= 10 || dt.getMonth() <= 3;
      const dayStr = format(dt, 'yyyy-MM-dd');
      const rates = sorted.find(r => dayStr >= r.effectiveDate) || sorted[sorted.length-1];
      let tCat = 'Off-Peak';
      if (!isW) {
        if (h >= 19 || h < 7) tCat = 'Off-Peak';
        else if (isWin) tCat = (h >= 7 && h < 11) || (h >= 17 && h < 19) ? 'On-Peak' : 'Mid-Peak';
        else tCat = (h >= 11 && h < 17) ? 'On-Peak' : 'Mid-Peak';
      }
      let uCat = 'Mid-Peak';
      if (h >= 23 || h < 7) uCat = 'Overnight';
      else if (isW) uCat = 'Weekend Off-Peak';
      else if (h >= 16 && h < 21) uCat = 'On-Peak';
      const cT = d.usage_kwh * (rates.tou[tCat === 'Off-Peak' ? 'offPeak' : tCat === 'Mid-Peak' ? 'midPeak' : 'onPeak'] / 100);
      const cU = d.usage_kwh * (rates.ulo[uCat === 'Overnight' ? 'overnight' : uCat === 'Weekend Off-Peak' ? 'weekendOffPeak' : uCat === 'Mid-Peak' ? 'midPeak' : 'onPeak'] / 100);
      return { ...d, dateObj: dt, dayStr, hourStr: format(dt, 'HH:mm'), touCategory: tCat, uloCategory: uCat, isWinter: isWin, costTOU: cT, costULO: cU, costTiered: d.usage_kwh * (rates.tiered.tier1/100), activeRateSet: rates } as ProcessedPoint;
    });
  }, [rawData, rateHistory]);

  const filteredData = useMemo(() => {
    if (!startDate || !endDate) return processedData;
    const s = new Date(startDate + "T00:00:00"); const e = new Date(endDate + "T23:59:59");
    return processedData.filter(d => d.dateObj >= s && d.dateObj <= e);
  }, [processedData, startDate, endDate]);

  const activeChartData = useMemo(() => {
    let set = filteredData;
    if (zoomTarget) {
      if (zoomLevel === 'weekly') set = filteredData.filter(d => format(d.dateObj, 'yyyy-MM') === zoomTarget);
      else if (zoomLevel === 'daily') set = filteredData.filter(d => format(startOfWeek(d.dateObj, {weekStartsOn:1}), 'yyyy-MM-dd') === zoomTarget);
      else if (zoomLevel === 'hourly') set = filteredData.filter(d => d.dayStr === zoomTarget);
    }

    if (zoomLevel === 'hourly') return set.map(d => ({ label: d.hourStr, usage: d.usage_kwh, key: d.hourStr, costTOU: d.costTOU, costULO: d.costULO, costTiered: d.costTiered }));

    const map = new Map<string, any>();
    set.forEach(d => {
      let l = ''; let k = '';
      if (zoomLevel === 'monthly') { l = format(d.dateObj, 'MMM yyyy'); k = format(d.dateObj, 'yyyy-MM'); }
      else if (zoomLevel === 'weekly') { const mon = startOfWeek(d.dateObj, { weekStartsOn: 1 }); l = "Week of " + format(mon, 'MMM dd'); k = format(mon, 'yyyy-MM-dd'); }
      else if (zoomLevel === 'daily') { l = format(d.dateObj, 'MMM dd'); k = d.dayStr; }
      if (!map.has(k)) map.set(k, { label: l, usage: 0, key: k, costTOU: 0, costULO: 0, readings: [] });
      const o = map.get(k); o.usage += d.usage_kwh; o.costTOU += d.costTOU; o.costULO += d.costULO; o.readings.push(d);
    });
    return Array.from(map.values()).map(v => {
      const r = v.readings[0]; const days = new Set(v.readings.map((x:any)=>x.dayStr)).size;
      const th = (r.isWinter ? r.activeRateSet.tiered.thresholdWinter : r.activeRateSet.tiered.thresholdSummer) * (days / 30.4);
      const cT = v.usage <= th ? v.usage * (r.activeRateSet.tiered.tier1/100) : (th * (r.activeRateSet.tiered.tier1/100)) + ((v.usage-th)*(r.activeRateSet.tiered.tier2/100));
      return { ...v, costTiered: cT };
    }).sort((a,b) => a.key.localeCompare(b.key));
  }, [filteredData, zoomLevel, zoomTarget]);

  const comparison = useMemo(() => {
    if (filteredData.length === 0) return null;
    return activeChartData.reduce((acc, curr) => ({ TOU: acc.TOU + curr.costTOU, Tiered: acc.Tiered + curr.costTiered, ULO: acc.ULO + curr.costULO }), { TOU: 0, Tiered: 0, ULO: 0 });
  }, [activeChartData]);

  const vampire = useMemo(() => {
     if (filteredData.length === 0) return { cost: 0, watts: 0 };
     const sorted = filteredData.map(d => d.usage_kwh).sort((a, b) => a - b);
     const base = sorted[Math.floor(sorted.length * 0.05)] || sorted[0];
     return { cost: base * 24 * 30 * (filteredData[0].activeRateSet.tou.offPeak / 100), watts: base * 1000 };
  }, [filteredData]);

  const anomalies = useMemo(() => {
    const dayStats = Array.from({length: 7}, () => ({ sum: 0, days: new Set<string>() }));
    processedData.forEach(d => { const dOW = d.dateObj.getDay(); dayStats[dOW].sum += d.usage_kwh; dayStats[dOW].days.add(d.dayStr); });
    const expectedAvgs = dayStats.map(stat => stat.days.size > 0 ? stat.sum / stat.days.size : 0);
    const dailyTotals = new Map<string, { dateObj: Date, usage: number }>();
    filteredData.forEach(d => { if (!dailyTotals.has(d.dayStr)) dailyTotals.set(d.dayStr, { dateObj: d.dateObj, usage: 0 }); dailyTotals.get(d.dayStr)!.usage += d.usage_kwh; });
    const spikes: any[] = [];
    dailyTotals.forEach((val) => {
      const exp = expectedAvgs[val.dateObj.getDay()];
      if (exp > 0 && val.usage > exp * 1.5 && (val.usage - exp) > 5) spikes.push({ date: val.dateObj, usage: val.usage, expected: exp, diffPct: ((val.usage - exp) / exp) * 100 });
    });
    return spikes.sort((a,b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
  }, [processedData, filteredData]);

  const heatmapData = useMemo(() => {
    const grid = Array.from({length: 7}, () => Array.from({length: 24}, () => ({ sum: 0, count: 0, avg: 0 })));
    let maxAvg = 0;
    filteredData.forEach(d => { const day = d.dateObj.getDay(); const hour = d.dateObj.getHours(); grid[day][hour].sum += d.usage_kwh; grid[day][hour].count += 1; });
    grid.forEach(day => day.forEach(hour => { if (hour.count > 0) hour.avg = hour.sum / hour.count; if (hour.avg > maxAvg) maxAvg = hour.avg; }));
    return { grid, maxAvg };
  }, [filteredData]);

  // --- Handlers ---

  const handleBarClick = (item: any) => {

    if (!item || !item.key) return;
    if (zoomLevel === 'monthly') { setZoomLevel('weekly'); setZoomTarget(item.key); }
    else if (zoomLevel === 'weekly') { setZoomLevel('daily'); setZoomTarget(item.key); }
    else if (zoomLevel === 'daily') { setZoomLevel('hourly'); setZoomTarget(item.key); }
  };

  const goBack = () => {
    if (zoomLevel === 'hourly') setZoomLevel('daily');
    else if (zoomLevel === 'daily') setZoomLevel('weekly');
    else if (zoomLevel === 'weekly') setZoomLevel('monthly');
    setZoomTarget(null);
  };

  const navigatePeriod = (dir: 'prev' | 'next') => {
    if (zoomTarget) {
       const cur = new Date((zoomLevel === 'weekly' ? zoomTarget + "-01" : zoomTarget) + "T00:00:00");
       if (zoomLevel === 'weekly') cur.setMonth(cur.getMonth() + (dir === 'next' ? 1 : -1));
       else if (zoomLevel === 'daily') cur.setDate(cur.getDate() + (dir === 'next' ? 7 : -7));
       else if (zoomLevel === 'hourly') cur.setDate(cur.getDate() + (dir === 'next' ? 1 : -1));
       const next = format(cur, zoomLevel === 'weekly' ? 'yyyy-MM' : 'yyyy-MM-dd');
       setZoomTarget(next);
       if (next < startDate) setStartDate(next + (zoomLevel === 'weekly' ? "-01" : ""));
    } else {
      const s = new Date(startDate + "T00:00:00");
      if (viewScope === 'BillingPeriod') {
        // Move to middle of next/prev month to handle edge cases in getBillingPeriod
        const target = dir === 'next' ? addMonths(s, 1) : subMonths(s, 1);
        const p = getBillingPeriod(target, billingDay);
        setStartDate(format(p.start, 'yyyy-MM-dd')); setEndDate(format(p.end, 'yyyy-MM-dd'));
      } else if (viewScope === 'Month') {
        const target = dir === 'next' ? addMonths(s, 1) : subMonths(s, 1);
        setStartDate(format(startOfMonth(target), 'yyyy-MM-dd'));
        setEndDate(format(lastDayOfMonth(target), 'yyyy-MM-dd'));
      } else {
        s.setMonth(s.getMonth() + (dir === 'next' ? 1 : -1));
        const p = getBillingPeriod(s, billingDay);
        setStartDate(format(p.start, 'yyyy-MM-dd')); setEndDate(format(p.end, 'yyyy-MM-dd'));
      }
    }
  };

  const emergencyReset = () => { localStorage.clear(); window.location.reload(); };
  const updateBillingDay = (day: number) => { 
    setBillingDay(day); 
    localStorage.setItem('billing_day', day.toString()); 
    if (viewScope === 'BillingPeriod') {
      const s = new Date(startDate + "T00:00:00");
      // Use the middle of the current period to re-anchor
      const anchor = addDays(s, 15);
      const p = getBillingPeriod(anchor, day);
      setStartDate(format(p.start, 'yyyy-MM-dd'));
      setEndDate(format(p.end, 'yyyy-MM-dd'));
    }
  };

  if (loading) return <div className="p-20 text-center font-black text-black text-4xl animate-pulse bg-slate-50 min-screen h-screen flex items-center justify-center">PREPARING OPTIMIZER...</div>;

  return (
    <div className="space-y-10 text-black relative font-black uppercase">
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
             <button onClick={() => { 
               setViewScope('BillingPeriod');
               const p = getBillingPeriod(new Date(), billingDay); 
               setStartDate(format(p.start, 'yyyy-MM-dd')); 
               setEndDate(format(p.end, 'yyyy-MM-dd')); 
               setZoomLevel('monthly'); 
             }} className={`p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[8px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'BillingPeriod' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>Billing Period</button>
             
             <button onClick={() => { 
               setViewScope('Month');
               const s = startOfMonth(new Date());
               const e = lastDayOfMonth(new Date());
               setStartDate(format(s, 'yyyy-MM-dd')); 
               setEndDate(format(e, 'yyyy-MM-dd')); 
               setZoomLevel('monthly'); 
             }} className={`p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[8px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'Month' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>Month</button>
             
             <button onClick={() => { 
               setViewScope('YTD');
               setStartDate(format(startOfYear(new Date()), 'yyyy-MM-dd')); 
               setEndDate(format(new Date(), 'yyyy-MM-dd')); 
               setZoomLevel('monthly'); 
             }} className={`p-2 md:p-3 border-2 md:border-4 border-black rounded-lg md:rounded-xl font-black text-[8px] md:text-[10px] text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none transition-all uppercase ${viewScope === 'YTD' ? 'bg-yellow-400' : 'bg-white hover:bg-slate-50'}`}>YTD</button>
           </div>
        </div>

        <div className="flex bg-black p-1 rounded-xl gap-1 lg:ml-auto">
          <button onClick={() => setViewMode('Chart')} className={`px-4 md:px-6 py-2 rounded-lg text-[10px] md:text-xs font-black transition-all ${viewMode === 'Chart' ? 'bg-white text-black' : 'text-slate-400'}`}>CHART</button>
          <button onClick={() => setViewMode('Insights')} className={`px-4 md:px-6 py-2 rounded-lg text-[10px] md:text-xs font-black transition-all ${viewMode === 'Insights' ? 'bg-yellow-400 text-black' : 'text-slate-400'}`}>INSIGHTS</button>
        </div>

        <div className="flex flex-wrap items-center gap-3 md:gap-4 lg:ml-auto">
           <div className="bg-slate-100 p-2 md:p-3 rounded-xl md:rounded-2xl border-2 md:border-4 border-black flex items-center gap-2 md:gap-3">
              <Settings2 size={16} className="text-slate-500" />
              <input type="number" min="1" max="31" value={billingDay} onChange={e => updateBillingDay(parseInt(e.target.value))} className="w-8 md:w-12 bg-transparent text-xs md:text-sm outline-none text-black font-black" />
           </div>
           <div className="bg-slate-100 p-1 md:p-2 rounded-xl md:rounded-2xl border-2 md:border-4 border-black flex gap-1">
              {['Tiered', 'TOU', 'ULO'].map((p:any) => <button key={p} onClick={() => setUserPlan(p)} className={`px-3 md:px-6 py-1 md:py-2 rounded-lg md:rounded-xl text-[8px] md:text-[10px] font-black transition-all ${userPlan === p ? 'bg-black text-white shadow-lg' : 'text-black hover:bg-white'}`}>{p}</button>)}
           </div>
           <button onClick={() => setShowVampireHelp(true)} className="bg-blue-600 text-white p-3 md:p-6 rounded-2xl md:rounded-3xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] border-2 md:border-4 border-black text-center font-black relative hover:scale-105 transition-all group min-w-[120px]">
              <div className="text-[8px] md:text-[10px] uppercase flex items-center justify-center gap-1">Vampire Load <HelpCircle size={8} className="opacity-50 md:size-10 group-hover:opacity-100" /></div>
              <div className="text-xl md:text-4xl italic">${vampire.cost.toFixed(2)}</div>
           </button>
        </div>
      </div>

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
                      <li>We analyze your entire dataset to find your <strong>"Baseline"</strong> usage (the lowest 5% of your hourly readings).</li>
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
        <div className="space-y-6 md:space-y-10">
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
                {['monthly', 'weekly', 'daily'].map((l:any) => <button key={l} onClick={() => {setZoomLevel(l); setZoomTarget(null);}} className={`px-3 md:px-6 py-1 md:py-2 rounded-md md:rounded-lg text-[10px] md:text-xs font-black transition-all ${zoomLevel === l && !zoomTarget ? 'bg-black text-white' : 'text-slate-500'}`}>{l}</button>)}
              </div>
              <div className="text-center lg:text-right text-black font-black">
                 <div className="text-[8px] md:text-[10px]">Total selection cost ({userPlan})</div>
                 <div className="text-2xl md:text-5xl italic mt-1 md:mt-2 font-black">${activeChartData.reduce((acc, curr) => acc + (curr as any)[`cost${userPlan}`], 0).toFixed(2)}</div>
              </div>
            </div>

            <div className="h-[300px] md:h-[500px] -ml-4 md:-ml-6">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={activeChartData as any[]}>
                  <CartesianGrid vertical={false} stroke="#000" strokeWidth={1} opacity={0.1} />
                  <XAxis dataKey="label" tick={{fontSize: 12, fill: '#000', fontWeight: 900}} stroke="#000" strokeWidth={4} />
                  <YAxis tick={{fontSize: 12, fill: '#000', fontWeight: 900}} stroke="#000" strokeWidth={4} />
                  <Tooltip 
                    cursor={{fill: '#000', opacity: 0.05}} 
                    contentStyle={{borderRadius: '0px', border: '4px solid #000', boxShadow: '12px 12px 0px 0px #000', padding: '24px', background: '#FFF', pointerEvents: 'none'}} 
                    itemStyle={{color: '#000', fontWeight: 900, fontSize: '18px'}} 
                    labelStyle={{fontWeight: 900, color: '#000', marginBottom: '8px', textTransform: 'uppercase'}} 
                    formatter={(v: any, name: any) => {
                       if (name === 'usage') return [`${Number(v).toFixed(2)} kWh`, 'Power'];
                       return [`$${Number(v).toFixed(2)}`, name.replace('cost', '') + ' Cost'];
                    }}
                  />
                  <Bar 
                    dataKey="usage" 
                    fill="#2563EB" 
                    stroke="#000" 
                    strokeWidth={3} 
                    radius={0} 
                    activeBar={{ fill: '#FFD600' }} 
                    onClick={(d: any) => handleBarClick(d)} 
                    className="cursor-pointer"
                  >
                    {activeChartData.map((_, index) => <Cell key={`cell-${index}`} style={{ cursor: 'pointer', pointerEvents: 'auto' }} />)}
                  </Bar>
                  <Bar dataKey="costTOU" hide /> <Bar dataKey="costTiered" hide /> <Bar dataKey="costULO" hide />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-10 text-black font-black uppercase">
            {[
              { id: 'Tiered', name: 'Tiered Pricing', cost: comparison?.Tiered, rates: [{ l: 'Tier 1', v: '12.0¢' }, { l: 'Tier 2', v: '14.2¢' }] },
              { id: 'TOU', name: 'Time-of-Use', cost: comparison?.TOU, rates: [{ l: 'Off-Peak', v: '9.8¢', c: 'text-emerald-600' }, { l: 'Mid-Peak', v: '15.7¢', c: 'text-yellow-600' }, { l: 'On-Peak', v: '20.3¢', c: 'text-red-600' }] },
              { id: 'ULO', name: 'Ultra-Low Over', cost: comparison?.ULO, rates: [{ l: 'Overnight', v: '3.9¢', c: 'text-purple-600' }, { l: 'Weekend Off', v: '9.8¢', c: 'text-emerald-600' }, { l: 'Mid-Peak', v: '15.7¢', c: 'text-yellow-600' }, { l: 'On-Peak', v: '39.1¢', c: 'text-red-600' }] }
            ].map((plan, i) => (
              <div key={i} onClick={() => setUserPlan(plan.id as any)} className={`bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[2rem] border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] md:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] relative transition-all cursor-pointer ${userPlan === plan.id ? 'ring-4 md:ring-8 ring-yellow-400 ring-inset scale-[1.02]' : ''}`}>
                {userPlan === plan.id && <div className="absolute top-2 right-2 md:top-4 md:right-4 bg-yellow-400 px-3 md:px-6 py-1 rounded-full border-2 border-black font-black text-[8px] md:text-[10px] uppercase text-black shadow-sm flex items-center gap-1 md:gap-2"><CheckCircle2 size={10} className="md:w-3 md:h-3" /> <span className="hidden sm:inline">YOUR PLAN</span><span className="sm:hidden">ACTIVE</span></div>}
                <h3 className="text-xl md:text-2xl mb-2 md:mb-4 font-black">{plan.name}</h3>
                <div className="text-4xl md:text-6xl italic mb-6 md:mb-10 font-black text-black">${plan.cost?.toFixed(2)}</div>
                <div className="space-y-2 md:space-y-4 bg-slate-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-[10px] md:text-xs font-black text-black">
                  {plan.rates.map((r:any, j:number) => <div key={j} className={`flex justify-between ${r.c || ''}`}><span>{r.l}</span> <span>{r.v}</span></div>)}
                </div>
              </div>
            ))}
          </div>

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
                       ) : ( <span className="text-red-600">-${Math.abs((comparison as any)[userPlan] - Math.min(comparison.TOU, comparison.Tiered, comparison.ULO)).toFixed(2)}</span> )}
                  </div>
                  <div className="text-[8px] md:text-[10px] mt-2 md:mt-4 font-black text-center text-black">vs. your current {userPlan} plan</div>
               </div>
            </div>
          )}
        </div>
      )}

      {viewMode === 'Insights' && (
        <div className="space-y-6 md:space-y-10 animate-in fade-in duration-500 font-black text-black uppercase">
          <div className="bg-yellow-400 p-6 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black">
             <div className="flex items-center gap-2 md:gap-4 mb-4 md:mb-8 text-black font-black uppercase"><AlertTriangle size={24} className="md:w-10 md:h-10" strokeWidth={3} /><h3 className="text-2xl md:text-4xl">Usage Anomalies</h3></div>
             {anomalies.length > 0 ? (
               <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 font-black text-black">
                 {anomalies.map((anom, i) => (
                   <div key={i} className="bg-white p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black text-black font-black uppercase">
                     <div className="text-red-600 text-[8px] md:text-[10px] mb-1 md:mb-2 font-black">{format(anom.date, 'EEEE, MMM do')}</div>
                     <div className="text-2xl md:text-3xl italic font-black text-black">{anom.usage.toFixed(1)} kWh</div>
                     <div className="text-[8px] md:text-[10px] text-slate-500 mt-1 md:mt-2 font-black">+{anom.diffPct.toFixed(0)}% vs average</div>
                   </div>
                 ))}
               </div>
             ) : <div className="bg-white p-6 md:p-8 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black text-lg md:text-xl text-black">No significant spikes detected!</div>}
          </div>

          <div className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] overflow-x-auto text-black">
             <h3 className="text-2xl md:text-4xl mb-4 md:mb-8 italic text-black font-black uppercase">Weekly Routine Heatmap</h3>
             <div className="min-w-[600px] md:min-w-[800px] text-black">
               <div className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-2 text-black font-black uppercase">
                 <div className="w-12 md:w-16 font-black"></div>
                 {Array.from({length:24}).map((_, i) => <div key={i} className="text-center text-[8px] md:text-[10px] text-black font-black">{i}h</div>)}
               </div>
               {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, dIdx) => (
                 <div key={day} className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-1 text-black font-black uppercase">
                   <div className="w-12 md:w-16 text-[10px] md:text-xs flex items-center font-black uppercase">{day}</div>
                   {heatmapData.grid[dIdx].map((hour, hIdx) => {
                      const int = hour.avg / heatmapData.maxAvg;
                      let bg = 'bg-slate-100';
                      if (int > 0.8) bg = 'bg-red-600 border-red-800'; else if (int > 0.6) bg = 'bg-orange-500 border-orange-700'; else if (int > 0.4) bg = 'bg-yellow-400 border-yellow-600'; else if (int > 0.2) bg = 'bg-blue-300 border-blue-500';
                      return <div key={hIdx} className={`h-8 md:h-12 rounded-sm md:rounded-md border-b-2 md:border-b-4 ${bg} hover:scale-110 relative group transition-all font-black`}><div className="opacity-0 group-hover:opacity-100 absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-black text-white text-[8px] md:text-[10px] p-2 rounded pointer-events-none z-50 whitespace-nowrap font-black">{hour.avg.toFixed(2)} kWh</div></div>
                   })}
                 </div>
               ))}
             </div>
             <div className="mt-4 text-[8px] md:text-[10px] text-slate-400 font-black text-center md:hidden">Scroll horizontally to see all hours →</div>
          </div>
        </div>
      )}
    </div>
  );
}
