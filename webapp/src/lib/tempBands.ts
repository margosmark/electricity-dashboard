/**
 * Wave T slice 1 — the temperature-banded usage curve.
 *
 * The question this answers is the one every Ontario summer raises and no
 * single chart in this app could: "is my bill about the weather, and about
 * WHICH weather?" Binning the household's own hourly readings by the outdoor
 * temperature of that same hour turns the answer into a picture:
 *
 *   • the COLD bins are flat — a house that heats with gas (or barely at all)
 *     draws the same ~1.3 kWh/h at −14 °C as at −2 °C, which kills the
 *     "winter is expensive because of heating" intuition on the user's own
 *     data instead of in an article;
 *   • the HOT bins climb — 18–24 °C already runs about twice the cold
 *     baseline, 24–30 °C about three times: that is the AC signature;
 *   • the share-of-kWh overlay says WHERE the money is. A bin can be
 *     expensive per hour and irrelevant to the bill simply because the year
 *     has few such hours — Toronto spends ~14% of its hours above 24 °C but
 *     they carry ~17% of the kWh, while the −10..5 °C bin holds a fifth of
 *     the year and a fifth of the energy at the baseline rate.
 *
 * Everything here is cadence-independent: readings are summed into clock
 * hours first (4×15-min readings equal 1×60-min for both kWh and kW), so a
 * 15-minute feed and a 60-minute feed produce the same curve.
 *
 * Temperatures arrive from `lib/openMeteo.ts` (client-side CDN fetch, cached
 * in the browser, aligned on absolute UTC hours). When they do not — offline,
 * blocked, no data for the dates — the report says how many hours it could
 * not explain rather than silently dropping them from the averages.
 */

import type { HourlyTemps } from './openMeteo';
import { tempAtC } from './openMeteo';
import type { ProcessedPoint } from './energy';

/** A temperature bin. Edges are °C; `minInclusive`/`maxExclusive` are half-open. */
export type TempBandDef = {
  id: string;
  /** What the bin is called on the axis. */
  label: string;
  minC: number;
  maxC: number;
  /** Right edge counts as inside (the 24–30 bin owns exactly 30). */
  maxInclusive: boolean;
};

/**
 * The seven bins, coldest to hottest. Fixed on purpose: the same seven bins
 * every time means a user can compare two windows without re-reading a legend,
 * and the task's published reference table is in these bins.
 */
export const TEMP_BANDS: readonly TempBandDef[] = [
  { id: 'lt-10', label: '< -10', minC: -Infinity, maxC: -10, maxInclusive: false },
  { id: '-10..5', label: '-10 to 5', minC: -10, maxC: 5, maxInclusive: false },
  { id: '5..12', label: '5 to 12', minC: 5, maxC: 12, maxInclusive: false },
  { id: '12..18', label: '12 to 18', minC: 12, maxC: 18, maxInclusive: false },
  { id: '18..24', label: '18 to 24', minC: 18, maxC: 24, maxInclusive: false },
  { id: '24..30', label: '24 to 30', minC: 24, maxC: 30, maxInclusive: true },
  { id: 'gt-30', label: 'over 30', minC: 30, maxC: Infinity, maxInclusive: false },
] as const;

/** Which bin a temperature belongs to, or null when there is no temperature. */
export function bandIndexOf(tempC: number | null | undefined): number | null {
  if (typeof tempC !== 'number' || !Number.isFinite(tempC)) return null;
  for (let i = 0; i < TEMP_BANDS.length; i += 1) {
    const b = TEMP_BANDS[i];
    const below = b.maxC === Infinity ? true : b.maxInclusive ? tempC <= b.maxC : tempC < b.maxC;
    if (tempC >= b.minC && below) return i;
  }
  return null;
}

/** One bin's numbers. */
export type TempBandRow = {
  band: TempBandDef;
  /** Clock hours that landed in this bin. */
  hours: number;
  /** Energy those hours carried. */
  kwh: number;
  /** What that energy cost under the plan on screen. */
  cost: number;
  /** The headline: average draw per hour, i.e. average kW. */
  meanKwhPerHour: number;
  /** What an hour in this bin actually cost. */
  centsPerKwh: number;
  /** Share of the MATCHED energy — where the bill's kWh actually sits. */
  shareOfKwh: number;
  /** Mean temperature of the hours in the bin (honest about the spread). */
  meanTempC: number;
};

export type TempBandReport = {
  rows: TempBandRow[];
  /** Hours that had both a reading and a temperature. */
  matchedHours: number;
  /** Hours the window's readings cover. */
  totalHours: number;
  /** matchedHours / totalHours — the panel's honesty number. */
  coverage: number;
  /** Energy behind the matched hours (the denominator of every share). */
  totalKwh: number;
  /** The bin whose mean draw is highest — the "what drives your peak" answer. */
  peakBandId: string | null;
};

/** The plan on screen, which decides how a reading's cost is read. */
export type TempBandPlan = 'TOU' | 'Tiered' | 'ULO';

const costOf = (row: ProcessedPoint, plan: TempBandPlan): number =>
  plan === 'TOU' ? row.costTOU : plan === 'ULO' ? row.costULO : row.costTiered;

/**
 * Bin every hour of `rows` by that hour's outdoor temperature.
 *
 * Hours with no temperature are counted, never quietly averaged away: they
 * show up as totalHours − matchedHours and drive `coverage`, so a partial
 * fetch is visibly partial.
 */
export function buildTempBandReport(
  rows: ProcessedPoint[],
  temps: HourlyTemps | null | undefined,
  plan: TempBandPlan,
): TempBandReport {
  const hours = new Map<number, { kwh: number; cost: number }>();
  for (const row of rows) {
    const key = Math.floor(row.timestamp / 3600);
    const bucket = hours.get(key);
    if (bucket) {
      bucket.kwh += row.usage_kwh;
      bucket.cost += costOf(row, plan);
    } else {
      hours.set(key, { kwh: row.usage_kwh, cost: costOf(row, plan) });
    }
  }

  const acc = TEMP_BANDS.map(() => ({ hours: 0, kwh: 0, cost: 0, tempSum: 0 }));
  let matchedHours = 0;
  let totalKwh = 0;
  for (const [hour, bucket] of hours) {
    const tempC = tempAtC(temps, hour * 3600);
    const index = bandIndexOf(tempC);
    if (index === null || tempC === null) continue;
    matchedHours += 1;
    totalKwh += bucket.kwh;
    acc[index].hours += 1;
    acc[index].kwh += bucket.kwh;
    acc[index].cost += bucket.cost;
    acc[index].tempSum += tempC;
  }

  const rowsOut: TempBandRow[] = TEMP_BANDS.map((band, i) => {
    const a = acc[i];
    return {
      band,
      hours: a.hours,
      kwh: a.kwh,
      cost: a.cost,
      meanKwhPerHour: a.hours > 0 ? a.kwh / a.hours : 0,
      centsPerKwh: a.kwh > 0 ? (a.cost / a.kwh) * 100 : 0,
      shareOfKwh: totalKwh > 0 ? a.kwh / totalKwh : 0,
      meanTempC: a.hours > 0 ? a.tempSum / a.hours : 0,
    };
  });

  let peakBandId: string | null = null;
  let peak = -Infinity;
  for (const row of rowsOut) {
    if (row.hours > 0 && row.meanKwhPerHour > peak) {
      peak = row.meanKwhPerHour;
      peakBandId = row.band.id;
    }
  }

  const totalHours = hours.size;
  return {
    rows: rowsOut,
    matchedHours,
    totalHours,
    coverage: totalHours > 0 ? matchedHours / totalHours : 0,
    totalKwh,
    peakBandId,
  };
}

/** True when the window has nothing to say (no readings, or nothing matched). */
export function tempBandEmpty(report: TempBandReport): boolean {
  return report.totalHours === 0 || report.matchedHours === 0;
}
