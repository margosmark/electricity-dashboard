/**
 * Wave L item 4 — LocalTimeParameters as the dataset's DST source of truth.
 *
 * ESPI ships the DST regime as DstRuleType bitmaps, and Mark's Oakville file
 * carries the North-American pair (360E2000 / B40E2000, "DST For North
 * America"). These tests decode the file's OWN rules — no synthesized ones —
 * and assert the transitions they produce, then prove the rules drive the
 * pricing clock: a feed with a different regime (EU last-Sunday March/October)
 * buckets and prices differently from the browser's default, while a feed
 * whose rules match the browser's prices exactly as before.
 *
 * TZ is forced to America/Toronto: that is the browser timezone this app
 * assumes (see OPERATIONS.md), and CI runners default to UTC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DST_RULE_DISABLED,
  categorizeTOUAt,
  categorizeULOAt,
  decodeDstRule,
  dstTransitionAt,
  parseGreenButtonFeed,
  processRawData,
  resolveZone,
  type LocalTimeParams,
  type RateSet,
} from './energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Toronto';
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** The clock rules out of the real Oakville file. */
const OAKVILLE: LocalTimeParams = {
  tzOffset: -18000,
  dstOffset: 3600,
  dstStartRule: '360E2000',
  dstEndRule: 'B40E2000',
};

const SPRING_2026 = Date.UTC(2026, 2, 8, 7, 0, 0) / 1000; // 02:00 EST → 07:00Z
const FALL_2026 = Date.UTC(2026, 10, 1, 6, 0, 0) / 1000; // 02:00 EDT → 06:00Z

const rates: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** Encode a rule the way the schema describes it (handy for foreign regimes). */
function encodeRule(parts: {
  month: number;
  operator: number;
  dayOfMonth?: number;
  dayOfWeek?: number;
  hour: number;
  minute?: number;
}): string {
  const v =
    ((parts.month << 28) |
      (parts.operator << 25) |
      ((parts.dayOfMonth ?? 0) << 20) |
      ((parts.dayOfWeek ?? 0) << 17) |
      (parts.hour << 12) |
      ((parts.minute ?? 0) * 60)) >>>
    0; // shifts are int32; the bitmap is uint32 (months ≥ 9 set the top bit)
  return v.toString(16).toUpperCase().padStart(8, '0');
}

/* ------------------------------------------------------------ decoding ---- */

describe('DstRuleType decoding', () => {
  it('reads the file’s own start rule: second Sunday of March at 02:00', () => {
    expect(decodeDstRule('360E2000')).toEqual({
      month: 3,
      operator: 3,
      dayOfMonth: 0,
      dayOfWeek: 7,
      hour: 2,
      minute: 0,
      second: 0,
    });
  });

  it('reads the file’s own end rule: first Sunday of November at 02:00', () => {
    expect(decodeDstRule('B40E2000')).toEqual({
      month: 11,
      operator: 2,
      dayOfMonth: 0,
      dayOfWeek: 7,
      hour: 2,
      minute: 0,
      second: 0,
    });
  });

  it('round-trips the rules it can also encode', () => {
    expect(
      decodeDstRule(encodeRule({ month: 3, operator: 3, dayOfWeek: 7, hour: 2 })),
    ).toEqual(decodeDstRule('360E2000'));
    expect(
      decodeDstRule(encodeRule({ month: 11, operator: 2, dayOfWeek: 7, hour: 2 })),
    ).toEqual(decodeDstRule('B40E2000'));
  });

  it('treats disabled, absent and malformed rules as no rule', () => {
    expect(decodeDstRule('FFFFFFFF')).toBeNull();
    expect(DST_RULE_DISABLED).toBe(0xffffffff);
    expect(decodeDstRule(null)).toBeNull();
    expect(decodeDstRule('')).toBeNull();
    expect(decodeDstRule('not-hex')).toBeNull();
    expect(decodeDstRule('F0000000')).toBeNull(); // month 15 does not exist
  });
});

/* ---------------------------------------------------------- transitions --- */

describe('the file’s rules put the 2026 transitions where the calendar has them', () => {
  const zone = resolveZone(OAKVILLE)!;

  it('agrees with Wave G’s synthesized dates, from the file alone', () => {
    const t = zone.transitions(2026);
    expect(t.start).toBe(SPRING_2026); // Sun Mar 8, 2026 02:00 EST
    expect(t.end).toBe(FALL_2026); // Sun Nov 1, 2026 02:00 EDT
  });

  it('reads the rule time in the offset that was in force before the change', () => {
    const startRule = decodeDstRule(OAKVILLE.dstStartRule)!;
    const endRule = decodeDstRule(OAKVILLE.dstEndRule)!;
    // spring: 02:00 standard (UTC-5) = 07:00Z
    expect(dstTransitionAt(startRule, 2026, OAKVILLE.tzOffset)).toBe(SPRING_2026);
    // fall: 02:00 daylight (UTC-4) = 06:00Z
    expect(dstTransitionAt(endRule, 2026, OAKVILLE.tzOffset + 3600)).toBe(FALL_2026);
    // reading the end rule in standard time would be an hour late — that is
    // the mistake this convention exists to prevent
    expect(dstTransitionAt(endRule, 2026, OAKVILLE.tzOffset)).toBe(FALL_2026 + 3600);
  });

  it('flips the offset exactly at the transitions', () => {
    expect(zone.isDST(SPRING_2026 - 1)).toBe(false);
    expect(zone.isDST(SPRING_2026)).toBe(true);
    expect(zone.isDST(FALL_2026 - 1)).toBe(true);
    expect(zone.isDST(FALL_2026)).toBe(false);
    expect(zone.offsetAt(SPRING_2026 - 1)).toBe(-18000);
    expect(zone.offsetAt(SPRING_2026)).toBe(-14400);
  });

  it('gives the 23-hour and 25-hour days the calendar has', () => {
    // 01:59 EST … then the clock jumps to 03:00 EDT (02:00 never happens)
    expect(zone.wallClock(SPRING_2026 - 1).hour).toBe(1);
    expect(zone.wallClock(SPRING_2026).hour).toBe(3);
    // 01:59 EDT … then 01:00 EST again (01:00 happens twice)
    expect(zone.wallClock(FALL_2026 - 1).hour).toBe(1);
    expect(zone.wallClock(FALL_2026).hour).toBe(1);
    expect(zone.hourKey(FALL_2026 - 1)).toBe('01:59');
    expect(zone.hourKey(FALL_2026)).toBe('01:00');
  });

  it('buckets days in the file’s own zone', () => {
    expect(zone.dayKey(Date.UTC(2026, 6, 22, 3, 0) / 1000)).toBe('2026-07-21'); // 23:00 EDT
    expect(zone.dayKey(Date.UTC(2026, 6, 22, 4, 0) / 1000)).toBe('2026-07-22'); // 00:00 EDT
  });
});

/* --------------------------------------------------- foreign regimes ------ */

describe('a feed’s rules win over the browser’s defaults', () => {
  // The EU changes its clocks at 01:00 UTC: 02:00 CET when DST starts,
  // 03:00 CEST when it ends — which is what the rule's wall time has to say,
  // because a rule is read in the offset that was in force before the change.
  const EU: LocalTimeParams = {
    tzOffset: 3600,
    dstOffset: 3600,
    dstStartRule: encodeRule({ month: 3, operator: 7, dayOfWeek: 7, hour: 2 }),
    dstEndRule: encodeRule({ month: 10, operator: 7, dayOfWeek: 7, hour: 3 }),
  };

  it('places the EU transitions, not the North-American ones', () => {
    const eu = resolveZone(EU)!;
    expect(eu.transitions(2026).start).toBe(Date.UTC(2026, 2, 29, 1, 0, 0) / 1000); // last Sun Mar, 01:00 UTC
    expect(eu.transitions(2026).end).toBe(Date.UTC(2026, 9, 25, 1, 0, 0) / 1000); // last Sun Oct, 01:00 UTC

    const na = resolveZone({ ...EU, dstStartRule: OAKVILLE.dstStartRule, dstEndRule: OAKVILLE.dstEndRule })!;
    expect(na.transitions(2026).start).not.toBe(eu.transitions(2026).start);
    expect(na.transitions(2026).end).not.toBe(eu.transitions(2026).end);
  });

  it('prices a reading by the regime the file declares, not by the browser', () => {
    // 2026-10-25 01:30Z: the EU clock has already fallen back (local 02:30),
    // a North-American regime on the same offset is still on daylight time
    // (local 03:30), and Toronto is still on EDT (local 21:30 the day before).
    const ts = Date.UTC(2026, 9, 25, 1, 30) / 1000;
    const eu = resolveZone(EU)!;
    const naSameOffset = resolveZone({
      tzOffset: 3600,
      dstOffset: 3600,
      dstStartRule: OAKVILLE.dstStartRule,
      dstEndRule: OAKVILLE.dstEndRule,
    })!;

    expect(eu.isDST(ts)).toBe(false);
    expect(naSameOffset.isDST(ts)).toBe(true);
    expect(eu.hourKey(ts)).toBe('02:30');
    expect(naSameOffset.hourKey(ts)).toBe('03:30');
    expect(eu.dayKey(ts)).toBe('2026-10-25');
    expect(naSameOffset.dayKey(ts)).toBe('2026-10-25');
  });

  it('feeds that into pricing: TOU category, day bucket and hour bucket', () => {
    // 15:30Z on a Monday: Toronto 11:30 → summer On-Peak; Berlin 17:30 → Mid-Peak.
    const ts = Date.UTC(2026, 5, 15, 15, 30) / 1000;
    const berlin = processRawData([{ timestamp: ts, usage_kwh: 1 }], [rates], resolveZone(EU));
    const browser = processRawData([{ timestamp: ts, usage_kwh: 1 }], [rates]);

    expect(browser[0].hourStr).toBe('11:30');
    expect(browser[0].touCategory).toBe('On-Peak');
    expect(berlin[0].hourStr).toBe('17:30');
    expect(berlin[0].touCategory).toBe('Mid-Peak');
    expect(berlin[0].dayStr).toBe('2026-06-15');
    // the instant itself is untouched — only the reading of it changes
    expect(berlin[0].dateObj.getTime()).toBe(browser[0].dateObj.getTime());
  });

  it('still prices exactly as before when the file’s rules match the browser’s', () => {
    const ts = Date.UTC(2026, 5, 15, 15, 30) / 1000;
    const oakville = processRawData([{ timestamp: ts, usage_kwh: 1 }], [rates], resolveZone(OAKVILLE));
    const browser = processRawData([{ timestamp: ts, usage_kwh: 1 }], [rates]);
    expect(oakville[0]).toEqual(browser[0]);
  });
});

/* ----------------------------------------------------- file without rules - */

describe('feeds that say only a fixed offset', () => {
  it('parses tzOffset alone and never invents a DST regime', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
        <entry><content><espi:LocalTimeParameters>
          <espi:tzOffset>-18000</espi:tzOffset>
        </espi:LocalTimeParameters></content></entry>
      </feed>`;
    const { localTime, summaries } = parseGreenButtonFeed(xml);
    expect(localTime).toEqual({
      tzOffset: -18000,
      dstOffset: null,
      dstStartRule: null,
      dstEndRule: null,
    });
    expect(summaries).toEqual([]);

    const zone = resolveZone(localTime)!;
    expect(zone.isDST(Date.UTC(2026, 6, 1) / 1000)).toBe(false);
    expect(zone.offsetAt(Date.UTC(2026, 6, 1) / 1000)).toBe(-18000);
    expect(zone.transitions(2026)).toEqual({ start: null, end: null });
    expect(zone.dayKey(Date.UTC(2026, 6, 22, 5, 0) / 1000)).toBe('2026-07-22');
  });

  it('parses the Green Button Connect standin’s own clock', () => {
    const { localTime } = parseGreenButtonFeed(read('utility-espi-prefixed-standin.xml'));
    expect(localTime).toEqual({
      tzOffset: -21600,
      dstOffset: 3600,
      dstStartRule: '360E2000',
      dstEndRule: 'B40E2000',
    });
  });

  it('ignores a LocalTimeParameters block that states no offset', () => {
    const xml = `<feed xmlns:espi="http://naesb.org/espi"><entry><content>
      <espi:LocalTimeParameters><espi:dstStartRule>360E2000</espi:dstStartRule>
      </espi:LocalTimeParameters></content></entry></feed>`;
    expect(parseGreenButtonFeed(xml).localTime).toBeNull();
    expect(resolveZone(null)).toBeNull();
  });
});

/* --------------------------------------------------------- sanity check --- */

describe('the classifier itself is unchanged on a wall clock', () => {
  /** A wall clock on a real 2026 weekday that is not a holiday. */
  const at = (w: { hour: number; dow: number; month: number; day: number }) =>
    categorizeTOUAt({ year: 2026, ...w });

  it('matches the browser’s pre-Wave-L answers', () => {
    expect(at({ hour: 13, dow: 3, month: 7, day: 15 })).toBe('On-Peak'); // summer 13:00
    expect(at({ hour: 13, dow: 2, month: 2, day: 10 })).toBe('Mid-Peak'); // winter 13:00
    expect(at({ hour: 8, dow: 0, month: 7, day: 12 })).toBe('Off-Peak'); // Sunday
    expect(at({ hour: 20, dow: 3, month: 7, day: 15 })).toBe('Off-Peak');
    expect(at({ hour: 7, dow: 3, month: 7, day: 15 })).toBe('Mid-Peak');
    expect(at({ hour: 11, dow: 3, month: 7, day: 15 })).toBe('On-Peak');
    expect(at({ hour: 16, dow: 3, month: 7, day: 15 })).toBe('On-Peak'); // 11:00–17:00
    expect(at({ hour: 17, dow: 3, month: 7, day: 15 })).toBe('Mid-Peak');
    // Ontario's winter window runs Nov 1 – Apr 30: April still prices like
    // winter, May does not (the season flip Wave G pinned).
    expect(at({ hour: 7, dow: 5, month: 4, day: 10 })).toBe('On-Peak');
    expect(at({ hour: 7, dow: 1, month: 5, day: 11 })).toBe('Mid-Peak');
    expect(at({ hour: 7, dow: 2, month: 11, day: 10 })).toBe('On-Peak');
    expect(at({ hour: 7, dow: 4, month: 12, day: 10 })).toBe('On-Peak');
  });

  it('prices the OEB’s holidays at the lowest rate all day (the real bill caught this)', () => {
    // 2026-08-03 is the Civic Holiday: Oakville's meter counted every hour of
    // it as off-peak, and doing the same is what makes our TOU split match the
    // bill's Off/Mid/On-Peak-Summer kWh.
    expect(at({ hour: 13, dow: 1, month: 8, day: 3 })).toBe('Off-Peak');
    expect(at({ hour: 7, dow: 1, month: 8, day: 3 })).toBe('Off-Peak');
    expect(at({ hour: 16, dow: 1, month: 8, day: 3 })).toBe('Off-Peak');
    // the plain Monday a week later prices normally
    expect(at({ hour: 13, dow: 1, month: 8, day: 10 })).toBe('On-Peak');
    // …and so do Canada Day and New Year's Day
    expect(at({ hour: 13, dow: 3, month: 7, day: 1 })).toBe('Off-Peak');
    expect(at({ hour: 13, dow: 4, month: 1, day: 1 })).toBe('Off-Peak');
    // ULO follows the same OEB schedule: weekend-off-peak all day
    expect(categorizeULOAt({ hour: 10, dow: 1, year: 2026, month: 8, day: 3 })).toBe(
      'Weekend Off-Peak',
    );
    expect(categorizeULOAt({ hour: 10, dow: 1, year: 2026, month: 8, day: 10 })).toBe('Mid-Peak');
  });
});
