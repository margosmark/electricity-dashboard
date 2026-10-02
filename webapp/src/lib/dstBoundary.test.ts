/**
 * Wave G item 3 — DST-boundary pricing check.
 *
 * TOU/ULO classification reads `Date.getHours()` — the LOCAL wall clock of
 * whatever machine runs the code. Two things can go wrong at a DST boundary:
 *
 *   - the 23-hour / 25-hour day produces an off-by-one hour, and
 *   - a reading is priced into the wrong rate window for exactly one hour a
 *     year, which is invisible in normal testing but wrong on the bill.
 *
 * These tests pin the app's output to an INDEPENDENT wall-clock reference
 * built from Intl (which resolves instants through the ICU timezone rules,
 * not through `getHours()`), over datasets that cross spring-forward and
 * fall-back, plus the Apr 30 / May 1 rate-season change.
 *
 * TZ is forced to America/Toronto: that is the browser timezone this app
 * assumes (see OPERATIONS.md), and CI runners default to UTC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  categorizeTOU,
  categorizeULO,
  processRawData,
  type RateSet,
} from './energy';

const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'America/Toronto';
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/* --------------------------- independent reference ----------------------- */

const WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Toronto',
  hour: 'numeric',
  hour12: false,
  weekday: 'short',
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
});

type WallClock = { hour: number; weekday: string; month: number; day: number };

/** Resolve an instant to Toronto wall-clock parts WITHOUT using Date#getHours. */
function wallClock(tsSec: number): WallClock {
  const parts = Object.fromEntries(
    WALL.formatToParts(new Date(tsSec * 1000)).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return { hour, weekday: parts.weekday, month: Number(parts.month), day: Number(parts.day) };
}

const isWeekendWall = (w: WallClock) => w.weekday === 'Sat' || w.weekday === 'Sun';
/** Ontario rate season: winter Nov 1 – Apr 30, summer May 1 – Oct 31. */
const isWinterWall = (w: WallClock) => w.month >= 11 || w.month <= 4;

/** OEB Time-of-Use windows, written from the published schedule. */
function refTOU(w: WallClock): string {
  if (isWeekendWall(w)) return 'Off-Peak';
  if (w.hour >= 19 || w.hour < 7) return 'Off-Peak';
  if (isWinterWall(w)) {
    return (w.hour >= 7 && w.hour < 11) || (w.hour >= 17 && w.hour < 19) ? 'On-Peak' : 'Mid-Peak';
  }
  return w.hour >= 11 && w.hour < 17 ? 'On-Peak' : 'Mid-Peak';
}

/** OEB Ultra-Low Overnight windows, written from the published schedule. */
function refULO(w: WallClock): string {
  if (w.hour >= 23 || w.hour < 7) return 'Overnight';
  if (isWeekendWall(w)) return 'Weekend Off-Peak';
  if (w.hour >= 16 && w.hour < 21) return 'On-Peak';
  return 'Mid-Peak';
}

/* ------------------------------- fixtures -------------------------------- */

const HOUR = 3600;

/** Hourly reading timestamps (unix seconds) starting at `startIso` (UTC). */
function hourlySeries(startIso: string, hours: number): number[] {
  const start = Math.floor(Date.parse(startIso) / 1000);
  return Array.from({ length: hours }, (_, i) => start + i * HOUR);
}

const rates: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** 2026 DST: spring-forward Sun Mar 8, fall-back Sun Nov 1. */
const SPRING = hourlySeries('2026-03-06T00:00:00Z', 24 * 6); // Mar 6 → Mar 12
const FALL = hourlySeries('2026-10-30T00:00:00Z', 24 * 6); // Oct 30 → Nov 5
const SEASON = hourlySeries('2026-04-28T00:00:00Z', 24 * 6); // Apr 28 → May 4
const ALL = [...SPRING, ...FALL, ...SEASON];

/* --------------------------------- tests --------------------------------- */

describe('DST datasets are shaped the way the calendar actually is', () => {
  it('spring-forward day has 23 local hours (02:00 never happens)', () => {
    const day = SPRING.filter((ts) => wallClock(ts).weekday === 'Sun' && wallClock(ts).month === 3);
    const hours = new Set(day.map((ts) => wallClock(ts).hour));
    expect(hours.has(2)).toBe(false);
    expect([...Array(24).keys()].filter((h) => !hours.has(h))).toEqual([2]);
    expect(day.length).toBe(23);
  });

  it('fall-back day has 25 instants and hour 01 happens twice', () => {
    const day = FALL.filter((ts) => wallClock(ts).weekday === 'Sun' && wallClock(ts).month === 11);
    expect(day.length).toBe(25);
    const labels = day.map((ts) => wallClock(ts).hour);
    expect(labels.filter((h) => h === 1).length).toBe(2);
    expect(new Set(labels).size).toBe(24);
  });
});

describe('wall-clock resolution across the transitions', () => {
  it('Date#getHours agrees with the ICU reference for every reading', () => {
    for (const ts of ALL) {
      expect(new Date(ts * 1000).getHours(), `instant ${ts}`).toBe(wallClock(ts).hour);
    }
  });

  it('prices the repeated fall-back hour identically on both occurrences', () => {
    const first = Math.floor(Date.parse('2026-11-01T05:30:00Z') / 1000); // 01:30 EDT
    const second = Math.floor(Date.parse('2026-11-01T06:30:00Z') / 1000); // 01:30 EST
    expect(wallClock(first).hour).toBe(1);
    expect(wallClock(second).hour).toBe(1);
    expect(categorizeTOU(new Date(first * 1000))).toBe('Off-Peak');
    expect(categorizeTOU(new Date(second * 1000))).toBe('Off-Peak');
    expect(categorizeULO(new Date(first * 1000))).toBe('Overnight');
    expect(categorizeULO(new Date(second * 1000))).toBe('Overnight');
    // They are a real hour apart in UTC even though the labels collide.
    expect(second - first).toBe(HOUR);
  });

  it('never classifies an instant into the skipped spring-forward hour', () => {
    const beforeGap = Math.floor(Date.parse('2026-03-08T06:30:00Z') / 1000); // 01:30 EST
    const afterGap = Math.floor(Date.parse('2026-03-08T07:30:00Z') / 1000); // 03:30 EDT
    expect(wallClock(beforeGap).hour).toBe(1);
    expect(wallClock(afterGap).hour).toBe(3);
    const hoursInDay = SPRING
      .filter((ts) => wallClock(ts).weekday === 'Sun' && wallClock(ts).month === 3)
      .map((ts) => wallClock(ts).hour);
    expect(hoursInDay).not.toContain(2);
  });
});

describe('every hourly reading lands in the correct rate window', () => {
  it('TOU matches the reference across spring-forward, fall-back and season change', () => {
    for (const ts of ALL) {
      const date = new Date(ts * 1000);
      expect(categorizeTOU(date), `TOU @ ${date.toISOString()} (${wallClock(ts).weekday} ${wallClock(ts).hour}h)`).toBe(
        refTOU(wallClock(ts)),
      );
    }
  });

  it('ULO matches the reference across the same three windows', () => {
    for (const ts of ALL) {
      const date = new Date(ts * 1000);
      expect(categorizeULO(date), `ULO @ ${date.toISOString()} (${wallClock(ts).weekday} ${wallClock(ts).hour}h)`).toBe(
        refULO(wallClock(ts)),
      );
    }
  });

  it('only ever returns a known category (no undefined window)', () => {
    const tou = new Set(['Off-Peak', 'Mid-Peak', 'On-Peak']);
    const ulo = new Set(['Overnight', 'Weekend Off-Peak', 'Mid-Peak', 'On-Peak']);
    for (const ts of ALL) {
      expect(tou.has(categorizeTOU(new Date(ts * 1000)))).toBe(true);
      expect(ulo.has(categorizeULO(new Date(ts * 1000)))).toBe(true);
    }
  });
});

describe('named boundary instants', () => {
  const at = (iso: string) => new Date(Date.parse(iso));

  it('weekday right after spring-forward uses the winter on-peak windows', () => {
    // Mon Mar 9 2026, 08:00 EDT → winter On-Peak (07:00–11:00).
    expect(wallClock(Math.floor(Date.parse('2026-03-09T12:00:00Z') / 1000))).toMatchObject({
      hour: 8,
      weekday: 'Mon',
    });
    expect(categorizeTOU(at('2026-03-09T12:00:00Z'))).toBe('On-Peak');
    // Same clock time in the evening is still on-peak (17:00–19:00).
    expect(categorizeTOU(at('2026-03-09T22:00:00Z'))).toBe('On-Peak');
    // 13:00 local (17:00Z, EDT) is mid-peak in winter.
    expect(categorizeTOU(at('2026-03-09T17:00:00Z'))).toBe('Mid-Peak');
  });

  it('weekday right after fall-back still lands on-peak at 17:00 EST', () => {
    // Mon Nov 2 2026, 17:00 EST → winter On-Peak.
    expect(wallClock(Math.floor(Date.parse('2026-11-02T22:00:00Z') / 1000))).toMatchObject({
      hour: 17,
      weekday: 'Mon',
    });
    expect(categorizeTOU(at('2026-11-02T22:00:00Z'))).toBe('On-Peak');
  });

  it('the Apr 30 → May 1 season flip changes which hours are on-peak', () => {
    // 12:30 local on Apr 30 (winter): mid-peak. On May 1 (summer): on-peak.
    const apr30 = Math.floor(Date.parse('2026-04-30T16:30:00Z') / 1000);
    const may01 = Math.floor(Date.parse('2026-05-01T16:30:00Z') / 1000);
    expect(wallClock(apr30)).toMatchObject({ hour: 12, month: 4, day: 30 });
    expect(wallClock(may01)).toMatchObject({ hour: 12, month: 5, day: 1 });
    expect(categorizeTOU(new Date(apr30 * 1000))).toBe('Mid-Peak');
    expect(categorizeTOU(new Date(may01 * 1000))).toBe('On-Peak');
  });
});

describe('processRawData — priced output at the boundaries', () => {
  it('flags the right season and charges the categorized rate', () => {
    const points = [
      { timestamp: Math.floor(Date.parse('2026-03-09T12:00:00Z') / 1000), usage_kwh: 2 }, // winter on-peak
      { timestamp: Math.floor(Date.parse('2026-05-01T16:30:00Z') / 1000), usage_kwh: 2 }, // summer on-peak
      { timestamp: Math.floor(Date.parse('2026-11-01T05:30:00Z') / 1000), usage_kwh: 2 }, // fall-back off-peak
      { timestamp: Math.floor(Date.parse('2026-03-08T07:30:00Z') / 1000), usage_kwh: 2 }, // spring-forward off-peak
    ];
    const processed = processRawData(points, [rates]);

    expect(processed[0]).toMatchObject({ touCategory: 'On-Peak', isWinter: true });
    expect(processed[1]).toMatchObject({ touCategory: 'On-Peak', isWinter: false });
    expect(processed[2]).toMatchObject({ touCategory: 'Off-Peak', isWinter: true });
    expect(processed[3]).toMatchObject({ touCategory: 'Off-Peak', isWinter: true });

    expect(processed[0].costTOU).toBeCloseTo(2 * 0.203, 9);
    expect(processed[1].costTOU).toBeCloseTo(2 * 0.203, 9);
    expect(processed[2].costTOU).toBeCloseTo(2 * 0.098, 9);
    expect(processed[3].costTOU).toBeCloseTo(2 * 0.098, 9);

    for (const row of processed) {
      expect(Number.isFinite(row.costTOU)).toBe(true);
      expect(Number.isFinite(row.costULO)).toBe(true);
      expect(Number.isFinite(row.costTiered)).toBe(true);
    }
  });

  it('produces finite costs for a whole DST-crossing dataset', () => {
    const processed = processRawData(
      ALL.map((timestamp, i) => ({ timestamp, usage_kwh: 0.5 + (i % 7) * 0.1 })),
      [rates],
    );
    expect(processed).toHaveLength(ALL.length);
    for (const row of processed) {
      expect(Number.isFinite(row.costTOU)).toBe(true);
      expect(Number.isFinite(row.costULO)).toBe(true);
      expect(row.touCategory).toMatch(/^(Off-Peak|Mid-Peak|On-Peak)$/);
      expect(row.uloCategory).toMatch(/^(Overnight|Weekend Off-Peak|Mid-Peak|On-Peak)$/);
    }
  });
});
