import { describe, it, expect } from 'vitest';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from './energy';
import {
  buildEvScenario,
  detectEvCandidate,
  CHARGING_NIGHTS_PER_MONTH,
} from './evScenario';

const RATES: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/**
 * Hourly rows for `days` calendar days starting 2026-06-01 (a month with no
 * DST transition, so every day really does have 24 hours).
 */
function hourly(days: number, kwhAt: (d: Date) => number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let day = 0; day < days; day++) {
    for (let h = 0; h < 24; h++) {
      const d = new Date(2026, 5, 1 + day, h, 0, 0);
      raw.push({ timestamp: Math.floor(d.getTime() / 1000), usage_kwh: kwhAt(d) });
    }
  }
  return processRawData(raw, [RATES]);
}

/** A quiet house: 0.4 kW all day, plus `ev` kWh during `evHours` on every night. */
function houseWithNightBlock(days: number, evHours: number[], ev: number) {
  const evSet = new Set(evHours);
  return hourly(days, (d) => (evSet.has(d.getHours()) ? 0.4 + ev : 0.4));
}

/* ========================================================================== *
 * detectEvCandidate
 * ========================================================================== */

describe('detectEvCandidate', () => {
  it('returns null for an empty dataset', () => {
    expect(detectEvCandidate([])).toBeNull();
  });

  it('returns null when nothing in the night is above the charging floor', () => {
    const rows = hourly(10, () => 0.4);
    expect(detectEvCandidate(rows)).toBeNull();
  });

  it('finds a block that wraps midnight and reports the clock range', () => {
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0);
    const c = detectEvCandidate(rows);
    expect(c).not.toBeNull();
    expect(c!.hours).toBe(3);
    expect(c!.label).toBe('23:00–02:00');
    // 3.4 kW average (0.4 base + 3.0 EV) over 3 hours
    expect(c!.meanKw).toBeCloseTo(3.4, 5);
    expect(c!.kwhPerNight).toBeCloseTo(10.2, 5);
    expect(c!.nights).toBe(20);
    expect(c!.days).toBe(20);
    expect(c!.detail).toContain('seen on 20 of 20 days');
  });

  it('finds a block that sits entirely before midnight', () => {
    const rows = houseWithNightBlock(15, [22, 23], 1.4);
    const c = detectEvCandidate(rows);
    expect(c).not.toBeNull();
    expect(c!.label).toBe('22:00–00:00');
    expect(c!.kwhPerNight).toBeCloseTo(2 * 1.8, 5);
  });

  it('ignores a sustained daytime block (not an overnight charge)', () => {
    const rows = hourly(10, (d) => (d.getHours() >= 10 && d.getHours() < 16 ? 5 : 0.4));
    expect(detectEvCandidate(rows)).toBeNull();
  });

  it('rejects a single night hour: too short to be a charging block', () => {
    const rows = hourly(10, (d) => (d.getHours() === 2 ? 6 : 0.4));
    expect(detectEvCandidate(rows)).toBeNull();
  });

  it('reports nights honestly when the block only shows up some days', () => {
    const rows = hourly(20, (d) => {
      const charging = d.getDate() % 2 === 0; // half the nights
      return charging && (d.getHours() >= 23 || d.getHours() < 1) ? 0.5 + 3 : 0.4;
    });
    const c = detectEvCandidate(rows);
    expect(c).not.toBeNull();
    expect(c!.nights).toBeLessThan(c!.days);
    expect(c!.nights).toBeGreaterThan(0);
  });

  it('picks the LONGER of two night blocks', () => {
    const rows = hourly(12, (d) => {
      const h = d.getHours();
      if (h === 22) return 5; // 1h only
      if (h >= 1 && h <= 5) return 4; // 5h — wins
      return 0.4;
    });
    const c = detectEvCandidate(rows);
    expect(c).not.toBeNull();
    expect(c!.hours).toBe(5);
    expect(c!.label).toBe('01:00–06:00');
  });
});

/* ========================================================================== *
 * buildEvScenario
 * ========================================================================== */

describe('buildEvScenario', () => {
  it('reports no-data on an empty dataset', () => {
    const s = buildEvScenario({ rows: [], rates: RATES, dailyKwh: 10 });
    expect(s.ready).toBe(false);
    expect(s.emptyReason).toBe('no-data');
    expect(s.planComparison).toBeNull();
  });

  it('reports no-rates when the rate history has not loaded', () => {
    const rows = houseWithNightBlock(5, [23, 0], 3);
    const s = buildEvScenario({ rows, rates: null, dailyKwh: 10 });
    expect(s.ready).toBe(false);
    expect(s.emptyReason).toBe('no-rates');
  });

  it('reports no-ev-kwh when nothing is tagged and nothing was detected', () => {
    const rows = hourly(5, () => 0.4);
    const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 0 });
    expect(s.ready).toBe(false);
    expect(s.emptyReason).toBe('no-ev-kwh');
    expect(s.candidate).toBeNull();
    // ...but the 4–9pm exposure is a property of the data, so it still ships.
    expect(s.peakExposure).not.toBeNull();
  });

  it('prices one charge and one month per plan at the overnight-appropriate rate', () => {
    const rows = hourly(5, () => 0.4);
    const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 10 });
    expect(s.prices.TOU.rateCents).toBe(9.8);
    expect(s.prices.ULO.rateCents).toBe(3.9);
    expect(s.prices.Tiered.rateCents).toBe(12.0);
    expect(s.prices.TOU.perCharge).toBeCloseTo(0.98, 6);
    expect(s.prices.ULO.perCharge).toBeCloseTo(0.39, 6);
    expect(s.prices.ULO.perMonth).toBeCloseTo(0.39 * CHARGING_NIGHTS_PER_MONTH, 6);
    expect(s.chargeSavingUloVsTouPerMonth).toBeCloseTo(
      (0.98 - 0.39) * CHARGING_NIGHTS_PER_MONTH,
      6,
    );
  });

  it('marks the number as detected when the tag matches the block we found', () => {
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0); // 10.2 kWh/night
    const c = detectEvCandidate(rows);
    const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 10.2, candidate: c });
    expect(s.source).toBe('detected');
    expect(s.assumptions[0]).toContain('read from your own data');
    expect(s.assumptions[0]).toContain('cannot tell an EV apart');
  });

  it('marks the number as tagged and calls out the mismatch when it differs', () => {
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0); // 10.2 kWh/night
    const c = detectEvCandidate(rows);
    const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 18, candidate: c });
    expect(s.source).toBe('tagged');
    expect(s.assumptions[0]).toContain('You tagged 18.0 kWh');
    expect(s.assumptions[0]).toContain('averages 10.2 kWh/night');
  });

  it('says the comparison is an upper bound when no block was found', () => {
    const rows = hourly(10, () => 0.4);
    const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 8 });
    expect(s.source).toBe('tagged');
    expect(s.candidate).toBeNull();
    expect(s.assumptions.join(' ')).toContain('upper bound');
  });

  it('always states the 23:00–07:00, 30-night and commodity-only assumptions', () => {
    const rows = hourly(5, () => 0.4);
    const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 10 });
    const all = s.assumptions.join(' | ');
    expect(all).toContain('23:00–07:00');
    expect(all).toContain(`${CHARGING_NIGHTS_PER_MONTH} charging nights`);
    expect(all).toContain('delivery, regulatory charges and HST');
  });

  describe('three-plan comparison with the charge moved into overnight', () => {
    it('is a no-op when the block already charges overnight — we do not invent savings', () => {
      // Weekday afternoons at 4 kW, EV block already in 23:00–02:00.
      const rows = hourly(30, (d) => {
        const h = d.getHours();
        const weekday = d.getDay() >= 1 && d.getDay() <= 5;
        if (weekday && h >= 16 && h < 21) return 4;
        if (h >= 23 || h < 2) return 3.4;
        return 0.4;
      });
      const candidate = detectEvCandidate(rows);
      expect(candidate).not.toBeNull();
      const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 10, candidate });
      const pc = s.planComparison!;
      expect(pc).not.toBeNull();
      expect(pc.days).toBe(30);
      expect(pc.evKwh).toBeCloseTo(300, 5);
      // 23:00–02:00 is TOU off-peak AND ULO overnight already, so moving it
      // into 23:00–07:00 changes nothing on any plan.
      expect(pc.withChargeOnOvernight.TOU).toBeCloseTo(pc.baseline.TOU, 6);
      expect(pc.withChargeOnOvernight.ULO).toBeCloseTo(pc.baseline.ULO, 6);
      expect(pc.withChargeOnOvernight.Tiered).toBeCloseTo(pc.baseline.Tiered, 6);
      expect(pc.currentEvCost.ULO).toBeCloseTo((300 * 3.9) / 100, 4);
      expect(pc.currentEvCost.TOU).toBeCloseTo((300 * 9.8) / 100, 4);
    });

    it('prices an unobserved charge at each plan\'s worst case and brings it down', () => {
      // No night block anywhere: a daytime house whose owner tags an EV anyway.
      const rows = hourly(30, (d) => {
        const h = d.getHours();
        const weekday = d.getDay() >= 1 && d.getDay() <= 5;
        return weekday && h >= 16 && h < 21 ? 4 : 0.4;
      });
      expect(detectEvCandidate(rows)).toBeNull();
      const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 10 });
      const pc = s.planComparison!;
      expect(pc.evKwh).toBeCloseTo(300, 5);

      // Upper bound: charged today at each plan's most expensive rate...
      expect(pc.currentEvCost.ULO).toBeCloseTo((300 * 39.1) / 100, 4);
      expect(pc.currentEvCost.TOU).toBeCloseTo((300 * 20.3) / 100, 4);
      // ...moved into 23:00–07:00.
      expect(pc.overnightEvCost.ULO).toBeCloseTo((300 * 3.9) / 100, 4);
      expect(pc.overnightEvCost.TOU).toBeCloseTo((300 * 9.8) / 100, 4);

      expect(pc.withChargeOnOvernight.ULO).toBeLessThan(pc.baseline.ULO);
      expect(pc.withChargeOnOvernight.TOU).toBeLessThan(pc.baseline.TOU);
      // Flat rate: moving hours cannot change what Tiered costs.
      expect(pc.withChargeOnOvernight.Tiered).toBeCloseTo(pc.baseline.Tiered, 6);
      expect(pc.currentEvCost.Tiered).toBeCloseTo(pc.overnightEvCost.Tiered, 6);
    });
  });

  describe('weekday 4–9pm exposure', () => {
    const rows = hourly(31, (d) => {
      const h = d.getHours();
      const weekday = d.getDay() >= 1 && d.getDay() <= 5;
      return weekday && h >= 16 && h < 21 ? 2 : 0.5;
    });

    it('flags the exposed hours with kWh and dollars at ULO On-Peak', () => {
      const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 10 });
      const e = s.peakExposure!;
      expect(e).not.toBeNull();
      expect(e.hoursPerWeekday).toBe(5);
      expect(e.rateCents).toBe(39.1);
      expect(e.windowLabel).toBe('Weekdays 16:00–21:00');
      // ~31 days -> 1.018 months; 5 weekdays/wk * 5h * 2 kWh = 50 kWh/week
      expect(e.kwhPerMonth).toBeGreaterThan(150);
      expect(e.kwhPerMonth).toBeLessThan(250);
      expect(e.costPerMonth).toBeCloseTo((e.kwhPerMonth * 39.1) / 100, 6);
      expect(e.overnightCostPerMonth).toBeCloseTo((e.kwhPerMonth * 3.9) / 100, 6);
      expect(e.atStakePerMonth).toBeCloseTo(e.costPerMonth - e.overnightCostPerMonth, 6);
      expect(s.assumptions.join(' ')).toContain('ULO On-Peak at 39.1¢/kWh');
    });

    it('is null when the dataset has no weekday afternoon readings at all', () => {
      const flat = hourly(10, () => 0.5).filter((r) => {
        const dow = r.dateObj.getDay();
        const h = r.dateObj.getHours();
        return !(dow >= 1 && dow <= 5 && h >= 16 && h < 21);
      });
      const s = buildEvScenario({ rows: flat, rates: RATES, dailyKwh: 10 });
      expect(s.peakExposure).toBeNull();
    });
  });
});
