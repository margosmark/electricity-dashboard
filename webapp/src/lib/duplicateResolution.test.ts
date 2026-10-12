/**
 * Duplicate-resolution guard — one UsagePoint, the same consumption at
 * 15/30/60 minutes (t_1fca89fa, QA acceptance F-02).
 *
 * A custodian may publish one day's consumption more than once: as 16×15-min
 * readings, again as 8×30-min and again as 4×60-min. Series isolation already
 * keeps those three apart per (UsagePoint, MeterReading, ReadingType) — each
 * carries its own 4.0 kWh and its own interval length — but the group's
 * billable stream used to be their UNION, so the day was summed to 12.0 kWh,
 * stored as 28 points and shown as "12 KWH". That is the same physical energy
 * priced three times, and the "combined-series" note that recorded the merge
 * never reached the dashboard's refusal row (a single-UsagePoint file never
 * renders the picker that carried it).
 *
 * These tests pin the contract on the parser surface the app, the picker and
 * the QA probe all read: `groups[].readings`, the series, and `feed.notes`.
 *
 * Run: `npx vitest run src/lib/duplicateResolution.test.ts`
 */

import { describe, it, expect } from 'vitest';
import { parseGreenButtonFeed, type UsagePointGroup } from './energy';

/* ==========================================================================
 * The QA fixture's own shape, rebuilt inline (no private XML)
 * ========================================================================== */

/** 2025-11-01T10:00:00Z — the first interval of the QA corpus' F-02 document. */
const START = 1762005600;
const NS = 'https://sandbox.example.com/DataCustodian/espi/1_1/resource';

type Meter = {
  /** MeterReading id — also the ReadingType id, as the fixture encodes it. */
  mr: string;
  /** Every reading's own duration, in seconds. */
  step: number;
  count: number;
  /** Value as published (uom 72 = Wh, multiplier 0). */
  wh: number;
  /** Interval start of this series' first reading (defaults to START). */
  start?: number;
};

/** One ReadingType + MeterReading + IntervalBlock per series, all under one UsagePoint. */
function seriesEntries(up: string, meters: Meter[]): string[] {
  const out: string[] = [];
  for (const m of meters) {
    out.push(
      `<entry><link rel="self" href="${NS}/ReadingType/${m.mr}"/><content><espi:ReadingType>` +
        `<espi:accumulationBehaviour>4</espi:accumulationBehaviour><espi:commodity>1</espi:commodity>` +
        `<espi:dataQualifier>12</espi:dataQualifier><espi:flowDirection>1</espi:flowDirection>` +
        `<espi:intervalLength>${m.step}</espi:intervalLength><espi:kind>12</espi:kind>` +
        `<espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:uom>72</espi:uom>` +
        `</espi:ReadingType></content></entry>`,
    );
    out.push(
      `<entry><link rel="self" href="${NS}/UsagePoint/${up}/MeterReading/${m.mr}"/>` +
        `<link rel="related" href="${NS}/ReadingType/${m.mr}"/>` +
        `<content><espi:MeterReading/></content></entry>`,
    );
    const from = m.start ?? START;
    const readings = Array.from(
      { length: m.count },
      (_, i) =>
        `<espi:IntervalReading><espi:timePeriod><espi:duration>${m.step}</espi:duration>` +
        `<espi:start>${from + i * m.step}</espi:start></espi:timePeriod>` +
        `<espi:value>${m.wh}</espi:value></espi:IntervalReading>`,
    ).join('');
    out.push(
      `<entry><link rel="self" href="${NS}/UsagePoint/${up}/MeterReading/${m.mr}/IntervalBlock/ib-${m.mr}"/>` +
        `<content><espi:IntervalBlock><espi:interval><espi:duration>${m.step * m.count}</espi:duration>` +
        `<espi:start>${from}</espi:start></espi:interval>${readings}</espi:IntervalBlock></content></entry>`,
    );
  }
  return out;
}

function doc(parts: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">\n` +
    `${parts.join('\n')}\n</feed>`
  );
}

/** The F-02 document: one 4.0 kWh day published at three resolutions. */
const F02 = doc(
  seriesEntries('4', [
    { mr: '4', step: 900, count: 16, wh: 250 }, // 16 × 15 min = 4.0 kWh
    { mr: '5', step: 1800, count: 8, wh: 500 }, // 8 × 30 min = 4.0 kWh
    { mr: '6', step: 3600, count: 4, wh: 1000 }, // 4 × 60 min = 4.0 kWh
  ]),
);

const kwhTotal = (g: UsagePointGroup): number =>
  g.readings.reduce((sum, r) => sum + r.usage_kwh, 0);
const combinedNotes = (notes: { code: string; detail: string }[]): string[] =>
  notes.filter((n) => n.code === 'combined-series').map((n) => n.detail);

/* ==========================================================================
 * The defect
 * ========================================================================== */

describe('one UsagePoint publishing the same day at 15/30/60 minutes', () => {
  it('prices the day ONCE — 4.0 kWh, not 12.0', () => {
    const group = parseGreenButtonFeed(F02).groups[0];
    expect(group.readings).toHaveLength(16);
    expect(kwhTotal(group)).toBeCloseTo(4, 6);
    // The finest series is the one priced, its own intervals intact.
    expect(group.readings[0]).toEqual({ timestamp: START, usage_kwh: 0.25 });
  });

  it('keeps every series intact — isolation is untouched', () => {
    const group = parseGreenButtonFeed(F02).groups[0];
    expect(group.series).toHaveLength(3);
    const byStep = Object.fromEntries(
      group.series.map((s) => [s.meta.intervalLength, s.readings.length]),
    );
    expect(byStep).toEqual({ 900: 16, 1800: 8, 3600: 4 });
    for (const s of group.series) {
      const sum = s.readings.reduce((n, r) => n + (r.kwh ?? 0), 0);
      expect(sum).toBeCloseTo(4, 6);
      expect(s.status).toBe('supported');
    }
  });

  it('says what it did: the note names all three series and the one priced', () => {
    const feed = parseGreenButtonFeed(F02);
    const details = combinedNotes(feed.notes);
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('4 · 4 · Wh (uom 72)'); // priced (finest)
    expect(details[0]).toContain('4 · 5 · Wh (uom 72)'); // refused
    expect(details[0]).toContain('4 · 6 · Wh (uom 72)'); // refused
    expect(details[0]).toContain('12 reading(s)'); // 8 (30-min) + 4 (60-min)
    expect(details[0]).toContain('only the finest series (4 · 4 · Wh (uom 72)) was priced');
    // The same sentence is on the group, where the picker prints it.
    expect(feed.groups[0].notes.map((n) => n.detail)).toContain(details[0]);
  });

  it('is order-independent — shuffling the entries changes nothing', () => {
    const reversed = doc([...seriesEntries('4', [
      { mr: '4', step: 900, count: 16, wh: 250 },
      { mr: '5', step: 1800, count: 8, wh: 500 },
      { mr: '6', step: 3600, count: 4, wh: 1000 },
    ])].reverse());
    const group = parseGreenButtonFeed(reversed).groups[0];
    expect(group.readings).toHaveLength(16);
    expect(kwhTotal(group)).toBeCloseTo(4, 6);
  });
});

/* ==========================================================================
 * What the guard must NOT change
 * ========================================================================== */

describe('the guard only fires on genuinely overlapping energy', () => {
  it('adds second-resolution history that continues where the first stops', () => {
    // 4 × 15-min for the first hour, then 1 × 60-min for the next: the two
    // series ABUT and never cover the same instant, so both are real energy
    // and both are priced (nothing is dropped to make a total look cleaner).
    const xml = doc(
      seriesEntries('4', [
        { mr: '4', step: 900, count: 4, wh: 250 },
        { mr: '6', step: 3600, count: 1, wh: 1000, start: START + 3600 },
      ]),
    );
    const feed = parseGreenButtonFeed(xml);
    const group = feed.groups[0];
    expect(group.readings).toHaveLength(5);
    expect(kwhTotal(group)).toBeCloseTo(2, 6);
    expect(combinedNotes(feed.notes).join(' ')).not.toContain('overlapping periods');
  });

  it('keeps a coarser series’ readings that lie OUTSIDE the finer one', () => {
    // The 15-min series covers one hour; the 60-min series covers four. Only
    // the first hour is duplicated, so only that reading is refused — the other
    // three are the only source for their hours and stay priced.
    const xml = doc(
      seriesEntries('4', [
        { mr: '4', step: 900, count: 4, wh: 250 }, // 1.0 kWh over [START, +1h)
        { mr: '6', step: 3600, count: 4, wh: 1000 }, // 4.0 kWh over [START, +4h)
      ]),
    );
    const feed = parseGreenButtonFeed(xml);
    const group = feed.groups[0];
    expect(kwhTotal(group)).toBeCloseTo(4, 6); // 1.0 + the 3 hours only it has
    expect(group.readings).toHaveLength(7);
    const detail = combinedNotes(feed.notes).join(' ');
    expect(detail).toContain('the 1 reading(s) of the others that fall inside its coverage were refused');
    expect(detail).toContain('The 3 reading(s) of theirs that lie outside that coverage were still priced');
  });

  it('prices a series declared twice at the SAME resolution once', () => {
    // Two MeterReadings, same quantity, identical instants: which of them the
    // custodian means is not stated, and adding them would double the day.
    const xml = doc(
      seriesEntries('4', [
        { mr: '4', step: 900, count: 4, wh: 250 },
        { mr: '5', step: 900, count: 4, wh: 250 },
      ]),
    );
    const feed = parseGreenButtonFeed(xml);
    expect(kwhTotal(feed.groups[0])).toBeCloseTo(1, 6);
    expect(combinedNotes(feed.notes)).toHaveLength(1);
  });

  it('leaves a single-series point exactly as it was', () => {
    const xml = doc(seriesEntries('4', [{ mr: '4', step: 900, count: 16, wh: 250 }]));
    const feed = parseGreenButtonFeed(xml);
    expect(feed.groups[0].readings).toHaveLength(16);
    expect(kwhTotal(feed.groups[0])).toBeCloseTo(4, 6);
    expect(feed.notes).toEqual([]);
  });

  it('never merges across UsagePoints (the F-01 multi-meter case)', () => {
    // Same day, same quantity, two DIFFERENT points: 12.5 kWh each, and the
    // totals add because the meters are different services. The guard is
    // per-point, so both survive in full.
    const xml = doc([
      ...seriesEntries('up-A', [{ mr: '4', step: 900, count: 4, wh: 3125 }]),
      ...seriesEntries('up-B', [{ mr: '4', step: 900, count: 4, wh: 3125 }]),
    ]);
    const feed = parseGreenButtonFeed(xml);
    expect(feed.groups).toHaveLength(2);
    expect(feed.groups.map(kwhTotal)).toEqual([12.5, 12.5]);
  });
});
