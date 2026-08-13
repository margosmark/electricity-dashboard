import { XMLParser } from 'fast-xml-parser';
import {
  format, isWeekend, startOfWeek, startOfMonth,
  setDate, isBefore, subMonths, addMonths, subDays,
} from 'date-fns';

export type DataPoint = { timestamp: number; usage_kwh: number };

export type RateSet = {
  effectiveDate: string;
  tou: { offPeak: number; midPeak: number; onPeak: number };
  tiered: { tier1: number; tier2: number; thresholdWinter: number; thresholdSummer: number };
  ulo: { overnight: number; weekendOffPeak: number; midPeak: number; onPeak: number };
};

export type ProcessedPoint = DataPoint & {
  dateObj: Date;
  dayStr: string;
  hourStr: string;
  touCategory: string;
  uloCategory: string;
  isWinter: boolean;
  costTOU: number;
  costTiered: number;
  costULO: number;
  activeRateSet: RateSet;
};

export type ChartDataItem = {
  label: string;
  usage: number;
  key: string;
  costTOU: number;
  costULO: number;
  costTiered: number;
  readings?: ProcessedPoint[];
};

export type Anomaly = {
  date: Date;
  usage: number;
  expected: number;
  diffPct: number;
};

export function getBillingPeriod(refDate: Date, bDay: number): { start: Date; end: Date } {
  let start = setDate(startOfMonth(refDate), bDay);
  if (isBefore(refDate, start)) start = subMonths(start, 1);
  const end = subDays(addMonths(start, 1), 1);
  return { start, end };
}

export function parseGreenButtonXML(xmlText: string): DataPoint[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    isArray: (n) => ['IntervalReading', 'entry', 'IntervalBlock'].includes(n),
  });
  const parsed = parser.parse(xmlText);
  const readings: DataPoint[] = [];
  const stack: any[] = [parsed];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
    } else {
      if (obj.IntervalReading) {
        const arr = Array.isArray(obj.IntervalReading) ? obj.IntervalReading : [obj.IntervalReading];
        arr.forEach((ir: any) => {
          const s = parseInt(ir.timePeriod?.start || '0', 10);
          const v = parseInt(ir.value || '0', 10);
          if (s > 0) readings.push({ timestamp: s, usage_kwh: v / 1000.0 });
        });
      }
      for (const k in obj) {
        if (k !== 'IntervalReading' && typeof obj[k] === 'object') stack.push(obj[k]);
      }
    }
  }
  return readings.sort((a, b) => a.timestamp - b.timestamp);
}

export function categorizeTOU(date: Date): string {
  const h = date.getHours();
  if (isWeekend(date)) return 'Off-Peak';
  const isWin = date.getMonth() >= 10 || date.getMonth() <= 3;
  if (h >= 19 || h < 7) return 'Off-Peak';
  if (isWin) return (h >= 7 && h < 11) || (h >= 17 && h < 19) ? 'On-Peak' : 'Mid-Peak';
  return (h >= 11 && h < 17) ? 'On-Peak' : 'Mid-Peak';
}

export function categorizeULO(date: Date): string {
  const h = date.getHours();
  if (h >= 23 || h < 7) return 'Overnight';
  if (isWeekend(date)) return 'Weekend Off-Peak';
  if (h >= 16 && h < 21) return 'On-Peak';
  return 'Mid-Peak';
}

export function getTouRateKey(category: string): 'offPeak' | 'midPeak' | 'onPeak' {
  if (category === 'Off-Peak') return 'offPeak';
  if (category === 'Mid-Peak') return 'midPeak';
  return 'onPeak';
}

export function getUloRateKey(category: string): 'overnight' | 'weekendOffPeak' | 'midPeak' | 'onPeak' {
  if (category === 'Overnight') return 'overnight';
  if (category === 'Weekend Off-Peak') return 'weekendOffPeak';
  if (category === 'Mid-Peak') return 'midPeak';
  return 'onPeak';
}

export function processRawData(rawData: DataPoint[], rateHistory: RateSet[]): ProcessedPoint[] {
  if (rateHistory.length === 0) return [];
  const sorted = [...rateHistory].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  return rawData.map((d) => {
    const dt = new Date(d.timestamp * 1000);
    const dayStr = format(dt, 'yyyy-MM-dd');
    const rates = sorted.find((r) => dayStr >= r.effectiveDate) || sorted[sorted.length - 1];
    const touCategory = categorizeTOU(dt);
    const uloCategory = categorizeULO(dt);
    const isWinter = dt.getMonth() >= 10 || dt.getMonth() <= 3;
    const costTOU = d.usage_kwh * (rates.tou[getTouRateKey(touCategory)] / 100);
    const costULO = d.usage_kwh * (rates.ulo[getUloRateKey(uloCategory)] / 100);
    const costTiered = d.usage_kwh * (rates.tiered.tier1 / 100);
    return {
      ...d,
      dateObj: dt,
      dayStr,
      hourStr: format(dt, 'HH:mm'),
      touCategory,
      uloCategory,
      isWinter,
      costTOU,
      costULO,
      costTiered,
      activeRateSet: rates,
    };
  });
}

export function filterByDateRange(
  processedData: ProcessedPoint[],
  startDate: string,
  endDate: string,
): ProcessedPoint[] {
  if (!startDate || !endDate) return processedData;
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate + 'T23:59:59');
  return processedData.filter((d) => d.dateObj >= s && d.dateObj <= e);
}

export function getFilteredForZoom(
  filteredData: ProcessedPoint[],
  zoomLevel: string,
  zoomTarget: string | null,
): ProcessedPoint[] {
  if (!zoomTarget) return filteredData;
  if (zoomLevel === 'weekly') return filteredData.filter((d) => format(d.dateObj, 'yyyy-MM') === zoomTarget);
  if (zoomLevel === 'daily')
    return filteredData.filter(
      (d) => format(startOfWeek(d.dateObj, { weekStartsOn: 1 }), 'yyyy-MM-dd') === zoomTarget,
    );
  if (zoomLevel === 'hourly') return filteredData.filter((d) => d.dayStr === zoomTarget);
  return filteredData;
}

export function aggregateChartData(
  data: ProcessedPoint[],
  zoomLevel: string,
): ChartDataItem[] {
  if (zoomLevel === 'hourly') {
    return data.map((d) => ({
      label: d.hourStr,
      usage: d.usage_kwh,
      key: d.hourStr,
      costTOU: d.costTOU,
      costULO: d.costULO,
      costTiered: d.costTiered,
    }));
  }

  const map = new Map<string, { label: string; usage: number; key: string; costTOU: number; costULO: number; readings: ProcessedPoint[] }>();
  data.forEach((d) => {
    let l = '';
    let k = '';
    if (zoomLevel === 'monthly') {
      l = format(d.dateObj, 'MMM yyyy');
      k = format(d.dateObj, 'yyyy-MM');
    } else if (zoomLevel === 'weekly') {
      const mon = startOfWeek(d.dateObj, { weekStartsOn: 1 });
      l = 'Week of ' + format(mon, 'MMM dd');
      k = format(mon, 'yyyy-MM-dd');
    } else if (zoomLevel === 'daily') {
      l = format(d.dateObj, 'MMM dd');
      k = d.dayStr;
    }
    if (!map.has(k)) map.set(k, { label: l, usage: 0, key: k, costTOU: 0, costULO: 0, readings: [] });
    const o = map.get(k)!;
    o.usage += d.usage_kwh;
    o.costTOU += d.costTOU;
    o.costULO += d.costULO;
    o.readings.push(d);
  });

  return Array.from(map.values())
    .map((v) => {
      const r = v.readings[0];
      const days = new Set(v.readings.map((x) => x.dayStr)).size;
      const th =
        (r.isWinter ? r.activeRateSet.tiered.thresholdWinter : r.activeRateSet.tiered.thresholdSummer) *
        (days / 30.4);
      const costTiered =
        v.usage <= th
          ? v.usage * (r.activeRateSet.tiered.tier1 / 100)
          : th * (r.activeRateSet.tiered.tier1 / 100) + (v.usage - th) * (r.activeRateSet.tiered.tier2 / 100);
      return { ...v, costTiered };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function buildActiveChartData(
  filteredData: ProcessedPoint[],
  zoomLevel: string,
  zoomTarget: string | null,
): ChartDataItem[] {
  const data = getFilteredForZoom(filteredData, zoomLevel, zoomTarget);
  return aggregateChartData(data, zoomLevel);
}

export function calculateComparison(
  activeChartData: ChartDataItem[],
): { TOU: number; Tiered: number; ULO: number } | null {
  if (activeChartData.length === 0) return null;
  return activeChartData.reduce(
    (acc, curr) => ({
      TOU: acc.TOU + curr.costTOU,
      Tiered: acc.Tiered + curr.costTiered,
      ULO: acc.ULO + curr.costULO,
    }),
    { TOU: 0, Tiered: 0, ULO: 0 },
  );
}

export function calculateVampire(
  filteredData: ProcessedPoint[],
): { cost: number; watts: number } {
  if (filteredData.length === 0) return { cost: 0, watts: 0 };
  const sorted = filteredData.map((d) => d.usage_kwh).sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length * 0.05)] || sorted[0];
  return {
    cost: base * 24 * 30 * (filteredData[0].activeRateSet.tou.offPeak / 100),
    watts: base * 1000,
  };
}

export function detectAnomalies(
  processedData: ProcessedPoint[],
  filteredData: ProcessedPoint[],
): Anomaly[] {
  const dayStats = Array.from({ length: 7 }, () => ({ sum: 0, days: new Set<string>() }));
  processedData.forEach((d) => {
    const dOW = d.dateObj.getDay();
    dayStats[dOW].sum += d.usage_kwh;
    dayStats[dOW].days.add(d.dayStr);
  });
  const expectedAvgs = dayStats.map((stat) => (stat.days.size > 0 ? stat.sum / stat.days.size : 0));

  const dailyTotals = new Map<string, { dateObj: Date; usage: number }>();
  filteredData.forEach((d) => {
    if (!dailyTotals.has(d.dayStr)) dailyTotals.set(d.dayStr, { dateObj: d.dateObj, usage: 0 });
    dailyTotals.get(d.dayStr)!.usage += d.usage_kwh;
  });

  const spikes: Anomaly[] = [];
  dailyTotals.forEach((val) => {
    const exp = expectedAvgs[val.dateObj.getDay()];
    if (exp > 0 && val.usage > exp * 1.5 && val.usage - exp > 5) {
      spikes.push({ date: val.dateObj, usage: val.usage, expected: exp, diffPct: ((val.usage - exp) / exp) * 100 });
    }
  });
  return spikes.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
}

export type HeatmapCell = { sum: number; count: number; avg: number };
export type HeatmapData = { grid: HeatmapCell[][]; maxAvg: number };

export function buildHeatmapData(
  filteredData: ProcessedPoint[],
): HeatmapData {
  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sum: 0, count: 0, avg: 0 })),
  );
  let maxAvg = 0;
  filteredData.forEach((d) => {
    const day = d.dateObj.getDay();
    const hour = d.dateObj.getHours();
    grid[day][hour].sum += d.usage_kwh;
    grid[day][hour].count += 1;
  });
  grid.forEach((day) =>
    day.forEach((hour) => {
      if (hour.count > 0) hour.avg = hour.sum / hour.count;
      if (hour.avg > maxAvg) maxAvg = hour.avg;
    }),
  );
  return { grid, maxAvg };
}

export function isWeekendBar(zoomLevel: string, key: string | undefined): boolean {
  return zoomLevel === 'daily' && !!key && isWeekend(new Date(key + 'T00:00:00'));
}

export function getBarColor(zoomLevel: string, key: string | undefined): string {
  return isWeekendBar(zoomLevel, key) ? '#F97316' : '#2563EB';
}
