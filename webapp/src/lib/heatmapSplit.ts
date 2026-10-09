/**
 * Wave R — weekday vs weekend, as two grids instead of one.
 *
 * The existing heatmap is a single 7×24 grid. It is honest, and it is also
 * where "my EV charges weekdays at 19:00" goes to hide: five weekday rows
 * share their colour scale with two weekend rows whose shape is completely
 * different (no 07–17 commute trough, no 19:00 charger spike), so the cell
 * that would give the weekday pattern away is compressed into the same
 * mid-blue as everything around it. Two condensed grids — Mon–Fri at 5×24
 * and Sat+Sun at 2×24 — each read at a glance on their own.
 *
 * The split is a LAYOUT change, not a measurement change: both grids keep
 * `maxAvg` from the source (the whole dataset's biggest cell), so a blue in
 * the weekday grid is the same kWh as the same blue in the weekend grid and
 * the two can still be compared by eye. Re-scaling each grid independently
 * would make every pattern pop and would be a lie about the numbers.
 */

import type { HeatmapCell, HeatmapData } from './energy';

/** `grid` is indexed by `Date.getDay()`, so row 0 is Sunday. */
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Display order for each grid (the source grid's own row order is Sun-first). */
export const WEEKDAY_ROWS = [1, 2, 3, 4, 5] as const;
export const WEEKEND_ROWS = [6, 0] as const;

export type HeatmapGroup = {
  id: 'weekday' | 'weekend';
  /** Panel heading. */
  label: string;
  /** Row labels in display order — `DAY_LABELS[day]` for each source row. */
  dayLabels: string[];
  /** The source grid's rows, reordered. `rows[r][hour]`. */
  rows: HeatmapCell[][];
  /** How many distinct calendar days feed this grid (for the caption). */
  days: number;
};

export type HeatmapSplit = {
  weekday: HeatmapGroup;
  weekend: HeatmapGroup;
  /** Shared colour scale — the source grid's own max, never re-derived. */
  maxAvg: number;
};

function group(
  id: HeatmapGroup['id'],
  label: string,
  sourceOrder: readonly number[],
  data: HeatmapData,
): HeatmapGroup {
  // A cell's `days` is how many calendar days fed it; a whole group's
  // coverage is the largest of those (the busiest hour seen that often).
  let days = 0;
  const rows = sourceOrder.map((dayIndex) => {
    const row = data.grid[dayIndex];
    for (const cell of row) if (cell.days > days) days = cell.days;
    return row;
  });
  return {
    id,
    label,
    dayLabels: sourceOrder.map((dayIndex) => DAY_LABELS[dayIndex]),
    rows,
    days,
  };
}

/**
 * Split a 7×24 weekday heatmap into the weekday and weekend grids.
 *
 * Pure re-ordering: every cell object comes back untouched, so a test can
 * assert that `split(...).weekday.rows[0][19] === source.grid[1][19]` and
 * know nothing was re-averaged.
 */
export function splitHeatmap(data: HeatmapData): HeatmapSplit {
  return {
    weekday: group('weekday', 'Weekdays', WEEKDAY_ROWS, data),
    weekend: group('weekend', 'Weekend', WEEKEND_ROWS, data),
    maxAvg: data.maxAvg,
  };
}

/**
 * The same colour buckets the old single grid used, keyed on the SHARED
 * max — so a cell looks identical whether it is drawn in one grid or the
 * other.
 */
export function heatColor(avg: number, maxAvg: number): string {
  if (maxAvg <= 0 || avg <= 0) return 'bg-slate-100';
  const intensity = avg / maxAvg;
  if (intensity > 0.8) return 'bg-red-600 border-red-800';
  if (intensity > 0.6) return 'bg-orange-500 border-orange-700';
  if (intensity > 0.4) return 'bg-yellow-400 border-yellow-600';
  if (intensity > 0.2) return 'bg-blue-300 border-blue-500';
  return 'bg-slate-100';
}
