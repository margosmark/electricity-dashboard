import { describe, it, expect } from 'vitest';
import {
  analyzeTouShifts,
  LOOKBACK_WEEKS,
} from './touShift';
import { processRawData, type DataPoint, type RateSet } from './energy';

const rates: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** Unix seconds for a local-time date (mirrors how DataPoint timestamps work). */
function ts(year: number, month: number, day: number, hour: number): number {
  return Math.floor(new Date(year, month, day, hour, 0, 0).getTime() / 1000);
}

/**
 * Build raw readings for a weekly pattern.
 * @param weeks        how many consecutive weeks (ending at the anchor week)
 * @param pattern      weekday(0=Sun)-to-hours + kWh factory (weekIndex => kWh)
 * @param anchor       a date inside the newest week (the data's "last" week)
 */
type PatternSlot = { weekday: number; hours: number[]; kwh: (week: number) => number };

function buildData(
  weeks: number,
  pattern: PatternSlot[],
  anchor: { year: number; month: number; day: number },
): DataPoint[] {
  // Monday of the anchor week
  const anchorDate = new Date(anchor.year, anchor.month, anchor.day);
  const dow = anchorDate.getDay(); // 0=Sun
  const daysBackToMonday = (dow + 6) % 7;
  const monday = new Date(anchorDate);
  monday.setDate(monday.getDate() - daysBackToMonday);

  const out: DataPoint[] = [];
  for (let w = 0; w < weeks; w++) {
    const weekMonday = new Date(monday);
    weekMonday.setDate(weekMonday.getDate() - (weeks - 1 - w) * 7);
    for (const slot of pattern) {
      // Map slot weekday (0=Sun) onto this week's dates
      const delta = (slot.weekday + 6) % 7; // Monday=0 offset
      const day = new Date(weekMonday);
      day.setDate(day.getDate() + delta);
      for (const hour of slot.hours) {
        out.push({ timestamp: ts(day.getFullYear(), day.getMonth(), day.getDate(), hour), usage_kwh: slot.kwh(w) });
      }
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function run(raw: DataPoint[], plan: 'TOU' | 'Tiered' | 'ULO' = 'TOU') {
  return analyzeTouShifts(processRawData(raw, [rates]), plan, rates);
}

describe('analyzeTouShifts', () => {
  it('returns no-data for an empty dataset', () => {
    const result = run([]);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-data');
  });

  it('returns insufficient-history when fewer than 3 weeks are loaded', () => {
    const raw = buildData(2, [{ weekday: 3, hours: [12, 13], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('insufficient-history');
    expect(result.dataWeeks).toBe(2);
  });

  it('detects a recurring On-Peak block present in 4 of 5 weeks and prices shift options', () => {
    // Wednesday 12:00-14:00, present in weeks 0-3 but missing in week 4
    // (week index counts from the OLDEST week; pattern drops out recently)
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        {
          weekday: 3,
          hours: [12, 13],
          kwh: (w) => (w < 4 ? 2.0 : 0),
        },
      ],
      { year: 2026, month: 7, day: 15 },
    ).filter((d) => d.usage_kwh > 0);

    const result = run(raw);
    expect(result.emptyReason).toBeNull();
    expect(result.blocks).toHaveLength(1);

    const block = result.blocks[0];
    expect(block.weekday).toBe(3); // Wednesday
    expect(block.startHour).toBe(12);
    expect(block.endHour).toBe(14); // 12:00 and 13:00 → exclusive end
    expect(block.label).toBe('Wed 12:00–14:00');
    expect(block.weeksSeen).toBe(4);
    expect(block.avgWeeklyKwh).toBeCloseTo(4.0, 5); // 2h × 2.0 kWh
    expect(block.consistencyCv).toBeCloseTo(0, 5); // perfectly steady
    expect(block.baselineRateCents).toBe(20.3); // TOU On-Peak

    // Options ranked by monthly $: Overnight ULO (20.3−3.9=16.4¢) beats
    // weekend/off-peak TOU (20.3−9.8=10.5¢). Weekend and off-peak tie on rate.
    expect(block.options.map((o) => o.target)).toEqual(['overnight_ulo', 'weekend', 'offpeak_tou']);
    const overnight = block.options[0];
    expect(overnight.savingsCentsPerKwh).toBeCloseTo(16.4, 5);
    // 4 kWh/wk × 0.164 $/kWh × 52/12 wk/mo = 2.8427…
    expect(overnight.monthlySavings).toBeCloseTo(4.0 * 0.164 * (52 / 12), 4);
    expect(block.bestMonthlySavings).toBe(overnight.monthlySavings);
    // Every option must carry its honest assumption
    for (const o of block.options) expect(o.assumption.length).toBeGreaterThan(10);
  });

  it('requires recurrence in >=3 of the last 5 weeks (2 weeks of a 5-week dataset is rejected)', () => {
    // Data spans all 5 weeks (baseline night reading every week) but the
    // On-Peak pattern only shows up in the last 2 → rejected as non-recurring.
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 3, hours: [12], kwh: (w) => (w >= 3 ? 2.0 : 0) },
        { weekday: 3, hours: [22], kwh: () => 0.4 }, // Off-Peak anchor reading
      ],
      { year: 2026, month: 7, day: 15 },
    ).filter((d) => d.usage_kwh > 0);
    const result = run(raw);
    expect(result.dataWeeks).toBe(LOOKBACK_WEEKS);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });

  it('rejects inconsistent usage (CV > 0.4) even when the slot recurs every week', () => {
    // Wildly varying kWh: 0.5 / 6.0 alternating → CV ≈ 0.77
    const raw = buildData(
      LOOKBACK_WEEKS,
      [{ weekday: 3, hours: [12], kwh: (w) => (w % 2 === 0 ? 0.5 : 6.0) }],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });

  it('ignores Off-Peak slots: weekend recurrence is never recommended', () => {
    // Saturday 13:00 is Off-Peak under TOU all year → nothing to shift from
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 6, hours: [13], kwh: () => 2.5 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw);
    expect(result.blocks).toEqual([]);
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });

  it('ignores weekday Off-Peak hours (e.g. 22:00)', () => {
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 2, hours: [22], kwh: () => 2.5 }], { year: 2026, month: 7, day: 15 });
    expect(run(raw).blocks).toEqual([]);
  });

  it('merges consecutive On-Peak hours into one block and splits non-consecutive ones', () => {
    // Summer weekday On-Peak = 11:00–17:00 → 12,13,14 and 16 qualify (15 is the gap)
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 1, hours: [12, 13, 14], kwh: () => 1.5 }, // 12–15 contiguous
        { weekday: 1, hours: [16], kwh: () => 1.2 },         // gap at 15 → separate
      ],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks.map((b) => b.id)).toEqual(['mon-12-15', 'mon-16-17']);
    expect(result.blocks[0].avgWeeklyKwh).toBeCloseTo(4.5, 5);
    expect(result.blocks[0].label).toBe('Mon 12:00–15:00');
  });

  it('ranks blocks by monthly dollar impact (bigger shiftable load first)', () => {
    const raw = buildData(
      LOOKBACK_WEEKS,
      [
        { weekday: 2, hours: [12], kwh: () => 1.0 },   // smaller block
        { weekday: 4, hours: [12, 13], kwh: () => 3.0 }, // 6 kWh/wk → bigger
      ],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].weekday).toBe(4);
    expect(result.blocks[0].bestMonthlySavings).toBeGreaterThan(result.blocks[1].bestMonthlySavings);
    // Total = sum of best options
    expect(result.totalMonthlySavings).toBeCloseTo(
      result.blocks.reduce((acc, b) => acc + b.bestMonthlySavings, 0),
      6,
    );
  });

  it('drops destinations that cannot save money (never shows negative/nonsense savings)', () => {
    // Custom rate set where ULO overnight is MORE expensive than TOU on-peak:
    // the overnight option must vanish, not show a negative number.
    const weirdRates: RateSet = {
      ...rates,
      ulo: { ...rates.ulo, overnight: 99.0 },
    };
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [12], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const processed = processRawData(raw, [weirdRates]);
    const result = analyzeTouShifts(processed, 'TOU', weirdRates);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].options.map((o) => o.target)).not.toContain('overnight_ulo');
    for (const o of result.blocks[0].options) {
      expect(o.savingsCentsPerKwh).toBeGreaterThan(0);
      expect(o.monthlySavings).toBeGreaterThan(0);
    }
  });

  it('uses the ULO mid-peak baseline when the plan is ULO (same wall-clock, different category)', () => {
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [12], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw, 'ULO');
    expect(result.blocks).toHaveLength(1);
    // Summer 12:00 is ULO Mid-Peak (Overnight ends at 07:00, On-Peak starts 16:00)
    expect(result.blocks[0].baselineRateCents).toBe(15.7);
    // Savings priced against mid-peak: 15.7 − 9.8 = 5.9¢ for off-peak targets
    const offpeak = result.blocks[0].options.find((o) => o.target === 'weekend')!;
    expect(offpeak.savingsCentsPerKwh).toBeCloseTo(5.9, 5);
  });

  it('prices against the Tiered flat baseline when the plan is Tiered', () => {
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [12], kwh: () => 2.0 }], { year: 2026, month: 7, day: 15 });
    const result = run(raw, 'Tiered');
    expect(result.blocks[0].baselineRateCents).toBe(12.0);
    const overnight = result.blocks[0].options.find((o) => o.target === 'overnight_ulo')!;
    expect(overnight.savingsCentsPerKwh).toBeCloseTo(8.1, 5); // 12.0 − 3.9
  });

  it('anchors the 5-week window to the newest reading, not to today', () => {
    // Data from January (past relative to "now" = October 2026) — analysis must
    // still work (deterministic: no Date.now() anywhere in the window math).
    // Winter weekday On-Peak = 07:00–11:00 and 17:00–19:00 → use 18:00.
    const raw = buildData(LOOKBACK_WEEKS, [{ weekday: 3, hours: [18], kwh: () => 2.0 }], { year: 2026, month: 0, day: 20 });
    const result = run(raw);
    expect(result.blocks).toHaveLength(1);
    expect(result.dataWeeks).toBe(LOOKBACK_WEEKS);
  });

  it('handles a dataset longer than 5 weeks by only considering the last 5', () => {
    const raw = buildData(
      8,
      [{ weekday: 3, hours: [12], kwh: (w) => (w >= 5 ? 2.0 : 0) }],
      { year: 2026, month: 7, day: 15 },
    ).filter((d) => d.usage_kwh > 0);
    const result = run(raw);
    // Pattern exists only in the last 3 of 8 weeks → inside the window, qualifies
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].weeksSeen).toBe(3);
    // Only 3 weeks carry any readings at all (older weeks were filtered out)
    expect(result.dataWeeks).toBe(3);
  });

  it('treats zero-usage weeks as absent, not as consistent zeros', () => {
    const raw = buildData(
      LOOKBACK_WEEKS,
      [{ weekday: 3, hours: [12], kwh: (w) => (w === 0 ? 2.0 : 0) }],
      { year: 2026, month: 7, day: 15 },
    );
    const result = run(raw);
    expect(result.blocks).toEqual([]); // only 1 real week
    expect(result.emptyReason).toBe('no-recurring-onpeak');
  });
});
