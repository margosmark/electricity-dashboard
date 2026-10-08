import { describe, it, expect } from 'vitest';
import { processRawData, type DataPoint, type ProcessedPoint, type RateSet } from './energy';
import {
  anchorBand,
  buildEvScenario,
  detectEvCandidate,
  CHARGING_NIGHTS_PER_MONTH,
  EV_MIN_KW,
  type EvPlan,
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
  return hourlyFrom(new Date(2026, 5, 1), days, kwhAt);
}

/**
 * Hourly rows for `days` calendar days starting at `start` — the start date
 * pins the Ontario rate SEASON (winter is Nov 1 – Apr 30), which is the whole
 * point of the anchor fixtures below.
 */
function hourlyFrom(start: Date, days: number, kwhAt: (d: Date) => number): ProcessedPoint[] {
  const raw: DataPoint[] = [];
  for (let day = 0; day < days; day++) {
    for (let h = 0; h < 24; h++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, h, 0, 0);
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
 * Reading-interval (cadence) hygiene — the same night at 60 and 15 minutes
 *
 * `usage_kwh` is energy PER READING INTERVAL. Every fixture above is hourly,
 * which is exactly why `sum / readings` looked right: an hourly feed has one
 * reading per day per clock hour. Split the same profile into 15-minute
 * readings and that divisor reads 4x low — the block drops under EV_MIN_KW
 * and detectEvCandidate returns null ("nothing charging-shaped in your
 * data") on a house that does charge.
 * ========================================================================== */

/**
 * The SAME profile rendered at any cadence: each clock hour's kWh split evenly
 * across its readings, one interval apart. Energy per day is identical at
 * either cadence, so every derived number must match.
 */
function atCadence(
  days: number,
  stepMinutes: number,
  hourKwh: (d: Date) => number,
): ProcessedPoint[] {
  return atCadenceFrom(new Date(2026, 5, 1), days, stepMinutes, hourKwh);
}

/** {@link atCadence} for an arbitrary start date (rate-season fixtures). */
function atCadenceFrom(
  start: Date,
  days: number,
  stepMinutes: number,
  hourKwh: (d: Date) => number,
): ProcessedPoint[] {
  const perHour = 60 / stepMinutes;
  const raw: DataPoint[] = [];
  for (let day = 0; day < days; day++) {
    for (let h = 0; h < 24; h++) {
      const hourTotal = hourKwh(new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, h, 0, 0));
      for (let k = 0; k < perHour; k++) {
        raw.push({
          timestamp: Math.floor(
            new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, h, k * stepMinutes, 0).getTime() / 1000,
          ),
          usage_kwh: hourTotal / perHour,
        });
      }
    }
  }
  return processRawData(raw, [RATES]);
}

/** {@link houseWithNightBlock} at an arbitrary cadence. */
function houseCadence(days: number, stepMinutes: number, evHours: number[], ev: number) {
  const evSet = new Set(evHours);
  return atCadence(days, stepMinutes, (d) => (evSet.has(d.getHours()) ? 0.4 + ev : 0.4));
}

/** The pre-fix per-reading mean, kept only to pin the 4x delta against. */
function legacyMeanKw(rows: ProcessedPoint[]): number[] {
  const sum = new Array<number>(24).fill(0);
  const count = new Array<number>(24).fill(0);
  for (const r of rows) {
    const h = r.dateObj.getHours();
    sum[h] += r.usage_kwh;
    count[h] += 1;
  }
  return sum.map((s, h) => (count[h] > 0 ? s / count[h] : 0));
}

describe('detectEvCandidate cadence independence', () => {
  const NIGHT = [23, 0, 1];

  it('reports identical numbers from an hourly and a 15-minute feed', () => {
    const hourlyC = detectEvCandidate(houseWithNightBlock(20, NIGHT, 3.0));
    const quarterC = detectEvCandidate(houseCadence(20, 15, NIGHT, 3.0));
    expect(hourlyC).not.toBeNull();
    expect(quarterC).not.toBeNull();
    expect(quarterC!.meanKw).toBeCloseTo(hourlyC!.meanKw, 9);
    expect(quarterC!.kwhPerNight).toBeCloseTo(hourlyC!.kwhPerNight, 9);
    expect(quarterC!.hours).toBe(hourlyC!.hours);
    expect(quarterC!.label).toBe(hourlyC!.label);
    expect(quarterC!.nights).toBe(hourlyC!.nights);
    expect(quarterC!.days).toBe(hourlyC!.days);
    // The evidence sentence under the prefill, verbatim.
    expect(quarterC!.detail).toBe(hourlyC!.detail);
    expect(quarterC!.detail).toContain('10.2 kWh a night across 3 h (3.4 kW average)');
  });

  it('still finds a 3.4 kW block on a 15-minute feed that a per-reading mean would miss', () => {
    const rows = houseCadence(20, 15, NIGHT, 3.0);
    const legacy = legacyMeanKw(rows);
    // Pre-fix the gate saw 0.85 (a per-15-minute-reading figure), not 3.4.
    expect(legacy[23]).toBeLessThan(EV_MIN_KW);
    const c = detectEvCandidate(rows);
    expect(c).not.toBeNull();
    expect(c!.meanKw).toBeGreaterThanOrEqual(EV_MIN_KW);
    expect(c!.meanKw).toBeCloseTo(3.4, 9);
    expect(c!.kwhPerNight).toBeCloseTo(10.2, 9);
  });

  it('regression pin: on a 15-minute feed kwhPerNight is 4x the pre-fix figure', () => {
    // Strong enough to pass EV_MIN_KW even after the 4x haircut, so the
    // pre-fix code DID fire here — and under-reported by exactly 4x.
    const rows = houseCadence(20, 15, NIGHT, 7.0);
    const legacy = legacyMeanKw(rows);
    const legacyKwhPerNight = NIGHT.reduce((a, h) => a + legacy[h], 0);
    expect(legacyKwhPerNight).toBeCloseTo(3 * (7.4 / 4), 9);

    const c = detectEvCandidate(rows);
    expect(c).not.toBeNull();
    expect(c!.label).toBe('23:00–02:00');
    expect(c!.kwhPerNight).toBeCloseTo(legacyKwhPerNight * 4, 6);
    expect(c!.kwhPerNight).toBeCloseTo(3 * 7.4, 6);
    expect(c!.meanKw).toBeCloseTo(7.4, 6);
  });

  it('does not move any number on an hourly feed', () => {
    const c = detectEvCandidate(houseWithNightBlock(20, NIGHT, 3.0));
    expect(c).not.toBeNull();
    expect(c!.meanKw).toBeCloseTo(3.4, 5);
    expect(c!.kwhPerNight).toBeCloseTo(10.2, 5);
    expect(c!.nights).toBe(20);
    expect(c!.days).toBe(20);
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

/* ========================================================================== *
 * EV v2 — "when do you charge?" — the hour anchor + stay-vs-move counterfactual
 *
 * The shipped card had no hour to price against: with no detected night block
 * it fell back to each plan's WORST case, so a household that charges at 19:00
 * (a ULO On-Peak hour) was shown a number computed for somebody else's clock.
 * These fixtures pin the three things the anchor had to add:
 *
 *   1. the STAY side is priced at the anchor hour on the CURRENT plan, read
 *      back from the readings' own period charges — so winter/summer and
 *      weekday/weekend windows come out of the data, never a static table;
 *   2. the MOVE is modelled as a ±1 h habit spread, not one knife-edge hour;
 *   3. the credit is ONE number split into shift + plan, and the three-plan
 *      comparison pays the same credit once — never twice.
 * ========================================================================== */

const ALL_PLANS: EvPlan[] = ['TOU', 'Tiered', 'ULO'];

/** Mon 2026-01-05 for 28 days: WINTER (Nov 1 – Apr 30), 20 weekdays + 8 weekend days, no holiday. */
const WINTER = new Date(2026, 0, 5);
/** Mon 2026-06-01 for 28 days: SUMMER, the same 20/8 weekday shape, no holiday. */
const SUMMER = new Date(2026, 5, 1);

/**
 * The complaint itself as a fixture: a house that charges in the EVENING, so
 * detectEvCandidate finds nothing charging-shaped in the night and the shipped
 * code had no hour at all to price against.
 */
function eveningCharger(start: Date, days: number, evHours = [19, 20], ev = 3.0) {
  const set = new Set(evHours);
  return hourlyFrom(start, days, (d) => (set.has(d.getHours()) ? 0.4 + ev : 0.4));
}

describe('anchorBand', () => {
  it('wraps the ±1 h habit-drift band around the clock', () => {
    expect(anchorBand(19)).toEqual([18, 19, 20]);
    expect(anchorBand(0)).toEqual([23, 0, 1]);
    expect(anchorBand(23)).toEqual([22, 23, 0]);
    expect(anchorBand(7)).toEqual([6, 7, 8]);
  });
});

describe('charge-hour anchor: stay at 7 PM vs move to midnight', () => {
  /** Winter weekday 18:00 = On-Peak 20.3¢ (17:00–19:00), weekend = Off-Peak. */
  const WINTER_RATE_18 = (20 * 20.3 + 8 * 9.8) / 28;
  /** Summer weekday 18:00 = Mid-Peak 15.7¢ (11:00–17:00 is on-peak, so not 18). */
  const SUMMER_RATE_18 = (20 * 15.7 + 8 * 9.8) / 28;
  /** 19:00 and 20:00 are Off-Peak in BOTH seasons: TOU on-peak ENDS at 19:00. */
  const RATE_19_20 = 9.8;
  /** ULO weekday 16:00–21:00 = On-Peak 39.1¢, weekends 9.8¢ — no season. */
  const ULO_RATE_16_21 = (20 * 39.1 + 8 * 9.8) / 28;

  const winterEvening = () => eveningCharger(WINTER, 28);
  const winterMove = (overrides: Partial<Parameters<typeof buildEvScenario>[0]> = {}) =>
    buildEvScenario({
      rows: winterEvening(),
      rates: RATES,
      dailyKwh: 10,
      currentPlan: 'TOU',
      chargeHour: 19,
      chargeHourSource: 'user',
      ...overrides,
    });

  it('prices the stay side at the anchor hour from the readings — winter windows, not a table', () => {
    const rows = winterEvening();
    // The 7 PM block is OUTSIDE the night window, so detection honestly says
    // "nothing charging-shaped" — the household's answer is what we have.
    expect(detectEvCandidate(rows)).toBeNull();

    const s = winterMove();
    const cm = s.chargeMove!;
    expect(cm).not.toBeNull();
    expect(cm.hour).toBe(19);
    expect(cm.source).toBe('user');
    expect(cm.band).toEqual([18, 19, 20]);
    expect(cm.bandLabel).toBe('18:00–21:00');
    expect(cm.stayBasis).toBe('band');
    expect(cm.stayHours).toEqual([18, 19, 20]);
    expect(cm.seasons).toEqual(['Winter']);

    const stayRate = (WINTER_RATE_18 + RATE_19_20 + RATE_19_20) / 3;
    expect(cm.stayRateCents).toBeCloseTo(stayRate, 6);
    // The kWh are spread evenly across the ±1 h band, not dumped on one hour.
    expect(cm.stayCostPerCharge).toBeCloseTo((10 * stayRate) / 100, 6);
    expect(cm.stayCostPerMonth).toBeCloseTo(cm.stayCostPerCharge * CHARGING_NIGHTS_PER_MONTH, 6);
    // Evidence line carries the per-hour rates it blended.
    expect(cm.stayBreakdown.map((b) => b.hour)).toEqual([18, 19, 20]);
    expect(cm.stayBreakdown[0].rateCents).toBeCloseTo(WINTER_RATE_18, 9);
    expect(cm.stayBreakdown[1].rateCents).toBeCloseTo(RATE_19_20, 9);
    expect(cm.stayBreakdown[2].rateCents).toBeCloseTo(RATE_19_20, 9);
    expect(cm.stayBreakdown[0].categories).toContain('On-Peak');
    expect(cm.stayBreakdown[1].categories).toEqual(['Off-Peak']);
    expect(cm.stayBreakdown.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 9);
    expect(cm.detail).toContain('18:00');
    expect(s.assumptions.join(' ')).toContain('one hour either side for habit drift');
  });

  it('answers the actual question — stay vs move, split into shift + plan', () => {
    const cm = winterMove().chargeMove!;
    const stay = (10 * ((WINTER_RATE_18 + 2 * RATE_19_20) / 3)) / 100;
    const uloAtAnchor = (10 * ULO_RATE_16_21) / 100;
    const move = (10 * 3.9) / 100;

    expect(cm.stayCostPerCharge).toBeCloseTo(stay, 6);
    expect(cm.uloAtAnchorCostPerCharge).toBeCloseTo(uloAtAnchor, 6);
    // The move side IS the card's $/charge on ULO — one credit, two views.
    expect(cm.moveCostPerCharge).toBeCloseTo(move, 6);
    expect(cm.moveCostPerMonth).toBeCloseTo(move * CHARGING_NIGHTS_PER_MONTH, 6);

    // THE SKEW: at 19:00 ULO is On-Peak, so changing PLAN alone loses money…
    expect(cm.planSavingPerMonth).toBeLessThan(0);
    expect(cm.planSavingPerCharge).toBeCloseTo(stay - uloAtAnchor, 6);
    // …and moving the HOUR is where the money is.
    expect(cm.shiftSavingPerMonth).toBeGreaterThan(0);
    expect(cm.shiftSavingPerCharge).toBeCloseTo(uloAtAnchor - move, 6);
    // The three numbers add up exactly: total = plan + shift (never both paid).
    expect(cm.totalSavingPerCharge).toBeCloseTo(stay - move, 6);
    expect(cm.totalSavingPerMonth).toBeCloseTo(cm.planSavingPerMonth + cm.shiftSavingPerMonth, 6);
    expect(cm.totalSavingPerMonth).toBeCloseTo(cm.stayCostPerMonth - cm.moveCostPerMonth, 6);
    expect(cm.totalSavingPerMonth).toBeGreaterThan(0);
  });

  it('is season-aware: the same anchor prices differently in Nov–Apr than in May–Oct', () => {
    const winter = winterMove().chargeMove!;
    const summer = buildEvScenario({
      rows: eveningCharger(SUMMER, 28),
      rates: RATES,
      dailyKwh: 10,
      currentPlan: 'TOU',
      chargeHour: 19,
      chargeHourSource: 'user',
    }).chargeMove!;

    expect(winter.seasons).toEqual(['Winter']);
    expect(summer.seasons).toEqual(['Summer']);
    expect(winter.stayBreakdown[0].rateCents).toBeCloseTo(WINTER_RATE_18, 6); // On-Peak 20.3¢
    expect(summer.stayBreakdown[0].rateCents).toBeCloseTo(SUMMER_RATE_18, 6); // Mid-Peak 15.7¢
    // Winter's counterfactual bill for STAYING PUT is the bigger one.
    expect(winter.stayCostPerMonth).toBeGreaterThan(summer.stayCostPerMonth);
    expect(winter.stayCostPerMonth).toBeCloseTo(
      (10 * ((WINTER_RATE_18 + 2 * RATE_19_20) / 3) * CHARGING_NIGHTS_PER_MONTH) / 100,
      6,
    );
    expect(summer.stayCostPerMonth).toBeCloseTo(
      (10 * ((SUMMER_RATE_18 + 2 * RATE_19_20) / 3) * CHARGING_NIGHTS_PER_MONTH) / 100,
      6,
    );
    // ULO has no season: its windows are the same in January and June.
    expect(summer.uloAtAnchorRateCents).toBeCloseTo(ULO_RATE_16_21, 6);
    expect(winter.uloAtAnchorRateCents).toBeCloseTo(ULO_RATE_16_21, 6);
  });

  it('never credits the same kWh twice: the three-plan comparison pays it once', () => {
    const s = winterMove();
    const cm = s.chargeMove!;
    const pc = s.planComparison!;
    expect(pc.days).toBe(28);

    for (const plan of ALL_PLANS) {
      // "Today" in the comparison IS the stay side of the anchor — same hours,
      // same rate, so the two views can never disagree or double-credit.
      expect(pc.currentEvCost[plan]).toBeCloseTo(
        cm.stayCostPerChargeByPlan[plan] * pc.days,
        6,
      );
      // The credit the comparison books (baseline − shifted) is exactly
      // stay − overnight for those same hours: one credit, once.
      expect(pc.baseline[plan] - pc.withChargeOnOvernight[plan]).toBeCloseTo(
        pc.currentEvCost[plan] - pc.overnightEvCost[plan],
        6,
      );
    }
    // …and on ULO that credit is the anchor's own stay-vs-move, scaled up.
    expect(pc.baseline.ULO - pc.withChargeOnOvernight.ULO).toBeCloseTo(
      (cm.stayCostPerChargeByPlan.ULO - cm.moveCostPerCharge) * pc.days,
      6,
    );
    // …and the move side is the same money the comparison credits.
    expect(pc.overnightEvCost.ULO).toBeCloseTo(cm.moveCostPerCharge * pc.days, 6);
  });

  it('differs from the shipped "assume the worst / assume overnight" number', () => {
    const s = winterMove();
    const pc = s.planComparison!;
    // What the shipped build printed with no hour to price against: each
    // plan's WORST case (TOU on-peak 20.3¢, ULO on-peak 39.1¢).
    const shippedTou = (pc.evKwh * 20.3) / 100;
    const shippedUloDelta = (pc.evKwh * (39.1 - 3.9)) / 100;
    expect(pc.currentEvCost.TOU).toBeCloseTo((pc.evKwh * s.chargeMove!.stayRateCents) / 100, 6);
    expect(pc.currentEvCost.TOU).toBeLessThan(shippedTou);
    // The ULO "savings from shifting" shrinks, because 19:00 is not 39.1¢ today.
    const actualUloDelta = pc.baseline.ULO - pc.withChargeOnOvernight.ULO;
    expect(actualUloDelta).toBeGreaterThan(0);
    expect(actualUloDelta).toBeLessThan(shippedUloDelta);
  });

  it('says "already optimal" when the anchor sits inside 23:00–07:00 — no fake shift saving', () => {
    const onUlo = winterMove({ currentPlan: 'ULO', chargeHour: 0 }).chargeMove!;
    expect(onUlo.band).toEqual([23, 0, 1]);
    expect(onUlo.alreadyOvernight).toBe(true);
    // Every band hour is already at ULO's overnight rate: the shift is worth
    // exactly nothing and we say so instead of inventing a saving.
    expect(onUlo.shiftSavingPerMonth).toBeCloseTo(0, 9);
    expect(onUlo.totalSavingPerMonth).toBeCloseTo(0, 9);

    // On Time-of-Use the same hours are a PLAN difference, not a shift —
    // and it is labelled as one rather than booked as a move.
    const onTou = winterMove({ currentPlan: 'TOU', chargeHour: 0 }).chargeMove!;
    expect(onTou.alreadyOvernight).toBe(true);
    expect(onTou.shiftSavingPerMonth).toBeCloseTo(0, 9);
    expect(onTou.totalSavingPerMonth).toBeCloseTo(onTou.planSavingPerMonth, 6);
    expect(onTou.totalSavingPerMonth).toBeGreaterThan(0);
  });

  it('falls back to an upper bound when the dataset has no readings at the anchor hour', () => {
    const rows = hourlyFrom(WINTER, 28, () => 0.4).filter(
      (r) => ![18, 19, 20].includes(r.dateObj.getHours()),
    );
    const s = buildEvScenario({
      rows,
      rates: RATES,
      dailyKwh: 10,
      currentPlan: 'TOU',
      chargeHour: 19,
      chargeHourSource: 'user',
    });
    const cm = s.chargeMove!;
    expect(cm.stayBasis).toBe('worst-case');
    expect(cm.stayRateCents).toBe(20.3); // TOU's most expensive rate, not a guess
    expect(cm.stayBreakdown.every((b) => b.upperBound)).toBe(true);
    expect(s.assumptions.join(' ')).toContain('upper bound');
  });

  it('lets the household’s own hour override the overnight block we detected', () => {
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0); // block 23:00–02:00
    const candidate = detectEvCandidate(rows);
    expect(candidate).not.toBeNull();

    const s = buildEvScenario({
      rows,
      rates: RATES,
      dailyKwh: 10.2,
      candidate,
      currentPlan: 'TOU',
      chargeHour: 19,
      chargeHourSource: 'user',
    });
    const cm = s.chargeMove!;
    expect(cm.stayBasis).toBe('band');
    expect(cm.stayHours).toEqual([18, 19, 20]);
    expect(cm.stayLabel).not.toContain('23:00');
    // The block is no longer the price basis for "today".
    const pc = s.planComparison!;
    expect(pc.currentEvCost.TOU).toBeCloseTo((pc.evKwh * cm.stayRateCents) / 100, 6);
  });

  it('prefills the anchor from the block it detected, and prices today with that block', () => {
    const rows = houseWithNightBlock(20, [23, 0, 1], 3.0);
    const candidate = detectEvCandidate(rows);
    const s = buildEvScenario({ rows, rates: RATES, dailyKwh: 10.2, candidate, currentPlan: 'TOU' });
    const cm = s.chargeMove!;
    expect(cm.source).toBe('detected');
    expect(cm.hour).toBe(23);
    expect(cm.stayBasis).toBe('block');
    expect(cm.stayHours).toEqual([23, 0, 1]);
    expect(cm.stayLabel).toBe('23:00–02:00');
    expect(cm.alreadyOvernight).toBe(true);
    // 23:00–02:00 is ULO Overnight already: nothing to shift, and it says so.
    expect(cm.shiftSavingPerMonth).toBeCloseTo(0, 9);
    expect(cm.totalSavingPerMonth).toBeGreaterThan(0); // …the PLAN difference is real
    const pc = s.planComparison!;
    expect(pc.currentEvCost.TOU).toBeCloseTo((pc.evKwh * cm.stayRateCents) / 100, 6);
    expect(pc.currentEvCost.ULO).toBeCloseTo((pc.evKwh * 3.9) / 100, 4);
  });

  it('gives the same anchor rate from an hourly and a 15-minute feed', () => {
    const evSet = new Set([19, 20]);
    const day = (d: Date) => (evSet.has(d.getHours()) ? 3.4 : 0.4);
    const run = (rows: ProcessedPoint[]) =>
      buildEvScenario({
        rows,
        rates: RATES,
        dailyKwh: 10,
        currentPlan: 'TOU',
        chargeHour: 19,
        chargeHourSource: 'user',
      }).chargeMove!;
    const fromHourly = run(hourlyFrom(WINTER, 14, day));
    const fromQuarter = run(atCadenceFrom(WINTER, 14, 15, day));
    expect(fromQuarter.stayRateCents).toBeCloseTo(fromHourly.stayRateCents, 9);
    expect(fromQuarter.uloAtAnchorRateCents).toBeCloseTo(fromHourly.uloAtAnchorRateCents, 9);
    expect(fromQuarter.stayCostPerMonth).toBeCloseTo(fromHourly.stayCostPerMonth, 9);
    expect(fromQuarter.seasons).toEqual(['Winter']);
  });

  it('shows no comparison at all when we know neither an hour nor a block', () => {
    const s = buildEvScenario({ rows: eveningCharger(WINTER, 28), rates: RATES, dailyKwh: 10 });
    expect(s.candidate).toBeNull();
    expect(s.chargeMove).toBeNull();
    // …and the three-plan comparison keeps the shipped worst-case fallback.
    const pc = s.planComparison!;
    expect(pc.currentEvCost.TOU).toBeCloseTo((pc.evKwh * 20.3) / 100, 6);
    expect(s.assumptions.join(' ')).toContain('upper bound');
  });

  it('is null until the household tags a nightly kWh', () => {
    const s = winterMove({ dailyKwh: 0 });
    expect(s.ready).toBe(false);
    expect(s.chargeMove).toBeNull();
  });
});
