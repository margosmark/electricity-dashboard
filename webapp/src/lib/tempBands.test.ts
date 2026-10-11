/**
 * Wave T — lib/tempBands.ts.
 *
 * The bin edges, the cadence rule (4×15-minute readings in one hour is ONE
 * hour, not four), the plan-priced ¢/kWh, and the honesty numbers: hours that
 * could not be matched to a temperature are counted as unmatched and left out
 * of the averages, never averaged in as if they were 0 °C.
 */

import { describe, it, expect } from 'vitest';

import { TEMP_BANDS, bandIndexOf, buildTempBandReport, tempBandEmpty } from './tempBands';
import type { HourlyTemps } from './openMeteo';
import { tieredCostFor, tieredRateCentsFor } from './energy';
import type { ProcessedPoint, RateSet } from './energy';

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** One reading at an absolute UTC hour. */
function point(hour: number, usage: number, cents = 0): ProcessedPoint {
  const timestamp = hour * 3600;
  const dateObj = new Date(timestamp * 1000);
  return {
    timestamp,
    usage_kwh: usage,
    dateObj,
    dayStr: dateObj.toISOString().slice(0, 10),
    hourStr: `${String(dateObj.getUTCHours()).padStart(2, '0')}:00`,
    touCategory: 'Off-Peak',
    uloCategory: 'Overnight',
    isWinter: false,
    costTOU: cents,
    costTiered: cents,
    costULO: cents,
    activeRateSet: rateSet,
  };
}

/** A series covering [startHour, startHour + temps.length). */
const series = (startHour: number, temps: (number | null)[]): HourlyTemps => ({ startHour, values: temps });

const HOUR_0 = 1_751_600; // a round hour index; nothing here is date-sensitive

describe('bin edges', () => {
  it('has the seven fixed bins, coldest to hottest', () => {
    expect(TEMP_BANDS.map((b) => b.id)).toEqual([
      'lt-10', '-10..5', '5..12', '12..18', '18..24', '24..30', 'gt-30',
    ]);
  });

  it('puts each edge in exactly one bin', () => {
    expect(bandIndexOf(-20.4)).toBe(0);
    expect(bandIndexOf(-10.1)).toBe(0);
    expect(bandIndexOf(-10)).toBe(1); // the lower edge belongs to the warmer bin
    expect(bandIndexOf(4.9)).toBe(1);
    expect(bandIndexOf(5)).toBe(2);
    expect(bandIndexOf(11.9)).toBe(2);
    expect(bandIndexOf(12)).toBe(3);
    expect(bandIndexOf(18)).toBe(4);
    expect(bandIndexOf(23.9)).toBe(4);
    expect(bandIndexOf(24)).toBe(5);
    expect(bandIndexOf(30)).toBe(5); // 30 belongs to "24 to 30", not "over 30"
    expect(bandIndexOf(30.1)).toBe(6);
    expect(bandIndexOf(41)).toBe(6);
  });

  it('has no bin for "no temperature"', () => {
    expect(bandIndexOf(null)).toBeNull();
    expect(bandIndexOf(undefined)).toBeNull();
    expect(bandIndexOf(Number.NaN)).toBeNull();
  });
});

describe('buildTempBandReport', () => {
  it('returns all seven bins, and says so plainly when there is nothing to band', () => {
    const report = buildTempBandReport([], null, 'TOU');
    expect(report.rows).toHaveLength(7);
    expect(report.totalHours).toBe(0);
    expect(report.matchedHours).toBe(0);
    expect(tempBandEmpty(report)).toBe(true);
    expect(report.peakBandId).toBeNull();
  });

  it('counts an hour once, however many readings that hour has', () => {
    // 4×15-min readings in one hour is one hour of ~1 kW, not four hours.
    const rows = [point(HOUR_0, 0.25), point(HOUR_0, 0.25), point(HOUR_0, 0.25), point(HOUR_0, 0.25)];
    const report = buildTempBandReport(rows, series(HOUR_0, [20]), 'TOU');
    expect(report.totalHours).toBe(1);
    expect(report.matchedHours).toBe(1);
    const band = report.rows[4]; // 18..24
    expect(band.hours).toBe(1);
    expect(band.kwh).toBeCloseTo(1, 6);
    expect(band.meanKwhPerHour).toBeCloseTo(1, 6);
  });

  it('prices each bin at the plan on screen and shares the kWh out to 100%', () => {
    // 4 hours: two cold, two hot, at 1 kWh each and 10¢/kWh.
    const rows = [point(HOUR_0, 1, 0.1), point(HOUR_0 + 1, 1, 0.1), point(HOUR_0 + 2, 1, 0.1), point(HOUR_0 + 3, 1, 0.1)];
    const temps = series(HOUR_0, [-12, -4, 26, 31]);
    const report = buildTempBandReport(rows, temps, 'TOU');

    expect(report.rows[0].hours).toBe(1); // < -10
    expect(report.rows[1].hours).toBe(1); // -10..5
    expect(report.rows[5].hours).toBe(1); // 24..30
    expect(report.rows[6].hours).toBe(1); // over 30

    for (const band of report.rows.filter((b) => b.hours > 0)) {
      expect(band.kwh).toBeCloseTo(1, 6);
      expect(band.centsPerKwh).toBeCloseTo(10, 6); // 0.1 $ ÷ 1 kWh
    }
    expect(report.rows.reduce((s, b) => s + b.shareOfKwh, 0)).toBeCloseTo(1, 9);
    expect(report.rows[1].shareOfKwh).toBeCloseTo(0.25, 9);
    expect(report.totalKwh).toBeCloseTo(4, 6);
  });

  it('prices with the plan that was asked for', () => {
    const rows = [point(HOUR_0, 2, 0.5)];
    const temps = series(HOUR_0, [26]);
    expect(buildTempBandReport(rows, temps, 'TOU').rows[5].centsPerKwh).toBeCloseTo(25, 6);
    // Tiered is NOT the per-reading `costTiered` column (25¢ here): a 2 kWh
    // summer hour sits under its prorated month allowance, so the window
    // prices at tier 1 — 12¢. Corrected, not worked around: the old 25 was
    // the tier-1 COLUMN being read as if it were the window's rate.
    expect(buildTempBandReport(rows, temps, 'Tiered').rows[5].centsPerKwh).toBeCloseTo(12, 6);
  });

  it('prices Tiered at the WINDOW rate, so the bands add back to the plan card', () => {
    // 10 July days × 100 kWh — the same threshold-crossing window
    // energy.test.ts pins. Summing the per-reading tier-1 field would book
    // $120.00 across these bins; the window rule books $137.66, and the
    // blended 13.7657¢/kWh is what every band must report.
    const rows = Array.from({ length: 240 }, (_, h) => point(HOUR_0 + h, 100 / 24, 0.12));
    const temps = series(HOUR_0, Array.from({ length: 240 }, (_, h) => (h % 2 ? 27 : -2)));
    const report = buildTempBandReport(rows, temps, 'Tiered');

    const kwh = report.rows.reduce((s, b) => s + b.kwh, 0);
    const cost = report.rows.reduce((s, b) => s + b.cost, 0);
    expect(kwh).toBeCloseTo(1000, 6); // 240 h × 100/24 kWh = 10 days × 100
    expect(cost).toBeCloseTo(tieredCostFor(rows), 6);
    // No bin may disagree with the window: Tiered has no time dimension.
    for (const band of report.rows.filter((b) => b.hours > 0)) {
      expect(band.centsPerKwh).toBeCloseTo(tieredRateCentsFor(rows)!, 6);
    }
  });

  it('leaves unmatched hours OUT of the averages and says how many there were', () => {
    const rows = [point(HOUR_0, 1), point(HOUR_0 + 1, 5), point(HOUR_0 + 2, 3)];
    // The middle hour has no temperature.
    const report = buildTempBandReport(rows, series(HOUR_0, [20, null, 20]), 'TOU');
    expect(report.totalHours).toBe(3);
    expect(report.matchedHours).toBe(2);
    expect(report.coverage).toBeCloseTo(2 / 3, 9);
    // The 5 kWh hour is NOT in the average: (1 + 3) / 2, not (1 + 5 + 3) / 3.
    expect(report.rows[4].meanKwhPerHour).toBeCloseTo(2, 9);
    expect(report.totalKwh).toBeCloseTo(4, 9);
    expect(tempBandEmpty(report)).toBe(false);
  });

  it('reports no match — not a flat winter — when there are no temperatures at all', () => {
    const rows = Array.from({ length: 24 }, (_, h) => point(HOUR_0 + h, 1.3));
    const report = buildTempBandReport(rows, null, 'TOU');
    expect(report.matchedHours).toBe(0);
    expect(report.coverage).toBe(0);
    expect(tempBandEmpty(report)).toBe(true);
    expect(report.rows.every((b) => b.hours === 0 && b.meanKwhPerHour === 0)).toBe(true);
  });

  it('ignores temperatures for hours the household has no readings for', () => {
    const rows = [point(HOUR_0, 1)];
    // A whole year of weather, of which one hour is used.
    const temps = series(HOUR_0, Array.from({ length: 24 * 30 }, () => 30));
    const report = buildTempBandReport(rows, temps, 'TOU');
    expect(report.matchedHours).toBe(1);
    expect(report.totalHours).toBe(1);
    expect(report.rows[5].hours + report.rows[6].hours).toBe(1);
  });

  it('names the hottest bin — the one that drives the peak', () => {
    const rows = [
      point(HOUR_0, 1), point(HOUR_0 + 1, 1),
      point(HOUR_0 + 2, 4), point(HOUR_0 + 3, 4),
    ];
    const report = buildTempBandReport(rows, series(HOUR_0, [2, 3, 27, 29]), 'TOU');
    expect(report.peakBandId).toBe('24..30');
    expect(report.rows.find((b) => b.band.id === '24..30')!.meanKwhPerHour).toBeCloseTo(4, 9);
    expect(report.rows.find((b) => b.band.id === '-10..5')!.meanKwhPerHour).toBeCloseTo(1, 9);
  });

  it('reports each bin\u2019s mean temperature, for the tooltip and the audit', () => {
    const rows = [point(HOUR_0, 1), point(HOUR_0 + 1, 1)];
    const report = buildTempBandReport(rows, series(HOUR_0, [19, 23]), 'TOU');
    expect(report.rows[4].meanTempC).toBeCloseTo(21, 9);
  });
});

describe('the shape the card exists to show', () => {
  it('is flat across the cold bins and triples on the hot side', () => {
    // 96 hours: 48 cold at a steady 1.3 kWh/h, 48 hot rising to ~4 kWh/h.
    const rows: ProcessedPoint[] = [];
    const temps: number[] = [];
    for (let h = 0; h < 96; h += 1) {
      const cold = h < 48;
      rows.push(point(HOUR_0 + h, cold ? 1.3 : 4.2));
      // One cold bin and one hot bin only, so the share arithmetic is checkable.
      temps.push(cold ? -2 : 27);
    }
    const report = buildTempBandReport(rows, series(HOUR_0, temps), 'TOU');

    const coldest = report.rows.find((b) => b.band.id === '-10..5')!;
    const hottest = report.rows.find((b) => b.band.id === '24..30')!;
    expect(coldest.hours).toBeGreaterThan(0);
    expect(hottest.hours).toBeGreaterThan(0);
    expect(coldest.meanKwhPerHour).toBeCloseTo(1.3, 6);
    expect(hottest.meanKwhPerHour).toBeCloseTo(4.2, 6);
    expect(hottest.meanKwhPerHour / coldest.meanKwhPerHour).toBeGreaterThan(3);
    // Half the hours, half the energy — the shares must reflect that.
    expect(coldest.shareOfKwh + hottest.shareOfKwh).toBeCloseTo(1, 9);
  });
});
