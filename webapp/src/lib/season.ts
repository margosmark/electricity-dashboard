/**
 * Wave G item 6 — rate-season bands.
 *
 * Ontario changes its TOU windows twice a year (Nov 1 – Apr 30 winter,
 * May 1 – Oct 31 summer) and the tiered threshold changes with them
 * (thresholdWinter vs thresholdSummer). Charts that mix the two seasons make
 * the change invisible, so the chart carries a subtle band per season and the
 * plan cards name the threshold that is actually in force.
 *
 * Pure helpers live here so the boundaries are unit-tested; ChartView only
 * renders what these return.
 */

export type Season = 'winter' | 'summer';

export const SEASON_INFO: Record<Season, { label: string; range: string; long: string }> = {
  winter: { label: 'Winter', range: 'Nov 1 – Apr 30', long: 'Winter rate window (Nov 1 – Apr 30)' },
  summer: { label: 'Summer', range: 'May 1 – Oct 31', long: 'Summer rate window (May 1 – Oct 31)' },
};

/** The other season, for "…vs 600 kWh in summer" style notes. */
export const otherSeason = (s: Season): Season => (s === 'winter' ? 'summer' : 'winter');

/**
 * Rate season for a calendar month index (0 = Jan … 11 = Dec).
 * Winter runs November through April inclusive.
 */
export function seasonForMonthIndex(monthIndex: number): Season {
  return monthIndex >= 10 || monthIndex <= 3 ? 'winter' : 'summer';
}

/** Season containing `day` (`yyyy-MM-dd`, as stored in chart keys). */
export function seasonForDay(day: string): Season {
  const month = Number(day.slice(5, 7));
  return seasonForMonthIndex(Number.isFinite(month) && month >= 1 ? month - 1 : 0);
}

/** Season containing `month` (`yyyy-MM`). */
export function seasonForMonth(month: string): Season {
  const m = Number(month.slice(5, 7));
  return seasonForMonthIndex(Number.isFinite(m) && m >= 1 ? m - 1 : 0);
}

export type ZoomKind = 'monthly' | 'weekly' | 'daily' | 'hourly';

/**
 * Season for a chart bar key.
 * `hourly` keys are `HH:mm` (one day), so the day comes from `dayKey`
 * (zoomTarget) with `fallbackDay` as the caller's window start.
 */
export function seasonForChartKey(zoom: ZoomKind, key: string, dayKey?: string | null): Season {
  if (zoom === 'hourly') return seasonForDay(dayKey ?? '');
  if (zoom === 'monthly') return seasonForMonth(key);
  return seasonForDay(key);
}

export type SeasonSegment = {
  season: Season;
  /** First chart key in the run. */
  fromKey: string;
  /** Last chart key in the run. */
  toKey: string;
  /** Number of bars in the run. */
  bars: number;
};

/**
 * Contiguous runs of one season across the bars currently on screen.
 * Returns [] for an empty chart, one segment when the window sits inside a
 * single season, and two (or more) when it crosses Nov 1 / May 1.
 */
export function seasonSegments(
  keys: string[],
  seasonOf: (key: string) => Season,
): SeasonSegment[] {
  const out: SeasonSegment[] = [];
  for (const key of keys) {
    const season = seasonOf(key);
    const last = out[out.length - 1];
    if (last && last.season === season) {
      last.toKey = key;
      last.bars += 1;
    } else {
      out.push({ season, fromKey: key, toKey: key, bars: 1 });
    }
  }
  return out;
}

/** Segments for a chart's current bars. */
export function chartSeasonSegments(
  zoom: ZoomKind,
  keys: string[],
  dayKey?: string | null,
): SeasonSegment[] {
  return seasonSegments(keys, (key) => seasonForChartKey(zoom, key, dayKey));
}

/**
 * Segment run over actual chart bars, tracking the axis LABELS as well as the
 * keys — the XAxis renders `label`, so a ReferenceArea band has to be anchored
 * with those.
 */
export type ChartSegment = SeasonSegment & {
  fromLabel: string;
  toLabel: string;
  firstKey: string;
  lastKey: string;
};

export function chartSegments(
  zoom: ZoomKind,
  items: ReadonlyArray<{ key: string; label: string }>,
  dayKey?: string | null,
): ChartSegment[] {
  const out: ChartSegment[] = [];
  for (const item of items) {
    const season = seasonForChartKey(zoom, item.key, dayKey);
    const last = out[out.length - 1];
    if (last && last.season === season) {
      last.toKey = item.key;
      last.toLabel = item.label;
      last.bars += 1;
    } else {
      out.push({
        season,
        fromKey: item.key,
        toKey: item.key,
        fromLabel: item.label,
        toLabel: item.label,
        firstKey: item.key,
        lastKey: item.key,
        bars: 1,
      });
    }
  }
  return out;
}

/** Distinct seasons in `seasons`, in canonical (winter, summer) order. */
export function distinctSeasons(seasons: Season[]): Season[] {
  const seen = new Set(seasons);
  return (['winter', 'summer'] as Season[]).filter((s) => seen.has(s));
}
