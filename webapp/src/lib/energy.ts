import { XMLParser } from 'fast-xml-parser';
import {
  format, isWeekend, startOfWeek, startOfMonth,
  setDate, isBefore, subMonths, addMonths, subDays,
  startOfDay, isAfter, addDays, endOfMonth, differenceInCalendarDays,
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
  /** What the DAY ITSELF looks like, not just that it was expensive. */
  signature: ApplianceSignature;
};

/* ==========================================================================
 * Appliance-signature labelling for anomaly days
 *
 * detectAnomalies already knows WHICH day was expensive. These functions say
 * WHAT SHAPE the excess took — hedged, evidence-first, with an honest
 * "we can't tell" fallback. Readings are treated as one per hour (the same
 * assumption calculateVampire makes), summed into an hourly kW curve.
 * ========================================================================== */

export type ApplianceSignatureId =
  | 'sustained-high'
  | 'short-spike'
  | 'overnight-flat-tail'
  | 'unclassified';

export type ApplianceSignature = {
  id: ApplianceSignatureId;
  /** What we dare to put on the card. */
  label: string;
  /** The numbers that earned the label. */
  detail: string;
};

/** A run has to hold this much power before we name an appliance. */
export const SIGNATURE_SUSTAINED_KW = 3;
/** ...for at least this many consecutive hours to be "sustained". */
export const SIGNATURE_SUSTAINED_HOURS = 4;
/** A run this short (at the same power) is a spike, not a heater. */
export const SIGNATURE_SPIKE_MAX_HOURS = 2;
/** Hours of the 23:00–07:00 window that must be recorded to judge the tail. */
export const SIGNATURE_TAIL_MIN_HOURS = 5;
/** Overnight power at or above this is a load that never switched off. */
export const SIGNATURE_TAIL_MIN_KW = 1.0;
/** ...and it has to be FLAT (stddev/mean) to call it "left on". */
export const SIGNATURE_TAIL_MAX_CV = 0.35;

const SIGNATURE_TAIL_HOURS = [23, 0, 1, 2, 3, 4, 5, 6];

type DayCurve = (number | null)[];

/** Sum each hour's readings into one kWh (= kW for an hourly feed) curve. */
function hourlyCurve(rows: { dateObj: Date; usage_kwh: number }[]): DayCurve {
  const curve: DayCurve = new Array<number | null>(24).fill(null);
  for (const r of rows) {
    const h = r.dateObj.getHours();
    curve[h] = (curve[h] ?? 0) + r.usage_kwh;
  }
  return curve;
}

/** Longest run of consecutive RECORDED hours at or above `kw`. */
function longestRunAbove(
  curve: DayCurve,
  kw: number,
): { start: number; hours: number; avg: number; peak: number } {
  let best = { start: -1, hours: 0, avg: 0, peak: 0 };
  let i = 0;
  while (i < 24) {
    if (curve[i] === null || (curve[i] as number) < kw) {
      i += 1;
      continue;
    }
    let sum = 0;
    let peak = 0;
    let j = i;
    while (j < 24 && curve[j] !== null && (curve[j] as number) >= kw) {
      sum += curve[j] as number;
      peak = Math.max(peak, curve[j] as number);
      j += 1;
    }
    const hours = j - i;
    if (hours > best.hours) best = { start: i, hours, avg: sum / hours, peak };
    i = j;
  }
  return best;
}

function hourRange(start: number, hours: number): string {
  const end = start + hours;
  return `${String(start).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00`;
}

/**
 * Classify the SHAPE of one day's hourly curve.
 *
 * Order follows how specific each signature is:
 *   1. sustained >=3 kW for >=4 h      -> water heater / EV / space heater
 *   2. a brief 1–2 h spike at >=3 kW   -> motor / kettle
 *   3. a flat, elevated 23:00–07:00    -> something left on
 *   4. anything else                   -> "unclassified", says what we checked
 *
 * Pure: same day, same label, always.
 */
export function classifyDayShape(
  rows: { dateObj: Date; usage_kwh: number }[],
): ApplianceSignature {
  const curve = hourlyCurve(rows);

  const sustained = longestRunAbove(curve, SIGNATURE_SUSTAINED_KW);
  if (sustained.hours >= SIGNATURE_SUSTAINED_HOURS) {
    return {
      id: 'sustained-high',
      label: 'Looks like a water heater / EV / space heater',
      detail: `${sustained.hours} h straight at ${SIGNATURE_SUSTAINED_KW} kW or more (${sustained.avg.toFixed(1)} kW average, ${hourRange(sustained.start, sustained.hours)})`,
    };
  }

  if (sustained.hours >= 1 && sustained.hours <= SIGNATURE_SPIKE_MAX_HOURS) {
    return {
      id: 'short-spike',
      label: 'Looks like a motor / kettle',
      detail: `Brief ${sustained.hours} h spike to ${sustained.peak.toFixed(1)} kW (${hourRange(sustained.start, sustained.hours)}) — sharp and short, like a well pump, kettle or power tool`,
    };
  }

  const tailValues: number[] = [];
  for (const h of SIGNATURE_TAIL_HOURS) if (curve[h] !== null) tailValues.push(curve[h] as number);
  if (tailValues.length >= SIGNATURE_TAIL_MIN_HOURS) {
    const mean = tailValues.reduce((a, b) => a + b, 0) / tailValues.length;
    const variance =
      tailValues.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / tailValues.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    if (mean >= SIGNATURE_TAIL_MIN_KW && cv <= SIGNATURE_TAIL_MAX_CV) {
      return {
        id: 'overnight-flat-tail',
        label: 'Looks like a left-on load',
        detail: `${tailValues.length} hours from 23:00 to 07:00 held ${mean.toFixed(1)} kW and never dipped (${Math.round(cv * 100)}% spread) — something ran all night instead of switching off`,
      };
    }
  }

  return {
    id: 'unclassified',
    label: 'Unclassified — nothing we can name',
    detail: `No ${SIGNATURE_SUSTAINED_KW} kW run lasting ${SIGNATURE_SUSTAINED_HOURS} h, no sharp short spike and no flat 23:00–07:00 block in this day's readings`,
  };
}

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

/**
 * First `powerOfTenMultiplier` inside `node`, depth-first. Raw scan — used
 * only for values already known to sit under a ReadingType.
 */
function findMultiplierIn(node: unknown): number | null {
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
      continue;
    }
    const objAny = obj as Record<string, unknown>;
    const raw = objAny.powerOfTenMultiplier;
    if (raw !== undefined && raw !== null && raw !== '') {
      const n = Number(Array.isArray(raw) ? raw[0] : raw);
      if (Number.isFinite(n)) return n;
    }
    for (const k in objAny) {
      if (typeof objAny[k] === 'object') stack.push(objAny[k]);
    }
  }
  return null;
}

/**
 * The multiplier that scales IntervalReading values: the one declared on a
 * **ReadingType**, and nothing else.
 *
 * Summary blocks carry their own `powerOfTenMultiplier` too — Oakville Hydro's
 * export stamps `-6` on `<measurement>` entries inside
 * ElectricPowerUsageSummary. Applying THAT to interval readings would turn a
 * 3.5 kWh hour into 0.0000035 kWh, so only ReadingType scalers are honoured.
 */
function findReadingTypeMultiplier(node: unknown): number | null {
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
      continue;
    }
    const objAny = obj as Record<string, unknown>;
    if (objAny.ReadingType !== undefined && objAny.ReadingType !== null) {
      for (const rt of asArray<Record<string, unknown>>(objAny.ReadingType as Record<string, unknown>)) {
        const m = findMultiplierIn(rt);
        if (m !== null) return m;
      }
    }
    for (const k in objAny) {
      if (k !== 'ReadingType' && typeof objAny[k] === 'object') stack.push(objAny[k]);
    }
  }
  return null;
}

/** Resource id from the first href containing `/<resource>/<id>` (e.g. ReadingType/3). */
function pickHrefId(entry: Record<string, unknown>, resource: string): string | null {
  const links = asArray<Record<string, unknown>>(entry.link as Record<string, unknown>);
  const re = new RegExp(`/${resource}/([^/?#\"']+)`);
  for (const l of links) {
    const href = String((l && l['@_href']) || '');
    const m = href.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Scale a raw IntervalReading value to kWh.
 *
 * ESPI stores `value` as an integer in the ReadingType's unit scaled by
 * 10^powerOfTenMultiplier — and the multiplier lives on a SEPARATE
 * ReadingType entry, linked by href, not inside the IntervalBlock. Getting
 * this wrong is a silent 1000x error: Hydro One exports
 * `powerOfTenMultiplier -3` with Wh values, so ignoring it turns a 3.95 kWh
 * hour into 3954 kWh.
 *
 * Resolution order (each step is exercised by utilitySamples.test.ts):
 *   1. a ReadingType linked from this entry (href → exponent map)
 *   2. an inline multiplier inside the entry itself
 *   3. a single distinct exponent used everywhere in the document
 *   4. no scaling (multiplier 0)
 */
function scaleReadingValue(raw: number, multiplier: number): number {
  if (!Number.isFinite(raw) || raw < 0) return Number.NaN;
  if (!Number.isFinite(multiplier) || multiplier === 0) return raw / 1000;
  return (raw * 10 ** multiplier) / 1000;
}

/** Depth-first collection of every IntervalReading below `node`, sorted later. */
function collectReadings(node: unknown, skipKeys: string[] = [], multiplier = 0): DataPoint[] {
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
          const s = parseInt(String(timePeriod?.start ?? '0'), 10);
          const v = parseInt(String(ir.value ?? '0'), 10);
          // Untrusted input: a value that is not a number (markup, an object,
          // a unit suffix) must not become NaN and poison every total it
          // touches — drop that one reading instead of trusting it.
          const kwh = scaleReadingValue(v, multiplier);
          if (s > 0 && Number.isFinite(kwh) && kwh >= 0) readings.push({ timestamp: s, usage_kwh: kwh });
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

  // ReadingType exponents declared in this document, keyed by resource id
  // (the multiplier lives on its own entry, linked by href). Plus every
  // exponent seen anywhere, for the single-value fallback.
  const multipliersById = new Map<string, number>();
  const declared = new Set<number>();
  for (const entry of entries) {
    const mult = findReadingTypeMultiplier(entry);
    if (mult === null) continue;
    declared.add(mult);
    const rtId = pickHrefId(entry, 'ReadingType');
    if (rtId !== null) multipliersById.set(rtId, mult);
  }
  const singleDeclared = declared.size === 1 ? [...declared][0] : null;

  const multiplierFor = (entry: Record<string, unknown>): number => {
    const rtId = pickHrefId(entry, 'ReadingType');
    if (rtId !== null && multipliersById.has(rtId)) return multipliersById.get(rtId)!;
    const inline = findReadingTypeMultiplier(entry);
    if (inline !== null) return inline;
    if (singleDeclared !== null) return singleDeclared;
    return 0;
  };

  for (const entry of entries) {
    const readings = collectReadings(entry, [], multiplierFor(entry));
    if (readings.length === 0) continue;
    const id = pickUsagePointId(entry) || '';
    const g = ensure(id);
    g.readings.push(...readings);
    g.blocks += countIntervalBlocks(entry);
  }

  // Readings that sit outside any <entry> (non-Atom fixtures) still belong to
  // one unnamed meter, exactly as the pre-grouping parser treated them.
  const orphans = collectReadings(parsed, ['entry'], singleDeclared ?? 0);
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

// ---------------------------------------------------------------------------
// First-load window selection
// ---------------------------------------------------------------------------

export type InitialWindowScope = 'Month' | 'BillingPeriod' | 'Custom';

export type InitialWindow = {
  start: string; // yyyy-MM-dd
  end: string; // yyyy-MM-dd
  scope: InitialWindowScope;
};

/** A window is "mostly empty" below this share of its calendar days carrying a reading. */
const MIN_WINDOW_COVERAGE = 0.5;

/**
 * Pick the window a freshly loaded dataset should open in.
 *
 * The old behavior (anchor the billing period on the LAST data day) opens a
 * mostly-future window whenever the data stops at the start of a period: data
 * ending 2026-10-01 with billing_day=1 opened Oct 1-31 for ~12h of data.
 *
 * Candidates are tried in order and the first one that is at least
 * MIN_WINDOW_COVERAGE covered by readings wins:
 *
 *   1. Billing period anchored on min(last data day, today) — the clamp keeps
 *      the anchor itself out of the future, so a feed timestamped ahead of the
 *      clock can never open a window that runs past today.      [BillingPeriod]
 *   2. Calendar month of that anchor.                                      [Month]
 *   3. The last `billing period length` days ending on the last data day,
 *      never starting before the first reading. Data-anchored, so it is
 *      covered by construction when the other two are mostly future/empty. [Custom]
 *
 * Returns null when there is no data to anchor on.
 */
export function selectInitialWindow(
  rawData: DataPoint[],
  billingDay: number,
  today: Date,
): InitialWindow | null {
  if (rawData.length === 0) return null;

  let minTs = rawData[0].timestamp;
  let maxTs = rawData[0].timestamp;
  for (const d of rawData) {
    if (d.timestamp < minTs) minTs = d.timestamp;
    if (d.timestamp > maxTs) maxTs = d.timestamp;
  }
  const firstDay = startOfDay(new Date(minTs * 1000));
  const lastDay = startOfDay(new Date(maxTs * 1000));

  // Anchor = min(last data day, today) — never anchor into the future.
  const anchor = isAfter(lastDay, today) ? startOfDay(today) : lastDay;

  const daysWithReadings = new Set(
    rawData.map((d) => format(new Date(d.timestamp * 1000), 'yyyy-MM-dd')),
  );
  const coverage = (s: Date, e: Date): number => {
    const total = differenceInCalendarDays(e, s) + 1;
    if (total <= 0) return 0;
    let withData = 0;
    for (let d = s; !isAfter(d, e); d = addDays(d, 1)) {
      if (daysWithReadings.has(format(d, 'yyyy-MM-dd'))) withData += 1;
    }
    return withData / total;
  };

  const billing = getBillingPeriod(anchor, billingDay);
  const spanDays = differenceInCalendarDays(billing.end, billing.start) + 1;
  const trailEnd = addDays(lastDay, -(spanDays - 1));
  const trailStart = isAfter(firstDay, trailEnd) ? firstDay : trailEnd;

  const candidates: { window: { start: Date; end: Date }; scope: InitialWindowScope }[] = [
    { window: billing, scope: 'BillingPeriod' },
    { window: { start: startOfMonth(anchor), end: endOfMonth(anchor) }, scope: 'Month' },
    { window: { start: trailStart, end: lastDay }, scope: 'Custom' },
  ];

  for (const c of candidates) {
    if (coverage(c.window.start, c.window.end) >= MIN_WINDOW_COVERAGE) {
      return {
        start: format(c.window.start, 'yyyy-MM-dd'),
        end: format(c.window.end, 'yyyy-MM-dd'),
        scope: c.scope,
      };
    }
  }

  // Unreachable in practice (the trailing window is data-anchored); if the
  // dataset's own days are mostly missing, show the raw data range instead.
  return {
    start: format(firstDay, 'yyyy-MM-dd'),
    end: format(lastDay, 'yyyy-MM-dd'),
    scope: 'Custom',
  };
}

// ---------------------------------------------------------------------------
// Full-data totals (the "since {first data date}" strip)
// ---------------------------------------------------------------------------

export type FullDataTotals = {
  firstDate: string; // yyyy-MM-dd of the oldest reading
  lastDate: string; // yyyy-MM-dd of the newest reading
  totalKwh: number;
  costTOU: number;
  costTiered: number;
  costULO: number;
  bestPlan: 'TOU' | 'Tiered' | 'ULO';
  worstPlan: 'TOU' | 'Tiered' | 'ULO';
  /** worst plan − best plan: what the wrong plan would cost over the whole dataset. */
  planDelta: number;
};

/**
 * Cost of EVERY reading in the dataset under each of the three plans.
 *
 * The per-plan sums reuse the monthly buckets the chart's monthly zoom uses
 * (aggregateChartData + calculateComparison), so tiered tier-2 thresholds stay
 * month-scoped and this strip always agrees with the plan cards. Independent
 * of the visible date window — that is the point of the strip.
 */
export function calculateFullDataTotals(processedData: ProcessedPoint[]): FullDataTotals | null {
  if (processedData.length === 0) return null;
  const monthly = aggregateChartData(processedData, 'monthly');
  const costs = calculateComparison(monthly);
  if (!costs) return null;

  let totalKwh = 0;
  let oldest = processedData[0];
  let newest = processedData[0];
  for (const d of processedData) {
    totalKwh += d.usage_kwh;
    if (d.timestamp < oldest.timestamp) oldest = d;
    if (d.timestamp > newest.timestamp) newest = d;
  }

  // Deterministic tie-break: strict comparison keeps the first of this order.
  const order = ['TOU', 'Tiered', 'ULO'] as const;
  let bestPlan: FullDataTotals['bestPlan'] = 'TOU';
  let worstPlan: FullDataTotals['worstPlan'] = 'TOU';
  for (const p of order) {
    if (costs[p] < costs[bestPlan]) bestPlan = p;
    if (costs[p] > costs[worstPlan]) worstPlan = p;
  }

  return {
    firstDate: format(oldest.dateObj, 'yyyy-MM-dd'),
    lastDate: format(newest.dateObj, 'yyyy-MM-dd'),
    totalKwh,
    costTOU: costs.TOU,
    costTiered: costs.Tiered,
    costULO: costs.ULO,
    bestPlan,
    worstPlan,
    planDelta: costs[worstPlan] - costs[bestPlan],
  };
}

/** The lowest 5% of hourly readings — the draw that never turns off. */
function bottomFivePercentKwh(rows: ProcessedPoint[]): number {
  if (rows.length === 0) return 0;
  const sorted = rows.map((d) => d.usage_kwh).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.05)] || sorted[0];
}

export function calculateVampire(
  filteredData: ProcessedPoint[],
): { cost: number; watts: number } {
  if (filteredData.length === 0) return { cost: 0, watts: 0 };
  const base = bottomFivePercentKwh(filteredData);
  return {
    cost: base * 24 * 30 * (filteredData[0].activeRateSet.tou.offPeak / 100),
    watts: base * 1000,
  };
}

/* --------------------------------------------------------------------------
 * Always-on floor — the same measurement, phrased the way a household talks
 * about it, and checked against the community benchmark instead of left as a
 * bare number.
 * -------------------------------------------------------------------------- */

/** Community rule of thumb: always-on load is about 10% of the bill. */
export const ALWAYS_ON_BENCHMARK_SHARE = 0.1;
/** How far either side of the benchmark still counts as "about 10%". */
export const ALWAYS_ON_TOLERANCE = 0.02;

export type AlwaysOnFloor = {
  /** Typical never-off draw, in watts. */
  watts: number;
  /** Same thing as energy: watts/1000 × 24. */
  kwhPerDay: number;
  /** kwhPerDay priced at this household's own blended commodity rate. */
  annualCost: number;
  /** The blended $/kWh the household actually pays across the window. */
  blendedRateCents: number;
  /** Floor cost as a share of the window's total commodity cost. */
  billShare: number;
  benchmarkShare: number;
  verdict: 'below' | 'near' | 'above';
  /** "Always-on floor ≈ 8.4 kWh/day ≈ $312/yr" */
  label: string;
  /** The benchmark sentence under it. */
  detail: string;
};

export function calculateAlwaysOnFloor(
  rows: ProcessedPoint[],
  plan: 'TOU' | 'Tiered' | 'ULO',
): AlwaysOnFloor | null {
  if (rows.length === 0) return null;
  const base = bottomFivePercentKwh(rows);

  let cost = 0;
  let kwh = 0;
  for (const r of rows) {
    cost += plan === 'TOU' ? r.costTOU : plan === 'ULO' ? r.costULO : r.costTiered;
    kwh += r.usage_kwh;
  }
  // The rate this household really pays, across the hours it really used.
  const blendedRateCents = kwh > 0 ? (cost / kwh) * 100 : rows[0].activeRateSet.tou.offPeak;

  const kwhPerDay = base * 24;
  const annualCost = kwhPerDay * 365 * (blendedRateCents / 100);
  const floorCost = base * rows.length * (blendedRateCents / 100);
  const billShare = cost > 0 ? floorCost / cost : 0;
  const drift = Math.abs(billShare - ALWAYS_ON_BENCHMARK_SHARE);
  const verdict: AlwaysOnFloor['verdict'] =
    drift <= ALWAYS_ON_TOLERANCE ? 'near' : billShare < ALWAYS_ON_BENCHMARK_SHARE ? 'below' : 'above';

  return {
    watts: base * 1000,
    kwhPerDay,
    annualCost,
    blendedRateCents,
    billShare,
    benchmarkShare: ALWAYS_ON_BENCHMARK_SHARE,
    verdict,
    label: `Always-on floor ≈ ${kwhPerDay.toFixed(1)} kWh/day ≈ $${annualCost.toFixed(0)}/yr`,
    detail: `Community benchmark is about ${Math.round(ALWAYS_ON_BENCHMARK_SHARE * 100)}% of the bill — yours works out at ${(billShare * 100).toFixed(0)}% (${verdict === 'near' ? 'in line with it' : verdict === 'below' ? 'below it, nicely low' : 'above it, worth a plug-hunt'}).`,
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

  const dailyTotals = new Map<string, { dateObj: Date; usage: number; rows: ProcessedPoint[] }>();
  filteredData.forEach((d) => {
    const existing = dailyTotals.get(d.dayStr);
    if (!existing) {
      dailyTotals.set(d.dayStr, { dateObj: d.dateObj, usage: 0, rows: [] });
    }
    const bucket = dailyTotals.get(d.dayStr)!;
    bucket.usage += d.usage_kwh;
    bucket.rows.push(d);
  });

  const spikes: Anomaly[] = [];
  dailyTotals.forEach((val) => {
    const exp = expectedAvgs[val.dateObj.getDay()];
    if (exp > 0 && val.usage > exp * 1.5 && val.usage - exp > 5) {
      spikes.push({
        date: val.dateObj,
        usage: val.usage,
        expected: exp,
        diffPct: ((val.usage - exp) / exp) * 100,
        // Why was it expensive — the SHAPE of that day, not just its total.
        signature: classifyDayShape(val.rows),
      });
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

/* ==========================================================================
 * Multi-export merge — 2+ Green Button files into one reading set
 *
 * A single export usually covers one billing period, so extending the date
 * range means uploading several. Rows are deduped on their unix timestamp and
 * the FIRST file that claims a timestamp wins, so an overlap never silently
 * rewrites a value the user already had.
 * ========================================================================== */

export type MergeSource = { name: string; readings: DataPoint[] };

export type MergeFileSummary = {
  name: string;
  /** Rows this file contributed to the merged set. */
  rows: number;
  /** Rows the file carried before dedupe. */
  rawRows: number;
  duplicates: number;
  /** yyyy-MM-dd, '' when the file carried no readable rows. */
  firstDate: string;
  lastDate: string;
};

export type MergeResult = {
  /** Sorted ascending by timestamp, one row per distinct timestamp. */
  readings: DataPoint[];
  /** Raw rows across every file, before dedupe. */
  totalRows: number;
  duplicateRows: number;
  mergedRows: number;
  firstDate: string;
  lastDate: string;
  files: MergeFileSummary[];
};

function dayOfTimestamp(ts: number): string {
  return format(new Date(ts * 1000), 'yyyy-MM-dd');
}

export function mergeReadings(sources: MergeSource[]): MergeResult {
  const seen = new Set<number>();
  const kept: DataPoint[] = [];
  const files: MergeFileSummary[] = [];
  let totalRows = 0;
  let duplicateRows = 0;

  for (const source of sources) {
    const sorted = [...source.readings].sort((a, b) => a.timestamp - b.timestamp);
    let rows = 0;
    let duplicates = 0;
    let first = 0;
    let last = 0;

    for (const r of sorted) {
      totalRows += 1;
      if (first === 0 || r.timestamp < first) first = r.timestamp;
      if (r.timestamp > last) last = r.timestamp;
      if (seen.has(r.timestamp)) {
        duplicates += 1;
        duplicateRows += 1;
        continue;
      }
      seen.add(r.timestamp);
      kept.push(r);
      rows += 1;
    }

    files.push({
      name: source.name,
      rows,
      rawRows: sorted.length,
      duplicates,
      firstDate: sorted.length > 0 ? dayOfTimestamp(first) : '',
      lastDate: sorted.length > 0 ? dayOfTimestamp(last) : '',
    });
  }

  kept.sort((a, b) => a.timestamp - b.timestamp);

  return {
    readings: kept,
    totalRows,
    duplicateRows,
    mergedRows: kept.length,
    firstDate: kept.length > 0 ? dayOfTimestamp(kept[0].timestamp) : '',
    lastDate: kept.length > 0 ? dayOfTimestamp(kept[kept.length - 1].timestamp) : '',
    files,
  };
}

/* ==========================================================================
 * Work-from-home window — what share of the visible energy lands on a
 * weekday between 07:00 and 19:00. One line on the Chart that explains WHY
 * a tiered plan wins or loses for this household.
 * ========================================================================== */

export const WFH_START_HOUR = 7;
export const WFH_END_HOUR = 19;

export type WfhShare = {
  share: number;
  kwh: number;
  totalKwh: number;
  /** Distinct weekdays inside the window. */
  weekdays: number;
  label: string;
};

export function calculateWfhShare(rows: ProcessedPoint[]): WfhShare | null {
  if (rows.length === 0) return null;
  let kwh = 0;
  let totalKwh = 0;
  const weekdays = new Set<string>();
  for (const r of rows) {
    totalKwh += r.usage_kwh;
    const dow = r.dateObj.getDay();
    const h = r.dateObj.getHours();
    if (dow >= 1 && dow <= 5 && h >= WFH_START_HOUR && h < WFH_END_HOUR) {
      kwh += r.usage_kwh;
      weekdays.add(r.dayStr);
    }
  }
  if (totalKwh <= 0) return null;
  return {
    share: kwh / totalKwh,
    kwh,
    totalKwh,
    weekdays: weekdays.size,
    label: `Work-from-home window (07:00–19:00 weekdays)`,
  };
}
