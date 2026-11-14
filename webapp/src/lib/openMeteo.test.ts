/**
 * Wave T — lib/openMeteo.ts.
 *
 * The four things that can silently rot here, tested directly:
 *   1. ALIGNMENT — a temperature must land on the hour it describes, through
 *      both DST edges (a day with 23 hours, a day with 25) and across a
 *      chunked fetch. An off-by-one-hour bug does not crash anything; it
 *      quietly moves the whole AC story four hours earlier.
 *   2. SCOPE — the only dates ever requested are the dates the readings cover.
 *   3. FAILURE — an unreachable CDN, a mocked fetch, an HTML error page: all
 *      of them must come back as `status: 'error'` with no series, because a
 *      failed fetch that reads as "0 °C everywhere" would invent a winter
 *      heating story out of a network problem.
 *   4. THE BOUND (t_43c716ad) — the span is the FILE's word, so the number of
 *      sequential CDN requests it may cost is bounded too, and a span past
 *      the ceiling costs ZERO of them. Pinned by counting the calls a
 *      stubbed `fetchImpl` actually receives.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_TEMP_CHUNKS,
  OPEN_METEO,
  OPEN_METEO_CACHE_KEY,
  OPEN_METEO_CHUNK_DAYS,
  hourIndexOf,
  loadHourlyTemps,
  mergeHourlyTemps,
  openMeteoUrl,
  parseOpenMeteoHourly,
  spanOfRows,
  tempAtC,
  tempChunkCount,
  utcDateOfHour,
} from './openMeteo';
import { gasTempSpanRows } from './gasTempBands';
import { parseGreenButtonUsagePoints, parseUsageSummaries } from '@/lib/energy';

/** A deterministic °C for a UTC instant — the tests' only "weather" source. */
const tempFor = (hour: number) => 5 + ((hour % 48) / 4);

/** Open-Meteo's payload shape for a span of whole UTC days. */
function payloadForDays(firstDayHour: number, days: number, skipHours = new Set<number>()) {
  const time: string[] = [];
  const temperature_2m: (number | null)[] = [];
  for (let d = 0; d < days; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const hour = firstDayHour + d * 24 + h;
      if (skipHours.has(hour)) continue;
      const iso = new Date(hour * 3_600_000).toISOString();
      time.push(`${iso.slice(0, 10)}T${iso.slice(11, 16)}`);
      temperature_2m.push(tempFor(hour));
    }
  }
  return { hourly: { time, temperature_2m } };
}

/**
 * A fetch that answers any day range inside the synthetic weather.
 *
 * NOTE the units: `Date.parse` answers in MILLISECONDS, so an hour index is
 * `Date.parse(iso) / 3_600_000` (milliseconds in an hour).
 */
function synthFetch(opts: { fail?: boolean; junk?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (opts.fail) throw new Error('network down');
    const u = new URL(String(url));
    const start = Date.parse(`${u.searchParams.get('start_date')}T00:00:00Z`) / 3_600_000;
    const end = Date.parse(`${u.searchParams.get('end_date')}T00:00:00Z`) / 3_600_000;
    const days = Math.round((end - start) / 24) + 1;
    return {
      json: async () => (opts.junk ? { reason: 'rate limited' } : payloadForDays(start, days)),
    };
  });
}

const rows = (startHour: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ timestamp: (startHour + i) * 3600 }));

describe('the shared clock', () => {
  it('indexes whole hours from the unix epoch, in UTC', () => {
    expect(hourIndexOf(0)).toBe(0);
    expect(hourIndexOf(3599)).toBe(0);
    expect(hourIndexOf(3600)).toBe(1);
    // 2026-07-04T15:00:00Z
    expect(hourIndexOf(Date.parse('2026-07-04T15:00:00Z') / 1000)).toBe(
      Date.parse('2026-07-04T15:00:00Z') / 1000 / 3600,
    );
  });

  it('turns an hour index back into the UTC date the API wants', () => {
    expect(utcDateOfHour(hourIndexOf(Date.parse('2024-10-06T00:00:00Z') / 1000))).toBe('2024-10-06');
    expect(utcDateOfHour(hourIndexOf(Date.parse('2026-10-06T23:00:00Z') / 1000))).toBe('2026-10-06');
  });

  it('asks Open-Meteo for hourly temperature_2m in UTC at a city centre', () => {
    const url = new URL(openMeteoUrl('2024-10-06', '2026-10-07'));
    expect(url.origin + url.pathname).toBe('https://archive-api.open-meteo.com/v1/archive');
    expect(url.searchParams.get('latitude')).toBe(String(OPEN_METEO.latitude));
    expect(url.searchParams.get('longitude')).toBe(String(OPEN_METEO.longitude));
    expect(url.searchParams.get('hourly')).toBe('temperature_2m');
    expect(url.searchParams.get('timezone')).toBe('UTC');
    expect(url.searchParams.get('start_date')).toBe('2024-10-06');
    expect(url.searchParams.get('end_date')).toBe('2026-10-07');
  });
});

describe('parseOpenMeteoHourly', () => {
  it('builds a dense hour-indexed series', () => {
    const start = hourIndexOf(Date.parse('2026-07-04T00:00:00Z') / 1000);
    const parsed = parseOpenMeteoHourly(payloadForDays(start, 2))!;
    expect(parsed.startHour).toBe(start);
    expect(parsed.values).toHaveLength(48);
    expect(parsed.values[0]).toBe(tempFor(start));
    expect(parsed.values[47]).toBe(tempFor(start + 47));
  });

  it('keeps a hole a hole instead of inventing 0 °C', () => {
    const start = hourIndexOf(Date.parse('2026-07-04T00:00:00Z') / 1000);
    const payload = payloadForDays(start, 2);
    payload.hourly.temperature_2m[10] = null;
    payload.hourly.time.splice(11, 1);
    payload.hourly.temperature_2m.splice(11, 1);
    const parsed = parseOpenMeteoHourly(payload)!;
    expect(parsed.values[10]).toBeNull();
    expect(parsed.values[11]).toBeNull(); // the dropped stamp leaves a gap, not a value
    expect(parsed.values[12]).toBe(tempFor(start + 12));
  });

  it('refuses anything that is not an hourly temperature payload', () => {
    expect(parseOpenMeteoHourly(null)).toBeNull();
    expect(parseOpenMeteoHourly({})).toBeNull();
    expect(parseOpenMeteoHourly({ historicalRates: [] })).toBeNull();
    expect(parseOpenMeteoHourly({ hourly: { time: [], temperature_2m: [] } })).toBeNull();
    // Length mismatch is a truncated response, not a shorter year.
    expect(parseOpenMeteoHourly({ hourly: { time: ['2026-07-04T00:00'], temperature_2m: [1, 2] } })).toBeNull();
    expect(parseOpenMeteoHourly({ hourly: { time: ['not-a-time'], temperature_2m: [1] } })).toBeNull();
    expect(parseOpenMeteoHourly({ hourly: { time: ['2026-07-04T00:00'], temperature_2m: [Number.NaN] } })).toEqual({
      startHour: hourIndexOf(Date.parse('2026-07-04T00:00:00Z') / 1000),
      values: [null],
    });
  });
});

describe('mergeHourlyTemps', () => {
  const startOf = (iso: string) => hourIndexOf(Date.parse(iso) / 1000);

  it('joins adjacent pieces into one dense series', () => {
    const a = parseOpenMeteoHourly(payloadForDays(startOf('2026-07-04T00:00:00Z'), 1))!;
    const b = parseOpenMeteoHourly(payloadForDays(startOf('2026-07-05T00:00:00Z'), 1))!;
    const merged = mergeHourlyTemps([a, b])!;
    expect(merged.values).toHaveLength(48);
    expect(merged.values[23]).toBe(tempFor(a.startHour + 23));
    expect(merged.values[24]).toBe(tempFor(b.startHour));
  });

  it('keeps a gap a gap and survives an empty list', () => {
    const a = parseOpenMeteoHourly(payloadForDays(startOf('2026-07-04T00:00:00Z'), 1))!;
    const c = parseOpenMeteoHourly(payloadForDays(startOf('2026-07-07T00:00:00Z'), 1))!;
    const merged = mergeHourlyTemps([a, c])!;
    expect(merged.values).toHaveLength(24 * 4);
    expect(merged.values[30]).toBeNull();
    expect(mergeHourlyTemps([])).toBeNull();
    expect(mergeHourlyTemps([{ startHour: 0, values: [] }])).toBeNull();
  });
});

describe('spanOfRows', () => {
  it('is the readings\u2019 own span — never a calendar window', () => {
    expect(spanOfRows([])).toBeNull();
    const span = spanOfRows(rows(100, 10))!;
    expect(span.startHour).toBe(100);
    expect(span.endHour).toBe(109);
  });
});

describe('tempAtC', () => {
  const temps = { startHour: 10, values: [1, 2, 3] };

  it('reads an absolute hour, and nothing outside the series', () => {
    expect(tempAtC(temps, 10 * 3600)).toBe(1);
    expect(tempAtC(temps, 12 * 3600)).toBe(3);
    expect(tempAtC(temps, 9 * 3600)).toBeNull();
    expect(tempAtC(temps, 13 * 3600)).toBeNull();
    expect(tempAtC(null, 10 * 3600)).toBeNull();
  });
});

describe('loadHourlyTemps', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('has nothing to ask about when there is no data', async () => {
    const fetchImpl = synthFetch();
    const result = await loadHourlyTemps([], { fetchImpl, storage: null });
    expect(result.status).toBe('none');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks only for the dates the readings cover, and clips to them', async () => {
    // A reading mid-day on Oct 6 and one mid-day on Oct 8.
    const first = Date.parse('2024-10-06T05:00:00Z') / 3_600_000;
    const last = Date.parse('2024-10-08T17:00:00Z') / 3_600_000;
    const fetchImpl = synthFetch();
    const result = await loadHourlyTemps(rows(first, 1).concat(rows(last, 1)), {
      fetchImpl,
      storage: null,
    });

    expect(result.status).toBe('ready');
    expect(result.source).toBe('network');
    expect(result.spanHours).toBe(last - first + 1);
    expect(result.coveredHours).toBe(result.spanHours);
    // Two whole days of requests, no more.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const asked = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(asked.searchParams.get('start_date')).toBe('2024-10-06');
    expect(asked.searchParams.get('end_date')).toBe('2024-10-08');
    // ...and nothing outside the span was kept.
    expect(result.temps!.startHour).toBe(first);
    expect(result.temps!.values).toHaveLength(last - first + 1);
    expect(tempAtC(result.temps, first * 3600)).toBe(tempFor(first));
    expect(tempAtC(result.temps, last * 3600)).toBe(tempFor(last));
  });

  it('splits a long span into bounded chunks and reassembles them in order', async () => {
    const first = Date.parse('2024-10-06T00:00:00Z') / 3_600_000;
    const last = Date.parse('2026-10-06T23:00:00Z') / 3_600_000;
    const fetchImpl = synthFetch();
    const result = await loadHourlyTemps(rows(first, 1).concat(rows(last, 1)), {
      fetchImpl,
      storage: null,
    });
    expect(result.status).toBe('ready');
    // 731 days at 183 days a chunk = 4 requests.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.coveredHours).toBe(result.spanHours);
    expect(tempAtC(result.temps, first * 3600)).toBe(tempFor(first));
    expect(tempAtC(result.temps, last * 3600)).toBe(tempFor(last));
  });

  it('reads the browser cache instead of the network when it already covers the span', async () => {
    const first = Date.parse('2024-10-06T00:00:00Z') / 3_600_000;
    const span = rows(first, 1).concat(rows(first + 47, 1));
    const fetchImpl = synthFetch();
    const firstRun = await loadHourlyTemps(span, { fetchImpl, storage: localStorage });
    expect(firstRun.source).toBe('network');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const secondFetch = synthFetch();
    const secondRun = await loadHourlyTemps(span, { fetchImpl: secondFetch, storage: localStorage });
    expect(secondRun.status).toBe('ready');
    expect(secondRun.source).toBe('cache');
    expect(secondFetch).not.toHaveBeenCalled();
    expect(secondRun.temps!.values).toEqual(firstRun.temps!.values);
  });

  it('re-fetches when the household imports a LONGER export than the cache covers', async () => {
    const first = Date.parse('2024-10-06T00:00:00Z') / 3_600_000;
    await loadHourlyTemps(rows(first, 24), { fetchImpl: synthFetch(), storage: localStorage });
    const longerFetch = synthFetch();
    const result = await loadHourlyTemps(rows(first, 24 * 40), {
      fetchImpl: longerFetch,
      storage: localStorage,
    });
    expect(longerFetch).toHaveBeenCalled();
    expect(result.coveredHours).toBe(24 * 40);
  });

  it('reports an unreachable CDN as an error, never as an empty year', async () => {
    const result = await loadHourlyTemps(rows(100, 48), {
      fetchImpl: synthFetch({ fail: true }),
      storage: null,
    });
    expect(result.status).toBe('error');
    expect(result.temps).toBeNull();
    expect(result.coveredHours).toBe(0);
  });

  it('reports a non-weather payload (a mocked rates fetch, a rate-limit page) as an error', async () => {
    const junk = await loadHourlyTemps(rows(100, 48), { fetchImpl: synthFetch({ junk: true }), storage: null });
    expect(junk.status).toBe('error');
    expect(junk.temps).toBeNull();

    // What the app's own tests stub `fetch` with: a rates payload.
    const rates = vi.fn(async () => ({ json: async () => ({ historicalRates: [] }) }));
    const mocked = await loadHourlyTemps(rows(100, 48), { fetchImpl: rates, storage: null });
    expect(mocked.status).toBe('error');
  });

  it('survives storage that throws (private mode) and storage that is absent', async () => {
    const blocked = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const result = await loadHourlyTemps(rows(100, 48), {
      fetchImpl: synthFetch(),
      storage: blocked,
    });
    expect(result.status).toBe('ready');

    const uncached = await loadHourlyTemps(rows(100, 48), { fetchImpl: synthFetch(), storage: null });
    expect(uncached.status).toBe('ready');
    expect(uncached.source).toBe('network');
  });

  it('ignores a cache written for another location or another encoding', async () => {
    const first = Date.parse('2024-10-06T00:00:00Z') / 3_600_000;
    const span = rows(first, 48);
    localStorage.setItem(
      OPEN_METEO_CACHE_KEY,
      JSON.stringify({ lat: 45, lon: -75, startHour: first, values: new Array(48).fill(0), fetchedAt: Date.now() }),
    );
    const fetchImpl = synthFetch();
    const result = await loadHourlyTemps(span, { fetchImpl, storage: localStorage });
    expect(fetchImpl).toHaveBeenCalled();
    expect(result.source).toBe('network');

    localStorage.setItem(OPEN_METEO_CACHE_KEY, 'not json');
    const again = await loadHourlyTemps(span, { fetchImpl: synthFetch(), storage: localStorage });
    expect(again.source).toBe('network');
  });
});

/* ==========================================================================
 * THE BOUND — how many sequential CDN requests one span may cost
 * (t_43c716ad: the fetch-side secondary of F1, gate t_1bf524cc)
 * ==========================================================================
 * `spanOfRows` takes its bounds from the LOADED DATA, and the gas card asks
 * about both edges of every usable bill and reading (`gasTempSpanRows`), so
 * the SPAN — never the row count — is what the chunk loop prices: one
 * awaited request per 183 days, then a per-hour walk of the whole span. Two
 * rows an epoch apart measured up to ~740 000 sequential requests to
 * archive-api.open-meteo.com (t_3bfd4c3e). The bound refuses any span past
 * MAX_TEMP_CHUNKS BEFORE a single request is issued, with the same honest
 * `status: 'error'` a network failure reports.
 *
 * Pinned here, in the order the acceptance criteria ask for it:
 *   1. hostile shapes — two legal-duration rows seconds-to-eons apart, from
 *      the rows API AND from a file that actually parses — cost ZERO fetch
 *      calls, counted against a stubbed `fetchImpl`;
 *   2. the failure is honest: `status: 'error'`, `temps: null`, never an
 *      empty series that would read as 0 °C;
 *   3. the widest span this repo's real data states — the 22.9-year
 *      fixture's own billing period — still fetches: 46 requests, `ready`;
 *   4. the check and the loop cannot drift: `tempChunkCount` IS the loop's
 *      own iteration count, asserted equal to the calls actually made, on
 *      both sides of the ceiling.
 */

describe('the fetch bound (t_43c716ad)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** A `fetch` that would answer, used only where the test expects ZERO calls. */
  const neverFetch = () => vi.fn(async () => ({ json: async () => ({}) }));

  const FEED = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">\n${body}\n</feed>`;

  /** A gas bill that states its own m³ volume — usable by `gasTempSpanRows`. */
  const GAS_BILL = (start: number | string, duration: number | string) =>
    `<entry><content><espi:UsageSummary><espi:billingPeriod><espi:start>${start}</espi:start>` +
    `<espi:duration>${duration}</espi:duration></espi:billingPeriod>` +
    '<espi:currentBillingPeriodOverAllConsumption><espi:value>1000</espi:value>' +
    '<espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:uom>42</espi:uom>' +
    '</espi:currentBillingPeriodOverAllConsumption></espi:UsageSummary></content></entry>';

  it('refuses rows seconds-to-eons apart with ZERO requests and an honest error', async () => {
    // Both edges a hostile file's two bills produce: each has a LEGAL
    // duration (1 year) — only the STARTS are absurd, which is exactly the
    // shape `gasTempSpanRows` pushes for it.
    const hostile = [
      { timestamp: 0 },
      { timestamp: 31_536_000 },
      { timestamp: 1e15 },
      { timestamp: 1e15 + 31_536_000 },
    ];
    const span = spanOfRows(hostile)!;
    expect(tempChunkCount(span)).toBeGreaterThan(MAX_TEMP_CHUNKS);

    const fetchImpl = neverFetch();
    const result = await loadHourlyTemps(hostile, { fetchImpl, storage: null });

    // The honest failure contract, byte for byte the one a dead CDN reports.
    expect(result.status).toBe('error');
    expect(result.temps).toBeNull();
    expect(result.source).toBeNull();
    expect(result.coveredHours).toBe(0);
    // The span is still REPORTED — the caller knows what it asked about —
    // but no request was ever made for it: the pinned bound is ZERO.
    expect(result.spanHours).toBe(span.endHour - span.startHour + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('refuses a hostile FILE that still parses — epoch-dated bill beside a sane one', async () => {
    // Both bills are legal on every parse-side bound: starts of 1970-01-01
    // and 2024-01-01 (neither is past 2100), durations of 365 d and 31 d
    // (neither is past 100 y). Nothing refuses this file, so it IMPORTS —
    // and only the fetch bound can stop the eon-wide span its two edges
    // make: 1970 → 2024-02-01 is 108 sequential requests.
    const xml = FEED(GAS_BILL(0, 31_536_000) + GAS_BILL(1_704_067_200, 2_678_400));
    const summaries = parseUsageSummaries(xml);
    expect(summaries).toHaveLength(2);
    const spanRows = gasTempSpanRows([], summaries);
    expect(spanRows).toHaveLength(4);

    const span = spanOfRows(spanRows)!;
    expect(tempChunkCount(span)).toBe(108);

    const fetchImpl = neverFetch();
    const result = await loadHourlyTemps(spanRows, { fetchImpl, storage: null });
    expect(result.status).toBe('error');
    expect(result.temps).toBeNull();
    expect(result.coveredHours).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('still fetches the widest span this repo’s real data states — the 22.9-year fixture', async () => {
    const xml = readFileSync(
      join(__dirname, '../../tests/fixtures/utility-espi-prefixed-standin.xml'),
      'utf8',
    );
    const [bill] = parseUsageSummaries(xml);
    // The figure the 100-year duration ceiling was measured against: 721 958 400 s.
    expect(bill.duration).toBe(721_958_400);

    // The two edges `gasTempSpanRows` pushes for this period — a gas file
    // carrying the same cumulative "since 2000" period takes this exact path.
    const spanRows = [{ timestamp: bill.start }, { timestamp: bill.start + bill.duration }];
    const span = spanOfRows(spanRows)!;
    // 8 356 days at 183 days a chunk: 46 requests, inside the 80-chunk
    // ceiling with room to spare (the widest span ANY fixture can form is 55).
    expect(tempChunkCount(span)).toBe(46);
    expect(46).toBeLessThanOrEqual(MAX_TEMP_CHUNKS);

    const fetchImpl = synthFetch();
    const result = await loadHourlyTemps(spanRows, { fetchImpl, storage: null });
    expect(result.status).toBe('ready');
    expect(result.source).toBe('network');
    expect(fetchImpl).toHaveBeenCalledTimes(46);
    expect(result.coveredHours).toBe(result.spanHours);

    // The same fixture's READINGS — the electricity path's own span — cost 9.
    const groups = parseGreenButtonUsagePoints(xml);
    const readingRows = groups.flatMap((g) => g.readings.map((r) => ({ timestamp: r.timestamp })));
    expect(readingRows.length).toBe(514);
    expect(tempChunkCount(spanOfRows(readingRows)!)).toBe(9);
  }, 120_000);

  it('fetches exactly tempChunkCount(span) requests up to the ceiling, and none past it', async () => {
    // A span landing exactly ON the ceiling: day 0 → day (80 × 183) − 1.
    const days = MAX_TEMP_CHUNKS * OPEN_METEO_CHUNK_DAYS;
    const atCeiling = [{ timestamp: 0 }, { timestamp: (days - 1) * 86_400 }];
    const ceilingSpan = spanOfRows(atCeiling)!;
    expect(tempChunkCount(ceilingSpan)).toBe(MAX_TEMP_CHUNKS);

    const fetchImpl = synthFetch();
    const inside = await loadHourlyTemps(atCeiling, { fetchImpl, storage: null });
    // The count the CHECK computed is the count the LOOP ran — the two
    // share `chunkDayBounds`, so a drift between them fails right here.
    expect(fetchImpl).toHaveBeenCalledTimes(tempChunkCount(ceilingSpan));
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_TEMP_CHUNKS);
    expect(inside.status).toBe('ready');
    expect(inside.coveredHours).toBe(inside.spanHours);

    // One day wider: refused, and refused BEFORE the first request.
    const pastCeiling = [{ timestamp: 0 }, { timestamp: days * 86_400 }];
    expect(tempChunkCount(spanOfRows(pastCeiling)!)).toBe(MAX_TEMP_CHUNKS + 1);
    const refused = neverFetch();
    const outside = await loadHourlyTemps(pastCeiling, { fetchImpl: refused, storage: null });
    expect(outside.status).toBe('error');
    expect(outside.temps).toBeNull();
    expect(refused).toHaveBeenCalledTimes(0);
  }, 120_000);

  it('agrees with the loop on every shape: single hour, a day over a chunk, a year', async () => {
    const cases = [
      rows(100, 1), // one hour → one request
      rows(0, 24 * 183), // 183 whole days → exactly one chunk
      rows(0, 24 * 184), // one day past a chunk → two requests
      rows(0, 24 * 400), // 400 days → three requests
    ];
    for (const shape of cases) {
      const span = spanOfRows(shape)!;
      const fetchImpl = synthFetch();
      const result = await loadHourlyTemps(shape, { fetchImpl, storage: null });
      expect(result.status, `span ${span.startHour}..${span.endHour}`).toBe('ready');
      expect(fetchImpl.mock.calls.length, `span ${span.startHour}..${span.endHour}`).toBe(
        tempChunkCount(span),
      );
    }
  });
});
