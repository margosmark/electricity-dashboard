/**
 * ReadingType-aware ingestion — the semantic contract, pinned per case.
 *
 * Run: `npx vitest run src/lib/greenbutton/series.test.ts`
 *
 * Every test here exists because the previous single-pass parser got that case
 * wrong (or could not express it at all): one multiplier for the whole
 * document, one stream per UsagePoint, `duration` thrown away, negatives
 * silently dropped, and no way to say "this series is not consumption".
 *
 * The fixtures are built inline, on purpose: each one isolates ONE ESPI
 * variation so a failure names the variation. No private customer XML is
 * committed anywhere in this repo.
 */

import { describe, it, expect } from 'vitest';
import { parseReadingSeries, classifySeries, type SeriesMetadata } from './series';
import { parseGreenButtonFeed } from '@/lib/energy';
import { XMLParser } from 'fast-xml-parser';

/* ==========================================================================
 * Tiny ESPI document builder
 * ========================================================================== */

type Link = [rel: string, href: string];

type Entry = {
  self?: string;
  links?: Link[];
  body: string;
};

function feed(entries: Entry[], opts: { absolute?: boolean } = {}): string {
  const abs = (p: string) =>
    opts.absolute ? `https://custodian.example/espi/1_1/resource/RetailCustomer/1/${p.replace(/^\//, '')}` : p;
  const body = entries
    .map((e) => {
      const links = [
        ...(e.self ? [`<link rel="self" href="${abs(e.self)}"/>`] : []),
        ...(e.links ?? []).map(([rel, href]) => `<link rel="${rel}" href="${abs(href)}"/>`),
      ].join('');
      return `<entry>${links}<content>${e.body}</content></entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
${body}
</feed>`;
}

type RtSpec = {
  uom?: number | string;
  mult?: number | string;
  ab?: number;
  commodity?: number;
  fd?: number;
  kind?: number;
  intervalLength?: number;
};

function readingType(o: RtSpec): string {
  const el = (n: string, v: number | string | undefined) =>
    v === undefined ? '' : `<espi:${n}>${v}</espi:${n}>`;
  return `<espi:ReadingType>${el('uom', o.uom)}${el('powerOfTenMultiplier', o.mult)}${el(
    'accumulationBehaviour',
    o.ab,
  )}${el('commodity', o.commodity)}${el('flowDirection', o.fd)}${el('kind', o.kind)}${el(
    'intervalLength',
    o.intervalLength,
  )}</espi:ReadingType>`;
}

type Reading = { start: number; value: number | string; duration?: number };

function block(start: number, duration: number, readings: Reading[]): string {
  const rs = readings
    .map(
      (r) =>
        `<espi:IntervalReading><espi:timePeriod><espi:duration>${r.duration ?? duration}</espi:duration><espi:start>${r.start}</espi:start></espi:timePeriod><espi:value>${r.value}</espi:value></espi:IntervalReading>`,
    )
    .join('');
  return `<espi:IntervalBlock><espi:interval><espi:duration>${duration}</espi:duration><espi:start>${start}</espi:start></espi:interval>${rs}</espi:IntervalBlock>`;
}

/** Parse text the way the app does (namespace prefixes stripped, arrays forced). */
function parse(xml: string) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    isArray: (n) => ['IntervalReading', 'entry', 'IntervalBlock'].includes(n),
  });
  return parseReadingSeries(parser.parse(xml) as Record<string, unknown>);
}

/** One meter, one ReadingType, one block — the shape almost every test needs. */
function simpleDoc(
  rt: RtSpec,
  readings: Reading[],
  opts: { blockDuration?: number; absolute?: boolean; extra?: Entry[] } = {},
): string {
  const duration = opts.blockDuration ?? 3600;
  return feed(
    [
      { self: '/ReadingType/1', body: readingType(rt) },
      {
        self: '/UsagePoint/up-1/MeterReading/mr-1',
        links: [['related', '/ReadingType/1']],
        body: '<espi:MeterReading/>',
      },
      {
        self: '/UsagePoint/up-1/MeterReading/mr-1/IntervalBlock/ib-1',
        body: block(readings[0].start, duration, readings),
      },
      ...(opts.extra ?? []),
    ],
    { absolute: opts.absolute },
  );
}

/** Readings the group would actually price, in order. */
function priced(xml: string): number[] {
  const feedObj = parseGreenButtonFeed(xml);
  return feedObj.groups.flatMap((g) => g.readings.map((r) => r.usage_kwh));
}

/* ==========================================================================
 * Units and multipliers
 * ========================================================================== */

describe('units and multipliers — the same physical energy, encoded differently', () => {
  const R = [{ start: 1_700_000_000, value: 4000 }];

  it('reads 4 kWh from Wh with multiplier 0', () => {
    expect(priced(simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1 }, R))).toEqual([4]);
  });

  it('reads the same 4 kWh from uom 72 with multiplier 3 (the only way ESPI says "kWh")', () => {
    // ESPI has no kWh unit symbol: kilo is the powerOfTenMultiplier. A parser
    // that hard-codes /1000 without the exponent reports 0.004 kWh here.
    const xml = simpleDoc({ uom: 72, mult: 3, kind: 12, ab: 4, commodity: 1 }, [
      { start: 1_700_000_000, value: 4 },
    ]);
    expect(priced(xml)).toEqual([4]);
  });

  it('reads the same 4 kWh from uom 72 with multiplier -3 (Hydro One’s mWh encoding)', () => {
    const xml = simpleDoc({ uom: 72, mult: -3, kind: 12, ab: 4, commodity: 1 }, [
      { start: 1_700_000_000, value: 4_000_000 },
    ]);
    expect(priced(xml)).toEqual([4]);
  });

  it('reads the same 4 kWh from joules (uom 31)', () => {
    const xml = simpleDoc({ uom: 31, mult: 0, kind: 12, ab: 4, commodity: 1 }, [
      { start: 1_700_000_000, value: 14_400_000 },
    ]);
    expect(priced(xml)).toEqual([4]);
  });

  it('refuses VAh and VArh: apparent and reactive energy are not consumption', () => {
    for (const uom of [71, 73]) {
      const { series } = parse(
        simpleDoc({ uom, mult: 3, kind: 12, ab: 4, commodity: 1 }, [{ start: 1_700_000_000, value: 4000 }]),
      );
      expect(series[0].status).toBe('other-quantity');
      expect(series[0].readings.some((r) => r.kwh !== null)).toBe(false);
    }
  });
});

/* ==========================================================================
 * Interval duration
 * ========================================================================== */

describe('interval duration is preserved for every reading', () => {
  it('keeps 15-, 30- and 60-minute intervals distinct and reads them as stated', () => {
    for (const [duration, hours] of [
      [900, 0.25],
      [1800, 0.5],
      [3600, 1],
    ] as const) {
      const xml = simpleDoc({ uom: 72, mult: 3, kind: 12, ab: 4, commodity: 1, intervalLength: duration }, [
        { start: 1_700_000_000, value: 2, duration },
      ]);
      const { series } = parse(xml);
      expect(series[0].readings[0].duration_s).toBe(duration);
      // 2 kWh is 2 kWh whatever the interval; the duration is what tells a
      // per-hour rate what it is looking at, and it is no longer thrown away.
      expect(series[0].readings[0].kwh).toBe(2);
      expect(duration / 3600).toBe(hours);
    }
  });

  it('exposes the 15-minute cadence on the group, so 4 readings are not 4 hours', () => {
    const rows: Reading[] = [0, 1, 2, 3].map((i) => ({
      start: 1_700_000_000 + i * 900,
      value: 1000,
      duration: 900,
    }));
    // One daily block (3600 s span stated at block level) holding four 900 s
    // readings — exactly how a custodian publishes sub-hourly data.
    const xml = simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, intervalLength: 900 }, rows, {
      blockDuration: 3600,
    });
    const g = parseGreenButtonFeed(xml).groups[0];
    expect(g.readings).toHaveLength(4);
    const durations = g.series[0].readings.map((r) => r.duration_s);
    expect(durations).toEqual([900, 900, 900, 900]);
    // 4 readings x 900 s = 1 hour of data, not 4.
    const totalSeconds = durations.reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(totalSeconds / 3600).toBe(1);
  });

  it('falls back to ReadingType.intervalLength only when the reading states none', () => {
    const xml = feed([
      { self: '/ReadingType/1', body: readingType({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, intervalLength: 1800 }) },
      { self: '/UsagePoint/up/MeterReading/mr', links: [['related', '/ReadingType/1']], body: '<espi:MeterReading/>' },
      {
        self: '/UsagePoint/up/MeterReading/mr/IntervalBlock/ib',
        body: `<espi:IntervalBlock><espi:IntervalReading><espi:timePeriod><espi:start>1700000000</espi:start></espi:timePeriod><espi:value>500</espi:value></espi:IntervalReading></espi:IntervalBlock>`,
      },
    ]);
    expect(parse(xml).series[0].readings[0].duration_s).toBe(1800);
  });
});

/* ==========================================================================
 * Series isolation
 * ========================================================================== */

describe('series isolation — nothing incompatible is ever added together', () => {
  const energyRt = { uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1 } as const;

  it('keeps energy, power, register and exported series apart under ONE UsagePoint', () => {
    // One UsagePoint, four MeterReadings — the shape a custodian publishes when
    // it reports consumption, demand, a register and exported energy for the
    // same service. Only the first is consumption.
    const meters: [string, RtSpec][] = [
      ['energy', { ...energyRt }],
      ['power', { uom: 38, mult: 0, kind: 37, ab: 4, commodity: 1, fd: 1, intervalLength: 3600 }],
      ['register', { uom: 72, mult: 0, kind: 12, ab: 3, commodity: 1, fd: 1 }],
      ['export', { uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, fd: 19 }],
    ];
    const xml = feed([
      ...meters.map(([name, spec]) => ({ self: `/ReadingType/${name}`, body: readingType(spec) })),
      ...meters.map(([name]) => ({
        self: `/UsagePoint/up/MeterReading/mr-${name}`,
        links: [['related', `/ReadingType/${name}`]] as Link[],
        body: '<espi:MeterReading/>',
      })),
      ...meters.map(([name]) => ({
        self: `/UsagePoint/up/MeterReading/mr-${name}/IntervalBlock/ib-${name}`,
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 1500 }]),
      })),
    ]);

    const g = parseGreenButtonFeed(xml).groups[0];
    // Only the plain energy series is priced. The power series describes the
    // SAME consumption and is deliberately not added to it (that would double
    // the household's usage); the register and export series are refused.
    expect(g.readings).toEqual([{ timestamp: 1_700_000_000, usage_kwh: 1.5 }]);
    expect(g.notes.some((n) => n.code === 'combined-series')).toBe(true);
    // ...and all four series are still visible, each with its own reason.
    expect(g.series).toHaveLength(4);
    expect(g.series.map((s) => s.status).sort()).toEqual(
      ['power-converted', 'register', 'reverse-flow', 'supported'].sort(),
    );
    expect(g.notes.filter((n) => n.code === 'unsupported-series')).toHaveLength(2);
  });

  it('separates two UsagePoints and never lets one point’s rows into the other', () => {
    const xml = feed([
      { self: '/ReadingType/a', body: readingType({ ...energyRt }) },
      { self: '/ReadingType/b', body: readingType({ ...energyRt }) },
      { self: '/UsagePoint/up-A/MeterReading/mr-A', links: [['related', '/ReadingType/a']], body: '<espi:MeterReading/>' },
      { self: '/UsagePoint/up-B/MeterReading/mr-B', links: [['related', '/ReadingType/b']], body: '<espi:MeterReading/>' },
      {
        self: '/UsagePoint/up-A/MeterReading/mr-A/IntervalBlock/ib-A',
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 1000 }]),
      },
      {
        self: '/UsagePoint/up-B/MeterReading/mr-B/IntervalBlock/ib-B',
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 7000 }]),
      },
    ]);
    const { groups } = parseGreenButtonFeed(xml);
    expect(groups).toHaveLength(2);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g.readings]));
    expect(byId['up-A']).toEqual([{ timestamp: 1_700_000_000, usage_kwh: 1 }]);
    expect(byId['up-B']).toEqual([{ timestamp: 1_700_000_000, usage_kwh: 7 }]);
  });

  it('never nets an export series into the import stream', () => {
    const xml = feed([
      { self: '/ReadingType/in', body: readingType({ ...energyRt, fd: 1 }) },
      { self: '/ReadingType/out', body: readingType({ ...energyRt, fd: 19 }) },
      { self: '/UsagePoint/up/MeterReading/mr-in', links: [['related', '/ReadingType/in']], body: '<espi:MeterReading/>' },
      { self: '/UsagePoint/up/MeterReading/mr-out', links: [['related', '/ReadingType/out']], body: '<espi:MeterReading/>' },
      {
        self: '/UsagePoint/up/MeterReading/mr-in/IntervalBlock/ib',
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 3000 }]),
      },
      {
        self: '/UsagePoint/up/MeterReading/mr-out/IntervalBlock/ib',
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 5000 }]),
      },
    ]);
    const g = parseGreenButtonFeed(xml).groups[0];
    // 3 kWh imported and 5 kWh exported is NOT -2 kWh, and it is NOT 8 kWh.
    expect(g.readings.every((r) => r.usage_kwh === 3)).toBe(true);
    expect(g.readings).toHaveLength(1);
    const exported = g.series.find((s) => s.status === 'reverse-flow');
    expect(exported?.readings).toHaveLength(1);
    expect(exported?.readings[0].kwh).toBeNull();
  });
});

/* ==========================================================================
 * Commodity
 * ========================================================================== */

describe('commodity — gas and water never price as electricity', () => {
  it('refuses natural gas (commodity 7) and potable water (commodity 9)', () => {
    for (const [commodity, label] of [
      [7, 'naturalGas'],
      [9, 'potableWater'],
    ] as const) {
      const xml = simpleDoc({ uom: 72, mult: 3, kind: 12, ab: 4, commodity }, [
        { start: 1_700_000_000, value: 4 },
      ]);
      const { series, notes } = parse(xml);
      expect(series[0].status, label).toBe('other-commodity');
      expect(series[0].readings[0].kwh, label).toBeNull();
      expect(priced(xml)).toEqual([]);
      expect(notes.some((n) => n.code === 'unsupported-series')).toBe(true);
    }
  });

  it('prices a multi-commodity feed’s electricity series only', () => {
    const xml = feed([
      { self: '/ReadingType/elec', body: readingType({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, fd: 1 }) },
      { self: '/ReadingType/gas', body: readingType({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 7, fd: 1 }) },
      { self: '/UsagePoint/up/MeterReading/mr-e', body: '<espi:MeterReading/>' },
      { self: '/UsagePoint/up/MeterReading/mr-g', body: '<espi:MeterReading/>' },
      {
        self: '/UsagePoint/up/MeterReading/mr-e/IntervalBlock/ib',
        links: [['related', '/ReadingType/elec']],
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 2000 }]),
      },
      {
        self: '/UsagePoint/up/MeterReading/mr-g/IntervalBlock/ib',
        links: [['related', '/ReadingType/gas']],
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 9000 }]),
      },
    ]);
    expect(priced(xml)).toEqual([2]);
    const g = parseGreenButtonFeed(xml).groups[0];
    expect(g.series).toHaveLength(2);
    expect(g.series.filter((s) => s.status === 'supported')).toHaveLength(1);
  });
});

/* ==========================================================================
 * Accumulation
 * ========================================================================== */

describe('accumulation — registers are never summed as energy', () => {
  it('refuses a cumulative register (accumulationBehaviour 3) instead of adding it up', () => {
    const xml = simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 3, commodity: 1, fd: 1 }, [
      { start: 1_700_000_000, value: 100_000 },
      { start: 1_700_003_600, value: 101_000 },
    ]);
    const { series, notes } = parse(xml);
    expect(series[0].status).toBe('register');
    expect(priced(xml)).toEqual([]);
    expect(notes.find((n) => n.code === 'unsupported-series')?.detail).toMatch(/register/i);
  });

  it('refuses bulk quantity (1), continuous cumulative (2), latching (13) and bounded (14)', () => {
    for (const ab of [1, 2, 13, 14]) {
      const { series } = parse(simpleDoc({ uom: 72, mult: 0, kind: 12, ab, commodity: 1, fd: 1 }, [{ start: 1, value: 5 }]));
      expect(series[0].status, `ab=${ab}`).toBe('register');
    }
  });

  it('accepts deltaData (4) and summation (9), which ARE per-interval increments', () => {
    for (const ab of [4, 9]) {
      expect(classifySeries({ ...meta({ ab, uom: 72, mult: 0, commodity: 1, fd: 1 }) }).status, `ab=${ab}`).toBe(
        'supported',
      );
    }
  });

  it('refuses an indicating/instantaneous spot value (6, 12)', () => {
    for (const ab of [6, 12]) {
      expect(classifySeries({ ...meta({ ab, uom: 72, mult: 0, commodity: 1, fd: 1 }) }).status).toBe('spot');
    }
  });
});

/* ==========================================================================
 * Power
 * ========================================================================== */

describe('interval-average power', () => {
  it('converts W to energy with the interval duration — and says so', () => {
    const xml = simpleDoc({ uom: 38, mult: 0, kind: 37, ab: 4, commodity: 1, fd: 1, intervalLength: 3600 }, [
      { start: 1_700_000_000, value: 2000, duration: 3600 },
    ]);
    const { series, notes } = parse(xml);
    expect(series[0].status).toBe('power-converted');
    expect(series[0].readings[0].kwh).toBe(2); // 2000 W over 1 h
    expect(notes.some((n) => n.code === 'converted-to-energy')).toBe(true);
  });

  it('honours a 15-minute interval: 2000 W for 900 s is 0.5 kWh', () => {
    const { series } = parse(
      simpleDoc({ uom: 38, mult: 0, kind: 37, ab: 4, commodity: 1, fd: 1, intervalLength: 900 }, [
        { start: 1_700_000_000, value: 2000, duration: 900 },
      ]),
    );
    expect(series[0].readings[0].kwh).toBe(0.5);
  });

  it('refuses power with no known interval rather than inventing one', () => {
    const { series } = parse(
      simpleDoc({ uom: 38, mult: 0, kind: 37, ab: 4, commodity: 1, fd: 1 }, [
        { start: 1_700_000_000, value: 2000 },
      ]),
    );
    expect(series[0].status).toBe('unconvertible');
  });

  it('refuses a demand series (kind 8) carrying an energy unit as contradictory metadata', () => {
    expect(classifySeries({ ...meta({ uom: 72, mult: 0, kind: 8, ab: 4, commodity: 1, fd: 1 }) }).status).toBe(
      'other-quantity',
    );
  });

  it('refuses VA and VAr', () => {
    for (const uom of [61, 63]) {
      expect(classifySeries({ ...meta({ uom, mult: 0, kind: 37, ab: 4, commodity: 1, fd: 1, intervalLength: 3600 }) }).status).toBe(
        'other-quantity',
      );
    }
  });
});

/* ==========================================================================
 * Bad and unknown metadata
 * ========================================================================== */

describe('invalid and unknown metadata is refused, never guessed', () => {
  it('refuses a uom the schema does not define', () => {
    const { series } = parse(simpleDoc({ uom: 9999, mult: 0, kind: 12, ab: 4, commodity: 1 }, [{ start: 1, value: 5 }]));
    expect(series[0].status).toBe('other-quantity');
    expect(series[0].detail).toMatch(/undefined by the schema/);
  });

  it('refuses "code" / "sec" units — a quantity that is not energy at all', () => {
    for (const uom of [114, 27]) {
      expect(classifySeries({ ...meta({ uom, mult: 0, ab: 4, commodity: 1 }) }).status, `uom=${uom}`).toBe(
        'other-quantity',
      );
    }
  });

  it('drops a negative value in a forward energy series and counts it', () => {
    const xml = simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, fd: 1 }, [
      { start: 1_700_000_000, value: 1500 },
      { start: 1_700_003_600, value: -1500 },
    ]);
    const { series, notes } = parse(xml);
    expect(series[0].readings).toHaveLength(1);
    expect(series[0].dropped.negative).toBe(1);
    expect(notes.some((n) => n.code === 'refused-readings')).toBe(true);
    expect(priced(xml)).toEqual([1.5]);
  });

  it('drops a non-numeric value and a zero timestamp instead of poisoning totals with NaN', () => {
    const xml = simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, fd: 1 }, [
      { start: 1_700_000_000, value: 'nope' },
      { start: 0, value: 1000 },
      { start: 1_700_003_600, value: 2000 },
    ]);
    const { series } = parse(xml);
    expect(series[0].dropped.unparsable).toBe(2);
    expect(series[0].readings).toHaveLength(1);
    expect(priced(xml)).toEqual([2]);
  });

  it('refuses net (4) and total (20) directions, which combine import and export', () => {
    for (const fd of [4, 20, 15]) {
      expect(classifySeries({ ...meta({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, fd }) }).status, `fd=${fd}`).toBe(
        'combined-flow',
      );
    }
  });
});

/* ==========================================================================
 * Graph resolution: order, hrefs, link direction
 * ========================================================================== */

describe('graph resolution', () => {
  const rt = { uom: 72, mult: 3, kind: 12, ab: 4, commodity: 1, fd: 1 } as const;
  const readings = [{ start: 1_700_000_000, value: 4 }];

  it('gives identical readings from relative and absolute hrefs', () => {
    const rel = simpleDoc({ ...rt }, readings);
    const abs = simpleDoc({ ...rt }, readings, { absolute: true });
    expect(priced(abs)).toEqual(priced(rel));
    const a = parse(abs).series[0];
    const r = parse(rel).series[0];
    expect([a.usagePointId, a.meterReadingId, a.readingTypeId]).toEqual([
      r.usagePointId,
      r.meterReadingId,
      r.readingTypeId,
    ]);
  });

  it('gives identical readings whatever order the entries appear in', () => {
    const xml = simpleDoc({ ...rt }, readings);
    const entries = (xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []);
    expect(entries).toHaveLength(3);
    let i = 0;
    const reversed = xml.replace(/<entry>[\s\S]*?<\/entry>/g, () => entries[entries.length - 1 - i++]);
    expect(priced(reversed)).toEqual(priced(xml));
    const fwd = parse(xml);
    const rev = parse(reversed);
    expect(rev.series[0].key).toBe(fwd.series[0].key);
    expect(rev.series[0].meta.uom).toBe(fwd.series[0].meta.uom);
  });

  it('resolves the ReadingType when only the ReadingType side names its MeterReading', () => {
    const xml = feed([
      {
        self: '/ReadingType/rt-9',
        links: [['related', '/UsagePoint/up-9/MeterReading/mr-9']],
        body: readingType({ ...rt }),
      },
      { self: '/UsagePoint/up-9/MeterReading/mr-9', body: '<espi:MeterReading/>' },
      {
        self: '/UsagePoint/up-9/MeterReading/mr-9/IntervalBlock/ib-9',
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 4 }]),
      },
    ]);
    const { series } = parse(xml);
    expect(series[0].status).toBe('supported');
    expect(series[0].readingTypeId).toBe('rt-9');
    expect(priced(xml)).toEqual([4]);
  });

  it('preserves every ReadingType field on the series, unmodified', () => {
    const { series } = parse(simpleDoc({ ...rt }, [{ start: 1_700_000_000, value: 4 }]));
    expect(series[0].readingTypeId).toBe('1');
    expect(series[0].meta.uom).toBe(72);
    expect(series[0].meta.powerOfTenMultiplier).toBe(3);
    expect(series[0].meta.accumulationBehaviour).toBe(4);
    expect(series[0].meta.commodity).toBe(1);
    expect(series[0].meta.flowDirection).toBe(1);
    expect(series[0].meta.kind).toBe(12);
    expect(series[0].meta.assumed).toBe(false);
    expect(series[0].meta.unresolved).toBe(false);
  });

  it('applies a document’s only ReadingType when no entry links it, and announces it', () => {
    const xml = feed([
      { self: '/ReadingType/1', body: readingType({ uom: 72, mult: 3, kind: 12, ab: 4, commodity: 1 }) },
      {
        self: '/UsagePoint/up/MeterReading/mr/IntervalBlock/ib',
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 4 }]),
      },
    ]);
    const { series, notes } = parse(xml);
    expect(series[0].status).toBe('supported');
    expect(series[0].unlinked).toBe(true);
    expect(priced(xml)).toEqual([priced(simpleDoc({ uom: 72, mult: 3, kind: 12, ab: 4, commodity: 1 }, [{ start: 1_700_000_000, value: 4 }]))[0]]);
    expect(notes.some((n) => n.code === 'unlinked-reading-type')).toBe(true);
  });

  it('refuses rather than guesses when several ReadingTypes exist and none is linked', () => {
    const xml = feed([
      { self: '/ReadingType/1', body: readingType({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1 }) },
      { self: '/ReadingType/2', body: readingType({ uom: 72, mult: 3, kind: 12, ab: 4, commodity: 1 }) },
      {
        self: '/UsagePoint/up/MeterReading/mr/IntervalBlock/ib',
        body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 4000 }]),
      },
    ]);
    const { series } = parse(xml);
    expect(series[0].status).toBe('unresolved-reading-type');
    expect(priced(xml)).toEqual([]);
    expect(series[0].readings[0].kwh).toBeNull();
  });

  it('splits several inline ReadingTypes in one entry instead of applying one to the other', () => {
    const xml = feed([
      {
        self: '/UsagePoint/up/MeterReading/mr',
        body: `<espi:MeterReading>${readingType({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1 })}${readingType({ uom: 38, mult: 0, kind: 37, ab: 4, commodity: 1, fd: 1, intervalLength: 3600 })}${block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 1500 }])}</espi:MeterReading>`,
      },
    ]);
    const { series, notes } = parse(xml);
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series.every((s) => s.readings.every((r) => r.kwh === null))).toBe(true);
    expect(priced(xml)).toEqual([]);
    expect(notes.some((n) => n.code === 'ambiguous-inline-reading-types')).toBe(true);
  });
});

/* ==========================================================================
 * Legacy compatibility path
 * ========================================================================== */

describe('legacy compatibility path', () => {
  it('reads a document with no ReadingType at all as Wh and announces the assumption', () => {
    const xml = feed([{ body: block(1_700_000_000, 3600, [{ start: 1_700_000_000, value: 273 }]) }]);
    const { series, notes } = parse(xml);
    expect(series[0].legacy).toBe(true);
    expect(priced(xml)).toEqual([0.273]);
    const note = notes.find((n) => n.code === 'legacy-assumption');
    expect(note).toBeDefined();
    expect(note?.detail).toMatch(/watt-hours/);
    expect(note?.detail).toMatch(/assumption/);
  });

  it('announces the assumption for a ReadingType that omits uom but declares a multiplier', () => {
    const xml = simpleDoc({ mult: -1 }, [{ start: 1_700_000_000, value: 25000 }]);
    const { series, notes } = parse(xml);
    expect(series[0].legacy).toBe(false);
    expect(priced(xml)).toEqual([2.5]);
    expect(notes.find((n) => n.code === 'legacy-assumption')?.detail).toMatch(/declares no uom/);
  });

  it('announces an absent flowDirection instead of pretending it was stated', () => {
    const xml = simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1 }, [{ start: 1_700_000_000, value: 1500 }]);
    const { notes } = parse(xml);
    expect(notes.some((n) => n.code === 'assumed-direction')).toBe(true);
    expect(priced(xml)).toEqual([1.5]);
  });

  it('keeps a units-free fragment’s readings working (Alectra-shaped)', () => {
    const xml = `<?xml version="1.0"?><feed><IntervalReading><timePeriod><duration>3600</duration><start>1784638800</start></timePeriod><value>2290000</value></IntervalReading></feed>`;
    const { series } = parse(xml);
    expect(series[0].legacy).toBe(true);
    expect(series[0].readings[0].kwh).toBe(2290);
    expect(series[0].readings[0].duration_s).toBe(3600);
  });
});

/* ==========================================================================
 * UTC identity through DST
 * ========================================================================== */

describe('UTC identity through DST transitions', () => {
  /**
   * America/Toronto 2026: spring forward Sun 8 Mar (local day = 23 h), fall
   * back Sun 1 Nov (local day = 25 h). ESPI timestamps are epoch SECONDS, so
   * the parser must hand back instants exactly 3600 s apart across both, and
   * must not turn fewer/more local hours into fewer/more readings.
   */
  const springStart = 1772953200; // 2026-03-08T02:00:00-05:00 == 07:00Z
  const fallStart = 1793509200; // 2026-11-01T01:00:00-04:00 == 05:00Z

  it('keeps 23 local hours of spring-forward data as 23 one-hour readings 3600 s apart', () => {
    const rows: Reading[] = Array.from({ length: 23 }, (_, i) => ({
      start: springStart + i * 3600,
      value: 1000,
      duration: 3600,
    }));
    const xml = simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, intervalLength: 3600 }, rows, {
      blockDuration: 82800,
    });
    const { series } = parse(xml);
    const r = series[0].readings;
    expect(r).toHaveLength(23);
    for (let i = 1; i < r.length; i++) expect(r[i].timestamp - r[i - 1].timestamp).toBe(3600);
    expect(r[0].timestamp).toBe(springStart);
    expect(new Date(r[0].timestamp * 1000).toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('keeps 25 local hours of fall-back data as 25 readings with no invented hour', () => {
    const rows: Reading[] = Array.from({ length: 25 }, (_, i) => ({
      start: fallStart + i * 3600,
      value: 1000,
      duration: 3600,
    }));
    const xml = simpleDoc({ uom: 72, mult: 0, kind: 12, ab: 4, commodity: 1, intervalLength: 3600 }, rows, {
      blockDuration: 90000,
    });
    const { series } = parse(xml);
    const r = series[0].readings;
    expect(r).toHaveLength(25);
    for (let i = 1; i < r.length; i++) expect(r[i].timestamp - r[i - 1].timestamp).toBe(3600);
    // The repeated local 01:00 is two distinct instants, an hour apart.
    const local = r.map((x) => new Date(x.timestamp * 1000).toISOString());
    expect(local[0]).toBe('2026-11-01T05:00:00.000Z');
    expect(local[1]).toBe('2026-11-01T06:00:00.000Z');
    expect(r.every((x) => x.duration_s === 3600)).toBe(true);
  });
});

/* ==========================================================================
 * classifySeries — direct unit pins
 * ========================================================================== */

/** Short spec: `ab`/`mult` are spelled as the ESPI element names read. */
type MetaSpec = Omit<
  Partial<SeriesMetadata>,
  'accumulationBehaviour' | 'powerOfTenMultiplier' | 'flowDirection'
> & {
  ab?: number | null;
  mult?: number | null;
  fd?: number | null;
};

function meta(o: MetaSpec): SeriesMetadata {
  const { ab, mult, fd, ...rest } = o;
  return {
    uom: null,
    powerOfTenMultiplier: mult ?? null,
    accumulationBehaviour: ab ?? null,
    commodity: null,
    flowDirection: fd ?? null,
    kind: null,
    dataQualifier: null,
    defaultQuality: null,
    intervalLength: null,
    assumed: false,
    unresolved: false,
    ...rest,
  };
}

describe('classifySeries — the decision table', () => {
  it('names the status of every refusal so a diagnostic can say why', () => {
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 4, commodity: 1, fd: 1 }))).toEqual({ status: 'supported', reason: null });
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 3, commodity: 1, fd: 1 })).reason).toMatch(/register/);
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 4, commodity: 7, fd: 1 })).reason).toMatch(/non-electricity/);
    expect(classifySeries(meta({ uom: 73, mult: 0, ab: 4, commodity: 1, fd: 1 })).reason).toMatch(/reactive/);
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 4, commodity: 1, fd: 19 })).reason).toMatch(/exported/);
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 4, commodity: 1, fd: 4 })).reason).toMatch(/directions/);
  });

  it('treats an unspecified commodity as electricity but a specified other one as not', () => {
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 4, commodity: null })).status).toBe('supported');
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 4, commodity: 0 })).status).toBe('supported');
    expect(classifySeries(meta({ uom: 72, mult: 0, ab: 4, commodity: 3 })).status).toBe('other-commodity');
  });
});
