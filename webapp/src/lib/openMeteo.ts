/**
 * Wave T — client-side historical temperature, straight from Open-Meteo's CDN.
 *
 * Why this file exists: three Wave T slices need "how hot was it?" next to the
 * readings this app already holds — the temperature-banded usage curve, the
 * anomaly context cards ("31 °C — that's AC"), and nothing else. Every one of
 * them is a question about the past, and the past is exactly what Open-Meteo's
 * archive endpoint serves for free with no API key.
 *
 * THE NO-SERVER-FETCH INVARIANT. This app's privacy story is that a Green
 * Button export never leaves the browser: no upload, no backend, no account.
 * So the weather comes down the same way the rates the OEB publishes do — the
 * BROWSER calls a public CDN and the answer is cached in THIS browser. There
 * is no new route, no proxy, no server-side call, and nothing about the
 * household is sent anywhere except the coordinates this module is configured
 * with (a city centre, not a home address).
 *
 * WHAT IS FETCHED, AND WHAT IS NOT. Only the dates the user's own data covers:
 * the span is derived from the loaded readings and the request is chunked
 * inside it. A period with no readings is never asked about — no data, no
 * fetch, no cache entry. Offline (or blocked, or rate-limited) every caller
 * gets `status: 'error'` and renders its honest "no data" state; the app
 * worked before this call existed and keeps working after it fails.
 *
 * THE CLOCK, ONCE. Every temperature is stored against a UTC HOUR INDEX —
 * `Math.floor(unixSeconds / 3600)` — and the request asks Open-Meteo for
 * `timezone=UTC`, so the payload's `time` strings are UTC hours that index
 * directly into the array. That is not a micro-optimisation, it is the whole
 * correctness argument: local wall-clock keys break on the two DST days a year
 * (a skipped hour, a repeated one) and on any machine whose timezone is not
 * the meter's. An absolute hour is the same instant for the parser, the
 * browser and the CDN, so an EDT reading is compared with the temperature of
 * that same hour — which is also exactly equivalent to matching in local time
 * (verified both ways against Mark's 17,539 readings, evidence/wave-t-notes).
 */

/** Where this build's weather comes from. A city centre, never a home. */
export const OPEN_METEO = {
  /** Toronto — the city the reference data set is from. */
  latitude: 43.6532,
  longitude: -79.3832,
  /** UTC on purpose: see THE CLOCK, ONCE above. */
  timezone: 'UTC',
  label: 'Toronto',
} as const;

export const OPEN_METEO_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';

/** Days per request. Bounds payload size and keeps a long span retryable. */
export const OPEN_METEO_CHUNK_DAYS = 183;

/** localStorage key. Versioned: a changed encoding must not be read as old. */
export const OPEN_METEO_CACHE_KEY = 'oeo_openmeteo_v1';

const MS_PER_HOUR = 3_600_000;

/** The one clock: absolute hours since the epoch. */
export const hourIndexOf = (unixSeconds: number): number => Math.floor(unixSeconds / 3600);

/** `2026-07-04` for the UTC day containing this hour index. */
export function utcDateOfHour(hour: number): string {
  return new Date(hour * MS_PER_HOUR).toISOString().slice(0, 10);
}

/** A dense, UTC-hour-indexed temperature series. */
export type HourlyTemps = {
  /** Hour index of `values[0]`. */
  startHour: number;
  /** °C for every hour in [startHour, startHour + values.length). */
  values: (number | null)[];
};

/** The temperature at an absolute hour, or null when nothing covers it. */
export function tempAtC(temps: HourlyTemps | null | undefined, unixSeconds: number): number | null {
  if (!temps) return null;
  const i = hourIndexOf(unixSeconds) - temps.startHour;
  if (i < 0 || i >= temps.values.length) return null;
  return temps.values[i];
}

/** `archive…?latitude=…` for one inclusive day range. */
export function openMeteoUrl(startDate: string, endDate: string): string {
  const params = new URLSearchParams({
    latitude: String(OPEN_METEO.latitude),
    longitude: String(OPEN_METEO.longitude),
    start_date: startDate,
    end_date: endDate,
    hourly: 'temperature_2m',
    timezone: OPEN_METEO.timezone,
  });
  return `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
}

/** Open-Meteo's hourly stamps: `2026-07-04T15:00` — no offset, no seconds. */
const OPEN_METEO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Turn one Open-Meteo payload into hours on the shared clock.
 *
 * Returns null — rather than a partly-filled series — when the payload is not
 * an hourly temperature response at all: a mocked `fetch` in a test, a 500
 * page, a rate-limit JSON. Callers treat null as "no weather", never as "cold".
 */
export function parseOpenMeteoHourly(payload: unknown): HourlyTemps | null {
  const hourly = (payload as { hourly?: { time?: unknown; temperature_2m?: unknown } } | null)?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.temperature_2m)) return null;
  if (hourly.time.length !== hourly.temperature_2m.length || hourly.time.length === 0) return null;

  let startHour = Infinity;
  let endHour = -Infinity;
  const stamps: number[] = [];
  for (const t of hourly.time) {
    // Shape-checked before parsing: V8's fallback parser accepts absurdity
    // ("not-a-time" becomes 2000-01-01), and a wrong stamp is a wrong hour.
    if (typeof t !== 'string' || !OPEN_METEO_STAMP.test(t)) return null;
    const ms = Date.parse(`${t}:00Z`);
    if (Number.isNaN(ms)) return null;
    const h = hourIndexOf(ms / 1000);
    stamps.push(h);
    if (h < startHour) startHour = h;
    if (h > endHour) endHour = h;
  }

  const values: (number | null)[] = new Array<number | null>(endHour - startHour + 1).fill(null);
  for (let i = 0; i < stamps.length; i += 1) {
    const raw = hourly.temperature_2m[i];
    // Open-Meteo marks a hole with null; a non-number is a hole too, not a 0.
    values[stamps[i] - startHour] = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
  return { startHour, values };
}

/** Merge pieces (which may overlap) into one dense series. */
export function mergeHourlyTemps(pieces: HourlyTemps[]): HourlyTemps | null {
  const live = pieces.filter((p) => p.values.length > 0);
  if (live.length === 0) return null;
  const startHour = Math.min(...live.map((p) => p.startHour));
  const endHour = Math.max(...live.map((p) => p.startHour + p.values.length - 1));
  const values: (number | null)[] = new Array<number | null>(endHour - startHour + 1).fill(null);
  // Later pieces win on overlap: they were fetched for this span, the others
  // may be older cache rows from a previous range.
  for (const p of live) {
    for (let i = 0; i < p.values.length; i += 1) values[p.startHour + i - startHour] = p.values[i];
  }
  return { startHour, values };
}

/** A span, in hour indices, inclusive on both ends. */
export type TempSpan = { startHour: number; endHour: number };

/** The span the loaded READINGS cover — the only span we are allowed to ask about. */
export function spanOfRows(rows: { timestamp: number }[]): TempSpan | null {
  if (rows.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    const h = hourIndexOf(r.timestamp);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return Number.isFinite(lo) && hi >= lo ? { startHour: lo, endHour: hi } : null;
}

function covers(temps: HourlyTemps, span: TempSpan): boolean {
  return temps.startHour <= span.startHour && temps.startHour + temps.values.length - 1 >= span.endHour;
}

type CacheEntry = {
  lat: number;
  lon: number;
  startHour: number;
  values: (number | null)[];
  fetchedAt: number;
};

function readCache(span: TempSpan, storage: Storage | null, now: number): HourlyTemps | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(OPEN_METEO_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry | null;
    if (
      !parsed ||
      parsed.lat !== OPEN_METEO.latitude ||
      parsed.lon !== OPEN_METEO.longitude ||
      typeof parsed.startHour !== 'number' ||
      !Array.isArray(parsed.values) ||
      typeof parsed.fetchedAt !== 'number'
    ) {
      return null;
    }
    // Historical weather is final; a cached year-old series beats a re-fetch.
    if (now - parsed.fetchedAt < 0) return null;
    const temps: HourlyTemps = { startHour: parsed.startHour, values: parsed.values };
    return covers(temps, span) ? temps : null;
  } catch {
    // Private mode, blocked storage, half-written JSON: not fatal, just uncached.
    return null;
  }
}

function writeCache(temps: HourlyTemps, storage: Storage | null): void {
  if (!storage) return;
  try {
    const entry: CacheEntry = {
      lat: OPEN_METEO.latitude,
      lon: OPEN_METEO.longitude,
      startHour: temps.startHour,
      values: temps.values,
      fetchedAt: Date.now(),
    };
    storage.setItem(OPEN_METEO_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Quota (a 7-year export plus weather is a lot of JSON) or blocked storage:
    // the numbers on screen are already right, we just did not remember them.
  }
}

export type TempFetchStatus =
  /** Nothing to ask about (no readings). */
  | 'none'
  /** A series covering every hour of the span arrived. */
  | 'ready'
  /** The CDN was unreachable/refused; callers render "no data". */
  | 'error';

export type TempFetchResult = {
  status: TempFetchStatus;
  temps: HourlyTemps | null;
  /** Where the series came from — shown to the user, never guessed at. */
  source: 'cache' | 'network' | null;
  /** Hours of the span we hold a temperature for, and how many we asked about. */
  coveredHours: number;
  spanHours: number;
};

/**
 * The narrow slice of `fetch` this module needs: one URL in, one JSON body
 * out. Typed this way on purpose — a test (or the app's own stubbed fetch)
 * can answer with a plain object, and the "is this weather?" check below is
 * the thing that decides, not a Response-shaped ceremony.
 */
export type TempFetcher = (url: string) => Promise<{ json: () => Promise<unknown> }>;

type LoadDeps = {
  fetchImpl?: TempFetcher;
  storage?: Storage | null;
};

/**
 * Load temperatures for exactly the span `rows` covers.
 *
 * Sequential chunked requests (a polite number of them), the localStorage
 * cache consulted first, and a hard promise that a failure is reported as a
 * failure — never as an empty series that would read as "0 °C everywhere".
 */
export async function loadHourlyTemps(
  rows: { timestamp: number }[],
  deps: LoadDeps = {},
): Promise<TempFetchResult> {
  const span = spanOfRows(rows);
  if (!span) return { status: 'none', temps: null, source: null, coveredHours: 0, spanHours: 0 };

  const storage = deps.storage === undefined ? safeLocalStorage() : deps.storage;
  const spanHours = span.endHour - span.startHour + 1;

  const cached = readCache(span, storage, Date.now());
  if (cached) {
    return {
      status: 'ready',
      temps: cached,
      source: 'cache',
      coveredHours: coveredHours(cached, span),
      spanHours,
    };
  }

  const doFetch =
    deps.fetchImpl ?? (typeof fetch === 'function' ? (url: string) => fetch(url) : null);
  if (!doFetch) return { status: 'error', temps: null, source: null, coveredHours: 0, spanHours };

  try {
    const pieces: HourlyTemps[] = [];
    // Day-aligned chunk bounds: a request is always whole UTC days, so no
    // chunk ever splits a day and the API's own day grid is never straddled.
    const HOURS_PER_CHUNK = OPEN_METEO_CHUNK_DAYS * 24;
    const firstDay = Math.floor(span.startHour / 24) * 24;
    const lastDay = Math.floor(span.endHour / 24) * 24;
    for (let day = firstDay; day <= lastDay; day += HOURS_PER_CHUNK) {
      const from = utcDateOfHour(day);
      const to = utcDateOfHour(Math.min(day + HOURS_PER_CHUNK - 24, lastDay));
      const res = await doFetch(openMeteoUrl(from, to));
      const parsed = parseOpenMeteoHourly(await res.json());
      if (!parsed) return { status: 'error', temps: null, source: null, coveredHours: 0, spanHours };
      pieces.push(parsed);
    }
    const merged = mergeHourlyTemps(pieces);
    if (!merged) return { status: 'error', temps: null, source: null, coveredHours: 0, spanHours };

    // Clip to the span: the API answers whole days, we keep only what we asked
    // for, so a cache entry can never smuggle temperatures for dates the
    // household has no readings for.
    const from = span.startHour - merged.startHour;
    const to = span.endHour - merged.startHour;
    const temps: HourlyTemps = {
      startHour: span.startHour,
      values: merged.values.slice(Math.max(0, from), to + 1),
    };
    writeCache(temps, storage);
    return { status: 'ready', temps, source: 'network', coveredHours: coveredHours(temps, span), spanHours };
  } catch {
    return { status: 'error', temps: null, source: null, coveredHours: 0, spanHours };
  }
}

function coveredHours(temps: HourlyTemps, span: TempSpan): number {
  let n = 0;
  for (let h = span.startHour; h <= span.endHour; h += 1) {
    const v = temps.values[h - temps.startHour];
    if (typeof v === 'number') n += 1;
  }
  return n;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
