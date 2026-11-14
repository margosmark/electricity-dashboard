/**
 * Gas usage vs outdoor temperature — the arithmetic, pinned (t_909aa5fa).
 *
 * `lib/gasTempBands.ts` is the pure half of the gas TempBandCard, and every
 * number the card prints is produced here first: interval mean temperatures,
 * the seven shared bins, m³/day, shares, coverage, and the two honest drop
 * counters. The tests hand-compute each expectation from the fixture's own
 * figures — the math is the specification, no hidden heuristics.
 *
 * Run: `npx vitest run src/lib/gasTempBands.test.ts`
 */
import { describe, it, expect } from 'vitest';

import type { GasPoint } from './storage';
import type { UsageSummary } from './energy';
import type { HourlyTemps } from './openMeteo';
import {
  buildGasTempBandReport,
  gasTempBandEmpty,
  gasTempSource,
  gasTempSpanRows,
} from './gasTempBands';

const DAY = 86_400;
const HOUR = 3_600;
/** 2026-01-05T00:00:00Z — a plain, round instant to hang fixtures on. */
const JAN5 = Date.UTC(2026, 0, 5) / 1000;
const JUL5 = Date.UTC(2026, 6, 5) / 1000;
const JAN1 = Date.UTC(2026, 0, 1) / 1000;

const point = (timestamp: number, volume_m3: number, duration_s: number | null = DAY): GasPoint => ({
  timestamp,
  duration_s,
  volume_m3,
});

/** A dense series: `temp` for every hour of each span, null elsewhere. */
function seriesFor(spans: readonly { start: number; duration_s: number; temp: number }[]): HourlyTemps {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of spans) {
    const a = Math.floor(s.start / HOUR);
    const b = Math.floor((s.start + s.duration_s - 1) / HOUR);
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  const values: (number | null)[] = new Array<number | null>(hi - lo + 1).fill(null);
  for (const s of spans) {
    const a = Math.floor(s.start / HOUR);
    const b = Math.floor((s.start + s.duration_s - 1) / HOUR);
    for (let h = a; h <= b; h += 1) values[h - lo] = s.temp;
  }
  return { startHour: lo, values };
}

/** The first `covered` hours carry `temp`, the rest of the span is null. */
function partialSeries(start: number, duration_s: number, temp: number, covered: number): HourlyTemps {
  const startHour = Math.floor(start / HOUR);
  const values: (number | null)[] = new Array<number | null>(Math.ceil(duration_s / HOUR)).fill(null);
  for (let i = 0; i < covered && i < values.length; i += 1) values[i] = temp;
  return { startHour, values };
}

const isoDay = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);

/** An Enbridge-shaped gas bill: its own period, its own stated volume. */
function bill(opts: {
  start: number;
  days: number;
  /** null = the bill states no volume (the honest "not in this import" case). */
  volumeM3: number | null;
}): UsageSummary {
  const duration = opts.days * DAY;
  return {
    source: 'UsageSummary',
    start: opts.start,
    duration,
    startDate: isoDay(opts.start),
    endDate: isoDay(opts.start + duration),
    days: opts.days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null,
    volume:
      opts.volumeM3 === null
        ? null
        : { scaled: opts.volumeM3, value: opts.volumeM3, powerOfTenMultiplier: 0, uom: 42 },
    items:
      opts.volumeM3 === null
        ? [
            {
              note: 'Total gas charges ($)',
              amount: 157.3,
              rawAmount: 15730,
              itemKind: null,
              unitCost: null,
              measurement: null,
            },
          ]
        : [],
  };
}

const rowOf = (r: ReturnType<typeof buildGasTempBandReport>, id: string) => {
  const row = r.rows.find((x) => x.band.id === id);
  if (!row) throw new Error(`no band ${id}`);
  return row;
};

describe('buildGasTempBandReport — interval readings (the declared source)', () => {
  it('bands two daily readings by their own day means and does the m³/day math', () => {
    const points = [
      point(JAN5, 10), // −5 °C all day → the −10..5 bin
      point(JUL5, 1, DAY), // +15 °C all day → the 12..18 bin
    ];
    const temps = seriesFor([
      { start: JAN5, duration_s: DAY, temp: -5 },
      { start: JUL5, duration_s: DAY, temp: 15 },
    ]);
    const r = buildGasTempBandReport(points, [], temps);

    expect(r.source).toBe('interval');
    expect(r.totalIntervals).toBe(2);
    expect(r.matchedIntervals).toBe(2);
    expect(r.totalM3).toBeCloseTo(11, 9);

    const cold = rowOf(r, '-10..5');
    expect(cold.intervals).toBe(1);
    expect(cold.days).toBeCloseTo(1, 9);
    expect(cold.m3).toBeCloseTo(10, 9);
    expect(cold.meanM3PerDay).toBeCloseTo(10, 9); // 10 m³ ÷ 1 day
    expect(cold.meanTempC).toBeCloseTo(-5, 9);
    expect(cold.hours).toBe(24);
    expect(cold.shareOfM3).toBeCloseTo(10 / 11, 9);

    const mild = rowOf(r, '12..18');
    expect(mild.intervals).toBe(1);
    expect(mild.meanM3PerDay).toBeCloseTo(1, 9);
    expect(mild.shareOfM3).toBeCloseTo(1 / 11, 9);

    // Every other band is empty, not zeroed-into-existence.
    for (const id of ['lt-10', '5..12', '18..24', '24..30', 'gt-30']) {
      expect(rowOf(r, id).intervals, id).toBe(0);
      expect(rowOf(r, id).shareOfM3, id).toBe(0);
    }

    // Shares of the matched volume add up; the peak is the heavy band.
    const shareSum = r.rows.reduce((s, x) => s + x.shareOfM3, 0);
    expect(shareSum).toBeCloseTo(1, 9);
    expect(r.peakBandId).toBe('-10..5');
    expect(r.coverage).toBe(1);
    expect(r.matchedHours).toBe(48);
    expect(r.totalHours).toBe(48);
    expect(gasTempBandEmpty(r)).toBe(false);
  });

  it('a 33-day block divides by ITS OWN days — 330 m³ over 33 days = 10 m³/day', () => {
    const duration = 33 * DAY;
    const r = buildGasTempBandReport([point(JAN1, 330, duration)], [], seriesFor([
      { start: JAN1, duration_s: duration, temp: -8 },
    ]));
    const cold = rowOf(r, '-10..5'); // −8 °C sits in −10..5
    expect(cold.intervals).toBe(1);
    expect(cold.days).toBeCloseTo(33, 9);
    expect(cold.meanM3PerDay).toBeCloseTo(10, 9);
    expect(cold.hours).toBe(33 * 24);
    expect(r.matchedHours).toBe(33 * 24);
    expect(r.totalHours).toBe(33 * 24);
    expect(r.coverage).toBe(1);
  });

  it('two intervals in one band: mean temp is covered-HOUR weighted, m³/day is volume÷days', () => {
    // 1 day at 0 °C (24 h) + 10 days at 4 °C (240 h), both inside −10..5.
    const tenDays = 10 * DAY;
    const points = [point(JAN5, 10), point(JAN5 + DAY, 40, tenDays)];
    const temps = seriesFor([
      { start: JAN5, duration_s: DAY, temp: 0 },
      { start: JAN5 + DAY, duration_s: tenDays, temp: 4 },
    ]);
    const r = buildGasTempBandReport(points, [], temps);
    const cold = rowOf(r, '-10..5');
    expect(cold.intervals).toBe(2);
    expect(cold.days).toBeCloseTo(11, 9);
    expect(cold.m3).toBeCloseTo(50, 9);
    expect(cold.meanM3PerDay).toBeCloseTo(50 / 11, 9);
    // (0 × 24 + 4 × 240) ÷ 264 = 960 ÷ 264
    expect(cold.meanTempC).toBeCloseTo(960 / 264, 9);
    expect(cold.hours).toBe(264);
  });

  it('counts hours with no temperature instead of averaging them away (coverage is partial)', () => {
    const temps = partialSeries(JAN5, DAY, 0, 12); // first 12 h covered, last 12 null
    const r = buildGasTempBandReport([point(JAN5, 6)], [], temps);
    expect(r.totalIntervals).toBe(1);
    expect(r.matchedIntervals).toBe(1);
    expect(r.totalHours).toBe(24);
    expect(r.matchedHours).toBe(12);
    expect(r.coverage).toBeCloseTo(0.5, 9);
    expect(rowOf(r, '-10..5').hours).toBe(12);
    expect(rowOf(r, '-10..5').meanTempC).toBe(0);
  });

  it('an interval with NO temperature is counted, never banded', () => {
    const r = buildGasTempBandReport([point(JAN5, 10)], [], null);
    expect(r.totalIntervals).toBe(1);
    expect(r.matchedIntervals).toBe(0);
    expect(r.totalHours).toBe(24);
    expect(r.matchedHours).toBe(0);
    expect(r.coverage).toBe(0);
    expect(gasTempBandEmpty(r)).toBe(true);
    // temps === null is NOT 0 °C: no band claims the volume.
    expect(r.rows.every((x) => x.intervals === 0)).toBe(true);
  });

  it('leaves readings without a stated interval length OUT and counts them', () => {
    const points = [point(JAN5, 10), point(JUL5, 3, null)];
    const temps = seriesFor([{ start: JAN5, duration_s: DAY, temp: -5 }]);
    const r = buildGasTempBandReport(points, [], temps);
    expect(r.source).toBe('interval');
    expect(r.totalIntervals).toBe(1);
    expect(r.skippedReadings).toBe(1);
    expect(r.matchedIntervals).toBe(1);
  });
});

describe('buildGasTempBandReport — bill-only imports (the stated-volume fallback)', () => {
  it('bands each bill by its period mean temp at BILL-PERIOD granularity', () => {
    const days = 60;
    const bills = [bill({ start: JAN1, days, volumeM3: 600 })];
    const temps = seriesFor([{ start: JAN1, duration_s: days * DAY, temp: -10 }]);
    const r = buildGasTempBandReport([], bills, temps);

    expect(r.source).toBe('billed');
    expect(r.totalIntervals).toBe(1);
    const cold = rowOf(r, '-10..5'); // −10 °C is the band's inclusive edge
    expect(cold.intervals).toBe(1);
    expect(cold.days).toBeCloseTo(60, 9);
    expect(cold.m3).toBeCloseTo(600, 9);
    expect(cold.meanM3PerDay).toBeCloseTo(10, 9);
    expect(cold.meanTempC).toBeCloseTo(-10, 9);
    expect(cold.hours).toBe(60 * 24);
    expect(r.volumelessBills).toBe(0);
  });

  it('a bill that states NO volume is counted and left out — never priced, never zeroed', () => {
    const bills = [
      bill({ start: JAN1, days: 30, volumeM3: 300 }),
      bill({ start: JAN1 + 30 * DAY, days: 30, volumeM3: null }),
    ];
    const temps = seriesFor([{ start: JAN1, duration_s: 60 * DAY, temp: 5 }]);
    const r = buildGasTempBandReport([], bills, temps);
    expect(r.source).toBe('billed');
    expect(r.totalIntervals).toBe(1);
    expect(r.volumelessBills).toBe(1);
    expect(r.totalM3).toBeCloseTo(300, 9);
  });
});

describe('gasTempSource / gasTempSpanRows — the declared series and the fetch span', () => {
  it('usable stored readings win over bills (the monthly chart’s precedence)', () => {
    const points = [point(JAN5, 10)];
    const bills = [bill({ start: JAN1, days: 30, volumeM3: 300 })];
    expect(gasTempSource(points, bills)).toBe('interval');
    // Both edges of the reading: start AND end, so the fetch covers the day.
    const rows = gasTempSpanRows(points, bills);
    expect(rows).toEqual([{ timestamp: JAN5 }, { timestamp: JAN5 + DAY }]);
  });

  it('falls back to the bills when no reading states a length', () => {
    const points = [point(JUL5, 3, null)];
    const bills = [bill({ start: JAN1, days: 30, volumeM3: 300 })];
    expect(gasTempSource(points, bills)).toBe('billed');
    const rows = gasTempSpanRows(points, bills);
    // Both edges of the PERIOD — a span ending at the start would clip the
    // last bill's temperature series to its first hour.
    expect(rows).toEqual([
      { timestamp: JAN1 },
      { timestamp: JAN1 + 30 * DAY },
    ]);
  });

  it('reports none when there is no volume to band at all', () => {
    expect(gasTempSource([], [])).toBe('none');
    expect(gasTempSpanRows([], [])).toEqual([]);
    expect(gasTempSource([point(JUL5, 3, null)], [bill({ start: JAN1, days: 30, volumeM3: null })])).toBe(
      'none',
    );
  });
});

describe('honesty pins', () => {
  it('the report carries no money and no energy unit — volume, days, hours, °C only', () => {
    const r = buildGasTempBandReport(
      [point(JAN5, 10)],
      [bill({ start: JAN1, days: 30, volumeM3: 300 })],
      seriesFor([{ start: JAN5, duration_s: DAY, temp: -5 }]),
    );
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/[$¢]/);
    expect(json).not.toMatch(/kWh/i);
    expect(Object.keys(r.rows[0]).sort()).toEqual(
      ['band', 'days', 'hours', 'intervals', 'm3', 'meanM3PerDay', 'meanTempC', 'shareOfM3'].sort(),
    );
  });

  it('never mutates its inputs', () => {
    const points = [point(JAN5, 10)];
    const bills = [bill({ start: JAN1, days: 30, volumeM3: 300 })];
    const pointsBefore = JSON.stringify(points);
    const billsBefore = JSON.stringify(bills);
    buildGasTempBandReport(
      points,
      bills,
      seriesFor([{ start: JAN5, duration_s: DAY, temp: -5 }]),
    );
    expect(JSON.stringify(points)).toBe(pointsBefore);
    expect(JSON.stringify(bills)).toBe(billsBefore);
  });

  it('drops non-finite readings instead of painting a broken axis', () => {
    const r = buildGasTempBandReport(
      [
        { timestamp: JAN5, duration_s: DAY, volume_m3: Number.NaN },
        { timestamp: Number.POSITIVE_INFINITY, duration_s: DAY, volume_m3: 3 },
        point(JAN5 + DAY, 4),
      ],
      [],
      seriesFor([{ start: JAN5, duration_s: 2 * DAY, temp: 2 }]),
    );
    expect(r.totalIntervals).toBe(1);
    expect(r.matchedIntervals).toBe(1);
  });
});
