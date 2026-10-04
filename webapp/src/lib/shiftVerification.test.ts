import { describe, it, expect } from 'vitest';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from './energy';
import {
  analyzeShiftVerification,
  offPeakLabelFor,
  MIN_DAYS_PER_WINDOW,
} from './shiftVerification';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/**
 * Hourly rows over `days` days starting Monday 2026-06-01 (no DST in June,
 * so every day really does hold 24 readings).
 *
 * `weekdayEnergy` picks the profile per day; weekends always run flat.
 */
function hourly(
  days: number,
  weekdayEnergy: (dayOfMonth: number, hour: number, weekend: boolean) => number,
): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let day = 0; day < days; day++) {
    for (let h = 0; h < 24; h++) {
      const d = new Date(2026, 5, 1 + day, h, 0, 0);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      raw.push({
        timestamp: Math.floor(d.getTime() / 1000),
        usage_kwh: weekdayEnergy(d.getDate(), h, weekend),
      });
    }
  }
  return processRawData(raw, [RATES]);
}

/** Recent week (day >= 22) heavy off-peak, prior week heavy on-peak. */
const improvedWeek = (day: number, h: number, weekend: boolean) => {
  if (weekend) return 1;
  const off = h >= 19 || h < 7;
  const recent = day >= 22;
  if (recent) return off ? 2.4 : 0.6;
  return off ? 0.6 : 2.4;
};

/** Exactly the same shape in both windows. */
const flatWeek = () => 1.4;

describe('offPeakLabelFor', () => {
  it('names each plan’s cheap window honestly, and has none for Tiered', () => {
    expect(offPeakLabelFor('TOU')).toBe('off-peak');
    expect(offPeakLabelFor('ULO')).toBe('overnight + weekend off-peak');
    expect(offPeakLabelFor('Tiered')).toBeNull();
  });
});

describe('pickAnchorDay (via the reported anchorDay)', () => {
  it('takes the newest day when it is complete', () => {
    const v = analyzeShiftVerification(hourly(20, flatWeek), 'TOU');
    expect(v.anchorDay).toBe('2026-06-20');
    expect(v.recent!.days).toBe(7);
    expect(v.prior!.days).toBe(7);
  });

  it('steps back past a half-recorded last day', () => {
    const full = hourly(28, flatWeek);
    const cut = full.filter((r) => !(r.dayStr === '2026-06-28' && r.dateObj.getHours() > 5));
    const v = analyzeShiftVerification(cut, 'TOU');
    expect(v.anchorDay).toBe('2026-06-27');
    expect(v.recent!.days).toBe(7);
    expect(v.prior!.days).toBe(7);
  });
});

describe('analyzeShiftVerification', () => {
  it('reports no-data on an empty dataset', () => {
    const v = analyzeShiftVerification([], 'TOU');
    expect(v.ready).toBe(false);
    expect(v.emptyReason).toBe('no-data');
    expect(v.headline).toContain('NO DATA');
    expect(v.caveat).toContain('hint, not proof');
  });

  it('refuses to compare when the prior week is not recorded', () => {
    const rows = hourly(10, flatWeek);
    const v = analyzeShiftVerification(rows, 'TOU');
    expect(v.ready).toBe(false);
    expect(v.emptyReason).toBe('insufficient-history');
    expect(v.recent!.days).toBe(7);
    expect(v.prior!.days).toBeLessThan(MIN_DAYS_PER_WINDOW);
    expect(v.detail).toContain('upload a longer export');
  });

  it('says "no measurable change yet" when both weeks look the same', () => {
    const v = analyzeShiftVerification(hourly(28, flatWeek), 'TOU');
    expect(v.ready).toBe(true);
    expect(v.verdict).toBe('no-change');
    expect(v.headline).toBe('No measurable change yet');
    expect(v.shareDeltaPts).toBeCloseTo(0, 5);
    expect(v.costDelta).toBeCloseTo(0, 4);
  });

  it('calls an off-peak share jump an improvement, with the dollars behind it', () => {
    const v = analyzeShiftVerification(hourly(28, improvedWeek), 'TOU');
    expect(v.ready).toBe(true);
    expect(v.verdict).toBe('improved');
    expect(v.shareDeltaPts!).toBeGreaterThan(40);
    expect(v.costDelta).toBeGreaterThan(0);
    expect(v.headline).toMatch(/Off-peak share up \d+ pts/);
    expect(v.headline).toContain('/wk better');
    expect(v.recent!.offPeakShare!).toBeGreaterThan(0.75);
    expect(v.prior!.offPeakShare!).toBeLessThan(0.45);
    expect(v.detail).toContain('Last 7 days');
    expect(v.detail).toContain('Prior 7 days');
    expect(v.detail).toContain('off-peak');
  });

  it('calls a regression worse', () => {
    // The mirror image of improvedWeek: last week off-peak, this week not.
    const worsened = (day: number, h: number, weekend: boolean) => {
      if (weekend) return 1;
      const off = h >= 19 || h < 7;
      const recent = day >= 22;
      if (recent) return off ? 0.6 : 2.4;
      return off ? 2.4 : 0.6;
    };
    const v = analyzeShiftVerification(hourly(28, worsened), 'TOU');
    expect(v.ready).toBe(true);
    expect(v.verdict).toBe('worse');
    expect(v.shareDeltaPts!).toBeLessThan(-40);
    expect(v.costDelta).toBeLessThan(0);
    expect(v.headline).toMatch(/Off-peak share down \d+ pts/);
  });

  it('reports divergence honestly when share rises but the week costs more', () => {
    // Far more energy in the recent week — the shift is real, the bill is too.
    const rows = hourly(28, (day, h, weekend) => {
      const recent = day >= 22;
      if (weekend) return recent ? 3 : 1;
      const off = h >= 19 || h < 7;
      if (recent) return off ? 4 : 2;
      return off ? 0.5 : 2.5;
    });
    const v = analyzeShiftVerification(rows, 'TOU');
    expect(v.ready).toBe(true);
    expect(v.verdict).toBe('diverged');
    expect(v.shareDeltaPts!).toBeGreaterThan(0);
    expect(v.costDelta).toBeLessThan(0);
    expect(v.headline).toContain('weather or time at home');
  });

  it('reports divergence the other way: cheaper week that is just less usage', () => {
    const rows = hourly(28, (day, h, weekend) => {
      const recent = day >= 22;
      if (weekend) return recent ? 0.4 : 1;
      const off = h >= 19 || h < 7;
      if (recent) return off ? 0.4 : 1.2;
      return off ? 1.6 : 1.6;
    });
    const v = analyzeShiftVerification(rows, 'TOU');
    expect(v.ready).toBe(true);
    expect(v.verdict).toBe('diverged');
    expect(v.shareDeltaPts!).toBeLessThan(0);
    expect(v.costDelta).toBeGreaterThan(0);
    expect(v.headline).toContain('that is less usage, not a shift');
  });

  it('measures ULO off-peak as overnight + weekend, not the TOU window', () => {
    const rows = hourly(28, improvedWeek);
    const tou = analyzeShiftVerification(rows, 'TOU');
    const ulo = analyzeShiftVerification(rows, 'ULO');
    expect(ulo.offPeakLabel).toBe('overnight + weekend off-peak');
    // Same data, different cheap hours -> a different (but still real) share.
    expect(ulo.recent!.offPeakShare).not.toBeNull();
    expect(tou.recent!.offPeakShare).not.toBeNull();
    expect(ulo.recent!.offPeakShare!).not.toBeCloseTo(tou.recent!.offPeakShare!, 5);
  });

  it('refuses a shifting verdict on Tiered and says why', () => {
    const v = analyzeShiftVerification(hourly(28, improvedWeek), 'Tiered');
    expect(v.ready).toBe(true);
    expect(v.verdict).toBe('no-offpeak');
    expect(v.offPeakLabel).toBeNull();
    expect(v.shareDeltaPts).toBeNull();
    expect(v.headline).toContain('TIERED HAS NO OFF-PEAK WINDOW');
    expect(v.detail).toContain('flat rate');
    expect(v.recent!.offPeakShare).toBeNull();
    expect(v.recent!.offPeakKwh).toBeNull();
  });

  it('normalises each window to a 7-day week and keeps the raw totals', () => {
    const v = analyzeShiftVerification(hourly(28, improvedWeek), 'TOU');
    const w = v.recent!;
    expect(w.days).toBe(7);
    expect(w.weeklyCost).toBeCloseTo(w.totalCost, 6);
    expect(w.kwhPerDay).toBeCloseTo(w.totalKwh / 7, 6);
    expect(w.start).toBe('2026-06-22');
    expect(w.end).toBe('2026-06-28');
    expect(v.prior!.start).toBe('2026-06-15');
    expect(v.prior!.end).toBe('2026-06-21');
  });

  it('always keeps the caveat that one week is not proof', () => {
    const v = analyzeShiftVerification(hourly(28, improvedWeek), 'TOU');
    expect(v.caveat).toContain('weather');
    expect(v.caveat).toContain('hint, not proof');
  });
});
