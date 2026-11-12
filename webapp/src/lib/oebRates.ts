/**
 * OEB rate staleness parsing — pure functions, no I/O, no server state.
 *
 * The Ontario Energy Board publishes current commodity rates as HTML only:
 * probes on 2026-10-02 found NO public JSON (Drupal `?_format=json` → 406),
 * NO RSS/Atom feed (404 on /rss.xml, /feed), and NO CORS headers on the
 * rates page — so a browser cannot fetch it directly. The webapp serves the
 * page through a stateless same-origin route handler
 * (`webapp/src/app/oeb-rates-page/route.ts`; formerly a next.config rewrite
 * — the handler no longer forwards OEB's own ~5 KB response headers, which
 * 502ed this route at the edge, 2026-10-17) and runs THIS parser
 * client-side, once per session.
 *
 * The weekly gateway cron (scripts/check_oeb_staleness.py) parses the same
 * page server-side with equivalent logic; both sides are pinned to
 * src/lib/oebRates.fixture.html (extracted from the live page 2026-10-02).
 */

import {
  getTouRateKey,
  getUloRateKey,
  type RateSet,
  type ProcessedPoint,
} from './energy';

export const OEB_RATES_URL =
  'https://www.oeb.ca/consumer-information-and-protection/electricity-rates';

/**
 * Same-origin route handler that proxies the OEB page (CORS-free transport).
 * The value lives in ./oebRouteCsp — src/proxy.ts needs it too (it sets that
 * route's hardening CSP), and one source cannot drift from the other.
 */
export { OEB_RATES_PROXY_PATH } from './oebRouteCsp';

const MONTH_TO_NUM: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

export type OebPageParse = {
  /** ISO yyyy-MM-dd of the newest OEB set, e.g. '2025-11-01'. */
  effectiveDate: string | null;
  /** Full parsed set — null unless the date AND every price cell were found. */
  rates: RateSet | null;
  /** Names of anything we failed to extract (empty = clean parse). */
  missing: string[];
};

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|\u00a0/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) cells.push(stripTags(m[1]));
  return cells;
}

function tableBlocks(html: string): string[] {
  return html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
}

/** First number in a cell; understands thousands commas ('1,000' → 1000). */
function firstNumber(cell: string): number | null {
  const m = cell.replace(/\u00a0/g, ' ').match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 'November 1, 2025' → '2025-11-01' (manual mapping — no TZ pitfalls). */
function monthDateToIso(text: string): string | null {
  const m = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mm = MONTH_TO_NUM[m[1].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
}

type MissingSink = string[];

function priceFor(
  cells: string[],
  labelPattern: RegExp,
  what: string,
  missing: MissingSink,
): number | null {
  const label = cells[0] ?? '';
  if (!labelPattern.test(label)) return null;
  const n = firstNumber(cells[cells.length - 1] ?? '');
  if (n === null) {
    missing.push(what);
    return null;
  }
  return n;
}

/**
 * Parse the OEB current-rates page (full page or the `#current` section).
 * Resilient by design: everything that fails lands in `missing` instead of
 * throwing, so the caller can still act on a date-only parse.
 */
export function parseOebRatesPage(html: string): OebPageParse {
  const missing: MissingSink = [];

  // 1) Effective date sentence: "…prices set by the OEB for November 1, 2025,…"
  let effectiveDate: string | null = null;
  const dateMatch = html.match(
    /prices set by the OEB for\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i,
  );
  if (dateMatch && dateMatch[1] !== undefined) {
    effectiveDate = monthDateToIso(dateMatch[1].replace(/\s+/g, ' ').trim());
  }
  if (!effectiveDate) missing.push('effectiveDate');

  // 2) The three price tables, classified by their header row.
  const tou: Partial<RateSet['tou']> = {};
  const ulo: Partial<RateSet['ulo']> = {};
  const tiered: Partial<RateSet['tiered']> = {};

  for (const table of tableBlocks(html)) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const firstRow = rows[0];
    if (firstRow === undefined) continue;
    const header = stripTags(firstRow);

    if (/TOU Price Periods/i.test(header)) {
      for (const row of rows.slice(1)) {
        const c = rowCells(row);
        if (c.length < 2) continue;
        const v = priceFor(c, /^Off-Peak/i, 'tou.offPeak', missing);
        if (v !== null) tou.offPeak = v;
        const m = priceFor(c, /^Mid-Peak/i, 'tou.midPeak', missing);
        if (m !== null) tou.midPeak = m;
        const o = priceFor(c, /^On-Peak/i, 'tou.onPeak', missing);
        if (o !== null) tou.onPeak = o;
      }
    } else if (/ULO Price Periods/i.test(header)) {
      for (const row of rows.slice(1)) {
        const c = rowCells(row);
        if (c.length < 2) continue;
        const n = priceFor(c, /^Ultra-Low Overnight/i, 'ulo.overnight', missing);
        if (n !== null) ulo.overnight = n;
        const w = priceFor(c, /^Weekend Off-Peak/i, 'ulo.weekendOffPeak', missing);
        if (w !== null) ulo.weekendOffPeak = w;
        const m = priceFor(c, /^Mid-Peak/i, 'ulo.midPeak', missing);
        if (m !== null) ulo.midPeak = m;
        const o = priceFor(c, /^On-Peak/i, 'ulo.onPeak', missing);
        if (o !== null) ulo.onPeak = o;
      }
    } else if (/Tier Thresholds/i.test(header)) {
      for (const row of rows.slice(1)) {
        const c = rowCells(row);
        if (c.length < 2) continue;
        if (/^Tier 1/i.test(c[0] ?? '')) {
          const t1 = firstNumber(c[c.length - 1] ?? '');
          if (t1 === null) missing.push('tiered.tier1');
          else tiered.tier1 = t1;
          // Residential thresholds live in the Tier 1 row's season cells.
          const winter = (c[1] ?? '').match(/first\s+([\d,]+(?:\.\d+)?)\s*kWh/i);
          if (winter) tiered.thresholdWinter = parseFloat(winter[1].replace(/,/g, ''));
          else missing.push('tiered.thresholdWinter');
          const summer = (c[2] ?? '').match(/first\s+([\d,]+(?:\.\d+)?)\s*kWh/i);
          if (summer) tiered.thresholdSummer = parseFloat(summer[1].replace(/,/g, ''));
          else missing.push('tiered.thresholdSummer');
        } else if (/^Tier 2/i.test(c[0] ?? '')) {
          const t2 = firstNumber(c[c.length - 1] ?? '');
          if (t2 === null) missing.push('tiered.tier2');
          else tiered.tier2 = t2;
        }
      }
    }
  }

  // Anything still undefined at this point failed as a whole TABLE (a mere
  // missing cell was already recorded by priceFor above).
  const required: [string, unknown][] = [
    ['tou.offPeak', tou.offPeak], ['tou.midPeak', tou.midPeak], ['tou.onPeak', tou.onPeak],
    ['ulo.overnight', ulo.overnight], ['ulo.weekendOffPeak', ulo.weekendOffPeak],
    ['ulo.midPeak', ulo.midPeak], ['ulo.onPeak', ulo.onPeak],
    ['tiered.tier1', tiered.tier1], ['tiered.tier2', tiered.tier2],
    ['tiered.thresholdWinter', tiered.thresholdWinter],
    ['tiered.thresholdSummer', tiered.thresholdSummer],
  ];
  for (const [name, value] of required) {
    if (value === undefined && !missing.includes(name)) missing.push(name);
  }

  const complete =
    tou.offPeak !== undefined && tou.midPeak !== undefined && tou.onPeak !== undefined &&
    ulo.overnight !== undefined && ulo.weekendOffPeak !== undefined &&
    ulo.midPeak !== undefined && ulo.onPeak !== undefined &&
    tiered.tier1 !== undefined && tiered.tier2 !== undefined &&
    tiered.thresholdWinter !== undefined && tiered.thresholdSummer !== undefined &&
    effectiveDate !== null;

  if (complete) {
    return {
      effectiveDate,
      rates: {
        effectiveDate: effectiveDate!,
        tou: { offPeak: tou.offPeak!, midPeak: tou.midPeak!, onPeak: tou.onPeak! },
        ulo: {
          overnight: ulo.overnight!, weekendOffPeak: ulo.weekendOffPeak!,
          midPeak: ulo.midPeak!, onPeak: ulo.onPeak!,
        },
        tiered: {
          tier1: tiered.tier1!, tier2: tiered.tier2!,
          thresholdWinter: tiered.thresholdWinter!, thresholdSummer: tiered.thresholdSummer!,
        },
      },
      missing,
    };
  }

  // Partial parse: report whatever date we got, no rates object.
  if (!dateMatch) missing.push('dateSentence');
  return { effectiveDate, rates: null, missing };
}

/** ISO yyyy-MM-dd strings compare lexicographically. */
export function isOebDateNewer(oebDate: string, shippedMax: string | null): boolean {
  if (!shippedMax) return true;
  return oebDate > shippedMax;
}

/** Max effectiveDate across the shipped sets (null when none). */
export function maxShippedEffectiveDate(rates: RateSet[]): string | null {
  if (rates.length === 0) return null;
  return rates.map((r) => r.effectiveDate).sort().at(-1) ?? null;
}

/**
 * Compact per-period deltas between the shipped-latest set and the OEB set.
 * Only periods whose value changed are returned (a pure date bump yields []).
 */
export type RatePeriodDelta = {
  plan: 'TOU' | 'ULO' | 'Tiered';
  label: string;
  current: number;
  next: number;
};

export function summarizeRateChange(
  current: RateSet,
  next: RateSet,
): RatePeriodDelta[] {
  const out: RatePeriodDelta[] = [];
  const add = (plan: RatePeriodDelta['plan'], label: string, a: number, b: number) => {
    if (a !== b) out.push({ plan, label, current: a, next: b });
  };
  add('TOU', 'Off-Peak', current.tou.offPeak, next.tou.offPeak);
  add('TOU', 'Mid-Peak', current.tou.midPeak, next.tou.midPeak);
  add('TOU', 'On-Peak', current.tou.onPeak, next.tou.onPeak);
  add('ULO', 'Overnight', current.ulo.overnight, next.ulo.overnight);
  add('ULO', 'Weekend Off-Peak', current.ulo.weekendOffPeak, next.ulo.weekendOffPeak);
  add('ULO', 'Mid-Peak', current.ulo.midPeak, next.ulo.midPeak);
  add('ULO', 'On-Peak', current.ulo.onPeak, next.ulo.onPeak);
  add('Tiered', 'Tier 1', current.tiered.tier1, next.tiered.tier1);
  add('Tiered', 'Tier 2', current.tiered.tier2, next.tiered.tier2);
  return out;
}

/**
 * Computed sample impact: what the user's most recent ~30 days of readings
 * would have cost under the OEB's new rates vs. what the app charges today
 * (per-reading activeRateSet — i.e. exactly the historical truth).
 *
 * Tiered is repriced with the same month-scoped threshold bucketing the
 * chart uses (aggregateChartData), so the numbers agree with the plan cards.
 * Returns null when there is nothing to price.
 */
export type RateChangeImpact = {
  /** Calendar days covered by the sample window (≤ 30 when data is shorter). */
  windowDays: number;
  kwh: number;
  costCurrent: number;
  costNew: number;
  delta: number;
  perPlan: {
    plan: 'TOU' | 'Tiered' | 'ULO';
    current: number;
    next: number;
    delta: number;
  }[];
};

function tieredCostForWindow(
  rows: ProcessedPoint[],
  price: (r: ProcessedPoint) => { tier1: number; tier2: number; thWinter: number; thSummer: number },
): number {
  // Month buckets, exactly like aggregateChartData's monthly tiered logic.
  const buckets = new Map<string, ProcessedPoint[]>();
  for (const r of rows) {
    const key = r.dayStr.slice(0, 7);
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }
  let total = 0;
  for (const list of buckets.values()) {
    let usage = 0;
    for (const r of list) usage += r.usage_kwh;
    const p = price(list[0]);
    const days = new Set(list.map((r) => r.dayStr)).size;
    const th = (list[0].isWinter ? p.thWinter : p.thSummer) * (days / 30.4);
    total +=
      usage <= th
        ? usage * (p.tier1 / 100)
        : th * (p.tier1 / 100) + (usage - th) * (p.tier2 / 100);
  }
  return total;
}

export function calculateRateChangeImpact(
  processedData: ProcessedPoint[],
  nextSet: RateSet,
  windowDays = 30,
): RateChangeImpact | null {
  if (processedData.length === 0) return null;
  let maxTs = -Infinity;
  for (const r of processedData) if (r.timestamp > maxTs) maxTs = r.timestamp;
  // Inclusive window: exactly `windowDays` calendar dates ending at maxTs.
  const cutoff = maxTs - (windowDays - 1) * 86400;
  const rows = processedData.filter((r) => r.timestamp >= cutoff);
  if (rows.length === 0) return null;

  let minTs = Infinity;
  let kwh = 0;
  let currentTOU = 0;
  let currentULO = 0;
  for (const r of rows) {
    if (r.timestamp < minTs) minTs = r.timestamp;
    kwh += r.usage_kwh;
    currentTOU += r.costTOU;
    currentULO += r.costULO;
  }

  // Reprice the same rows under the incoming set. Categories (tou/ulo bucket
  // and isWinter) come from the timestamp — rate-independent — so only the
  // ¢/kWh values change.
  let newTOU = 0;
  let newULO = 0;
  for (const r of rows) {
    newTOU += (r.usage_kwh * nextSet.tou[getTouRateKey(r.touCategory)]) / 100;
    newULO += (r.usage_kwh * nextSet.ulo[getUloRateKey(r.uloCategory)]) / 100;
  }

  const currentTiered = tieredCostForWindow(rows, (r) => ({
    tier1: r.activeRateSet.tiered.tier1,
    tier2: r.activeRateSet.tiered.tier2,
    thWinter: r.activeRateSet.tiered.thresholdWinter,
    thSummer: r.activeRateSet.tiered.thresholdSummer,
  }));
  const newTiered = tieredCostForWindow(rows, () => ({
    tier1: nextSet.tiered.tier1,
    tier2: nextSet.tiered.tier2,
    thWinter: nextSet.tiered.thresholdWinter,
    thSummer: nextSet.tiered.thresholdSummer,
  }));

  const costCurrent = currentTOU + currentTiered + currentULO;
  const costNew = newTOU + newTiered + newULO;
  const coveredDays = Math.max(1, Math.round((maxTs - minTs) / 86400) + 1);

  return {
    windowDays: coveredDays,
    kwh,
    costCurrent,
    costNew,
    delta: costNew - costCurrent,
    perPlan: [
      { plan: 'TOU', current: currentTOU, next: newTOU, delta: newTOU - currentTOU },
      { plan: 'Tiered', current: currentTiered, next: newTiered, delta: newTiered - currentTiered },
      { plan: 'ULO', current: currentULO, next: newULO, delta: newULO - currentULO },
    ],
  };
}

/**
 * Deterministic content version of the shipped rate array — changes iff the
 * data changes. FNV-1a (32-bit) keeps it dependency-free and identical on
 * server (route) and client (tests).
 */
export function hashRateSets(rates: RateSet[]): string {
  const json = JSON.stringify(rates);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
