/**
 * ReadingType-aware Green Button ingestion — the resource graph and series isolation.
 *
 * WHY THIS EXISTS
 * A Green Button / ESPI document is a graph of Atom entries, not a list of
 * readings. `IntervalReading.value` is an integer whose MEANING lives on a
 * *ReadingType* entry reachable only through links:
 *
 *   UsagePoint ── MeterReading ── ReadingType      (identity, scale, semantics)
 *                    └─ IntervalBlock ── IntervalReading  (the numbers)
 *
 * The older single-pass parser walked entries in document order, guessed the
 * multiplier from whichever ReadingType it had seen, and merged every reading
 * of a UsagePoint into one stream. That silently mixed:
 *   - a forward (delivered) series with a reverse (exported) one,
 *   - an energy series (Wh) with a demand/power series (W) on the same meter,
 *   - electricity with natural gas or water on a multi-commodity feed,
 *   - several register series read off one meter,
 * and it applied one ReadingType's `powerOfTenMultiplier` to another's values.
 *
 * WHAT THIS MODULE GUARANTEES
 *   1. ORDER INDEPENDENCE — entries are indexed first (every resource kind and
 *      id is harvested out of link hrefs), then resolved. Entry order, and
 *      whether hrefs are relative (`/ReadingType/3`) or absolute
 *      (`https://host/espi/1_1/resource/ReadingType/100001`), changes nothing.
 *      The ReadingType↔MeterReading edge is followed in BOTH directions, so a
 *      feed that only publishes it ReadingType-side still resolves.
 *   2. SERIES ISOLATION — readings are grouped per
 *      (UsagePoint, MeterReading, ReadingType), never per UsagePoint alone.
 *   3. NO GUESSED SEMANTICS — a series becomes kWh only when the ESPI codes say
 *      it is an interval increment of active electrical energy; intervals of
 *      power convert only when a duration is known; registers, reactive and
 *      apparent quantities, other commodities and combined directions are
 *      reported as unsupported WITH a reason instead of being priced.
 *   4. NOTHING IS SILENTLY DROPPED — every refusal, every dropped reading and
 *      the legacy compatibility assumption surface as a SeriesNote.
 *
 * A document that identifies neither a UsagePoint nor a ReadingType still
 * parses (it is the historical, bundled-fixture shape) but does so on an
 * explicit compatibility path that announces the Wh assumption it rests on.
 */

import {
  DEMAND_MEASUREMENT_KIND,
  ENERGY_MEASUREMENT_KIND,
  POWER_MEASUREMENT_KIND,
  accumulationClassOf,
  accumulationName,
  commodityClassOf,
  commodityName,
  dataQualifierName,
  energyKwhFromIntervalPower,
  energyKwhFromRaw,
  flowClassOf,
  flowName,
  legacyWhKwhFromRaw,
  measurementName,
  multiplierName,
  quantityKindOf,
  uomName,
} from './espiUnits';

/* ==========================================================================
 * Types
 * ========================================================================== */

/** One IntervalReading, with the metadata the old parser threw away. */
export type SeriesReading = {
  /** UTC epoch seconds of the interval start — an instant, never local time. */
  timestamp: number;
  /** Interval length in seconds when the feed states one (ESPI timePeriod.duration). */
  duration_s: number | null;
  /** The value exactly as published, before scaling. */
  raw: number;
  /** kWh, or null when this series is not normalised to energy. */
  kwh: number | null;
  /** ESPI ReadingQuality quality, else the ReadingType defaultQuality. */
  quality: number | null;
  /** ESPI Reading cost (hundred-thousandths of the ReadingType currency). */
  cost: number | null;
};

/** Why a series is, or is not, usable as electricity consumption. */
export type SeriesStatus =
  /** Active energy per interval → `kwh` filled, safe to bill. */
  | 'supported'
  /** Interval-average active power → converted with the interval duration. */
  | 'power-converted'
  /** A register (bulk/cumulative/latching/bounded) — needs a differencing contract. */
  | 'register'
  /** Indicating / instantaneous / time-delayed spot value. */
  | 'spot'
  /** Natural gas, water, steam, refuse … never prices as electricity. */
  | 'other-commodity'
  /** Apparent or reactive energy/power, or a non-quantity unit. */
  | 'other-quantity'
  /** Exported / received energy: importing it as consumption would be a lie. */
  | 'reverse-flow'
  /** Net / total / quadrant: combines directions, so it cannot join either stream. */
  | 'combined-flow'
  /** Power with no known interval, or an accumulation the schema does not define. */
  | 'unconvertible'
  /** The document declares ReadingTypes but this entry resolves to none. */
  | 'unresolved-reading-type';

/** Every field preserved off the ReadingType, raw value included. */
export type SeriesMetadata = {
  uom: number | null;
  powerOfTenMultiplier: number | null;
  accumulationBehaviour: number | null;
  commodity: number | null;
  flowDirection: number | null;
  /** ESPI `kind` (MeasurementKind): 12 energy, 8 demand, 37 power. */
  kind: number | null;
  dataQualifier: number | null;
  defaultQuality: number | null;
  /** ESPI ReadingType.intervalLength, in seconds. */
  intervalLength: number | null;
  /** True when NO ReadingType anywhere in the document describes this series. */
  assumed: boolean;
  /** True when ReadingTypes exist but none could be tied to this series. */
  unresolved: boolean;
};

/** A reading series: one meter's one ReadingType. */
export type ReadingSeries = {
  /** `usagePoint|meterReading|readingType`, with `-` for an absent level. */
  key: string;
  usagePointId: string | null;
  meterReadingId: string | null;
  readingTypeId: string | null;
  status: SeriesStatus;
  /** Why this series is not billable; null when it is. */
  reason: string | null;
  /** Short identity for a picker row. */
  label: string;
  /** Long form, for diagnostics: every code with its schema name. */
  detail: string;
  meta: SeriesMetadata;
  readings: SeriesReading[];
  /** Number of IntervalBlock elements this series' readings came from. */
  blocks: number;
  /** Readings refused by value validation, counted rather than hidden. */
  dropped: { negative: number; unparsable: number };
  /** True when this series is a metadata-free legacy assumption. */
  legacy: boolean;
  /**
   * True when the ReadingType was applied because the document declared
   * exactly one and no entry linked it — a resolution, not a stated link.
   */
  unlinked: boolean;
};

/** A refusal, a drop or an assumption — never a silent behaviour. */
export type SeriesNote = {
  code:
    | 'unsupported-series'
    | 'converted-to-energy'
    | 'refused-readings'
    | 'legacy-assumption'
    | 'assumed-direction'
    | 'unlinked-reading-type'
    | 'ambiguous-inline-reading-types'
    | 'combined-series';
  /** One plain sentence a person can read in a diagnostics panel. */
  detail: string;
  /** Series key when the note is about one series. */
  seriesKey?: string;
};

export type ReadingSeriesResult = {
  series: ReadingSeries[];
  notes: SeriesNote[];
};

/* ==========================================================================
 * Small structural helpers (fast-xml-parser output shape)
 * ========================================================================== */

function asArray(v: unknown): Record<string, unknown>[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw !== null && typeof raw === 'object') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** `content` as an object (a bare text node is not a resource body). */
function contentOf(entry: Record<string, unknown>): Record<string, unknown> | null {
  const c = entry.content;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  return c as Record<string, unknown>;
}

/** Every `<entry>` anywhere in the parsed document. */
function collectEntries(node: unknown): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
      continue;
    }
    const objAny = obj as Record<string, unknown>;
    for (const k in objAny) {
      if (k === 'entry') entries.push(...asArray(objAny[k]));
      else if (typeof objAny[k] === 'object') stack.push(objAny[k]);
    }
  }
  return entries;
}

/* ==========================================================================
 * Link harvesting — every resource named anywhere in an href
 * ========================================================================== */

const RESOURCES = [
  'UsagePoint',
  'MeterReading',
  'ReadingType',
  'IntervalBlock',
  'UsageSummary',
  'LocalTimeParameters',
] as const;

const RESOURCE_SET: ReadonlySet<string> = new Set(RESOURCES);

/**
 * Every `<resource>/<id>` pair inside one href.
 *
 * Both shapes seen in real feeds fall out of the same split:
 *   /RetailCustomer/1/UsagePoint/J2648788/MeterReading/3/IntervalBlock/3
 *   https://host/espi/1_1/resource/ReadingType/100001
 * A collection href (`…/UsagePoint/f271…/MeterReading` or `…/UsagePoint`) ends
 * in a resource name, so no id follows it and nothing is harvested there.
 */
export function linkIds(href: string): Record<string, string> {
  const path = href.split('?')[0].split('#')[0];
  const parts = path.split('/').filter((p) => p.length > 0);
  const out: Record<string, string> = {};
  for (let i = 0; i < parts.length - 1; i++) {
    const res = parts[i];
    if (!RESOURCE_SET.has(res)) continue;
    const next = parts[i + 1];
    if (RESOURCE_SET.has(next)) continue;
    out[res] = safeDecode(next);
  }
  return out;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

const REL_RANK: Record<string, number> = { self: 0, up: 1, related: 2 };

/**
 * Ids per resource, best-ranked link first. `self` beats `up` beats `related`
 * beats an untyped link, so a `related` link pointing at a *different*
 * UsagePoint can never outvote the entry's own identity.
 */
function harvestIds(entry: Record<string, unknown>): Map<string, string[]> {
  const out = new Map<string, { id: string; rank: number; order: number }[]>();
  let order = 0;
  for (const l of asArray(entry.link)) {
    const href = String(l['@_href'] ?? '');
    const rank = REL_RANK[String(l['@_rel'] ?? '')] ?? 3;
    for (const [res, id] of Object.entries(linkIds(href))) {
      const arr = out.get(res) ?? [];
      arr.push({ id, rank, order: order++ });
      out.set(res, arr);
    }
  }
  const best = new Map<string, string[]>();
  for (const [res, arr] of out) {
    arr.sort((a, b) => a.rank - b.rank || a.order - b.order);
    best.set(
      res,
      arr.map((x) => x.id),
    );
  }
  return best;
}

function firstId(ids: Map<string, string[]>, resource: string): string | null {
  const arr = ids.get(resource);
  return arr && arr.length > 0 ? arr[0] : null;
}

/* ==========================================================================
 * ReadingType reading
 * ========================================================================== */

/** A ReadingType reduced to the fields that decide what a value means. */
type ReadingTypeInfo = Omit<SeriesMetadata, 'unresolved'>;

const METADATA_KEYS = [
  'uom',
  'powerOfTenMultiplier',
  'accumulationBehaviour',
  'commodity',
  'flowDirection',
  'kind',
  'dataQualifier',
  'defaultQuality',
  'intervalLength',
] as const;

/** Read one `<ReadingType>` element. */
function readReadingType(node: Record<string, unknown>): ReadingTypeInfo {
  const get = (k: string): number | null => num(node[k]);
  return {
    uom: get('uom'),
    powerOfTenMultiplier: get('powerOfTenMultiplier'),
    accumulationBehaviour: get('accumulationBehaviour'),
    commodity: get('commodity'),
    flowDirection: get('flowDirection'),
    kind: get('kind'),
    dataQualifier: get('dataQualifier'),
    defaultQuality: get('defaultQuality'),
    intervalLength: get('intervalLength'),
    assumed: false,
  };
}

/**
 * Every ReadingType element anywhere under `node` (nested trees carry one per
 * MeterReading). Only inside a `ReadingType` element, so a summary block's
 * `powerOfTenMultiplier` — Oakville stamps `-6` on
 * ElectricPowerUsageSummary measurements — can never be read as a scaler.
 */
function collectReadingTypes(node: unknown): ReadingTypeInfo[] {
  const out: ReadingTypeInfo[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
      continue;
    }
    const objAny = obj as Record<string, unknown>;
    if (objAny.ReadingType !== undefined) {
      for (const rt of asArray(objAny.ReadingType)) out.push(readReadingType(rt));
    }
    for (const k in objAny) {
      if (k !== 'ReadingType' && typeof objAny[k] === 'object') stack.push(objAny[k]);
    }
  }
  return out;
}

/** Stable id for a ReadingType that has no href of its own (inline/nested). */
function syntheticReadingTypeId(meta: ReadingTypeInfo): string {
  return 'inline:' + METADATA_KEYS.map((k) => `${k}=${meta[k] ?? ''}`).join(',');
}

/* ==========================================================================
 * Interval reading collection
 * ========================================================================== */

type RawReading = {
  timestamp: number | null;
  duration: number | null;
  value: number | null;
  quality: number | null;
  cost: number | null;
};

function readIntervalReading(ir: Record<string, unknown>): RawReading {
  const tp = ir.timePeriod;
  const tpObj =
    tp && typeof tp === 'object' && !Array.isArray(tp) ? (tp as Record<string, unknown>) : {};
  const q = asArray(ir.ReadingQuality)[0];
  return {
    timestamp: num(tpObj.start),
    duration: num(tpObj.duration),
    value: num(ir.value),
    quality: q ? num(q.quality) : null,
    cost: num(ir.cost),
  };
}

type BlockRef = {
  readings: RawReading[];
  /** `<interval><duration>` of the block, when stated. */
  duration: number | null;
};

/** Every IntervalBlock under `node`, with its own interval duration. */
function collectBlocks(node: unknown, skipKeys: string[] = []): BlockRef[] {
  const out: BlockRef[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
      continue;
    }
    const objAny = obj as Record<string, unknown>;
    if (objAny.IntervalBlock !== undefined) {
      for (const blk of asArray(objAny.IntervalBlock)) {
        const interval = blk.interval;
        const ivObj =
          interval && typeof interval === 'object' && !Array.isArray(interval)
            ? (interval as Record<string, unknown>)
            : {};
        const readings = asArray(blk.IntervalReading).map(readIntervalReading);
        if (readings.length > 0) out.push({ readings, duration: num(ivObj.duration) });
      }
    }
    for (const k in objAny) {
      if (k !== 'IntervalBlock' && !skipKeys.includes(k) && typeof objAny[k] === 'object') {
        stack.push(objAny[k]);
      }
    }
  }
  return out;
}

/**
 * IntervalReadings that sit directly under a parent with no IntervalBlock
 * around them — the shape of a fragment, of a bare `<IntervalReading>` in a
 * hand-made fixture, and of the oldest ESPI 1.0 exports. Blocks are skipped so
 * nothing is collected twice.
 */
function collectBareReadings(node: unknown, skipKeys: string[] = []): RawReading[] {
  const out: RawReading[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj)) {
      obj.forEach((i) => stack.push(i));
      continue;
    }
    const objAny = obj as Record<string, unknown>;
    if (objAny.IntervalBlock !== undefined) continue;
    if (objAny.IntervalReading !== undefined) {
      for (const ir of asArray(objAny.IntervalReading)) out.push(readIntervalReading(ir));
    }
    for (const k in objAny) {
      if (k !== 'IntervalReading' && !skipKeys.includes(k) && typeof objAny[k] === 'object') {
        stack.push(objAny[k]);
      }
    }
  }
  return out;
}

/* ==========================================================================
 * Series classification — the ONE place a series is judged
 * ========================================================================== */

const REFUSAL_REASON: Record<
  Exclude<SeriesStatus, 'supported' | 'power-converted' | 'unresolved-reading-type'>,
  string
> = {
  register:
    'is a register reading (its ESPI accumulationBehaviour is a cumulative or bulk quantity), not an interval increment: registers must be differenced against a known reset, and no such contract is available here.',
  spot: 'is a spot measurement (indicating, instantaneous or time-delayed), so it has no interval it could be an amount of energy for.',
  'other-commodity':
    'measures a non-electricity commodity (gas, water, steam, refuse …), so it must never be priced with electricity rates.',
  'other-quantity':
    'measures apparent or reactive energy or power, or a unit that is not an amount of energy at all.',
  'reverse-flow': 'is exported (received) energy — adding it to consumption would overstate usage.',
  'combined-flow':
    'combines directions (net, total or a quadrant), so it belongs to neither the import nor the export stream.',
  unconvertible: 'cannot be converted to energy with the metadata the feed provides.',
};

/**
 * Decide what a series is, from its ReadingType codes alone.
 *
 * Order is deliberate: commodity first (never price gas as electricity), then
 * accumulation (a register is not an interval), then the unit's quantity, then
 * the direction, and finally whether a `kind` contradicts the unit.
 */
export function classifySeries(meta: SeriesMetadata): {
  status: SeriesStatus;
  reason: string | null;
} {
  const refuse = (
    status: Exclude<SeriesStatus, 'supported' | 'power-converted' | 'unresolved-reading-type'>,
  ) => ({ status, reason: REFUSAL_REASON[status] });

  if (meta.unresolved) {
    return {
      status: 'unresolved-reading-type',
      reason:
        'has no ReadingType that could be tied to it, although the document declares ReadingTypes for other series: its unit, scale and interval are unknown, so its values were kept but not converted.',
    };
  }
  if (meta.assumed) return { status: 'supported', reason: null };

  const commodity = commodityClassOf(meta.commodity);
  if (commodity !== 'electricity' && commodity !== 'unspecified') return refuse('other-commodity');

  const accumulation = accumulationClassOf(meta.accumulationBehaviour);
  if (accumulation === 'register') return refuse('register');
  if (accumulation === 'spot') return refuse('spot');
  if (accumulation === 'unknown') return refuse('unconvertible');

  // A ReadingType that omits `uom` is the one case where the feed leaves the
  // unit undefined; ESPI's own default ("none") is useless for pricing, and
  // every such feed in the wild is an interval energy feed, so watt-hours are
  // assumed — and announced with a legacy-assumption note at the end of this
  // function, never silently.
  const unitDeclared = meta.uom !== null && meta.uom !== undefined;
  const quantity = unitDeclared ? quantityKindOf(meta.uom) : 'active-energy';

  // A `kind` that contradicts the unit is exactly the ambiguity this parser has
  // to surface rather than paper over.
  const kind = meta.kind === null ? null : Math.trunc(meta.kind);
  const kindSaysPower =
    kind !== null && kind !== 0 && (kind === DEMAND_MEASUREMENT_KIND || kind === POWER_MEASUREMENT_KIND);
  const kindSaysEnergy = kind !== null && kind !== 0 && kind === ENERGY_MEASUREMENT_KIND;
  const unitIsPower =
    quantity === 'active-power' || quantity === 'apparent-power' || quantity === 'reactive-power';
  if (kindSaysPower && quantity === 'active-energy') return refuse('other-quantity');
  if (kindSaysEnergy && unitIsPower) return refuse('other-quantity');
  if (kindSaysPower && !unitIsPower) return refuse('other-quantity');

  const flow = flowClassOf(meta.flowDirection);
  if (flow === 'reverse') return refuse('reverse-flow');
  if (flow === 'net' || flow === 'total' || flow === 'quadrant') return refuse('combined-flow');

  if (quantity === 'active-power') {
    if (seriesDuration(meta) === null) return refuse('unconvertible');
    return { status: 'power-converted', reason: null };
  }

  if (quantity !== 'active-energy') return refuse('other-quantity');
  const scalable = unitDeclared
    ? energyKwhFromRaw(1, meta.uom, meta.powerOfTenMultiplier) !== null
    : legacyWhKwhFromRaw(1, meta.powerOfTenMultiplier) !== null;
  if (!scalable) return refuse('unconvertible');

  return { status: 'supported', reason: null };
}

/** The ReadingType's own default interval length, as a duration in seconds. */
function seriesDuration(meta: SeriesMetadata): number | null {
  return meta.intervalLength !== null && meta.intervalLength > 0 ? meta.intervalLength : null;
}

function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
}

function seriesLabel(meta: SeriesMetadata, up: string | null, mr: string | null): string {
  const unit = meta.assumed ? 'assumed Wh' : meta.unresolved ? 'unknown unit' : uomName(meta.uom);
  return `${shortId(up)} · ${shortId(mr)} · ${unit}`;
}

function seriesDetail(meta: SeriesMetadata): string {
  if (meta.assumed) {
    return 'No ReadingType in the document described these readings: they were read as watt-hours scaled by the document-wide multiplier — a legacy compatibility assumption, not a declaration.';
  }
  if (meta.unresolved) {
    return 'No ReadingType could be tied to these readings even though the document declares some; nothing about the unit or scale is known.';
  }
  return [
    uomName(meta.uom),
    multiplierName(meta.powerOfTenMultiplier),
    accumulationName(meta.accumulationBehaviour),
    commodityName(meta.commodity),
    flowName(meta.flowDirection),
    measurementName(meta.kind),
    meta.intervalLength !== null ? `intervalLength ${meta.intervalLength}s` : 'no intervalLength',
    meta.dataQualifier !== null ? dataQualifierName(meta.dataQualifier) : 'no dataQualifier',
  ].join(' · ');
}

/* ==========================================================================
 * The resolver
 * ========================================================================== */

/** Interval length for one reading, in the order ESPI states it. */
function durationOf(
  r: RawReading,
  blockDuration: number | null,
  blockSize: number,
  meta: SeriesMetadata,
): number | null {
  if (r.duration !== null && r.duration > 0) return r.duration;
  // A block-level duration only describes a single reading; with several
  // readings in the block it is the block's span, not each reading's.
  if (blockDuration !== null && blockDuration > 0 && blockSize === 1) return blockDuration;
  return seriesDuration(meta);
}

function blankMeta(assumed: boolean, unresolved: boolean): SeriesMetadata {
  return {
    uom: null,
    powerOfTenMultiplier: null,
    accumulationBehaviour: null,
    commodity: null,
    flowDirection: null,
    kind: null,
    dataQualifier: null,
    defaultQuality: null,
    intervalLength: null,
    assumed,
    unresolved,
  };
}

/**
 * Turn one parsed ESPI document into reading series plus the reasons anything
 * was left out. Pure: no XML is re-read, no clock, no locale.
 */
export function parseReadingSeries(parsed: Record<string, unknown>): ReadingSeriesResult {
  const entries = collectEntries(parsed);
  const notes: SeriesNote[] = [];

  /* --- pass 1: index the graph ------------------------------------------------- */

  const rtById = new Map<string, ReadingTypeInfo>();
  /** meterReadingId → readingTypeId, harvested from either side of the edge. */
  const rtByMr = new Map<string, string>();
  /** meterReadingId → usagePointId. */
  const upByMr = new Map<string, string>();
  const entryIds = new Map<Record<string, unknown>, Map<string, string[]>>();
  for (const e of entries) entryIds.set(e, harvestIds(e));

  // Forward edges first (an entry naming BOTH ends), so a ReadingType entry's
  // back-reference can never overwrite a MeterReading's own link.
  for (const e of entries) {
    const ids = entryIds.get(e)!;
    const mr = firstId(ids, 'MeterReading');
    const rt = firstId(ids, 'ReadingType');
    const up = firstId(ids, 'UsagePoint');
    if (mr && rt && !rtByMr.has(mr)) rtByMr.set(mr, rt);
    if (mr && up && !upByMr.has(mr)) upByMr.set(mr, up);
  }
  // Reverse edges, and the ReadingType bodies themselves.
  for (const e of entries) {
    const ids = entryIds.get(e)!;
    const selfRt = firstId(ids, 'ReadingType');
    const selfMr = firstId(ids, 'MeterReading');
    const selfUp = firstId(ids, 'UsagePoint');
    if (selfRt) {
      const bodies = contentOf(e) ? asArray(contentOf(e)!.ReadingType) : [];
      if (bodies.length > 0) rtById.set(selfRt, readReadingType(bodies[0]));
      const mr = firstId(ids, 'MeterReading');
      if (mr && !rtByMr.has(mr)) rtByMr.set(mr, selfRt);
    }
    if (selfMr && selfUp && !upByMr.has(selfMr)) upByMr.set(selfMr, selfUp);
  }
  // ReadingTypes nested inside a tree entry have no href: index them too, under
  // an id derived from their own fields, so identical declarations collide and
  // different ones do not.
  const nestedTypes = collectReadingTypes(parsed);
  for (const rt of nestedTypes) rtById.set(syntheticReadingTypeId(rt), rt);

  // The document's DISTINCT ReadingTypes. One type indexed both by href and as
  // a nested body is ONE type, not two — otherwise a document with a single
  // declared type would look ambiguous and nothing would be priced.
  const distinctTypes = new Map<string, { id: string; meta: ReadingTypeInfo }>();
  for (const [id, info] of rtById) {
    const syn = syntheticReadingTypeId(info);
    if (!distinctTypes.has(syn)) distinctTypes.set(syn, { id, meta: info });
  }
  const documentDeclaresReadingTypes = distinctTypes.size > 0;
  /** The document's only ReadingType, when it has exactly one. */
  const soleReadingType = distinctTypes.size === 1 ? [...distinctTypes.values()][0] : null;

  /* --- pass 2: attach readings to their series --------------------------------- */

  const byKey = new Map<string, ReadingSeries>();

  const seriesFor = (
    upId: string | null,
    mrId: string | null,
    rtId: string | null,
    meta: SeriesMetadata,
    legacy: boolean,
    unlinked = false,
  ): ReadingSeries => {
    const key = `${upId ?? '-'}|${mrId ?? '-'}|${rtId ?? '-'}`;
    let s = byKey.get(key);
    if (!s) {
      const { status, reason } = classifySeries(meta);
      s = {
        key,
        usagePointId: upId,
        meterReadingId: mrId,
        readingTypeId: rtId,
        status,
        reason,
        label: seriesLabel(meta, upId, mrId),
        detail: seriesDetail(meta),
        meta,
        readings: [],
        blocks: 0,
        dropped: { negative: 0, unparsable: 0 },
        legacy,
        unlinked,
      };
      byKey.set(key, s);
    }
    return s;
  };

  const pushReadings = (series: ReadingSeries, blocks: BlockRef[], meta: SeriesMetadata): void => {
    const convert = series.status === 'supported' || series.status === 'power-converted';
    for (const block of blocks) {
      series.blocks += 1;
      for (const r of block.readings) {
        // A start of 0 (or a missing one) is not "midnight 1970", it is a
        // reading with no stated time, and pricing it would invent one.
        if (r.timestamp === null || r.timestamp <= 0 || r.value === null) {
          series.dropped.unparsable += 1;
          continue;
        }
        const duration = durationOf(r, block.duration, block.readings.length, meta);
        let kwh: number | null = null;
        if (convert) {
          // A forward/reverse register increment is non-negative by definition
          // (ESPI FlowDirectionKind); a negative here is not a small usage, it
          // is a value this parser must refuse to price.
          if (r.value < 0) {
            series.dropped.negative += 1;
            continue;
          }
          kwh =
            series.status === 'power-converted'
              ? energyKwhFromIntervalPower(
                  r.value,
                  meta.uom,
                  meta.powerOfTenMultiplier,
                  duration,
                )
              : meta.assumed || meta.uom === null
                ? legacyWhKwhFromRaw(r.value, meta.powerOfTenMultiplier)
                : energyKwhFromRaw(r.value, meta.uom, meta.powerOfTenMultiplier);
          if (kwh === null || !Number.isFinite(kwh) || kwh < 0) {
            series.dropped.negative += 1;
            continue;
          }
        }
        series.readings.push({
          timestamp: r.timestamp,
          duration_s: duration,
          raw: r.value,
          kwh,
          quality: r.quality ?? meta.defaultQuality,
          cost: r.cost,
        });
      }
    }
  };

  /** Resolve the ReadingType of one entry that carries IntervalBlocks. */
  const resolveMeta = (
    e: Record<string, unknown>,
  ): {
    meta: SeriesMetadata;
    rtId: string | null;
    legacy: boolean;
    unlinked: boolean;
    split: ReadingTypeInfo[];
  } => {
    const ids = entryIds.get(e)!;
    const mrId = firstId(ids, 'MeterReading');
    let rtId = firstId(ids, 'ReadingType');
    if (!rtId && mrId) rtId = rtByMr.get(mrId) ?? null;
    if (rtId && rtById.has(rtId)) {
      return {
        meta: { ...rtById.get(rtId)!, unresolved: false },
        rtId,
        legacy: false,
        unlinked: false,
        split: [],
      };
    }
    const inline = collectReadingTypes(e);
    if (inline.length === 1) {
      return {
        meta: { ...inline[0], unresolved: false },
        rtId: syntheticReadingTypeId(inline[0]),
        legacy: false,
        unlinked: false,
        split: [],
      };
    }
    if (inline.length > 1) {
      return {
        meta: { ...inline[0], unresolved: true },
        rtId: null,
        legacy: false,
        unlinked: false,
        split: inline,
      };
    }
    if (soleReadingType !== null) {
      // The document declares exactly ONE ReadingType and this entry does not
      // link it (Hydro One and Toronto Hydro both publish the link on the
      // MeterReading entry instead). With only one candidate in the document
      // there is no way to pick the wrong scale, so it is applied — and said
      // out loud as an unlinked resolution rather than passed off as a link.
      return {
        meta: { ...soleReadingType.meta, unresolved: false },
        rtId: soleReadingType.id,
        legacy: false,
        unlinked: true,
        split: [],
      };
    }
    if (documentDeclaresReadingTypes) {
      // Several ReadingTypes exist and none is tied to this entry: refuse
      // rather than assume, because assuming here would silently pick one
      // series' scale for another's numbers.
      return { meta: blankMeta(false, true), rtId: null, legacy: false, unlinked: false, split: [] };
    }
    return {
      meta: blankMeta(true, false),
      rtId: null,
      legacy: true,
      unlinked: false,
      split: [],
    };
  };

  for (const e of entries) {
    const blocks = collectBlocks(e);
    const bare = collectBareReadings(e);
    if (blocks.length === 0 && bare.length === 0) continue;
    if (bare.length > 0) blocks.push({ readings: bare, duration: null });
    const ids = entryIds.get(e)!;
    const upId = firstId(ids, 'UsagePoint') ?? (firstId(ids, 'MeterReading') ? upByMr.get(firstId(ids, 'MeterReading')!) ?? null : null);
    const mrId = firstId(ids, 'MeterReading');
    const resolved = resolveMeta(e);

    if (resolved.split.length > 1) {
      // Several ReadingTypes inline with no per-block link: the block→type
      // mapping is not stated, so keep each type's identity and refuse to
      // convert rather than apply one type's scale to another's numbers.
      for (const one of resolved.split) {
        const id = syntheticReadingTypeId(one);
        pushReadings(
          seriesFor(upId, mrId, id, { ...one, unresolved: true }, false),
          blocks,
          { ...one, unresolved: true },
        );
      }
      notes.push({
        code: 'ambiguous-inline-reading-types',
        detail: `An entry carried ${resolved.split.length} inline ReadingTypes with no per-block link. Their readings were kept apart by ReadingType instead of merged, and none was converted, because which block belongs to which type is not stated.`,
      });
      continue;
    }

    pushReadings(
      seriesFor(upId, mrId, resolved.rtId, resolved.meta, resolved.legacy, resolved.unlinked),
      blocks,
      resolved.meta,
    );
  }

  /* --- pass 3: readings outside any <entry> (fragment / non-Atom documents) ---- */

  const orphanBlocks = collectBlocks(parsed, ['entry']);
  const orphanBare = collectBareReadings(parsed, ['entry']);
  if (orphanBare.length > 0) orphanBlocks.push({ readings: orphanBare, duration: null });
  if (orphanBlocks.length > 0) {
    const meta: SeriesMetadata =
      soleReadingType !== null
        ? { ...soleReadingType.meta, unresolved: false }
        : documentDeclaresReadingTypes
          ? blankMeta(false, true)
          : blankMeta(true, false);
    pushReadings(
      seriesFor(null, null, null, meta, !documentDeclaresReadingTypes && soleReadingType === null),
      orphanBlocks,
      meta,
    );
  }

  const series = [...byKey.values()].filter(
    (s) => s.readings.length > 0 || s.blocks > 0 || s.dropped.negative > 0 || s.dropped.unparsable > 0,
  );

  /* --- diagnostics ------------------------------------------------------------- */

  for (const s of series) {
    if (s.status === 'power-converted') {
      notes.push({
        code: 'converted-to-energy',
        seriesKey: s.key,
        detail: `Series ${s.label} is interval-average real power (${uomName(s.meta.uom)}); each reading was converted to energy with its own interval duration.`,
      });
    } else if (s.status !== 'supported') {
      notes.push({
        code: 'unsupported-series',
        seriesKey: s.key,
        detail: `Series ${s.label} was NOT loaded as consumption: it ${s.reason} Its readings are preserved here and none of them was priced.`,
      });
    }
    if (s.dropped.negative > 0 || s.dropped.unparsable > 0) {
      notes.push({
        code: 'refused-readings',
        seriesKey: s.key,
        detail: `In series ${s.label}, ${s.dropped.negative} reading(s) failed value or direction validation and ${s.dropped.unparsable} carried no usable start or value. Neither set was priced; both counts are recorded on the series.`,
      });
    }
    if (s.legacy) {
      notes.push({
        code: 'legacy-assumption',
        seriesKey: s.key,
        detail: `No ReadingType described ${s.readings.length} reading(s), so they were read as watt-hours scaled by the document-wide multiplier — the legacy compatibility path. The timestamps are exact; the unit is an assumption, not a declaration.`,
      });
    }
    if (!s.legacy && !s.meta.unresolved && s.meta.uom === null) {
      notes.push({
        code: 'legacy-assumption',
        seriesKey: s.key,
        detail: `Series ${s.label} declares no uom, so its values were read as watt-hours scaled by ${multiplierName(s.meta.powerOfTenMultiplier)} — the default for an interval energy feed, but an assumption rather than a declaration.`,
      });
    }
    if (s.unlinked && !s.legacy) {
      notes.push({
        code: 'unlinked-reading-type',
        seriesKey: s.key,
        detail: `Series ${s.label} carried no ReadingType link, so the document's only ReadingType (${uomName(s.meta.uom)}, ${multiplierName(s.meta.powerOfTenMultiplier)}) was applied. With one declared type in the document there is no other candidate to confuse it with, but this is a resolution, not a stated link.`,
      });
    }
    if (
      !s.unlinked &&
      !s.legacy &&
      s.status === 'supported' &&
      flowClassOf(s.meta.flowDirection) === 'unspecified' &&
      !s.meta.unresolved
    ) {
      notes.push({
        code: 'assumed-direction',
        seriesKey: s.key,
        detail: `Series ${s.label} declares no usable flowDirection, so its readings were treated as delivered (forward) — the ESPI default for an interval feed.`,
      });
    }
  }

  return { series, notes };
}

/** The series whose readings may be added together as consumption. */
export function billableSeries(series: ReadingSeries[]): ReadingSeries[] {
  return series.filter((s) => s.status === 'supported' || s.status === 'power-converted');
}
