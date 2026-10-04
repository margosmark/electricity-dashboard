/**
 * EV charging scenario — "what does a charge actually cost, and what is the
 * 4–9pm weekday window costing me if I switch to Ultra-Low Overnight?"
 *
 * Two inputs, both honest about where they came from:
 *
 *  1. a NIGHTLY kWh the user typed, OR an auto-detected overnight block we
 *     found in their own data (prefilled, editable, and always labelled as
 *     "a block we found" — we never claim it is an EV);
 *  2. the loaded readings, repriced so the charge lands in the ULO overnight
 *     window (23:00–07:00) instead of wherever it charges today.
 *
 * Everything here is pure and deterministic: no `Date.now()`, the "how much
 * data do I have" question is answered from the readings themselves.
 */

import {
  aggregateChartData,
  calculateComparison,
  type ProcessedPoint,
  type RateSet,
} from './energy';

export type EvPlan = 'TOU' | 'Tiered' | 'ULO';

/** Clock hours that make up the ULO overnight window (23:00–07:00). */
export const OVERNIGHT_HOURS = [23, 0, 1, 2, 3, 4, 5, 6] as const;

/**
 * Detection window: one hour of slack on either side of the overnight window
 * (cars do start at 22:00 and finish at 07:30), ordered so a block that wraps
 * midnight reads as contiguous.
 */
export const DETECT_NIGHT_ORDER = [22, 23, 0, 1, 2, 3, 4, 5, 6, 7] as const;

/** Mean kW a night block must hold before we call it charging-shaped. */
export const EV_MIN_KW = 1.5;
/** ...for at least this many consecutive night hours. */
export const EV_MIN_HOURS = 2;
/** A night counts as "charging happened" once it reaches half the block's energy. */
export const EV_NIGHT_ENERGY_SHARE = 0.5;
/** Charging nights assumed by the $/month line. */
export const CHARGING_NIGHTS_PER_MONTH = 30;
/** Calendar days per month, for turning a window total into a monthly figure. */
export const DAYS_PER_MONTH = 30.44;
/** ULO's weekday 16:00–21:00 window — the hours a ULO switch exposes. */
export const ULO_PEAK_START_HOUR = 16;
export const ULO_PEAK_END_HOUR = 21;
/** A tag more than this share away from the detected block is called out. */
export const TAG_MISMATCH_SHARE = 0.15;

export type EvCandidate = {
  /** First clock hour of the block (inclusive). */
  startHour: number;
  /** Clock hour after the block's last one (exclusive; wraps past midnight). */
  endHour: number;
  hours: number;
  meanKw: number;
  kwhPerNight: number;
  /** Days where the block carried at least half its usual energy. */
  nights: number;
  /** Distinct days in the dataset. */
  days: number;
  /** "23:00–02:00" */
  label: string;
  /** The evidence sentence shown under the prefill. */
  detail: string;
};

function pad2(h: number): string {
  return String(h).padStart(2, '0');
}

function clockRange(hours: number[]): string {
  const first = hours[0];
  const last = hours[hours.length - 1];
  const end = last === 23 ? 0 : last + 1;
  return `${pad2(first)}:00–${pad2(end)}:00`;
}

/**
 * Find the longest run of CONSECUTIVE night hours whose average power looks
 * like charging (>= EV_MIN_KW for >= EV_MIN_HOURS), measured across the whole
 * loaded dataset.
 *
 * `usage_kwh` is energy PER READING INTERVAL, so an hour's sum must be divided
 * by the number of distinct DAYS that hour spans, not by the number of
 * readings: a day's worth of one clock hour is an hourly kWh (= kW) whatever
 * cadence the export used. A per-reading divisor reads 4x low on a
 * 15-minute feed — the block then fails `EV_MIN_KW` and we return null
 * ("nothing charging-shaped in your data") on a house that does charge.
 *
 * For an hourly feed every day contributes exactly one reading to a clock
 * hour, so days === readings and no existing number moves.
 *
 * Returns null when nothing in the data is charging-shaped — which is the
 * normal answer for a house without an EV, and must stay null rather than
 * being guessed at.
 */
export function detectEvCandidate(rows: ProcessedPoint[]): EvCandidate | null {
  if (rows.length === 0) return null;

  const sum = new Array<number>(24).fill(0);
  /** Distinct calendar days that contributed a reading to each clock hour. */
  const hourDays = Array.from({ length: 24 }, () => new Set<string>());
  const daySet = new Set<string>();
  for (const r of rows) {
    const h = r.dateObj.getHours();
    sum[h] += r.usage_kwh;
    hourDays[h].add(r.dayStr);
    daySet.add(r.dayStr);
  }
  const meanKw = sum.map((s, h) =>
    hourDays[h].size > 0 ? s / hourDays[h].size : 0,
  );

  const order = Array.from(DETECT_NIGHT_ORDER);
  let best: number[] = [];
  const bestPower = (run: number[]) => run.reduce((a, h) => a + meanKw[h], 0);

  for (let i = 0; i < order.length; i++) {
    if (meanKw[order[i]] < EV_MIN_KW) continue;
    let j = i;
    while (j + 1 < order.length && meanKw[order[j + 1]] >= EV_MIN_KW) j++;
    const run = order.slice(i, j + 1);
    if (run.length > best.length || (run.length === best.length && bestPower(run) > bestPower(best))) {
      best = run;
    }
    i = j;
  }

  if (best.length < EV_MIN_HOURS) return null;

  const kwhPerNight = bestPower(best);
  if (kwhPerNight <= 0) return null;
  const meanKwRun = kwhPerNight / best.length;

  const inRun = new Set(best);
  const perDay = new Map<string, number>();
  for (const r of rows) {
    if (!inRun.has(r.dateObj.getHours())) continue;
    perDay.set(r.dayStr, (perDay.get(r.dayStr) || 0) + r.usage_kwh);
  }
  const threshold = EV_NIGHT_ENERGY_SHARE * kwhPerNight;
  let nights = 0;
  for (const v of perDay.values()) if (v >= threshold) nights += 1;

  const days = daySet.size;
  const label = clockRange(best);

  return {
    startHour: best[0],
    endHour: best[best.length - 1] === 23 ? 0 : best[best.length - 1] + 1,
    hours: best.length,
    meanKw: meanKwRun,
    kwhPerNight,
    nights,
    days,
    label,
    detail: `${kwhPerNight.toFixed(1)} kWh a night across ${best.length} h (${meanKwRun.toFixed(1)} kW average), seen on ${nights} of ${days} days`,
  };
}

export type EvPlanPrice = {
  /** Commodity rate the charge lands at, cents/kWh. */
  rateCents: number;
  /** One night's charge. */
  perCharge: number;
  /** CHARGING_NIGHTS_PER_MONTH charges. */
  perMonth: number;
};

export type EvPlanComparison = {
  /** What the loaded data actually costs today, per plan. */
  baseline: Record<EvPlan, number>;
  /** Baseline with the tagged charge repriced into 23:00–07:00. */
  withChargeOnOvernight: Record<EvPlan, number>;
  /** The tagged charge priced where it charges today (or an upper bound). */
  currentEvCost: Record<EvPlan, number>;
  /** The same energy priced in the overnight window. */
  overnightEvCost: Record<EvPlan, number>;
  /** dailyKwh over every distinct day in the dataset. */
  evKwh: number;
  days: number;
};

export type EvPeakExposure = {
  /** Distinct clock hours of the weekday 16:00–21:00 window we actually saw. */
  hoursPerWeekday: number;
  kwhPerMonth: number;
  rateCents: number;
  costPerMonth: number;
  overnightCostPerMonth: number;
  /** What that window costs at ULO On-Peak minus what it would cost overnight. */
  atStakePerMonth: number;
  windowLabel: string;
};

export type EvScenarioEmptyReason = 'no-data' | 'no-rates' | 'no-ev-kwh';

export type EvScenario = {
  ready: boolean;
  emptyReason: EvScenarioEmptyReason | null;
  dailyKwh: number;
  /** Where the number came from — surfaced verbatim in the card. */
  source: 'detected' | 'tagged' | null;
  candidate: EvCandidate | null;
  prices: Record<EvPlan, EvPlanPrice>;
  /** $/month the charge costs on TOU minus $/month on ULO. */
  chargeSavingUloVsTouPerMonth: number;
  planComparison: EvPlanComparison | null;
  peakExposure: EvPeakExposure | null;
  assumptions: string[];
};

/** The rate a charge lands on under each plan when it runs 23:00–07:00. */
function overnightRateCents(plan: EvPlan, rates: RateSet): number {
  if (plan === 'TOU') return rates.tou.offPeak;
  if (plan === 'ULO') return rates.ulo.overnight;
  return rates.tiered.tier1;
}

/** The rate the same charge pays today if we cannot see where it charges. */
function worstCaseRateCents(plan: EvPlan, rates: RateSet): number {
  if (plan === 'TOU') return rates.tou.onPeak;
  if (plan === 'ULO') return rates.ulo.onPeak;
  // Tiered has no time-of-use windows: time shifting never moves this bill.
  return rates.tiered.tier1;
}

const PLANS: EvPlan[] = ['TOU', 'Tiered', 'ULO'];

export function buildEvScenario(input: {
  rows: ProcessedPoint[];
  rates: RateSet | null;
  /** Nightly kWh the user tagged (0 = nothing tagged yet). */
  dailyKwh: number;
  /** Pass a precomputed candidate to avoid detecting twice. */
  candidate?: EvCandidate | null;
}): EvScenario {
  const { rows, rates, dailyKwh } = input;
  const candidate =
    input.candidate !== undefined ? input.candidate : detectEvCandidate(rows);

  const prices = {} as Record<EvPlan, EvPlanPrice>;
  for (const plan of PLANS) {
    const rateCents = rates ? overnightRateCents(plan, rates) : 0;
    const perCharge = dailyKwh * (rateCents / 100);
    prices[plan] = {
      rateCents,
      perCharge,
      perMonth: perCharge * CHARGING_NIGHTS_PER_MONTH,
    };
  }

  const assumptions: string[] = [];

  // --- Peak exposure is computed whether or not an EV is tagged: it is a
  // property of the data, not of the scenario.
  let peakExposure: EvPeakExposure | null = null;
  if (rates && rows.length > 0) {
    const daySet = new Set<string>();
    const hoursSeen = new Set<number>();
    let peakKwh = 0;
    for (const r of rows) {
      daySet.add(r.dayStr);
      const dow = r.dateObj.getDay();
      const h = r.dateObj.getHours();
      if (dow >= 1 && dow <= 5 && h >= ULO_PEAK_START_HOUR && h < ULO_PEAK_END_HOUR) {
        peakKwh += r.usage_kwh;
        hoursSeen.add(h);
      }
    }
    if (peakKwh > 0) {
      const months = Math.max(1, daySet.size / DAYS_PER_MONTH);
      const kwhPerMonth = peakKwh / months;
      const costPerMonth = kwhPerMonth * (rates.ulo.onPeak / 100);
      const overnightCostPerMonth = kwhPerMonth * (rates.ulo.overnight / 100);
      peakExposure = {
        hoursPerWeekday: hoursSeen.size,
        kwhPerMonth,
        rateCents: rates.ulo.onPeak,
        costPerMonth,
        overnightCostPerMonth,
        atStakePerMonth: costPerMonth - overnightCostPerMonth,
        windowLabel: 'Weekdays 16:00–21:00',
      };
    }
  }

  const ready = rows.length > 0 && rates !== null && dailyKwh > 0;
  const emptyReason: EvScenarioEmptyReason | null = ready
    ? null
    : rows.length === 0
      ? 'no-data'
      : rates === null
        ? 'no-rates'
        : 'no-ev-kwh';

  if (!ready) {
    return {
      ready: false,
      emptyReason,
      dailyKwh,
      source: null,
      candidate,
      prices,
      chargeSavingUloVsTouPerMonth: 0,
      planComparison: null,
      peakExposure,
      assumptions,
    };
  }

  const activeRates = rates as RateSet;

  // --- Where did the number come from? Say so, and flag a mismatch.
  let source: EvScenario['source'] = 'tagged';
  if (candidate && Math.abs(dailyKwh - candidate.kwhPerNight) <= Math.max(0.1, TAG_MISMATCH_SHARE * candidate.kwhPerNight)) {
    source = 'detected';
  }

  if (candidate) {
    assumptions.push(
      source === 'detected'
        ? `Charging window read from your own data: ${candidate.label}, ${candidate.detail}. We can only see a block of load — we cannot tell an EV apart from any other timed appliance.`
        : `You tagged ${dailyKwh.toFixed(1)} kWh a night; the overnight block in your data averages ${candidate.kwhPerNight.toFixed(1)} kWh/night (${candidate.label}). We priced YOUR number and kept the block's charging hours.`,
    );
  } else {
    assumptions.push(
      `No overnight charging block turned up in your data, so the plan comparison prices this energy as if it charges during your most expensive hours today. Treat the swing as an upper bound, not a measurement.`,
    );
  }

  // --- Three-plan comparison with the charge moved into 23:00–07:00.
  const daySet = new Set<string>();
  for (const r of rows) daySet.add(r.dayStr);
  const days = daySet.size;
  const evKwh = dailyKwh * days;

  const monthly = aggregateChartData(rows, 'monthly');
  const baselineTotals = calculateComparison(monthly);

  const currentEvCost = {} as Record<EvPlan, number>;
  const overnightEvCost = {} as Record<EvPlan, number>;
  const withChargeOnOvernight = {} as Record<EvPlan, number>;

  if (baselineTotals) {
    for (const plan of PLANS) {
      // Observed $/kWh at the detected block (whatever the tag says — the
      // block tells us WHEN the car charges), else the honest worst case.
      let currentRate = worstCaseRateCents(plan, activeRates);
      if (candidate) {
        const run = new Set<number>();
        for (
          let h = candidate.startHour, n = 0;
          n < candidate.hours;
          n++, h = (h + 1) % 24
        ) run.add(h);
        let cost = 0;
        let kwh = 0;
        for (const r of rows) {
          if (!run.has(r.dateObj.getHours())) continue;
          cost += plan === 'TOU' ? r.costTOU : plan === 'ULO' ? r.costULO : r.costTiered;
          kwh += r.usage_kwh;
        }
        if (kwh > 0) currentRate = (cost / kwh) * 100;
      }

      currentEvCost[plan] = evKwh * (currentRate / 100);
      overnightEvCost[plan] = evKwh * (overnightRateCents(plan, activeRates) / 100);
      withChargeOnOvernight[plan] =
        baselineTotals[plan] - currentEvCost[plan] + overnightEvCost[plan];
    }
  }

  const planComparison: EvPlanComparison | null = baselineTotals
    ? { baseline: baselineTotals, withChargeOnOvernight, currentEvCost, overnightEvCost, evKwh, days }
    : null;

  assumptions.push(
    `$ per charge assumes the whole charge lands in 23:00–07:00, the ULO overnight window.`,
    `$ per month assumes ${CHARGING_NIGHTS_PER_MONTH} charging nights.`,
    `Rates are OEB commodity only — delivery, regulatory charges and HST are not in these numbers.`,
  );
  if (peakExposure) {
    assumptions.push(
      `${peakExposure.windowLabel} is ULO On-Peak at ${peakExposure.rateCents.toFixed(1)}¢/kWh — the exposure flagged below.`,
    );
  }

  return {
    ready: true,
    emptyReason: null,
    dailyKwh,
    source,
    candidate,
    prices,
    chargeSavingUloVsTouPerMonth: prices.TOU.perMonth - prices.ULO.perMonth,
    planComparison,
    peakExposure,
    assumptions,
  };
}
