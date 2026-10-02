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

/**
 * Legacy single-bucket parse: every reading in the document, merged.
 * Identical to the pre-UsagePoint behavior for single-meter feeds (which is
 * what a one-group document produces); the UI now routes through
 * {@link parseGreenButtonUsagePoints} so multi-meter feeds are never merged
 * silently.
 */
export function parseGreenButtonXML(xmlText: string): DataPoint[] {
  return combineUsagePointGroups(parseGreenButtonUsagePoints(xmlText));
}

/** The rows you get when the user explicitly picks "combine every meter". */
export function combineUsagePointGroups(groups: UsagePointGroup[]): DataPoint[] {
  return groups
    .flatMap((g) => g.readings)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * --- Multi-UsagePoint Green Button feeds -----------------------------------
 *
 * A Green Button feed can carry several UsagePoints (one per meter / rate
 * class). Every IntervalReading lives inside an <entry>, and that entry links
 * back to its UsagePoint through an href like
 *   .../UsagePoint/<uuid>/MeterReading/<uuid>/IntervalBlock/<uuid>
 * so readings can be attributed per meter instead of silently merged.
 */
export type UsagePointGroup = {
  /** UsagePoint id from the feed links; '' when the feed does not identify one. */
  id: string;
  /** Short human label for the picker. */
  label: string;
  readings: DataPoint[];
  /** Number of IntervalBlock elements the readings came from. */
  blocks: number;
};

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Depth-first collection of every IntervalReading below `node`, sorted later. */
function collectReadings(node: unknown, skipKeys: string[] = []): DataPoint[] {
  const readings: DataPoint[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
    } else {
      const objAny = obj as Record<string, unknown>;
      if (objAny.IntervalReading) {
        const arr = asArray<Record<string, unknown>>(objAny.IntervalReading as Record<string, unknown>);
        arr.forEach((ir) => {
          const timePeriod = ir.timePeriod as Record<string, unknown> | undefined;
          const s = parseInt((timePeriod?.start as string) || '0', 10);
          const v = parseInt((ir.value as string) || '0', 10);
          if (s > 0) readings.push({ timestamp: s, usage_kwh: v / 1000.0 });
        });
      }
      for (const k in objAny) {
        if (k !== 'IntervalReading' && !skipKeys.includes(k) && typeof objAny[k] === 'object') stack.push(objAny[k]);
      }
    }
  }
  return readings;
}

/** Every <entry> anywhere in the parsed document (feeds nest them differently). */
function collectEntries(node: unknown): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
    } else {
      const objAny = obj as Record<string, unknown>;
      for (const k in objAny) {
        if (k === 'entry') asArray<Record<string, unknown>>(objAny.entry as Record<string, unknown>).forEach((e) => entries.push(e));
        else if (typeof objAny[k] === 'object') stack.push(objAny[k]);
      }
    }
  }
  return entries;
}

/**
 * UsagePoint id that owns `entry`.
 *
 * Href shapes seen in ESPI 1.x feeds:
 *   rel="self"    .../UsagePoint/<up>                                  (UsagePoint entry)
 *   rel="self"    .../UsagePoint/<up>/MeterReading/<mr>/IntervalBlock/<ib>
 *   rel="up"      .../UsagePoint                                       (no id — the feed)
 *   rel="related" .../UsagePoint/<up>                                  (may be another point)
 * so `self` wins, then `up`, then any other href that names a point.
 */
function pickUsagePointId(entry: Record<string, unknown>): string | null {
  const links = asArray<Record<string, unknown>>(entry.link as Record<string, unknown>);
  const relRank = (rel: string) => (rel === 'self' ? 0 : rel === 'up' ? 1 : 2);
  const ordered = links
    .map((l) => ({ href: String((l && l['@_href']) || ''), rel: String((l && l['@_rel']) || '') }))
    .filter((l) => l.href.includes('/UsagePoint/'))
    .sort((a, b) => relRank(a.rel) - relRank(b.rel));
  for (const l of ordered) {
    const m = l.href.match(/\/UsagePoint\/([^/?#"']+)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Parse a Green Button document into per-UsagePoint groups.
 * Returns [] when the document carries no readings at all.
 * Documents that never identify a UsagePoint (plain fixtures, single-meter
 * exports without links) collapse into exactly one group with id '' — the
 * historical behavior.
 */
export function parseGreenButtonUsagePoints(xmlText: string): UsagePointGroup[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    isArray: (n) => ['IntervalReading', 'entry', 'IntervalBlock'].includes(n),
  });
  const parsed = parser.parse(xmlText) as Record<string, unknown>;

  const groups = new Map<string, UsagePointGroup>();
  const ensure = (id: string): UsagePointGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { id, label: id ? `UsagePoint ${id.slice(0, 8)}` : 'Meter', readings: [], blocks: 0 };
      groups.set(id, g);
    }
    return g;
  };

  const entries = collectEntries(parsed);
  for (const entry of entries) {
    const readings = collectReadings(entry);
    if (readings.length === 0) continue;
    const id = pickUsagePointId(entry) || '';
    const g = ensure(id);
    g.readings.push(...readings);
    g.blocks += countIntervalBlocks(entry);
  }

  // Readings that sit outside any <entry> (non-Atom fixtures) still belong to
  // one unnamed meter, exactly as the pre-grouping parser treated them.
  const orphans = collectReadings(parsed, ['entry']);
  if (orphans.length > 0) ensure('').readings.push(...orphans);

  const out = Array.from(groups.values());
  for (const g of out) g.readings.sort((a, b) => a.timestamp - b.timestamp);
  return out.sort((a, b) => {
    const at = a.readings[0]?.timestamp ?? 0;
    const bt = b.readings[0]?.timestamp ?? 0;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
}

function countIntervalBlocks(node: unknown): number {
  let n = 0;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
    } else {
      const objAny = obj as Record<string, unknown>;
      if (objAny.IntervalBlock) n += asArray(objAny.IntervalBlock).length;
      for (const k in objAny) {
        if (k !== 'IntervalBlock' && typeof objAny[k] === 'object') stack.push(objAny[k]);
      }
    }
  }
  return n;
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

/* ==========================================================================
 * CSV export of the processed per-interval table
 * ========================================================================== */

export const CSV_COLUMNS = [
  'datetime',
  'usage_kwh',
  'tou_category',
  'ulo_category',
  'costTOU',
  'costTiered',
  'costULO',
  'activeRateSet.effectiveDate',
] as const;

/** Round away binary-float noise without changing meaningful precision. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize the processed per-interval table to CSV: header row + one row per
 * reading, in the order given. Costs are rounded to 4 decimals, kWh to 3
 * (Wh resolution), datetime is ISO-8601 UTC.
 */
export function processedDataToCSV(rows: ProcessedPoint[]): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const d of rows) {
    lines.push(
      [
        d.dateObj.toISOString(),
        String(roundTo(d.usage_kwh, 3)),
        d.touCategory,
        d.uloCategory,
        String(roundTo(d.costTOU, 4)),
        String(roundTo(d.costTiered, 4)),
        String(roundTo(d.costULO, 4)),
        d.activeRateSet.effectiveDate,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** `energy_export_<start>_<end>.csv` — dates are `yyyy-MM-dd`, ISO order. */
export function csvExportFilename(startDate: string, endDate: string): string {
  const start = startDate || 'no-data';
  const end = endDate || 'no-data';
  return `energy_export_${start}_${end}.csv`;
}

/** Filename derived from the rows actually being exported (min/max day). */
export function csvFilenameForRows(rows: ProcessedPoint[]): string {
  if (rows.length === 0) return csvExportFilename('', '');
  let start = rows[0].dayStr;
  let end = rows[0].dayStr;
  for (const r of rows) {
    if (r.dayStr < start) start = r.dayStr;
    if (r.dayStr > end) end = r.dayStr;
  }
  return csvExportFilename(start, end);
}

/* ==========================================================================
 * True-bill estimate — LOCAL user inputs, never derived from /api/rates
 * (the API only carries commodity rates; delivery/regulatory/HST differ by
 * utility and are supplied by the user here).
 * ========================================================================== */

export type ExtraCharges = {
  /** Delivery, $/kWh. */
  deliveryPerKwh: string;
  /** Delivery, flat $/month. */
  deliveryFlat: string;
  /** Regulatory, $/kWh. */
  regulatoryPerKwh: string;
  /** HST percentage (Ontario default hint: 13). */
  hstPct: string;
};

/** Every field starts empty: with nothing set the estimate stays variable-only. */
export const EMPTY_EXTRA_CHARGES: ExtraCharges = {
  deliveryPerKwh: '',
  deliveryFlat: '',
  regulatoryPerKwh: '',
  hstPct: '',
};

export const BASELINE_ESTIMATE_CAPTION =
  'Estimate covers variable energy charges only — it does not include fixed delivery charges, regulatory charges, or HST.';

/** Raw field text → a non-negative number, or null when unset/unusable. */
export function parseChargeInput(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function hasExtraCharges(charges: ExtraCharges): boolean {
  return (
    parseChargeInput(charges.deliveryPerKwh) !== null ||
    parseChargeInput(charges.deliveryFlat) !== null ||
    parseChargeInput(charges.regulatoryPerKwh) !== null ||
    parseChargeInput(charges.hstPct) !== null
  );
}

/** Distinct calendar months covered by the window (flat $/month is charged per month). */
export function countMonthsInView(rows: ProcessedPoint[]): number {
  const months = new Set(rows.map((r) => r.dayStr.slice(0, 7)));
  return months.size;
}

export type TrueBill = {
  variable: number;
  delivery: number;
  regulatory: number;
  hst: number;
  total: number;
  /** Each applied input, resolved to a number (null = not supplied). */
  deliveryPerKwh: number | null;
  deliveryFlat: number | null;
  regulatoryPerKwh: number | null;
  hstPct: number | null;
  months: number;
  totalKwh: number;
  /** Human labels for exactly what the figure includes. */
  included: string[];
  caption: string;
};

/**
 * variable + delivery + regulatory + HST.
 * Returns null when every input is empty — that is the "behave exactly like
 * today" path (estimate = variable charges only).
 */
export function calculateTrueBill(input: {
  variableCost: number;
  totalKwh: number;
  months: number;
  charges: ExtraCharges;
}): TrueBill | null {
  const { variableCost, totalKwh, months, charges } = input;
  const deliveryPerKwh = parseChargeInput(charges.deliveryPerKwh);
  const deliveryFlat = parseChargeInput(charges.deliveryFlat);
  const regulatoryPerKwh = parseChargeInput(charges.regulatoryPerKwh);
  const hstPct = parseChargeInput(charges.hstPct);
  if (
    deliveryPerKwh === null &&
    deliveryFlat === null &&
    regulatoryPerKwh === null &&
    hstPct === null
  ) {
    return null;
  }

  const delivery = (deliveryPerKwh ?? 0) * totalKwh + (deliveryFlat ?? 0) * months;
  const regulatory = (regulatoryPerKwh ?? 0) * totalKwh;
  const preTax = variableCost + delivery + regulatory;
  const hst = hstPct === null ? 0 : preTax * (hstPct / 100);
  const total = preTax + hst;

  const included: string[] = ['variable energy charges'];
  if (deliveryPerKwh !== null) included.push(`delivery ($${deliveryPerKwh.toFixed(4)}/kWh)`);
  if (deliveryFlat !== null) included.push(`delivery ($${deliveryFlat.toFixed(2)}/month)`);
  if (regulatoryPerKwh !== null) included.push(`regulatory ($${regulatoryPerKwh.toFixed(4)}/kWh)`);
  if (hstPct !== null) included.push(`HST (${hstPct}%)`);

  return {
    variable: variableCost,
    delivery,
    regulatory,
    hst,
    total,
    deliveryPerKwh,
    deliveryFlat,
    regulatoryPerKwh,
    hstPct,
    months,
    totalKwh,
    included,
    caption: `Includes: ${included.join(' + ')}.`,
  };
}
