/**
 * Wave G item 4 — tolerant parsing, tested against REAL utility exports.
 *
 * Fixtures live in webapp/tests/fixtures (see its README for provenance):
 * genuine Hydro One + Toronto Hydro Download-My-Data exports, an
 * espi:-prefixed Green Button Connect feed, the Green Button Alliance sample,
 * and a genuine Alectra IntervalReading fragment.
 *
 * What must hold for any of them:
 *   - namespace prefixes are irrelevant (`espi:` present or absent),
 *   - entry order in the feed is irrelevant,
 *   - every reading is finite, scaled to real kWh and sorted,
 *   - a document that fails explains WHY (parseDiagnostic.test.ts).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGreenButtonUsagePoints, combineUsagePointGroups } from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

type Fixture = {
  file: string;
  utility: string;
  groups: number;
  groupIdPrefix: string;
  readings: number;
  firstTs: number;
  firstKwh: number;
};

const FIXTURES_UNDER_TEST: Fixture[] = [
  {
    file: 'utility-hydro-one.xml',
    utility: 'Hydro One (real DMD export, no espi: prefix, powerOfTenMultiplier -3)',
    groups: 1,
    groupIdPrefix: 'J2648788',
    readings: 48,
    firstTs: 1765170000,
    firstKwh: 3.9546,
  },
  {
    file: 'utility-toronto-hydro.xml',
    utility: 'Toronto Hydro (real DMD export, 15-minute intervals, no espi: prefix)',
    groups: 1,
    groupIdPrefix: '',
    readings: 96,
    firstTs: 1685595600,
    firstKwh: 0.489,
  },
  {
    file: 'utility-espi-prefixed-standin.xml',
    utility: 'Green Button Connect feed (espi: prefixes throughout, daily intervals)',
    groups: 1,
    groupIdPrefix: '58612fc14edd',
    readings: 514,
    firstTs: 1541221200,
    firstKwh: 34,
  },
  {
    file: 'green-button-alliance-sample.xml',
    utility: 'Green Button Alliance canonical sample (216 hourly readings)',
    groups: 1,
    groupIdPrefix: '2',
    readings: 216,
    firstTs: 1388552400,
    firstKwh: 0.273,
  },
];

describe.each(FIXTURES_UNDER_TEST)('$utility', (fx) => {
  const groups = () => parseGreenButtonUsagePoints(read(fx.file));

  it('parses into one group with the expected readings', () => {
    const parsed = groups();
    expect(parsed).toHaveLength(fx.groups);
    expect(parsed[0].id.startsWith(fx.groupIdPrefix)).toBe(true);

    const all = combineUsagePointGroups(parsed);
    expect(all).toHaveLength(fx.readings);
    expect(all[0]).toEqual({ timestamp: fx.firstTs, usage_kwh: fx.firstKwh });
  });

  it('produces finite, non-negative, sorted readings', () => {
    const all = combineUsagePointGroups(groups());
    for (let i = 0; i < all.length; i++) {
      expect(Number.isFinite(all[i].timestamp)).toBe(true);
      expect(Number.isFinite(all[i].usage_kwh)).toBe(true);
      expect(all[i].usage_kwh).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(all[i].timestamp).toBeGreaterThanOrEqual(all[i - 1].timestamp);
    }
  });

  it('scales values by the ReadingType powerOfTenMultiplier (no 1000x drift)', () => {
    const all = combineUsagePointGroups(groups());
    // A house never draws thousands of kWh in an interval: without applying
    // powerOfTenMultiplier this assertion is what catches the bug.
    const max = Math.max(...all.map((r) => r.usage_kwh));
    expect(max).toBeLessThan(500);
    expect(max).toBeGreaterThan(0);
  });

  it('does not depend on the order entries appear in the feed', () => {
    const xml = read(fx.file);
    const entryRe = /<entry[\s\S]*?<\/entry>/g;
    const entries = xml.match(entryRe);
    if (!entries || entries.length < 2) return; // single-entry feeds have nothing to reorder
    const shuffled = [...entries].reverse();
    let i = 0;
    const reordered = xml.replace(entryRe, () => shuffled[i++]);
    // Canonical form: this feed carries duplicate timestamps (several rate
    // blocks for one UsagePoint), and a stable sort preserves insertion
    // order among equals — so compare as a multiset, which is the actual
    // contract ("order of entries must not change what you load").
    const canonical = (xmlText: string) =>
      combineUsagePointGroups(parseGreenButtonUsagePoints(xmlText)).sort(
        (a, b) => a.timestamp - b.timestamp || a.usage_kwh - b.usage_kwh,
      );
    expect(canonical(reordered)).toEqual(canonical(xml));
  });
});

/* ------------------------------------------------------------------------ */

describe('genuine Alectra IntervalReading fragment', () => {
  it('loads its single reading (documented limitation: a fragment has no feed)', () => {
    const parsed = parseGreenButtonUsagePoints(read('utility-alectra-fragment.xml'));
    const all = combineUsagePointGroups(parsed);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ timestamp: 1784638800, usage_kwh: 2290 });
    // Alectra's real child order (cost, ReadingQuality, timePeriod, value,
    // tou) survives parsing — no assumption about element order.
  });
});

describe('namespace-prefix independence', () => {
  /** Same document twice: once with bare tags, once with espi: on every ESPI tag. */
  function feed(prefixed: boolean): string {
    const p = (tag: string) => (prefixed ? `espi:${tag}` : tag);
    const ns = prefixed ? ' xmlns:espi="http://naesb.org/espi"' : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"${ns}>
  <entry>
    <link href="https://utility.example/UsagePoint/aaaa-1111/MeterReading/m1/IntervalBlock/b1" rel="self"/>
    <content>
      <${p('IntervalBlock')}>
        <${p('IntervalReading')}>
          <${p('timePeriod')}><${p('start')}>1704067200</${p('start')}><${p('duration')}>3600</${p('duration')}></${p('timePeriod')}>
          <${p('value')}>1500</${p('value')}>
        </${p('IntervalReading')}>
        <${p('IntervalReading')}>
          <${p('timePeriod')}><${p('start')}>1704070800</${p('start')}></${p('timePeriod')}>
          <${p('value')}>2250</${p('value')}>
        </${p('IntervalReading')}>
      </${p('IntervalBlock')}>
    </content>
  </entry>
</feed>`;
  }

  it('yields identical readings with and without espi: prefixes', () => {
    const bare = combineUsagePointGroups(parseGreenButtonUsagePoints(feed(false)));
    const prefixed = combineUsagePointGroups(parseGreenButtonUsagePoints(feed(true)));
    expect(bare).toEqual(prefixed);
    expect(bare).toEqual([
      { timestamp: 1704067200, usage_kwh: 1.5 },
      { timestamp: 1704070800, usage_kwh: 2.25 },
    ]);
  });

  it('handles both shapes as they appear in real utility exports', () => {
    // Toronto Hydro / Hydro One: no prefix. Green Button Connect: prefixed.
    expect(combineUsagePointGroups(parseGreenButtonUsagePoints(read('utility-toronto-hydro.xml'))).length).toBe(96);
    expect(combineUsagePointGroups(parseGreenButtonUsagePoints(read('utility-espi-prefixed-standin.xml'))).length).toBe(514);
  });
});

describe('entry-order tolerance', () => {
  it('groups readings under the same UsagePoint regardless of link/entry position', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link href="https://u.example/UsagePoint/up-1/MeterReading/m/IntervalBlock/b" rel="self"/>
    <content><IntervalBlock>
      <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1000</value></IntervalReading>
    </IntervalBlock></content>
  </entry>
  <entry>
    <id>usage-point-entry</id>
    <link href="https://u.example/UsagePoint/up-1" rel="self"/>
  </entry>
  <entry>
    <link href="https://u.example/UsagePoint/up-1/MeterReading/m/IntervalBlock/b" rel="self"/>
    <content><IntervalBlock>
      <IntervalReading><timePeriod><start>1704070800</start></timePeriod><value>2000</value></IntervalReading>
    </IntervalBlock></content>
  </entry>
</feed>`;

    const forward = parseGreenButtonUsagePoints(xml);
    expect(forward).toHaveLength(1);
    expect(forward[0].id).toBe('up-1');
    expect(combineUsagePointGroups(forward)).toEqual([
      { timestamp: 1704067200, usage_kwh: 1 },
      { timestamp: 1704070800, usage_kwh: 2 },
    ]);

    // Reverse the three entries: same result, same order of readings.
    const entries = xml.match(/<entry[\s\S]*?<\/entry>/g)!;
    const reversed = xml.replace(/<entry[\s\S]*?<\/entry>/g, () => entries.pop()!);
    const backward = parseGreenButtonUsagePoints(reversed);
    expect(combineUsagePointGroups(backward)).toEqual(combineUsagePointGroups(forward));
    expect(backward[0].id).toBe('up-1');
  });
});

describe('powerOfTenMultiplier resolution', () => {
  it('uses the multiplier linked from the IntervalBlock entry (−3 → /1000 again)', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link href="https://u.example/ReadingType/3" rel="self"/>
    <content><ReadingType><powerOfTenMultiplier>-3</powerOfTenMultiplier><uom>72</uom></ReadingType></content>
  </entry>
  <entry>
    <link href="https://u.example/UsagePoint/up-1/MeterReading/m/IntervalBlock/b" rel="self"/>
    <link href="https://u.example/ReadingType/3" rel="related"/>
    <content><IntervalBlock>
      <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>3954600</value></IntervalReading>
    </IntervalBlock></content>
  </entry>
</feed>`;
    expect(combineUsagePointGroups(parseGreenButtonUsagePoints(xml))[0].usage_kwh).toBeCloseTo(3.9546, 6);
  });

  it('applies a single document-wide multiplier when no link identifies one', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><content><ReadingType><powerOfTenMultiplier>-1</powerOfTenMultiplier></ReadingType></content></entry>
  <entry><content><IntervalBlock>
    <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>25000</value></IntervalReading>
  </IntervalBlock></content></entry>
</feed>`;
    expect(combineUsagePointGroups(parseGreenButtonUsagePoints(xml))[0].usage_kwh).toBeCloseTo(2.5, 6);
  });

  it('ignores multipliers declared on summary measurements (Oakville-shaped feed)', () => {
    // Oakville Hydro's real export stamps powerOfTenMultiplier -6 on
    // <measurement> elements inside ElectricPowerUsageSummary. Those are
    // summary scalers — applying them to interval readings turns a 3.5 kWh
    // hour into 0.0000035 kWh.
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry>
    <link href="https://u.example/UsagePoint/up-9" rel="self"/>
    <content><espi:ElectricPowerUsageSummary>
      <espi:costAdditionalDetailLastPeriod>
        <espi:measurement>
          <espi:powerOfTenMultiplier>-6</espi:powerOfTenMultiplier>
          <espi:uom>72</espi:uom>
          <espi:value>478940000</espi:value>
        </espi:measurement>
      </espi:costAdditionalDetailLastPeriod>
    </espi:ElectricPowerUsageSummary></content>
  </entry>
  <entry>
    <link href="https://u.example/UsagePoint/up-9/MeterReading/m/IntervalBlock/b" rel="self"/>
    <content><espi:IntervalBlock>
      <espi:IntervalReading>
        <espi:timePeriod><espi:start>1782968400</espi:start></espi:timePeriod>
        <espi:value>3500</espi:value>
      </espi:IntervalReading>
    </espi:IntervalBlock></content>
  </entry>
</feed>`;
    const all = combineUsagePointGroups(parseGreenButtonUsagePoints(xml));
    expect(all).toEqual([{ timestamp: 1782968400, usage_kwh: 3.5 }]);
  });

  it('leaves readings unscaled when the document declares no multiplier', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><content><IntervalBlock>
    <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading>
  </IntervalBlock></content></entry>
</feed>`;
    expect(combineUsagePointGroups(parseGreenButtonUsagePoints(xml))[0].usage_kwh).toBe(1.5);
  });
});
