/**
 * Wave G item 6 — rate-season boundaries and the bands they produce.
 */

import { describe, it, expect } from 'vitest';
import {
  seasonForDay, seasonForMonth, seasonForMonthIndex, seasonForChartKey,
  chartSeasonSegments, seasonSegments, distinctSeasons, otherSeason, SEASON_INFO,
} from './season';

describe('season boundaries', () => {
  it('flips exactly on May 1 and Nov 1', () => {
    expect(seasonForDay('2026-04-30')).toBe('winter');
    expect(seasonForDay('2026-05-01')).toBe('summer');
    expect(seasonForDay('2026-10-31')).toBe('summer');
    expect(seasonForDay('2026-11-01')).toBe('winter');
  });

  it('keeps the deep-winter and high-summer months in the right bands', () => {
    expect(seasonForDay('2026-01-01')).toBe('winter');
    expect(seasonForDay('2026-02-15')).toBe('winter');
    expect(seasonForDay('2026-07-01')).toBe('summer');
    expect(seasonForDay('2026-12-31')).toBe('winter');
  });

  it('handles month indexes and yyyy-MM keys (monthly charts)', () => {
    expect([0, 1, 2, 3].map(seasonForMonthIndex)).toEqual(['winter', 'winter', 'winter', 'winter']);
    expect([4, 5, 6, 7, 8, 9].map(seasonForMonthIndex)).toEqual(['summer', 'summer', 'summer', 'summer', 'summer', 'summer']);
    expect([10, 11].map(seasonForMonthIndex)).toEqual(['winter', 'winter']);
    expect(seasonForMonth('2026-04')).toBe('winter');
    expect(seasonForMonth('2026-05')).toBe('summer');
    expect(seasonForMonth('2026-11')).toBe('winter');
  });

  it('tolerates a missing day key without throwing', () => {
    expect(() => seasonForDay('')).not.toThrow();
    expect(['winter', 'summer']).toContain(seasonForDay(''));
  });

  it('documents both windows', () => {
    expect(SEASON_INFO.winter.range).toBe('Nov 1 – Apr 30');
    expect(SEASON_INFO.summer.range).toBe('May 1 – Oct 31');
    expect(otherSeason('winter')).toBe('summer');
    expect(otherSeason('summer')).toBe('winter');
  });
});

describe('seasonForChartKey by zoom level', () => {
  it('uses the bar key for daily / weekly / monthly', () => {
    expect(seasonForChartKey('daily', '2026-04-30')).toBe('winter');
    expect(seasonForChartKey('daily', '2026-05-01')).toBe('summer');
    expect(seasonForChartKey('weekly', '2026-11-02')).toBe('winter');
    expect(seasonForChartKey('monthly', '2026-11')).toBe('winter');
    expect(seasonForChartKey('monthly', '2026-10')).toBe('summer');
  });

  it('uses the day, not the HH:mm key, for hourly bars', () => {
    // '13:00' parsed as a day would be nonsense — the day comes from zoomTarget.
    expect(seasonForChartKey('hourly', '13:00', '2026-04-30')).toBe('winter');
    expect(seasonForChartKey('hourly', '13:00', '2026-05-01')).toBe('summer');
  });
});

describe('seasonSegments / chartSeasonSegments', () => {
  it('is empty on an empty chart', () => {
    expect(seasonSegments([], () => 'winter')).toEqual([]);
    expect(chartSeasonSegments('daily', [])).toEqual([]);
  });

  it('returns one segment when the window sits inside one season', () => {
    const keys = ['2026-07-01', '2026-07-02', '2026-07-03'];
    expect(chartSeasonSegments('daily', keys)).toEqual([
      { season: 'summer', fromKey: '2026-07-01', toKey: '2026-07-03', bars: 3 },
    ]);
  });

  it('splits exactly at the May 1 boundary', () => {
    const keys = ['2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-02', '2026-05-03'];
    expect(chartSeasonSegments('daily', keys)).toEqual([
      { season: 'winter', fromKey: '2026-04-28', toKey: '2026-04-30', bars: 3 },
      { season: 'summer', fromKey: '2026-05-01', toKey: '2026-05-03', bars: 3 },
    ]);
  });

  it('splits exactly at the Nov 1 boundary', () => {
    const keys = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'];
    expect(chartSeasonSegments('daily', keys)).toEqual([
      { season: 'summer', fromKey: '2026-10-30', toKey: '2026-10-31', bars: 2 },
      { season: 'winter', fromKey: '2026-11-01', toKey: '2026-11-02', bars: 2 },
    ]);
  });

  it('never splits an hourly chart: the bars are one day', () => {
    const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    expect(chartSeasonSegments('hourly', hours, '2026-04-30')).toHaveLength(1);
    expect(chartSeasonSegments('hourly', hours, '2026-04-30')[0].season).toBe('winter');
    expect(chartSeasonSegments('hourly', hours, '2026-05-01')[0].season).toBe('summer');
  });

  it('splits monthly charts on month keys', () => {
    const keys = ['2026-04', '2026-05', '2026-06'];
    expect(chartSeasonSegments('monthly', keys)).toEqual([
      { season: 'winter', fromKey: '2026-04', toKey: '2026-04', bars: 1 },
      { season: 'summer', fromKey: '2026-05', toKey: '2026-06', bars: 2 },
    ]);
  });

  it('survives an odd key without throwing', () => {
    expect(() => chartSeasonSegments('daily', ['not-a-date'])).not.toThrow();
  });

  it('groups non-adjacent runs separately (defensive: keys are sorted, but be safe)', () => {
    const keys = ['2026-05-01', '2026-11-01', '2026-05-02'];
    expect(seasonSegments(keys, (k) => seasonForDay(k)).map((s) => s.season)).toEqual([
      'summer',
      'winter',
      'summer',
    ]);
  });
});

describe('real Oakville export window', () => {
  /**
   * The one genuine Oakville Hydro 60-minute export available for this task
   * (private, so not committed) spans 2026-07-02 → 2026-10-01: 2184 hourly
   * readings, entirely inside the summer window. It therefore does NOT cross
   * Apr 30 / May 1 — the crossing is covered by the synthetic boundary tests
   * above, and by the browser check on a two-season dataset.
   */
  const OAKVILLE_FIRST_DAY = '2026-07-02';
  const OAKVILLE_LAST_DAY = '2026-10-01';

  it('lies entirely within the summer band (no boundary crossing)', () => {
    const keys: string[] = [];
    for (let d = new Date(`${OAKVILLE_FIRST_DAY}T00:00:00Z`); d.toISOString().slice(0, 10) <= OAKVILLE_LAST_DAY; d.setUTCDate(d.getUTCDate() + 1)) {
      keys.push(d.toISOString().slice(0, 10));
    }
    expect(keys[0]).toBe(OAKVILLE_FIRST_DAY);
    expect(keys[keys.length - 1]).toBe(OAKVILLE_LAST_DAY);
    expect(keys.length).toBeGreaterThan(80);

    const segments = chartSeasonSegments('daily', keys);
    expect(segments).toHaveLength(1);
    expect(segments[0].season).toBe('summer');
    expect(segments[0].bars).toBe(keys.length);
  });
});

describe('distinctSeasons', () => {
  it('orders seasons canonically and de-duplicates', () => {
    expect(distinctSeasons(['summer', 'winter', 'summer'])).toEqual(['winter', 'summer']);
    expect(distinctSeasons(['summer'])).toEqual(['summer']);
    expect(distinctSeasons([])).toEqual([]);
  });
});
