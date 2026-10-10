import { XMLParser } from 'fast-xml-parser';
import { isOntarioHoliday } from './ontarioHolidays';
import type { HourlyTemps } from './openMeteo';
import { tempAtC } from './openMeteo';
import {
  isWeekend, startOfMonth,
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
  /** What the WEATHER looked like — present only when temperatures are. */
  context?: AnomalyContext;
};

/* ==========================================================================
 * Anomaly context — "31°C, that's AC" (Wave T slice 2)
 *
 * A spike is a fact ("you used 104 kWh, 74% over a normal Thursday"); WHY is
 * a guess. The weather half of the guess is cheap and checkable: if the day
 * was hot, air conditioning is the obvious culprit; if it was freezing,
 * heating; if it was mild, weather did not do it and the appliance list is
 * where to look. That is all this label claims — it does not name a device,
 * it says whether looking at the weather explains anything at all.
 *
 * Thresholds are the ones the household's OWN temperature curve justifies
 * (lib/tempBands.ts): 24°C is the bin where draw leaves the cold baseline and
 * roughly doubles, and 0°C is the freezing point that starts heating season.
 * Both are exported constants so a test can pin them and a reader can see
 * they were chosen, not discovered to fit one week.
 * ========================================================================== */

/** Above this day-high the verdict is "that's AC". */
export const ANOMALY_AC_TEMP_C = 24;
/** Below this day-low the verdict is "that's heat". */
export const ANOMALY_HEAT_TEMP_C = 0;

export type AnomalyContextKind = 'ac' | 'heat' | 'mild' | 'unknown';

/**
 * What the card says. `tempC` is the number the verdict is ABOUT — the day's
 * high when it is blaming heat, its low when it is blaming cold, its mean
 * when it is saying weather is not the story — so the label and the number
 * can never disagree.
 */
export type AnomalyContext = {
  kind: AnomalyContextKind;
  tempC: number | null;
  text: string;
};

/** Temperatures for one calendar day, as the UTC hours that fall in it. */
function dayTemps(
  rows: { timestamp: number }[],
  temps: HourlyTemps | null | undefined,
): { mean: number | null; high: number | null; low: number | null; hours: number } {
  let sum = 0;
  let high = -Infinity;
  let low = Infinity;
  let hours = 0;
  for (const r of rows) {
    const t = tempAtC(temps, r.timestamp);
    if (t === null) continue;
    hours += 1;
    sum += t;
    if (t > high) high = t;
    if (t < low) low = t;
  }
  if (hours === 0) return { mean: null, high: null, low: null, hours: 0 };
  return { mean: sum / hours, high, low, hours };
}

const whole = (v: number) => String(Math.round(v));

/**
 * The verdict string for one anomaly day.
 *
 * Four honest outcomes, no fifth: the day's high (air conditioning), its low
 * (heating), mild enough that weather is not an explanation, or no
 * temperature at all — in which case we say "no data" instead of guessing.
 */
export function anomalyWeatherContext(
  rows: { timestamp: number }[],
  temps: HourlyTemps | null | undefined,
): AnomalyContext {
  const day = dayTemps(rows, temps);
  if (day.mean === null || day.high === null || day.low === null) {
    return { kind: 'unknown', tempC: null, text: 'no data' };
  }
  if (day.high >= ANOMALY_AC_TEMP_C) {
    return { kind: 'ac', tempC: day.high, text: `${whole(day.high)}°C — that's AC` };
  }
  if (day.low <= ANOMALY_HEAT_TEMP_C) {
    return { kind: 'heat', tempC: day.low, text: `${whole(day.low)}°C — that's heat` };
  }
  return {
    kind: 'mild',
    tempC: day.mean,
    text: 'no weather signal — worth checking the appliance',
  };
}

/* ==========================================================================
 * Appliance-signature labelling for anomaly days
 *
 * detectAnomalies already knows WHICH day was expensive. These functions say
 * WHAT SHAPE the excess took — hedged, evidence-first, with an honest
 * "we can't tell" fallback. Readings are summed into per-clock-hour buckets,
 * so the curve is kW whatever the feed's cadence is (4×15 min in an hour sums
 * to the same kWh as 1×60 min) — no hourly-reading assumption here.
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

/**
 * Sum each clock hour's readings into one bucket.
 *
 * kWh accumulated over an hour = average kW over that hour, for ANY cadence,
 * so the curve is cadence-independent (a partial hour — a gap — reads low,
 * which is honest).
 */
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

/* Wave U — user-visible sentences in this file come from the locale catalog
 * at call time (lib code reads the module locale; components re-render on
 * toggle via useTranslation). Numeric fields stay numeric. */
import { fmtMoney0, getLocale, t } from '@/i18n';

/**
 * "$0.0412/kWh" / "$3.95/month" — the true-bill receipt's rate format.
 * fr-CA moves the symbol: "0,0412 $/kWh".
 */
function fmtCharge(rate: number, digits: number, unit: 'kWh' | 'month'): string {
  const fr = getLocale() === 'fr';
  const n = new Intl.NumberFormat(fr ? 'fr-CA' : 'en-CA', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(rate);
  return fr ? `${n} $/${unit}` : `$${n}/${unit}`;
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
      label: t('sig.sustained.label'),
      detail: t('sig.sustained.detail', {
        hours: sustained.hours,
        kw: SIGNATURE_SUSTAINED_KW,
        avg: sustained.avg.toFixed(1),
        range: hourRange(sustained.start, sustained.hours),
      }),
    };
  }

  if (sustained.hours >= 1 && sustained.hours <= SIGNATURE_SPIKE_MAX_HOURS) {
    return {
      id: 'short-spike',
      label: t('sig.spike.label'),
      detail: t('sig.spike.detail', {
        hours: sustained.hours,
        peak: sustained.peak.toFixed(1),
        range: hourRange(sustained.start, sustained.hours),
      }),
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
        label: t('sig.tail.label'),
        detail: t('sig.tail.detail', {
          hours: tailValues.length,
          kw: mean.toFixed(1),
          spread: Math.round(cv * 100),
        }),
      };
    }
  }

  return {
    id: 'unclassified',
    label: t('sig.unclassified.label'),
    detail: t('sig.unclassified.detail', {
      kw: SIGNATURE_SUSTAINED_KW,
      hours: SIGNATURE_SUSTAINED_HOURS,
    }),
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

/** What one parse of one Green Button document produces. */
export type GreenButtonFeed = {
  /** Per-UsagePoint reading groups; [] when the document carries no readings. */
  groups: UsagePointGroup[];
  /** Every bill block, oldest billing period first. */
  summaries: UsageSummary[];
  /** The feed's own clock rules, when the file carries LocalTimeParameters. */
  localTime: LocalTimeParams | null;
};

/**
 * One pass over one document: readings, bills and the feed's own clock.
 *
 * Everything Wave L needs sits in the same XML the reading parser already
 * parses, so parsing it twice would double an 800 KB document's cost for no
 * reason — the whole feed comes out of a single `XMLParser.parse`.
 *
 * Readings: a document is grouped per UsagePoint, and one that never
 * identifies a UsagePoint (plain fixtures, single-meter exports without
 * links) collapses into exactly one group with id '' — the historical
 * behaviour. Returns empty groups when the document carries no readings.
 */
export function parseGreenButtonFeed(xmlText: string): GreenButtonFeed {
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
  out.sort((a, b) => {
    const at = a.readings[0]?.timestamp ?? 0;
    const bt = b.readings[0]?.timestamp ?? 0;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });

  return {
    groups: out,
    summaries: parseUsageSummaryNodes(parsed),
    localTime: parseLocalTimeNode(parsed),
  };
}

/**
 * Parse a Green Button document into per-UsagePoint groups.
 * Returns [] when the document carries no readings at all.
 * Documents that never identify a UsagePoint (plain fixtures, single-meter
 * exports without links) collapse into exactly one group with id '' — the
 * historical behavior.
 *
 * Callers that also want the bills or the feed's clock use
 * {@link parseGreenButtonFeed} instead, so the document is parsed once.
 */
export function parseGreenButtonUsagePoints(xmlText: string): UsagePointGroup[] {
  return parseGreenButtonFeed(xmlText).groups;
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

/**
 * The wall-clock parts TOU/ULO/season classification reads.
 *
 * `month` is 1–12, `dow` is `Date#getDay` order (0 = Sunday). These come from
 * the browser's clock today, and from the feed's own {@link LocalTimeParams}
 * when the file carries them (Wave L) — the classifier itself never looks at
 * a `Date`, so one implementation prices both.
 */
export type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
};

export function wallClockOf(dt: Date): WallClock {
  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    hour: dt.getHours(),
    minute: dt.getMinutes(),
    dow: dt.getDay(),
  };
}

/**
 * OEB time-of-use windows, on a wall clock (not on a `Date`).
 *
 * Weekends AND the OEB's published holidays price off-peak all day — the
 * second half of that rule was missing until Wave L, when Mark's real bill
 * showed 2026-08-03 counted as a full off-peak day on the meter (see
 * lib/ontarioHolidays.ts).
 */
export function categorizeTOUAt(
  w: Pick<WallClock, 'hour' | 'dow' | 'month' | 'year' | 'day'>,
): string {
  const h = w.hour;
  if (w.dow === 0 || w.dow === 6) return 'Off-Peak';
  if (isOntarioHoliday(w.year, w.month, w.day)) return 'Off-Peak';
  // Ontario rate season: winter Nov 1 – Apr 30 (1-based months), summer May 1 – Oct 31.
  const isWin = w.month >= 11 || w.month <= 4;
  if (h >= 19 || h < 7) return 'Off-Peak';
  if (isWin) return (h >= 7 && h < 11) || (h >= 17 && h < 19) ? 'On-Peak' : 'Mid-Peak';
  return (h >= 11 && h < 17) ? 'On-Peak' : 'Mid-Peak';
}

/**
 * OEB ultra-low-overnight windows, on a wall clock.
 * On the OEB's holidays ULO prices like a weekend (weekend-off-peak + overnight).
 */
export function categorizeULOAt(
  w: Pick<WallClock, 'hour' | 'dow'> & Partial<Pick<WallClock, 'year' | 'month' | 'day'>>,
): string {
  const h = w.hour;
  if (h >= 23 || h < 7) return 'Overnight';
  const holiday =
    w.year !== undefined && w.month !== undefined && w.day !== undefined
      ? isOntarioHoliday(w.year, w.month, w.day)
      : false;
  if (w.dow === 0 || w.dow === 6 || holiday) return 'Weekend Off-Peak';
  if (h >= 16 && h < 21) return 'On-Peak';
  return 'Mid-Peak';
}

/** Local-browser classification — the pre-Wave-L behaviour, unchanged. */
export function categorizeTOU(date: Date): string {
  return categorizeTOUAt(wallClockOf(date));
}

/** Local-browser classification — the pre-Wave-L behaviour, unchanged. */
export function categorizeULO(date: Date): string {
  return categorizeULOAt(wallClockOf(date));
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

/* ---------------------------------------------------------------------------
 * Wave I — fast local date formatting.
 *
 * `date-fns` `format()` parses its pattern on EVERY call. On the bundled
 * 8,760-reading example year the Chart pipeline issued ~35,000 of them per
 * cold load, measured at 43.6 ms (processRawData) + 25.5 ms (aggregation) of
 * the 286 ms pipeline — and a phone at 4x CPU slowdown pays that four times
 * over. These helpers build byte-identical strings for the six patterns this
 * file actually uses with plain arithmetic in local time, which is what
 * `format()` does too, so no displayed value changes.
 * ------------------------------------------------------------------------- */
const MONTH_ABBR_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
// Wave U — the French chart labels, same array-lookup cost as English. The
// French abbreviations drop date-fns' trailing dot ("sept.") to match the
// OEB-style period captions elsewhere in the app.
const MONTH_ABBR_FR = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
];
/** Active-locale month abbreviations — one property read per call. */
const MONTH_ABBR = (): readonly string[] =>
  getLocale() === 'fr' ? MONTH_ABBR_FR : MONTH_ABBR_EN;
const p2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `yyyy-MM-dd` in local time — the app's day key everywhere. */
export function fmtDay(dt: Date): string {
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}

/** `yyyy-MM` in local time — the monthly bucket key. */
export function fmtMonthKey(dt: Date): string {
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}`;
}

/** `MMM yyyy` — the monthly bar label ("Sep 2026"). */
export function fmtMonthLabel(dt: Date): string {
  return `${MONTH_ABBR()[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** `MMM dd` — the daily bar label ("Oct 04"), zero-padded exactly like date-fns. */
export function fmtDayLabel(dt: Date): string {
  return `${MONTH_ABBR()[dt.getMonth()]} ${p2(dt.getDate())}`;
}

/** `HH:mm` — the hourly bar label ("07:00"), zero-padded. */
export function fmtHour(dt: Date): string {
  return `${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
}

/** Monday 00:00 local — `startOfWeek(d, { weekStartsOn: 1 })`, without the parse. */
export function mondayOf(dt: Date): Date {
  const midnight = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  midnight.setDate(midnight.getDate() - ((midnight.getDay() + 6) % 7));
  return midnight;
}

/* --- day-key arithmetic -------------------------------------------------
 * A `yyyy-MM-dd` day key carries no timezone, so it must be read back with
 * calendar maths rather than through a local Date (whose answer would depend
 * on the machine). These are the label/key twins of fmtDayLabel / fmtMonthKey
 * / mondayOf, for code that already holds a key. */

function dayKeyParts(key: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** `MMM dd` for a day key ("Oct 04"). */
function dayLabelOfDayKey(key: string): string {
  const p = dayKeyParts(key);
  if (!p) return key;
  return `${MONTH_ABBR()[p.month - 1]} ${p2(p.day)}`;
}

/** `MMM yyyy` for a day key ("Sep 2026"). */
function monthLabelOfDayKey(key: string): string {
  const p = dayKeyParts(key);
  if (!p) return key;
  return `${MONTH_ABBR()[p.month - 1]} ${p.year}`;
}

/** Monday's day key for a day key — mondayOf's arithmetic, timezone-free. */
function mondayKeyOfDayKey(key: string): string {
  const p = dayKeyParts(key);
  if (!p) return key;
  const utc = Date.UTC(p.year, p.month - 1, p.day);
  const shift = (new Date(utc).getUTCDay() + 6) % 7;
  const mon = new Date(utc - shift * 86400000);
  return `${mon.getUTCFullYear()}-${p2(mon.getUTCMonth() + 1)}-${p2(mon.getUTCDate())}`;
}

/**
 * Price every reading.
 *
 * `zone` is the dataset's own clock (from the file's LocalTimeParameters,
 * Wave L item 4): when present it decides the day bucket, the hour bucket and
 * the TOU/ULO/winter classification — i.e. everything the bill is computed
 * from — so a feed whose DST regime differs from the browser's still prices
 * correctly. `dateObj` always stays the true instant; without a zone this is
 * the browser's local clock, exactly as before.
 */
export function processRawData(
  rawData: DataPoint[],
  rateHistory: RateSet[],
  zone?: DatasetZone | null,
): ProcessedPoint[] {
  if (rateHistory.length === 0) return [];
  const sorted = [...rateHistory].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  // Rate schedules change a handful of times a year, not per reading: resolve
  // once per distinct day instead of scanning `sorted` 8,760 times.
  const ratesByDay = new Map<string, RateSet>();
  return rawData.map((d) => {
    const dt = new Date(d.timestamp * 1000);
    const w = zone ? zone.wallClock(d.timestamp) : wallClockOf(dt);
    const dayStr = zone ? zone.dayKey(d.timestamp) : fmtDay(dt);
    let rates = ratesByDay.get(dayStr);
    if (!rates) {
      rates = sorted.find((r) => dayStr >= r.effectiveDate) || sorted[sorted.length - 1];
      ratesByDay.set(dayStr, rates);
    }
    const touCategory = categorizeTOUAt(w);
    const uloCategory = categorizeULOAt(w);
    const isWinter = w.month >= 11 || w.month <= 4;
    const costTOU = d.usage_kwh * (rates.tou[getTouRateKey(touCategory)] / 100);
    const costULO = d.usage_kwh * (rates.ulo[getUloRateKey(uloCategory)] / 100);
    const costTiered = d.usage_kwh * (rates.tiered.tier1 / 100);
    return {
      ...d,
      dateObj: dt,
      dayStr,
      hourStr: zone ? zone.hourKey(d.timestamp) : fmtHour(dt),
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
  if (zoomLevel === 'weekly') return filteredData.filter((d) => fmtMonthKey(d.dateObj) === zoomTarget);
  if (zoomLevel === 'daily')
    return filteredData.filter((d) => fmtDay(mondayOf(d.dateObj)) === zoomTarget);
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

  type Bucket = {
    label: string;
    usage: number;
    key: string;
    costTOU: number;
    costULO: number;
    /** First reading of the bucket — carries the season + rate schedule. */
    first: ProcessedPoint;
    /** Distinct days seen, for the tiered threshold's per-30.4-day scaling. */
    days: Set<string>;
  };

  // Wave I: a bucket's label and key depend only on the reading's DAY, never
  // on the row, so derive them once per distinct day. The old code ran two
  // date-fns `format()` parses per reading — 17,520 of them for a year of
  // hourly data — and kept every ProcessedPoint in a per-bucket array just to
  // count distinct days and read element [0].
  const metaByDay = new Map<string, { label: string; key: string }>();
  // A bucket's label and key depend only on the reading's DAY. Deriving them
  // from dayStr (not from dateObj) keeps the buckets in the dataset's own
  // clock when the feed carries LocalTimeParameters (Wave L item 4) and
  // changes nothing otherwise — dayStr is exactly the local date string a
  // no-zone feed produced before.
  const metaFor = (d: ProcessedPoint): { label: string; key: string } => {
    const hit = metaByDay.get(d.dayStr);
    if (hit) return hit;
    let label = '';
    let key = '';
    if (zoomLevel === 'monthly') {
      label = monthLabelOfDayKey(d.dayStr);
      key = d.dayStr.slice(0, 7);
    } else if (zoomLevel === 'weekly') {
      const mon = mondayKeyOfDayKey(d.dayStr);
      label = 'Week of ' + dayLabelOfDayKey(mon);
      key = mon;
    } else if (zoomLevel === 'daily') {
      label = dayLabelOfDayKey(d.dayStr);
      key = d.dayStr;
    }
    const meta = { label, key };
    metaByDay.set(d.dayStr, meta);
    return meta;
  };

  const map = new Map<string, Bucket>();
  for (const d of data) {
    const { label, key } = metaFor(d);
    let o = map.get(key);
    if (!o) {
      o = { label, usage: 0, key, costTOU: 0, costULO: 0, first: d, days: new Set() };
      map.set(key, o);
    }
    o.usage += d.usage_kwh;
    o.costTOU += d.costTOU;
    o.costULO += d.costULO;
    o.days.add(d.dayStr);
  }

  return Array.from(map.values())
    .map((v) => {
      const r = v.first;
      const days = v.days.size;
      const th =
        (r.isWinter ? r.activeRateSet.tiered.thresholdWinter : r.activeRateSet.tiered.thresholdSummer) *
        (days / 30.4);
      const costTiered =
        v.usage <= th
          ? v.usage * (r.activeRateSet.tiered.tier1 / 100)
          : th * (r.activeRateSet.tiered.tier1 / 100) + (v.usage - th) * (r.activeRateSet.tiered.tier2 / 100);
      return { label: v.label, usage: v.usage, key: v.key, costTOU: v.costTOU, costULO: v.costULO, costTiered };
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

/** A window is "mostly empty" below this share of its calendar days carrying a reading.
 *  Exported because the billing-axis window picker applies the SAME gate —
 *  one number for "is this window worth opening", not two that can drift. */
export const MIN_WINDOW_COVERAGE = 0.5;

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
    rawData.map((d) => fmtDay(new Date(d.timestamp * 1000))),
  );
  const coverage = (s: Date, e: Date): number => {
    const total = differenceInCalendarDays(e, s) + 1;
    if (total <= 0) return 0;
    let withData = 0;
    for (let d = s; !isAfter(d, e); d = addDays(d, 1)) {
      if (daysWithReadings.has(fmtDay(d))) withData += 1;
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
        start: fmtDay(c.window.start),
        end: fmtDay(c.window.end),
        scope: c.scope,
      };
    }
  }

  // Unreachable in practice (the trailing window is data-anchored); if the
  // dataset's own days are mostly missing, show the raw data range instead.
  return {
    start: fmtDay(firstDay),
    end: fmtDay(lastDay),
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
    firstDate: fmtDay(oldest.dateObj),
    lastDate: fmtDay(newest.dateObj),
    totalKwh,
    costTOU: costs.TOU,
    costTiered: costs.Tiered,
    costULO: costs.ULO,
    bestPlan,
    worstPlan,
    planDelta: costs[worstPlan] - costs[bestPlan],
  };
}

/* ---------------------------------------------------------------------------
 * Reading-interval measurement
 *
 * `usage_kwh` is energy per READING INTERVAL, and Green Button / ESPI exports
 * are commonly 15-, 30- or 60-minute IntervalReadings. Anything that turns the
 * base load into a daily/annual figure multiplies by 24 h (hours/day), which is
 * only right when the feed is hourly — on a 15-minute export the same maths
 * comes out 4x too low, silently, because the bundled fixtures are hourly.
 * --------------------------------------------------------------------------- */

/**
 * The legacy hourly assumption, used ONLY when the interval can't be measured
 * from the data (kept explicit rather than silently spread through the maths).
 */
export const UNMEASURABLE_INTERVAL_HOURS = 1;

/**
 * Length of one reading interval, in HOURS, measured from the data itself.
 *
 * The *modal* positive gap between consecutive `timestamp`s (ties resolved to
 * the shortest), because real exports carry gaps the modal spacing ignores:
 * outage holes, DST transitions, missing readings and duplicated timestamps all
 * produce off-cadence deltas but never outnumber the true cadence.
 *
 * `timestamp` is epoch SECONDS (readings are built as `new Date(t * 1000)`),
 * so a 900-second gap is a 0.25-hour interval.
 *
 * Returns {@link UNMEASURABLE_INTERVAL_HOURS} when there is nothing to measure
 * from: fewer than two rows, or no positive gap at all (every stamp equal).
 */
export function inferIntervalHours(rows: { timestamp: number }[]): number {
  if (rows.length < 2) return UNMEASURABLE_INTERVAL_HOURS;

  const stamps = rows
    .map((r) => r.timestamp)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (stamps.length < 2) return UNMEASURABLE_INTERVAL_HOURS;

  const gapCounts = new Map<number, number>();
  for (let i = 1; i < stamps.length; i += 1) {
    const gap = stamps[i] - stamps[i - 1];
    if (gap > 0) gapCounts.set(gap, (gapCounts.get(gap) ?? 0) + 1);
  }
  if (gapCounts.size === 0) return UNMEASURABLE_INTERVAL_HOURS;

  let busiest = 0;
  let shortest = Infinity;
  for (const [gap, count] of gapCounts) {
    if (count > busiest || (count === busiest && gap < shortest)) {
      busiest = count;
      shortest = gap;
    }
  }
  const hours = shortest / 3600;
  return hours > 0 ? hours : UNMEASURABLE_INTERVAL_HOURS;
}

/**
 * The lowest 5% of readings — energy PER READING INTERVAL, in kWh.
 *
 * This is the raw measurement; it equals kW only for an hourly feed. Divide by
 * {@link inferIntervalHours} for a rate-ready draw (that is what
 * {@link calculateVampire} and {@link calculateAlwaysOnFloor} do).
 */
function bottomFivePercentKwhPerInterval(rows: ProcessedPoint[]): number {
  if (rows.length === 0) return 0;
  const sorted = rows.map((d) => d.usage_kwh).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.05)] || sorted[0];
}

export function calculateVampire(
  filteredData: ProcessedPoint[],
): { cost: number; watts: number } {
  if (filteredData.length === 0) return { cost: 0, watts: 0 };
  // P05 is per-interval kWh; convert to kW first, so the 24 h × 30 d
  // extrapolation below is right for 15-, 30- and 60-minute feeds alike.
  const kw =
    bottomFivePercentKwhPerInterval(filteredData) /
    inferIntervalHours(filteredData);
  return {
    cost: kw * 24 * 30 * (filteredData[0].activeRateSet.tou.offPeak / 100),
    watts: kw * 1000,
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
  const basePerInterval = bottomFivePercentKwhPerInterval(rows);
  // Per-interval kWh → kW, so the ×24 h/day below is cadence-independent.
  const kw = basePerInterval / inferIntervalHours(rows);

  let cost = 0;
  let kwh = 0;
  for (const r of rows) {
    cost += plan === 'TOU' ? r.costTOU : plan === 'ULO' ? r.costULO : r.costTiered;
    kwh += r.usage_kwh;
  }
  // The rate this household really pays, across the hours it really used.
  const blendedRateCents = kwh > 0 ? (cost / kwh) * 100 : rows[0].activeRateSet.tou.offPeak;

  const kwhPerDay = kw * 24;
  const annualCost = kwhPerDay * 365 * (blendedRateCents / 100);
  // Deliberately NOT divided by the interval: per-interval kWh × row count is
  // already the window's total energy, so this and billShare stay as they are.
  const floorCost = basePerInterval * rows.length * (blendedRateCents / 100);
  const billShare = cost > 0 ? floorCost / cost : 0;
  const drift = Math.abs(billShare - ALWAYS_ON_BENCHMARK_SHARE);
  const verdict: AlwaysOnFloor['verdict'] =
    drift <= ALWAYS_ON_TOLERANCE ? 'near' : billShare < ALWAYS_ON_BENCHMARK_SHARE ? 'below' : 'above';

  return {
    watts: kw * 1000,
    kwhPerDay,
    annualCost,
    blendedRateCents,
    billShare,
    benchmarkShare: ALWAYS_ON_BENCHMARK_SHARE,
    verdict,
    label: t('floor.calcLabel', { kwh: kwhPerDay.toFixed(1), cost: fmtMoney0(annualCost) }),
    detail: t(`floor.benchmark.${verdict}`, {
      benchmark: Math.round(ALWAYS_ON_BENCHMARK_SHARE * 100),
      actual: (billShare * 100).toFixed(0),
    }),
  };
}

export function detectAnomalies(
  processedData: ProcessedPoint[],
  filteredData: ProcessedPoint[],
  temps?: HourlyTemps | null,
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
        // ...and the weather it happened in, when we hold temperatures at all.
        // Computed HERE, next to the rows that made the day an anomaly, so the
        // card never has to reconstruct which hours belonged to it.
        context: anomalyWeatherContext(val.rows, temps),
      });
    }
  });
  return spikes.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
}

/**
 * One weekday×hour cell.
 *
 * `sum`/`count` describe the readings themselves; `days` is how many distinct
 * calendar days fed the cell, which is what `avg` divides by (see below).
 */
export type HeatmapCell = { sum: number; count: number; days: number; avg: number };
export type HeatmapData = { grid: HeatmapCell[][]; maxAvg: number };

/**
 * Average energy for each weekday-hour cell, in kWh.
 *
 * `sum` is over every reading in the cell (cadence-independent — 4×15-min
 * readings in an hour add up to the same kWh as 1×60-min), so `avg` must divide
 * by the number of DAYS represented, not the number of readings: a reading-mean
 * would show a quarter of the hour's energy on a 15-minute feed.
 *
 * For hourly feeds days === count, so the numbers do not move.
 */
export function buildHeatmapData(
  filteredData: ProcessedPoint[],
): HeatmapData {
  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sum: 0, count: 0, days: 0, avg: 0 })),
  );
  const seenDays = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => new Set<string>()),
  );
  let maxAvg = 0;
  filteredData.forEach((d) => {
    const day = d.dateObj.getDay();
    const hour = d.dateObj.getHours();
    grid[day][hour].sum += d.usage_kwh;
    grid[day][hour].count += 1;
    seenDays[day][hour].add(d.dayStr);
  });
  grid.forEach((day, dIdx) =>
    day.forEach((cell, hIdx) => {
      cell.days = seenDays[dIdx][hIdx].size;
      if (cell.days > 0) cell.avg = cell.sum / cell.days;
      if (cell.avg > maxAvg) maxAvg = cell.avg;
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

/** The four user-editable add-on fields (the card's inputs, nothing else). */
export type ExtraChargeField =
  | 'deliveryPerKwh'
  | 'deliveryFlat'
  | 'regulatoryPerKwh'
  | 'hstPct';

/** Where a set of add-on values came from, when it was not typed by hand. */
export type ExtraChargesSource = {
  /** billingPeriod.start of the UsageSummary they were derived from. */
  periodStart: number;
  /** Human label for that period ("Jul 22, 2026 – Aug 20"). */
  label: string;
  /** Exactly what the file produced — so "still the file's numbers" is a
   *  comparison, not a guess, and a later file can refresh them safely. */
  values: Record<ExtraChargeField, string>;
};

export type ExtraCharges = {
  /** Delivery, $/kWh. */
  deliveryPerKwh: string;
  /** Delivery, flat $/month. */
  deliveryFlat: string;
  /** Regulatory, $/kWh. */
  regulatoryPerKwh: string;
  /** HST percentage (Ontario default hint: 13). */
  hstPct: string;
  /** Set when these values were pre-filled from the feed's own bill (Wave L). */
  xmlSource?: ExtraChargesSource;
};

export const EXTRA_CHARGE_FIELDS: ExtraChargeField[] = [
  'deliveryPerKwh',
  'deliveryFlat',
  'regulatoryPerKwh',
  'hstPct',
];

/**
 * True while every field still says what it said when it was stored — either
 * untouched (all empty, no source) or exactly what the file produced. That is
 * the state in which a NEW bill may safely overwrite the values; once any
 * field differs, the user owns them.
 */
export function chargesArePristine(charges: ExtraCharges): boolean {
  if (charges.xmlSource) {
    return EXTRA_CHARGE_FIELDS.every(
      (f) => charges[f] === (charges.xmlSource?.values[f] ?? ''),
    );
  }
  return EXTRA_CHARGE_FIELDS.every((f) => charges[f] === '');
}

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

  // Wave U — the receipt line names each included charge in the active
  // language; the rates themselves stay numbers (fmtTrueBillRate below).
  const included: string[] = [t('trueBill.include.variable')];
  if (deliveryPerKwh !== null)
    included.push(t('trueBill.include.deliveryPerKwh', { rate: fmtCharge(deliveryPerKwh, 4, 'kWh') }));
  if (deliveryFlat !== null)
    included.push(t('trueBill.include.deliveryFlat', { rate: fmtCharge(deliveryFlat, 2, 'month') }));
  if (regulatoryPerKwh !== null)
    included.push(t('trueBill.include.regulatory', { rate: fmtCharge(regulatoryPerKwh, 4, 'kWh') }));
  if (hstPct !== null) included.push(t('trueBill.include.hst', { pct: hstPct }));

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
    caption: `${t('trueBill.includes', { list: included.join(' + ') })}.`,
  };
}

/* ==========================================================================
 * Wave L — the bill the feed already carries (UsageSummary)
 *
 * Oakville Hydro's export is not just meter readings: Mark's file has three
 * UsageSummary blocks, each a complete itemized bill (billingPeriod, money
 * scalars, and a costAdditionalDetailLastPeriod list of amount + note +
 * itemKind + optional measurement). Money is ESPI's "hundred-thousandths of
 * the currency" — see BILL_AMOUNT_SCALE — and the note is the only label we
 * can trust (see BillLineItem.itemKind).
 *
 * Everything below is pure and client-side: it runs over the same XML string
 * the reading parser already gets, and callers persist the results in
 * localStorage next to `energy_data`. No server round trip, ever.
 * ========================================================================== */

/** ESPI money scale: bill amounts are hundred-thousandths of a currency unit
 *  (the schema documents billLastPeriod exactly that way). $1,365.03 arrives
 *  as 136503000. Verified against Mark's Oakville Hydro export: the three
 *  periods' "Total Electricity Charges" sum to $1,365.03, matching the bill
 *  line-for-line. */
export const BILL_AMOUNT_SCALE = 100000;

export type BillMeasurement = {
  /** `value × 10^powerOfTenMultiplier` — the number the utility means. */
  scaled: number;
  value: number;
  powerOfTenMultiplier: number;
  uom: number | null;
};

export type BillLineItem = {
  /** Verbatim `<note>`, never normalised: it is the only dependable label. */
  note: string;
  /** Dollars (raw ÷ BILL_AMOUNT_SCALE); null when the element is absent. */
  amount: number | null;
  /** The raw integer exactly as the file sent it. */
  rawAmount: number | null;
  /** The raw ESPI ItemKind code, kept exactly as emitted — nothing in this
   *  app may branch on it. The published schemas do not agree on what the
   *  codes mean: the OpenADR-published Green Button XSD's LineItem has no
   *  itemKind at all, while beckn's open DEG documents 1–10 whose meaning
   *  contradicts Oakville's usage (4 on Delivery/Regulatory, 10 on priced
   *  TOU lines). So no code list is hard-coded here — grouping keys off
   *  `note`, and unknown codes still render as the number they are. */
  itemKind: number | null;
  /** Dollars per unit when the utility sends one (same money scale). */
  unitCost: number | null;
  /** Present on the informational lines: meter reads, TOU usage, dates. */
  measurement: BillMeasurement | null;
};

export type UsageSummary = {
  /** Element name the block arrived under: ESPI calls the schema type
   *  ElectricPowerUsageSummary, utilities also emit plain UsageSummary. */
  source: 'UsageSummary' | 'ElectricPowerUsageSummary';
  /** billingPeriod.start / .duration, unix seconds. */
  start: number;
  duration: number;
  /** `yyyy-MM-dd` of start and of start+duration, taken from the raw stamp. */
  startDate: string;
  endDate: string;
  days: number;
  billLastPeriod: number | null;
  billToDate: number | null;
  costAdditionalLastPeriod: number | null;
  /** ISO 4217 numeric code as emitted (124 = CAD). Null when absent. */
  currency: number | null;
  /** overallConsumptionLastPeriod, scaled by its own multiplier. */
  consumption: BillMeasurement | null;
  /** Every line item, verbatim and in file order. */
  items: BillLineItem[];
};

/** The feed's own clock rules, when the file carries them. */
export type LocalTimeParams = {
  /** Seconds east of UTC for the feed's standard time (Oakville: -18000). */
  tzOffset: number;
  /** Seconds added while DST is in force (usually 3600). */
  dstOffset: number | null;
  /** ESPI DstRuleType bitmaps, verbatim hex (`360E2000`). */
  dstStartRule: string | null;
  dstEndRule: string | null;
};

const BILL_BLOCK_NAMES = new Set(['UsageSummary', 'ElectricPowerUsageSummary']);

/** `yyyy-MM-dd` from a unix stamp, in UTC — how a billingPeriod reads. */
function utcDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

function billNum(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : null;
}

/** Raw ESPI money (hundred-thousandths) → dollars; null stays null. */
function scaleMoney(raw: number | null): number | null {
  return raw === null ? null : raw / BILL_AMOUNT_SCALE;
}

function billText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  return s === '' ? null : s;
}

/** Depth-first collection of every named node in the parsed document. */
function collectBillNodes(
  node: unknown,
  names: Set<string>,
): { name: string; node: Record<string, unknown> }[] {
  const out: { name: string; node: Record<string, unknown> }[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
      continue;
    }
    const o = obj as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const child = o[k];
      if (typeof child !== 'object' || child === null) continue;
      if (names.has(k)) {
        for (const c of asArray<Record<string, unknown>>(child as Record<string, unknown>)) {
          out.push({ name: k, node: c });
        }
      }
      stack.push(child);
    }
  }
  return out;
}

function parseMeasurement(raw: unknown): BillMeasurement | null {
  const node = asArray<Record<string, unknown>>(
    (raw as Record<string, unknown> | undefined) ?? {},
  )[0];
  if (!node) return null;
  const value = billNum(node.value);
  if (value === null) return null;
  const powerOfTenMultiplier = billNum(node.powerOfTenMultiplier) ?? 0;
  return {
    value,
    powerOfTenMultiplier,
    uom: billNum(node.uom),
    scaled: value * 10 ** powerOfTenMultiplier,
  };
}

function parseLineItem(raw: unknown): BillLineItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const rawAmount = billNum(o.amount);
  const note = billText(o.note) ?? '';
  const measurement = parseMeasurement(o.measurement);
  if (rawAmount === null && !note && measurement === null) return null;
  const rawUnitCost = billNum(o.unitCost);
  return {
    note,
    rawAmount,
    amount: rawAmount === null ? null : rawAmount / BILL_AMOUNT_SCALE,
    itemKind: billNum(o.itemKind),
    unitCost: rawUnitCost === null ? null : rawUnitCost / BILL_AMOUNT_SCALE,
    measurement,
  };
}

/**
 * Every bill block in an already-parsed document, oldest period first.
 * Blocks without a usable billingPeriod are skipped — they are not a bill.
 */
export function parseUsageSummaryNodes(parsed: unknown): UsageSummary[] {
  const out: UsageSummary[] = [];
  for (const { name, node } of collectBillNodes(parsed, BILL_BLOCK_NAMES)) {
    const period = asArray<Record<string, unknown>>(
      (node.billingPeriod as Record<string, unknown> | undefined) ?? {},
    )[0];
    const start = billNum(period?.start);
    const duration = billNum(period?.duration);
    if (start === null || duration === null || duration <= 0) continue;
    const items = asArray<Record<string, unknown>>(
      node.costAdditionalDetailLastPeriod as Record<string, unknown> | undefined,
    )
      .map(parseLineItem)
      .filter((i): i is BillLineItem => i !== null);
    const consumption = parseMeasurement(node.overallConsumptionLastPeriod);
    out.push({
      source: name as UsageSummary['source'],
      start,
      duration,
      startDate: utcDayKey(start),
      endDate: utcDayKey(start + duration),
      days: Math.round((duration / 86400) * 10) / 10,
      // the same hundred-thousandths scale as the line items
      billLastPeriod: scaleMoney(billNum(node.billLastPeriod)),
      billToDate: scaleMoney(billNum(node.billToDate)),
      costAdditionalLastPeriod: scaleMoney(billNum(node.costAdditionalLastPeriod)),
      currency: billNum(node.currency),
      consumption,
      items,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The first LocalTimeParameters in an already-parsed document, or null.
 * A block without tzOffset describes no clock, so it is ignored rather than
 * guessed at.
 */
export function parseLocalTimeNode(parsed: unknown): LocalTimeParams | null {
  for (const { node } of collectBillNodes(parsed, new Set(['LocalTimeParameters']))) {
    const tzOffset = billNum(node.tzOffset);
    if (tzOffset === null) continue;
    return {
      tzOffset,
      dstOffset: billNum(node.dstOffset),
      dstStartRule: billText(node.dstStartRule)?.toUpperCase() ?? null,
      dstEndRule: billText(node.dstEndRule)?.toUpperCase() ?? null,
    };
  }
  return null;
}

/** Convenience for callers that only want the bills (tests, scripts). */
export function parseUsageSummaries(xmlText: string): UsageSummary[] {
  return parseGreenButtonFeed(xmlText).summaries;
}

/* -------------------------------------------------------------------------
 * LocalTimeParameters → the dataset's own clock (Wave L item 4)
 *
 * ESPI's dstStartRule/dstEndRule are DstRuleType bitmaps:
 *   bits 0-11 seconds-in-hour (0-3599) · 12-16 hour · 17-19 weekday (1 = Mon
 *   … 7 = Sun) · 20-24 day of month · 25-27 operator · 28-31 month.
 * The operators: 0 = on the day of the month, 1 = first weekday on/after it,
 * 2-6 = 1st-5th weekday of the month, 7 = last weekday. 0xFFFFFFFF disables
 * DST. The rule's time is read in the local time in force BEFORE the change.
 * ------------------------------------------------------------------------- */

export type DstRule = {
  month: number;
  operator: number;
  dayOfMonth: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
  second: number;
};

/** `0xFFFFFFFF` — rule processing / DST correction disabled. */
export const DST_RULE_DISABLED = 0xffffffff;

/** Decode one ESPI DstRuleType hex bitmap; null when absent/disabled/broken. */
export function decodeDstRule(rule: string | null | undefined): DstRule | null {
  if (!rule) return null;
  const text = String(rule).trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(text)) return null;
  const v = parseInt(text, 16);
  if (!Number.isFinite(v) || v === DST_RULE_DISABLED) return null;
  const secondsInHour = v & 0xfff;
  const ruleOut: DstRule = {
    month: (v >>> 28) & 0x0f,
    operator: (v >>> 25) & 0x07,
    dayOfMonth: (v >>> 20) & 0x1f,
    dayOfWeek: (v >>> 17) & 0x07,
    hour: (v >>> 12) & 0x1f,
    minute: Math.floor(secondsInHour / 60),
    second: secondsInHour % 60,
  };
  if (ruleOut.month < 1 || ruleOut.month > 12) return null;
  if (ruleOut.hour > 23) return null;
  return ruleOut;
}

/** ESPI weekday (1 = Monday … 7 = Sunday) → JS weekday (0 = Sunday). */
function jsWeekday(espiDow: number): number | null {
  if (espiDow < 1 || espiDow > 7) return null;
  return espiDow === 7 ? 0 : espiDow;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day of month the rule fires on in `year`, or null when it cannot. */
function ruleDayOfMonth(rule: DstRule, year: number): number | null {
  const dim = daysInMonth(year, rule.month);
  const wd = jsWeekday(rule.dayOfWeek);
  const dowAt = (day: number) => new Date(Date.UTC(year, rule.month - 1, day)).getUTCDay();
  switch (rule.operator) {
    case 0:
      return rule.dayOfMonth >= 1 && rule.dayOfMonth <= dim ? rule.dayOfMonth : null;
    case 1: {
      if (wd === null) return null;
      const from = rule.dayOfMonth >= 1 ? rule.dayOfMonth : 1;
      if (from > dim) return null;
      return from + ((wd - dowAt(from) + 7) % 7);
    }
    case 2:
    case 3:
    case 4:
    case 5:
    case 6: {
      if (wd === null) return null;
      const firstDay = 1 + ((wd - dowAt(1) + 7) % 7);
      const day = firstDay + (rule.operator - 2) * 7;
      return day <= dim ? day : null;
    }
    case 7: {
      if (wd === null) return null;
      return dim - ((dowAt(dim) - wd + 7) % 7);
    }
    default:
      return null;
  }
}

/**
 * Unix seconds of the transition in `year`. `offsetBefore` is the UTC offset
 * in force immediately before the change (standard time for a DST start,
 * DST time for a DST end) — that is the offset the rule's wall time is read
 * in, and it is what makes 02:00 on 2026-03-08 land at 07:00Z while 02:00 on
 * 2026-11-01 lands at 06:00Z.
 */
export function dstTransitionAt(rule: DstRule, year: number, offsetBefore: number): number | null {
  const day = ruleDayOfMonth(rule, year);
  if (day === null) return null;
  const wall = Date.UTC(year, rule.month - 1, day, rule.hour, rule.minute, rule.second) / 1000;
  return wall - offsetBefore;
}

export type ZoneTransitions = { start: number | null; end: number | null };

/**
 * A dataset's own clock: fixed offset when the file only says tzOffset, and
 * DST-aware when it also carries the rule bitmaps. This is the source of
 * truth for the dataset's DST handling — the browser's own timezone is only
 * the fallback for files that carry no LocalTimeParameters at all.
 */
export type DatasetZone = {
  params: LocalTimeParams;
  isDST(ts: number): boolean;
  /** UTC offset in force at `ts`, seconds east. */
  offsetAt(ts: number): number;
  /** Wall clock in the dataset's zone at `ts`. */
  wallClock(ts: number): WallClock;
  /** `yyyy-MM-dd` in the dataset's zone. */
  dayKey(ts: number): string;
  /** `HH:mm` in the dataset's zone. */
  hourKey(ts: number): string;
  /** Transition instants covering `year`, or nulls when no rule is present. */
  transitions(year: number): ZoneTransitions;
};

export function resolveZone(params: LocalTimeParams | null | undefined): DatasetZone | null {
  if (!params) return null;
  const tzOffset = params.tzOffset;
  const dstOffset = params.dstOffset ?? 0;
  const startRule = decodeDstRule(params.dstStartRule);
  const endRule = decodeDstRule(params.dstEndRule);
  const cache = new Map<number, ZoneTransitions>();

  const transitions = (year: number): ZoneTransitions => {
    const hit = cache.get(year);
    if (hit) return hit;
    const value: ZoneTransitions = {
      start: startRule ? dstTransitionAt(startRule, year, tzOffset) : null,
      end: endRule ? dstTransitionAt(endRule, year, tzOffset + dstOffset) : null,
    };
    cache.set(year, value);
    return value;
  };

  const isDST = (ts: number): boolean => {
    if (!startRule || !endRule || dstOffset === 0) return false;
    const year = new Date(ts * 1000).getUTCFullYear();
    for (let y = year - 1; y <= year + 1; y += 1) {
      const t = transitions(y);
      if (t.start === null || t.end === null) continue;
      // Southern-hemisphere regimes end the DST year before they start it,
      // so the window may wrap: DST outside [end, start) instead of inside.
      const inDST = t.start < t.end ? ts >= t.start && ts < t.end : ts < t.end || ts >= t.start;
      if (inDST) return true;
    }
    return false;
  };

  const offsetAt = (ts: number): number => tzOffset + (isDST(ts) ? dstOffset : 0);

  const wallClock = (ts: number): WallClock => {
    const d = new Date((ts + offsetAt(ts)) * 1000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      dow: d.getUTCDay(),
    };
  };

  const dayKey = (ts: number): string => {
    const w = wallClock(ts);
    return `${w.year}-${p2(w.month)}-${p2(w.day)}`;
  };

  return {
    params,
    isDST,
    offsetAt,
    wallClock,
    dayKey,
    hourKey: (ts: number) => {
      const w = wallClock(ts);
      return `${p2(w.hour)}:${p2(w.minute)}`;
    },
    transitions,
  };
}

/** ISO 4217 numeric → the label we are sure of; anything else stays numeric. */
export function currencyLabel(code: number | null): string | null {
  if (code === null) return null;
  if (code === 124) return 'CAD';
  if (code === 840) return 'USD';
  return `ISO ${code}`;
}

/* -------------------------------------------------------------------------
 * Line-item classification — keys off the NOTE, never off itemKind
 * ------------------------------------------------------------------------- */

export type BillLineClass =
  | 'commodity'
  | 'delivery'
  | 'regulatory'
  | 'tax'
  | 'credit'
  | 'total'
  | 'info'
  | 'other';

const BILL_INFO_NOTE =
  /\busage\b|meter read|days in bill|loss factor|read date|due date|post date|balance forward|amount due/;

/**
 * Group a line for display and reconciliation. The note is the utility's own
 * wording (Oakville: "Off Peak-Summer", "H.S.T. # 000000000", "Delivery"),
 * so matching stays loose on purpose: an unknown wording falls through to
 * `other` and is still listed verbatim, never silently folded into a total
 * we would then double-count.
 */
export function classifyBillLine(item: BillLineItem): BillLineClass {
  const note = item.note.toLowerCase();
  if (BILL_INFO_NOTE.test(note)) return 'info';
  if (/^total\b|total electricity/.test(note)) return 'total';
  if (/h\.?s\.?t\.?|g\.?s\.?t\.?|\btax\b/.test(note)) return 'tax';
  if (item.amount !== null && item.amount < 0) return 'credit';
  if (/rebate|\bcredit\b/.test(note)) return 'credit';
  if (/delivery|distribution/.test(note)) return 'delivery';
  if (/regulatory/.test(note)) return 'regulatory';
  if (/(off|mid|on)[ -]?peak|tiered|-peak|block|supply|commodity|energy charge/.test(note)) {
    return 'commodity';
  }
  if (item.amount === null || item.amount === 0) return 'info';
  return 'other';
}

export type BillTotals = {
  /** Sum of the commodity lines — what the electricity itself cost. */
  commodity: number;
  delivery: number;
  regulatory: number;
  tax: number;
  /** Credits as signed numbers (the Ontario Electricity Rebate is negative). */
  credit: number;
  /** Any line we could not classify (listed, never folded into another). */
  other: number;
  /** "Total Electricity Charges" when present, else commodity+delivery+reg. */
  total: number;
  /** Explicit "Amount Due" when the file states a non-zero one. */
  amountDue: number | null;
  /** total + tax — the bill before the rebate, which is what our estimate
   *  models (Wave B has no rebate field, so the delta is compared here). */
  preRebate: number;
  /** preRebate + credit — what the customer actually pays. */
  payable: number;
};

export function billTotals(summary: UsageSummary): BillTotals {
  const t: BillTotals = {
    commodity: 0,
    delivery: 0,
    regulatory: 0,
    tax: 0,
    credit: 0,
    other: 0,
    total: 0,
    amountDue: null,
    preRebate: 0,
    payable: 0,
  };
  let statedTotal: number | null = null;
  for (const item of summary.items) {
    if (item.amount === null) continue;
    switch (classifyBillLine(item)) {
      case 'commodity': t.commodity += item.amount; break;
      case 'delivery': t.delivery += item.amount; break;
      case 'regulatory': t.regulatory += item.amount; break;
      case 'tax': t.tax += item.amount; break;
      case 'credit': t.credit += item.amount; break;
      case 'total': statedTotal = item.amount; break;
      case 'info':
        if (item.note.toLowerCase().includes('amount due') && item.amount !== 0) {
          t.amountDue = item.amount;
        }
        break;
      default: t.other += item.amount;
    }
  }
  t.total = statedTotal ?? t.commodity + t.delivery + t.regulatory;
  t.preRebate = t.total + t.tax;
  t.payable = t.preRebate + t.credit;
  if (t.amountDue === null) t.amountDue = t.payable;
  return t;
}

/**
 * kWh the bill charged for, from the "… Usage" measurement lines (Oakville
 * stamps one per TOU window; they sum to the billed quantity exactly). Null
 * when the file says nothing usable — callers fall back to the metered
 * readings, which are unambiguous, before they ever fall back to
 * overallConsumptionLastPeriod (whose unit varies by utility: Oakville's
 * numbers come out in kWh, the Green Button Alliance sample's in Wh).
 */
export function billedKwh(summary: UsageSummary): number | null {
  let sum = 0;
  let seen = false;
  for (const item of summary.items) {
    if (!/usage$/.test(item.note.trim().toLowerCase())) continue;
    if (!item.measurement) continue;
    sum += item.measurement.scaled;
    seen = true;
  }
  return seen ? sum : null;
}

/* -------------------------------------------------------------------------
 * Estimate vs actual, per billing period (Wave L item 2)
 * ------------------------------------------------------------------------- */

/**
 * The window this bill actually charges for.
 *
 * ESPI's `billingPeriod` is a coarse stamp — Oakville writes 00:00Z on the
 * read date — while the line items carry the reads themselves
 * ("Billing Period - Previous/Current Read Date", epoch seconds, uom 27).
 * When both exist the reads win: reconciling against `billingPeriod` puts
 * ~33 hours of readings either side of what was billed into the comparison,
 * which alone moves the estimate several dollars off the bill.
 *
 * Falls back to billingPeriod when the file states no reads (every fixture
 * but Oakville's shape).
 */
export function billWindow(summary: UsageSummary): { start: number; end: number } {
  const readAt = (needle: string): number | null => {
    for (const item of summary.items) {
      if (!item.note.toLowerCase().includes(needle)) continue;
      if (!item.measurement || item.measurement.uom !== 27) continue;
      const ts = item.measurement.scaled;
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
    return null;
  };
  const prev = readAt('previous read date');
  const cur = readAt('current read date');
  if (prev !== null && cur !== null && cur > prev) {
    // Reads describe THIS period or they are not this period's reads. A bill
    // that straddles a rate change (Oakville writes the Nov 1 / May 1 season
    // boundary as a read) hands out a sub-period span of 5-8 days; taking it
    // at face value silently truncates every downstream comparison to the
    // first season block (Wave P found three such bills in the 24-period
    // export — commodity modeled ~80% low with full "coverage"). The reads
    // win only when their span matches the billed period; otherwise fall
    // back to the coarse billingPeriod stamp, whose day-granular start is
    // still exact for these bills.
    if (Math.abs(cur - prev - summary.duration) <= BILL_WINDOW_TOLERANCE) {
      return { start: prev, end: cur };
    }
    return { start: summary.start, end: summary.start + summary.duration };
  }
  return { start: summary.start, end: summary.start + summary.duration };
}

/** How far a read span may sit from the billed period and still win: the
 *  reads carry the hour of day, billingPeriod only midnight UTC, so a day of
 *  slack covers clock skew without letting a 7-day season block pass. */
export const BILL_WINDOW_TOLERANCE = 86400;

/** Share of a period's days that must carry a reading before its numbers
 *  mean anything: a half-covered period would otherwise look like a huge
 *  "our rates are wrong" miss when it is really just missing data. */
export const PERIOD_MIN_COVERAGE = 0.9;
/** The spec's tolerance: commodity within a dollar, or we say so loudly. */
export const COMMODITY_MATCH_TOLERANCE = 1;

export type PeriodReconciliation = {
  summary: UsageSummary;
  totals: BillTotals;
  /** Readings whose timestamp falls inside this billing period. */
  rows: ProcessedPoint[];
  /** Distinct reading days ÷ period days. */
  coverage: number;
  /** Days of the period that carry at least one reading. */
  coveredDays: number;
  periodDays: number;
  meteredKwh: number | null;
  billedKwh: number | null;
  commodityActual: number;
  commodityEstimate: number | null;
  /** commodityEstimate − commodityActual; null when not comparable. */
  delta: number | null;
  comparable: boolean;
};

function planCostOf(rows: ProcessedPoint[], plan: 'TOU' | 'Tiered' | 'ULO'): number {
  let sum = 0;
  for (const r of rows) {
    sum += plan === 'TOU' ? r.costTOU : plan === 'ULO' ? r.costULO : r.costTiered;
  }
  return sum;
}

/** What our own rates say the given rows cost under `plan`. */
export function planCostFor(
  rows: ProcessedPoint[],
  plan: 'TOU' | 'Tiered' | 'ULO',
): number {
  return planCostOf(rows, plan);
}

/**
 * Reconcile every UsageSummary against our own priced readings.
 *
 * The commodity lines ("Off/Mid/On Peak-Summer") are exactly kWh × the OEB
 * rate we price with, so on a fully covered period our estimate and their
 * charge should land within a dollar — if they do not, the rate assumptions
 * are wrong and the panel says so instead of quietly showing a delta.
 */
export function reconcileBillingPeriods(
  summaries: UsageSummary[],
  rows: ProcessedPoint[],
  plan: 'TOU' | 'Tiered' | 'ULO',
): PeriodReconciliation[] {
  return summaries.map((summary) => {
    const { start: begin, end } = billWindow(summary);
    const inPeriod = rows.filter((r) => r.timestamp >= begin && r.timestamp < end);
    const periodDays = Math.max(1, Math.round((end - begin) / 86400));
    const days = new Set(inPeriod.map((r) => r.dayStr));
    const coverage = Math.min(1, days.size / periodDays);
    const totals = billTotals(summary);
    const metered = inPeriod.reduce((sum, r) => sum + r.usage_kwh, 0);
    const comparable = coverage >= PERIOD_MIN_COVERAGE && inPeriod.length > 0;
    const estimate = inPeriod.length > 0 ? planCostOf(inPeriod, plan) : null;
    return {
      summary,
      totals,
      rows: inPeriod,
      coverage,
      coveredDays: days.size,
      periodDays,
      meteredKwh: inPeriod.length > 0 ? metered : null,
      billedKwh: billedKwh(summary),
      commodityActual: totals.commodity,
      commodityEstimate: estimate,
      delta: comparable && estimate !== null ? estimate - totals.commodity : null,
      comparable,
    };
  });
}

/** The bill's own estimate-vs-actual answer, in one place: does our rate
 *  assumption reproduce their commodity charge for a period we can see? */
export function commodityVerdict(r: PeriodReconciliation): 'match' | 'off' | 'unknown' {
  if (r.delta === null) return 'unknown';
  return Math.abs(r.delta) <= COMMODITY_MATCH_TOLERANCE ? 'match' : 'off';
}

/* -------------------------------------------------------------------------
 * Auto-populated True Bill inputs (Wave L item 3)
 * ------------------------------------------------------------------------- */

export type ChargeFit = {
  /** Fixed dollars per billing period, when a split is derivable. */
  flat: number | null;
  /** Dollars per kWh. */
  perKwh: number;
  /** Largest |residual| of the fit, dollars. */
  maxResidual: number | null;
  /** Periods the fit was taken over. */
  periods: number;
  /** What the prefill actually used: a fixed+variable split, or one blended
   *  per-kWh rate covering the whole charge. */
  mode: 'split' | 'blended';
};

export type DerivedCharges = {
  charges: ExtraCharges;
  /** The period the numbers came from. */
  source: UsageSummary;
  /** "your XML's May 25, 2026 period" style label for the caption. */
  label: string;
  delivery: number;
  regulatory: number;
  tax: number;
  kwh: number;
  hstPct: number;
  fit: ChargeFit;
};

/** `MMM d, yyyy` from a unix stamp, in UTC. */
export function billPeriodLabel(ts: number, duration: number): string {
  const start = new Date(ts * 1000);
  const end = new Date((ts + duration) * 1000);
  // French ranges put the day first and drop the comma ("26 août – 24 sept").
  const fr = getLocale() === 'fr';
  const a = fr
    ? `${start.getUTCDate()} ${MONTH_ABBR()[start.getUTCMonth()]} ${start.getUTCFullYear()}`
    : `${MONTH_ABBR()[start.getUTCMonth()]} ${start.getUTCDate()}, ${start.getUTCFullYear()}`;
  const b = fr
    ? `${end.getUTCDate()} ${MONTH_ABBR()[end.getUTCMonth()]}`
    : `${MONTH_ABBR()[end.getUTCMonth()]} ${end.getUTCDate()}`;
  return duration >= 86400 ? `${a} – ${b}` : a;
}

const round = (v: number, dp: number) => Number(v.toFixed(dp));
/** 4 dp is what the field is designed for ("e.g. 0.0125"); keeps cents right. */
const rate = (v: number) => String(round(v, 4));

/**
 * How badly a split may miss before it stops being quotable.
 *
 * Measured against THIS period's charge for the line being split — the amount
 * the user is about to read a fixed/variable sentence about — because that is
 * the number the claim is about. A $6 miss on a $102 delivery line is 6% of
 * what the user is looking at and the split does not earn the right to be
 * quoted; the same $6 against a $900 line would be nothing. (The absolute $0.50
 * bar this replaced had exactly that flaw: it meant a different thing on every
 * bill size.)
 */
export const CHARGE_FIT_MAX_RESIDUAL_SHARE = 0.05;

/** Periods needed before "fixed + variable" is a fit and not a coincidence. */
export const CHARGE_FIT_MIN_PERIODS = 3;

type ChargeFitCore = {
  flat: number;
  perKwh: number;
  maxResidual: number;
  worstIndex: number;
  /** True when the intercept came out negative and the line was forced
   *  through zero — i.e. the charge has no fixed part at all. */
  throughOrigin: boolean;
};
type ChargeFitOutcome =
  | { ok: true; fit: ChargeFitCore }
  | { ok: false; why: string };

/**
 * Least squares of a charge against usage — the fit, and its worst miss,
 * with NO verdict on whether that miss is acceptable.
 *
 * The verdict belongs to the caller: "is a $6 miss tolerable?" is a question
 * about the dollar amount on screen, so it is answered there (see
 * `CHARGE_FIT_MAX_RESIDUAL_SHARE`) instead of being baked in here where the
 * next caller could not see it.
 *
 * Structural refusals still belong to the core, because no tolerance fixes
 * them: too few periods, usage that never moved, or a line that would need a
 * negative fixed charge or a negative rate to fit (both of which mean the
 * straight line is the wrong shape, not that it is slightly off).
 */
function fitChargeCore(amounts: number[], kwh: number[]): ChargeFitOutcome {
  if (amounts.length !== kwh.length) {
    return { ok: false, why: 'the periods and their kWh do not line up' };
  }
  const n = amounts.length;
  if (n < CHARGE_FIT_MIN_PERIODS) {
    return {
      ok: false,
      why: `only ${n} billing period${n === 1 ? '' : 's'} — at least ${CHARGE_FIT_MIN_PERIODS} are needed`,
    };
  }
  const meanX = kwh.reduce((a, b) => a + b, 0) / n;
  const meanY = amounts.reduce((a, b) => a + b, 0) / n;
  const spread = Math.max(...kwh) - Math.min(...kwh);
  if (meanX <= 0 || spread < meanX * 0.03) {
    return { ok: false, why: 'usage barely moves between periods, so a slope would be noise' };
  }
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (kwh[i] - meanX) * (amounts[i] - meanY);
    sxx += (kwh[i] - meanX) ** 2;
  }
  if (sxx <= 0) return { ok: false, why: 'every period used the same amount' };
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  if (slope < 0) return { ok: false, why: 'the fitted rate is negative (cheaper as you use more)' };

  // A NEGATIVE intercept does not mean "the fit is bad" — it means the line
  // has no fixed part at all, which is a real answer ("regulatory charges are
  // entirely volume-driven"). Forcing it through zero is the fit that
  // describes that shape; refusing to answer would throw away the answer.
  const throughOrigin = intercept < 0;
  let perKwh = slope;
  if (throughOrigin) {
    let sxy0 = 0;
    let sxx0 = 0;
    for (let i = 0; i < n; i += 1) {
      sxy0 += kwh[i] * amounts[i];
      sxx0 += kwh[i] * kwh[i];
    }
    if (sxx0 <= 0) return { ok: false, why: 'no period used any electricity' };
    perKwh = sxy0 / sxx0;
    if (perKwh < 0) return { ok: false, why: 'the fitted rate is negative (cheaper as you use more)' };
  }
  const flat = throughOrigin ? 0 : intercept;

  let maxResidual = 0;
  let worstIndex = 0;
  for (let i = 0; i < n; i += 1) {
    const residual = Math.abs(amounts[i] - (flat + perKwh * kwh[i]));
    if (residual > maxResidual) {
      maxResidual = residual;
      worstIndex = i;
    }
  }
  return { ok: true, fit: { flat, perKwh, maxResidual, worstIndex, throughOrigin } };
}

/**
 * Least-squares split of a charge into a fixed part and a $/kWh part across
 * several billing periods, or null when the periods are too alike (or too
 * noisy) for the split to mean anything.
 *
 * With three Oakville periods the delivery line fits $35.70 + $0.0253/kWh to
 * ±$0.20; when usage barely moves between periods the slope is noise, and
 * then we say so and use one blended rate instead of inventing a fixed part.
 * A fit that misses THIS period's charge by more than
 * `CHARGE_FIT_MAX_RESIDUAL_SHARE` of it is refused for the same reason: it
 * would answer a dollar question with a number that does not survive the
 * question. Every caller shares that one bar, so two panels can never quote
 * two different splits of the same line.
 */
function fitCharge(amounts: number[], kwh: number[]): ChargeFitCore | null {
  const outcome = fitChargeCore(amounts, kwh);
  if (!outcome.ok) return null;
  // The LAST pair is the newest period — the one every caller quotes.
  const tolerance = amounts[amounts.length - 1] * CHARGE_FIT_MAX_RESIDUAL_SHARE;
  return outcome.fit.maxResidual > tolerance ? null : outcome.fit;
}

/**
 * Which quantity a period's charges are a rate *of*.
 *
 * The bill's own "… Usage" lines come first: they are what the utility
 * actually charged for, they exist whether or not we hold readings for that
 * period, and every charge in the bill is priced off them. A fully covered
 * stretch of our own readings is next (it is unambiguous Wh → kWh), and
 * overallConsumptionLastPeriod last — its unit varies by utility, so it only
 * counts when it is the only thing the file says.
 */
function chargeBasisKwh(
  s: UsageSummary,
  stats: { coverage: number; meteredKwh: number | null } | undefined,
): number | null {
  const billed = billedKwh(s);
  if (billed !== null && billed > 0) return billed;
  if (stats && stats.coverage >= PERIOD_MIN_COVERAGE && stats.meteredKwh !== null && stats.meteredKwh > 0) {
    return stats.meteredKwh;
  }
  const c = s.consumption?.scaled ?? null;
  return c !== null && c > 0 ? c : null;
}

/** Per-period metered kWh + coverage for the periods in `summaries`. */
function periodStats(
  summaries: UsageSummary[],
  rows: ProcessedPoint[] | undefined,
): Map<number, { coverage: number; meteredKwh: number | null }> {
  const out = new Map<number, { coverage: number; meteredKwh: number | null }>();
  if (!rows) return out;
  for (const r of reconcileBillingPeriods(summaries, rows, 'TOU')) {
    out.set(r.summary.start, { coverage: r.coverage, meteredKwh: r.meteredKwh });
  }
  return out;
}

/**
 * Wave B's four manual fields, derived from the newest UsageSummary so the
 * user never has to type them.
 *
 * Returns null when the file carries no bill, or when that bill states no
 * charges at all — in either case the fields stay exactly as the user left
 * them, which is the pre-Wave-L behaviour.
 */
export function deriveExtraCharges(
  summaries: UsageSummary[],
  rows?: ProcessedPoint[],
): DerivedCharges | null {
  if (summaries.length === 0) return null;
  const source = summaries[summaries.length - 1];
  const totals = billTotals(source);
  const stats = periodStats(summaries, rows);
  const kwhOf = (s: UsageSummary) => chargeBasisKwh(s, stats.get(s.start));
  const kwh = kwhOf(source);
  if (kwh === null || kwh <= 0) return null;
  if (totals.delivery === 0 && totals.regulatory === 0 && totals.tax === 0) return null;

  // The split is fitted across ALL the periods we have (each needs its own
  // kWh), but the rates come from the newest period's own charges.
  const pairs: { amount: number; kwh: number }[] = [];
  for (const s of summaries) {
    const q = kwhOf(s);
    if (q === null || q <= 0) continue;
    pairs.push({ amount: billTotals(s).delivery, kwh: q });
  }
  const fit = fitCharge(
    pairs.map((p) => p.amount),
    pairs.map((p) => p.kwh),
  );
  const deliveryPerKwh = fit ? fit.perKwh : totals.delivery / kwh;
  const deliveryFlat = fit ? fit.flat : 0;
  const regulatoryPerKwh = totals.regulatory / kwh;
  // HST is charged on the pre-tax subtotal (Total Electricity Charges), which
  // is the same base calculateTrueBill applies HST to — so 13% here and 13%
  // there describe the same bill.
  const hstPct = totals.total > 0 ? (totals.tax / totals.total) * 100 : 0;

  const charges: ExtraCharges = {
    deliveryPerKwh: rate(deliveryPerKwh),
    deliveryFlat: fit ? String(round(deliveryFlat, 2)) : '',
    regulatoryPerKwh: rate(regulatoryPerKwh),
    hstPct: String(round(hstPct, 2)),
  };
  return {
    // The provenance travels WITH the values: whoever stores them can later
    // tell "still exactly what the file said" from "the user has edited it".
    charges: {
      ...charges,
      xmlSource: {
        periodStart: source.start,
        label: billPeriodLabel(source.start, source.duration),
        values: charges,
      },
    },
    source,
    label: billPeriodLabel(source.start, source.duration),
    delivery: totals.delivery,
    regulatory: totals.regulatory,
    tax: totals.tax,
    kwh,
    hstPct: round(hstPct, 2),
    fit: {
      flat: fit ? round(fit.flat, 2) : null,
      perKwh: round(deliveryPerKwh, 4),
      maxResidual: fit ? round(fit.maxResidual, 2) : null,
      periods: pairs.length,
      mode: fit ? 'split' : 'blended',
    },
  };
}

/** The delivery line's amortized fixed-vs-variable split, when one is
 *  derivable across the periods we have (Wave L slice 2). */
export function deliverySplit(
  summaries: UsageSummary[],
  rows?: ProcessedPoint[],
): ChargeFit | null {
  const stats = periodStats(summaries, rows);
  const pairs: { amount: number; kwh: number }[] = [];
  for (const s of summaries) {
    const q = chargeBasisKwh(s, stats.get(s.start));
    if (q === null || q <= 0) continue;
    pairs.push({ amount: billTotals(s).delivery, kwh: q });
  }
  const fit = fitCharge(
    pairs.map((p) => p.amount),
    pairs.map((p) => p.kwh),
  );
  if (!fit) {
    if (pairs.length === 0) return null;
    const newest = pairs[pairs.length - 1];
    return {
      flat: null,
      perKwh: round(newest.amount / newest.kwh, 4),
      maxResidual: null,
      periods: pairs.length,
      mode: 'blended',
    };
  }
  return {
    flat: round(fit.flat, 2),
    perKwh: round(fit.perKwh, 4),
    maxResidual: round(fit.maxResidual, 2),
    periods: pairs.length,
    mode: 'split',
  };
}

/* ==========================================================================
 * Fixed-vs-usage decomposition of a bill line (Wave T slice 3)
 *
 * "Can I actually reduce this?" is the question the delivery line invites and
 * the one a ¢/kWh average cannot answer, because an average cannot tell a
 * charge you would still owe at ZERO kWh (a monthly service charge, a fixed
 * rider) from one that scales with volume. Fitting the line against usage
 * across every billing period the file holds separates them — and, just as
 * importantly, says when it cannot.
 *
 * Two honest refusals, and they are different:
 *   • `unavailable` — there is not enough to fit (too few periods, usage that
 *     never moved). Nothing was tested.
 *   • `rejected` — it WAS fitted and the fit misses by more than
 *     CHARGE_FIT_MAX_RESIDUAL_SHARE of this period's charge. Quoting "$F is
 *     fixed" then would be a number that cannot survive its own question.
 *
 * The rejection is not hypothetical: on the reference 24-bill Oakville export
 * the delivery line misses by $6.56 at worst — 6.4% of the newest period's
 * $102.34 — because the utility repriced delivery between rate years. The
 * card says so, names the bill it misses, and falls back to the blended rate
 * that does not pretend to be two numbers. (evidence/wave-t-notes.md)
 * ========================================================================== */

export type ChargeDecompositionStatus = 'split' | 'rejected' | 'unavailable';

export type ChargeDecomposition = {
  line: 'delivery' | 'regulatory';
  /** This period's charge for that line — the amount being explained. */
  amount: number;
  /** The kWh this period's charges are priced off. */
  kwh: number;
  /** Periods the fit was taken over. */
  periods: number;
  status: ChargeDecompositionStatus;
  /** The fit, whether or not it was accepted — the attempt is never hidden. */
  fit: {
    flat: number;
    perKwh: number;
    maxResidual: number;
    /** Worst miss ÷ this period's charge. */
    residualShare: number;
    /** The bill the fit misses most, for the sentence. */
    worstPeriod: string | null;
  } | null;
  /** $ of this period's charge that owes at zero kWh. */
  fixed: number | null;
  /** $ of this period's charge that is volume-driven. */
  variable: number | null;
  fixedShare: number | null;
  /** One blended rate for the line — what survives every refusal. */
  blendedCentsPerKwh: number;
  /** The sentence the card leads with. */
  headline: string;
  detail: string;
};

const money2 = (n: number) => `$${n.toFixed(2)}`;

const LINE_NOUNS = {
  // `be` travels with the noun: "Delivery IS not decomposable", "Regulatory
  // charges ARE" — a card that gets the grammar wrong reads as if it got the
  // maths wrong too.
  delivery: { upper: 'Delivery', lower: 'delivery', be: 'is' },
  regulatory: { upper: 'Regulatory charges', lower: 'regulatory charges', be: 'are' },
} as const;

/**
 * Split one charge line into the part you would owe anyway and the part you
 * can act on, or say exactly why that split cannot be made.
 */
export function chargeDecomposition(
  summaries: UsageSummary[],
  rows: ProcessedPoint[] | undefined,
  line: 'delivery' | 'regulatory',
): ChargeDecomposition | null {
  if (summaries.length === 0) return null;
  const stats = periodStats(summaries, rows);
  const pairs: { amount: number; kwh: number; summary: UsageSummary }[] = [];
  for (const s of summaries) {
    const q = chargeBasisKwh(s, stats.get(s.start));
    if (q === null || q <= 0) continue;
    pairs.push({ amount: billTotals(s)[line], kwh: q, summary: s });
  }
  if (pairs.length === 0) return null;
  // A file whose every period says zero for this line (a sample feed, a bill
  // with nothing itemized) has nothing to explain — a "0.00 fixed, 0.00
  // variable" answer would be theatre.
  if (!pairs.some((p) => p.amount !== 0)) return null;

  const newest = pairs[pairs.length - 1];
  const noun = LINE_NOUNS[line];
  const blendedCentsPerKwh = newest.kwh > 0 ? (newest.amount / newest.kwh) * 100 : 0;

  const outcome = fitChargeCore(pairs.map((p) => p.amount), pairs.map((p) => p.kwh));
  const residualShare = outcome.ok ? outcome.fit.maxResidual / (newest.amount || 1) : null;
  const worstPeriod = outcome.ok
    ? billPeriodLabel(pairs[outcome.fit.worstIndex].summary.start, pairs[outcome.fit.worstIndex].summary.duration)
    : null;

  const fit =
    outcome.ok && residualShare !== null
      ? {
          flat: round(outcome.fit.flat, 2),
          perKwh: round(outcome.fit.perKwh, 4),
          maxResidual: round(outcome.fit.maxResidual, 2),
          residualShare: round(residualShare, 4),
          worstPeriod,
        }
      : null;

  if (!outcome.ok) {
    return {
      line,
      amount: newest.amount,
      kwh: newest.kwh,
      periods: pairs.length,
      status: 'unavailable',
      fit: null,
      fixed: null,
      variable: null,
      fixedShare: null,
      blendedCentsPerKwh: round(blendedCentsPerKwh, 2),
      headline: `${noun.upper} cannot be split into fixed and volume-driven from this data.`,
      detail: `${outcome.why}. The honest number for this line is the ${round(blendedCentsPerKwh, 2)}¢/kWh it averaged this period.`,
    };
  }

  const { flat, perKwh, maxResidual } = outcome.fit;
  const rejected = (residualShare ?? 0) > CHARGE_FIT_MAX_RESIDUAL_SHARE;

  if (rejected) {
    return {
      line,
      amount: newest.amount,
      kwh: newest.kwh,
      periods: pairs.length,
      status: 'rejected',
      fit,
      fixed: null,
      variable: null,
      fixedShare: null,
      blendedCentsPerKwh: round(blendedCentsPerKwh, 2),
      headline: `${noun.upper} ${noun.be} not linearly decomposable from this data.`,
      detail:
        `Fitted ${money2(flat)} fixed + $${perKwh.toFixed(4)}/kWh across ${pairs.length} billing periods, but the ` +
        `worst miss is ${money2(maxResidual)} — ${((residualShare ?? 0) * 100).toFixed(1)}% of this period's ` +
        `${money2(newest.amount)} ${noun.lower}, over the ${Math.round(CHARGE_FIT_MAX_RESIDUAL_SHARE * 100)}% bar ` +
        `we quote a split at (the bill it misses most is ${worstPeriod ?? 'unknown'}). ` +
        `The line is real and large — it just is not a straight line of usage, so ` +
        `${round(blendedCentsPerKwh, 2)}¢/kWh is the only rate that describes it honestly.`,
    };
  }

  const fixed = round(flat, 2);
  const variable = round(newest.amount - flat, 2);
  return {
    line,
    amount: newest.amount,
    kwh: newest.kwh,
    periods: pairs.length,
    status: 'split',
    fit,
    fixed,
    variable,
    fixedShare: newest.amount > 0 ? round(fixed / newest.amount, 4) : null,
    blendedCentsPerKwh: round(blendedCentsPerKwh, 2),
    // A line with no fixed part is a DIFFERENT answer, and it is the common
    // one for regulatory charges — say it as such instead of "$0.00 is fixed".
    headline: outcome.fit.throughOrigin
      ? `Of your ${money2(newest.amount)} ${noun.lower} this period, none of it is fixed — you would pay $0.00 at 0 kWh, and all ${money2(variable)} is volume-driven.`
      : `Of your ${money2(newest.amount)} ${noun.lower} this period, ${money2(fixed)} is fixed ` +
        `(you'd pay it at 0 kWh) and ${money2(variable)} is volume-driven.`,
    detail:
      `Fitted ${outcome.fit.throughOrigin ? '' : `${money2(flat)} + `}$${perKwh.toFixed(4)}/kWh across ` +
      `${pairs.length} billing periods${outcome.fit.throughOrigin ? ' (the line has no fixed part, so the fit runs through zero)' : ''}; ` +
      `worst miss ${money2(maxResidual)} (${((residualShare ?? 0) * 100).toFixed(1)}% of this period's line` +
      `${worstPeriod ? `, ${worstPeriod}` : ''}).`,
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
  return fmtDay(new Date(ts * 1000));
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
    label: t('wfh.label'),
  };
}
