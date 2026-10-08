/**
 * EV charging scenario — "what does a charge actually cost, when do you
 * charge it, and what does moving it to Ultra-Low Overnight actually do?"
 *
 * Three inputs, all honest about where they came from:
 *
 *  1. a NIGHTLY kWh the user typed, OR an auto-detected overnight block we
 *     found in their own data (prefilled, editable, and always labelled as
 *     "a block we found" — we never claim it is an EV);
 *  2. the HOUR they charge at (the anchor): prefilled from that detected
 *     block, or set on the hour wheel by the household. This is what makes
 *     "stay at 7 PM on your plan" vs "move it to midnight on ULO" answerable
 *     at all — without it the charge had no clock, and a 19:00 charger was
 *     shown a number computed for somebody else's evening;
 *  3. the loaded readings, repriced so the charge lands in the ULO overnight
 *     window (23:00–07:00) instead of wherever it charges today.
 *
 * Everything here is pure and deterministic: no `Date.now()`, the "how much
 * data do I have" question is answered from the readings themselves, and the
 * stay side is priced from the readings' OWN period charges, so the season
 * and the day type come out of the data instead of a static window table.
 */

/* Wave U — the EV assumptions are shown to the user, so they translate. */
import { fmtCents, periodLabel, t } from '@/i18n';
import {
  aggregateChartData,
  calculateComparison,
  tieredRateCentsFor,
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
  /** Distinct days of data the /month figures were scaled FROM. Every "per
   *  month" number here is peakKwh ÷ (days ÷ 30.44) — a run-rate over this
   *  window, never a month of metering. The UI must be able to say so. */
  days: number;
};

export type EvScenarioEmptyReason = 'no-data' | 'no-rates' | 'no-ev-kwh';

/* ------------------------------------------------------------------------ *
 * EV v2 — the "when do you charge?" hour anchor
 *
 * The complaint this fixes: a household whose car charges at 19:00 was shown
 * a ULO saving computed for somebody else's clock (or for no clock at all —
 * the shipped code fell back to each plan's worst case). The anchor is the
 * answer to one question — WHEN does it charge? — and the counterfactual it
 * unlocks is "stay at your hour on your plan" vs "move it to 23:00–07:00 on
 * ULO", split so the hour and the plan can never be credited twice.
 * ------------------------------------------------------------------------ */

/**
 * Hours either side of the anchor the household's habit is allowed to drift.
 *
 * Attributing a whole charge to ONE clock hour gives a knife-edge answer: an
 * hour either side can sit in a different price window (winter TOU on-peak
 * ENDS at 19:00, so 18:00 and 19:00 are different rates). People plug in
 * roughly the same time each night but not to the minute, so the honest
 * monthly expectation spreads the kWh across h−1, h and h+1 rather than
 * pinning the whole charge on one hour.
 */
export const ANCHOR_DRIFT_HOURS = 1;

/** The clock hours the charge can land on: [h−1, h, h+1], wrapped to the clock. */
export function anchorBand(hour: number): number[] {
  const wrap = (h: number) => ((h % 24) + 24) % 24;
  return [wrap(hour - ANCHOR_DRIFT_HOURS), wrap(hour), wrap(hour + ANCHOR_DRIFT_HOURS)];
}

/** Where the anchor hour came from: our own detection, or the household. */
export type ChargeHourSource = 'detected' | 'user';

/** Which hours "today" is priced from. */
export type StayBasis =
  /** The detected block — where the readings actually put the energy. */
  | 'block'
  /** The ±1 h band around the hour the household gave us. */
  | 'band'
  /** No readings at those hours at all: each plan's worst case, an upper bound. */
  | 'worst-case';

/** One anchor hour's price today, and the evidence behind it. */
export type EvHourPrice = {
  hour: number;
  /** Blended ¢/kWh across the readings we have at this hour. */
  rateCents: number;
  /** Windows seen at this hour — weekday and weekend can both appear. */
  categories: string[];
  /** Weight this hour carries in the blend; shares sum to 1. */
  share: number;
  /** No readings here: this hour is priced at the plan's worst case. */
  upperBound: boolean;
};

/**
 * The counterfactual the household actually asked for: what their charge costs
 * STAYING PUT at their hour on their current plan, versus MOVING it into
 * 23:00–07:00 on Ultra-Low Overnight — split into `plan` + `shift` so the
 * clock and the plan are never credited twice.
 */
export type EvChargeMove = {
  /** The hour they charge at (0–23). */
  hour: number;
  source: ChargeHourSource;
  /** The ±1 h drift band around `hour`. */
  band: number[];
  /** "18:00–21:00" */
  bandLabel: string;
  /** Hours "today" is priced from (the detected block, or the band). */
  stayHours: number[];
  /** "23:00–02:00" / "18:00–21:00" */
  stayLabel: string;
  stayBasis: StayBasis;
  /** Per-hour evidence for the stay side, in clock order. */
  stayBreakdown: EvHourPrice[];
  /** Current plan's blended rate at those hours, ¢/kWh. */
  stayRateCents: number;
  stayCostPerCharge: number;
  stayCostPerMonth: number;
  /** The same hours priced on each plan — what "today" costs, three ways. */
  stayCostPerChargeByPlan: Record<EvPlan, number>;
  /** The SAME hours on ULO — the plan half of the question. */
  uloAtAnchorRateCents: number;
  uloAtAnchorCostPerCharge: number;
  /** The charge inside 23:00–07:00 on ULO (=== prices.ULO). */
  moveRateCents: number;
  moveCostPerCharge: number;
  moveCostPerMonth: number;
  /** stay − ULO@anchor: what changing PLAN does, hour untouched. Negative = worse. */
  planSavingPerCharge: number;
  planSavingPerMonth: number;
  /** ULO@anchor − move: what moving the HOUR does, on ULO. */
  shiftSavingPerCharge: number;
  shiftSavingPerMonth: number;
  /** stay − move === plan + shift, exactly. One credit, split, added once. */
  totalSavingPerCharge: number;
  totalSavingPerMonth: number;
  /** Rate seasons the stay hours were priced in. */
  seasons: Array<'Winter' | 'Summer'>;
  /** The stay hours already sit inside 23:00–07:00: nothing to shift. */
  alreadyOvernight: boolean;
  /** Evidence sentence for the card. */
  detail: string;
};

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
  /** Stay at your hour vs move to 23:00–07:00 — null until an hour is known. */
  chargeMove: EvChargeMove | null;
  assumptions: string[];
};

/** The rate a charge lands on under each plan when it runs 23:00–07:00.
 *  `tieredRateCents` is the window's own blended tiered rate — Tiered has no
 *  overnight window, so the rate is simply what that plan costs here. */
function overnightRateCents(plan: EvPlan, rates: RateSet, tieredRateCents: number): number {
  if (plan === 'TOU') return rates.tou.offPeak;
  if (plan === 'ULO') return rates.ulo.overnight;
  return tieredRateCents;
}

/** The rate the same charge pays today if we cannot see where it charges. */
function worstCaseRateCents(plan: EvPlan, rates: RateSet, tieredRateCents: number): number {
  if (plan === 'TOU') return rates.tou.onPeak;
  if (plan === 'ULO') return rates.ulo.onPeak;
  // Tiered has no time-of-use windows: time shifting never moves this bill,
  // so the "worst case" is the same blended tiered rate, not the tier-1
  // floor (which would be the best case, not the worst).
  return tieredRateCents;
}

const PLANS: EvPlan[] = ['TOU', 'Tiered', 'ULO'];

/** ULO's overnight window as a set — the hours a move buys nothing. */
const OVERNIGHT = new Set<number>(OVERNIGHT_HOURS);

/** The clock hours a detected block covers, in clock order. */
function blockHoursOf(c: EvCandidate): number[] {
  const out: number[] = [];
  for (let h = c.startHour, n = 0; n < c.hours; n++, h = (h + 1) % 24) out.push(h);
  return out;
}

/** One clock hour's audit trail: what its readings were actually charged. */
type HourAudit = {
  kwh: number;
  cost: Record<EvPlan, number>;
  /** kWh per window label at this hour — the evidence line. */
  categories: Map<string, number>;
};

function planCategoryOf(r: ProcessedPoint, plan: EvPlan): string {
  if (plan === 'TOU') return r.touCategory;
  if (plan === 'ULO') return r.uloCategory;
  return 'Tiered';
}

/**
 * Price the hours the charge sits in TODAY, read back from the readings' own
 * period charges (`costTOU` / `costULO` / `costTiered`).
 *
 * That is the audit trail this needed: every row was priced with the RateSet
 * AND the season its own day used, so winter/summer windows, weekday/weekend
 * and holiday pricing all come out of the data. Nothing here re-derives a
 * window from a static table — which is the whole reason a 19:00 anchor in
 * November prices differently from the same anchor in June.
 *
 * Weights differ by basis, deliberately:
 *   • 'block' — weight each hour by the energy actually observed there, so
 *     the blend reproduces that block's real bill to the cent;
 *   • 'band' — weight the three drift hours equally: the model is "a third of
 *     the nights an hour early, a third on the dot, a third an hour late";
 *   • an hour with no readings prices at the plan's WORST case and is flagged
 *     as an upper bound rather than silently dropped.
 *
 * An empty `hours` list means nobody has answered the hour question and there
 * is no block: the shipped worst-case fallback, unchanged.
 */
function priceStayHours(input: {
  rows: ProcessedPoint[];
  hours: number[];
  basis: StayBasis;
  currentPlan: EvPlan;
  rates: RateSet;
  /** The window's own blended tiered rate — every Tiered figure shares it. */
  tieredRateCents: number;
}): {
  rateCents: Record<EvPlan, number>;
  breakdown: EvHourPrice[];
  seasons: Array<'Winter' | 'Summer'>;
} {
  const { rows, hours, basis, currentPlan, rates, tieredRateCents } = input;

  if (hours.length === 0) {
    return {
      rateCents: {
        TOU: worstCaseRateCents('TOU', rates, tieredRateCents),
        Tiered: worstCaseRateCents('Tiered', rates, tieredRateCents),
        ULO: worstCaseRateCents('ULO', rates, tieredRateCents),
      },
      breakdown: [],
      seasons: [],
    };
  }

  const wanted = new Set(hours);
  const audit = new Map<number, HourAudit>();
  let winterKwh = 0;
  let summerKwh = 0;
  for (const r of rows) {
    const h = r.dateObj.getHours();
    if (!wanted.has(h)) continue;
    let a = audit.get(h);
    if (!a) {
      a = { kwh: 0, cost: { TOU: 0, Tiered: 0, ULO: 0 }, categories: new Map() };
      audit.set(h, a);
    }
    a.kwh += r.usage_kwh;
    a.cost.TOU += r.costTOU;
    // Tiered is priced at the WINDOW's blended rate, not the per-reading
    // tier-1 field: these kWh sit inside a month that is (usually) already
    // over its threshold, so tier 1 would understate what the charge costs.
    a.cost.Tiered += (r.usage_kwh * tieredRateCents) / 100;
    a.cost.ULO += r.costULO;
    const cat = planCategoryOf(r, currentPlan);
    a.categories.set(cat, (a.categories.get(cat) ?? 0) + r.usage_kwh);
    if (r.isWinter) winterKwh += r.usage_kwh;
    else summerKwh += r.usage_kwh;
  }

  const observed = hours.reduce((sum, h) => sum + (audit.get(h)?.kwh ?? 0), 0);
  const uniform = basis !== 'block' || observed <= 0;
  const weightOf = (h: number) =>
    uniform ? 1 / hours.length : (audit.get(h)?.kwh ?? 0) / observed;
  const rateAt = (h: number, plan: EvPlan): number | null => {
    const a = audit.get(h);
    return !a || a.kwh <= 0 ? null : (a.cost[plan] / a.kwh) * 100;
  };

  const rateCents = {} as Record<EvPlan, number>;
  for (const plan of PLANS) {
    let rate = 0;
    for (const h of hours)
      rate += weightOf(h) * (rateAt(h, plan) ?? worstCaseRateCents(plan, rates, tieredRateCents));
    rateCents[plan] = rate;
  }

  const breakdown: EvHourPrice[] = hours.map((h) => {
    const own = rateAt(h, currentPlan);
    return {
      hour: h,
      rateCents: own ?? worstCaseRateCents(currentPlan, rates, tieredRateCents),
      categories:
        own === null
          ? ['no readings']
          : Array.from(audit.get(h)!.categories.entries())
              .sort((x, y) => y[1] - x[1])
              .map(([label]) => label),
      share: weightOf(h),
      upperBound: own === null,
    };
  });

  const seasons: Array<'Winter' | 'Summer'> = [];
  if (winterKwh > 0) seasons.push('Winter');
  if (summerKwh > 0) seasons.push('Summer');

  return { rateCents, breakdown, seasons };
}

/** The evidence sentence under the stay-vs-move comparison.
 *
 * Wave U — the sentence translates, and so do the rate-period NAMES inside
 * it: `categories` holds the canonical names ("Off-Peak") because they are
 * data the classifier produced, but this is prose shown to a person, so each
 * one goes through `periodLabel()` ("Période creuse"). The hour and the rate
 * are numbers, so they take the locale's decimal comma. */
function stayDetail(stayLabel: string, breakdown: EvHourPrice[]): string {
  if (breakdown.length === 0) return '';
  if (breakdown.every((b) => b.upperBound)) {
    return t('ev.stayDetailUpper', { label: stayLabel });
  }
  return t('ev.stayDetail', {
    label: stayLabel,
    hours: breakdown
      .map(
        (b) =>
          `${pad2(b.hour)}:00 ${b.categories.map((c) => periodLabel(c)).join(t('ev.categoriesAnd'))} ${fmtCents(b.rateCents, 1)}`,
      )
      .join(' · '),
  });
}

/**
 * "Stay at your hour on your plan" vs "move the same kWh to 23:00–07:00 on
 * ULO", plus the exact split between the two causes.
 *
 * The split is the point: at 19:00 on ULO the same hours are On-Peak, so the
 * PLAN half can be negative while the SHIFT half is strongly positive. Showing
 * only the total (or only either half) is how the shipped card misled exactly
 * the households it was built for.
 */
function buildChargeMove(input: {
  anchor: { hour: number; source: ChargeHourSource };
  stayHours: number[];
  stayLabel: string;
  stayBasis: StayBasis;
  pricing: ReturnType<typeof priceStayHours>;
  dailyKwh: number;
  currentPlan: EvPlan;
  rates: RateSet;
}): EvChargeMove {
  const { anchor, stayHours, stayLabel, stayBasis, pricing, dailyKwh, currentPlan, rates } = input;
  const perCharge = (rateCents: number) => dailyKwh * (rateCents / 100);
  const perMonth = (dollars: number) => dollars * CHARGING_NIGHTS_PER_MONTH;

  const stayCostPerChargeByPlan = {} as Record<EvPlan, number>;
  for (const plan of PLANS) stayCostPerChargeByPlan[plan] = perCharge(pricing.rateCents[plan]);

  const stayCostPerCharge = stayCostPerChargeByPlan[currentPlan];
  const uloAtAnchorCostPerCharge = stayCostPerChargeByPlan.ULO;
  const moveRateCents = rates.ulo.overnight;
  const moveCostPerCharge = perCharge(moveRateCents);

  // One credit, two halves: plan (which plan at your hour) + shift (which hour
  // on ULO). They add up to the total exactly, so no view can pay it twice.
  const planSavingPerCharge = stayCostPerCharge - uloAtAnchorCostPerCharge;
  const shiftSavingPerCharge = uloAtAnchorCostPerCharge - moveCostPerCharge;
  const totalSavingPerCharge = stayCostPerCharge - moveCostPerCharge;

  return {
    hour: anchor.hour,
    source: anchor.source,
    band: anchorBand(anchor.hour),
    bandLabel: clockRange(anchorBand(anchor.hour)),
    stayHours,
    stayLabel,
    stayBasis,
    stayBreakdown: pricing.breakdown,
    stayRateCents: pricing.rateCents[currentPlan],
    stayCostPerCharge,
    stayCostPerMonth: perMonth(stayCostPerCharge),
    stayCostPerChargeByPlan,
    uloAtAnchorRateCents: pricing.rateCents.ULO,
    uloAtAnchorCostPerCharge,
    moveRateCents,
    moveCostPerCharge,
    moveCostPerMonth: perMonth(moveCostPerCharge),
    planSavingPerCharge,
    planSavingPerMonth: perMonth(planSavingPerCharge),
    shiftSavingPerCharge,
    shiftSavingPerMonth: perMonth(shiftSavingPerCharge),
    totalSavingPerCharge,
    totalSavingPerMonth: perMonth(totalSavingPerCharge),
    seasons: pricing.seasons,
    alreadyOvernight: stayHours.length > 0 && stayHours.every((h) => OVERNIGHT.has(h)),
    detail: stayDetail(stayLabel, pricing.breakdown),
  };
}

export function buildEvScenario(input: {
  rows: ProcessedPoint[];
  rates: RateSet | null;
  /** Nightly kWh the user tagged (0 = nothing tagged yet). */
  dailyKwh: number;
  /** Pass a precomputed candidate to avoid detecting twice. */
  candidate?: EvCandidate | null;
  /**
   * "When do you usually charge?" — a clock hour (0–23), or null when nobody
   * has answered yet. Null falls back to the detected block's first hour, so
   * we reuse the winning candidate rather than asking blind when one exists.
   */
  chargeHour?: number | null;
  /** Whether that hour came from our detection or from the household. */
  chargeHourSource?: ChargeHourSource | null;
  /**
   * The plan the household is actually on. The "stay put" side of the
   * counterfactual is priced on this plan — 19:00 costs something different
   * on TOU than it does on ULO, and only their own plan answers "what am I
   * paying today".
   */
  currentPlan?: EvPlan;
}): EvScenario {
  const { rows, rates, dailyKwh } = input;
  const candidate =
    input.candidate !== undefined ? input.candidate : detectEvCandidate(rows);

  // ONE Tiered number for the whole scenario: the window's own blended tiered
  // rate (month-scoped tier-2 threshold, ÷ this window's kWh). The stay side,
  // the overnight side and the plan cards all read from it, so "moving hours
  // cannot change what Tiered costs" stays exactly true while the figure
  // itself is the rate the household actually pays — not the tier-1 floor.
  const tieredRateCents =
    rates === null
      ? 0
      : ((rows.length > 0 ? tieredRateCentsFor(rows) : null) ?? rates.tiered.tier1);

  const prices = {} as Record<EvPlan, EvPlanPrice>;
  for (const plan of PLANS) {
    const rateCents = rates ? overnightRateCents(plan, rates, tieredRateCents) : 0;
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
        days: daySet.size,
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
      chargeMove: null,
      assumptions,
    };
  }

  const activeRates = rates as RateSet;
  const currentPlan = input.currentPlan ?? 'TOU';

  // --- The hour anchor: where does the charge's energy sit TODAY?
  const chargeHour = input.chargeHour ?? null;
  const chargeHourSource: ChargeHourSource | null =
    input.chargeHourSource !== undefined
      ? input.chargeHourSource
      : chargeHour !== null
        ? 'user'
        : candidate
          ? 'detected'
          : null;
  const anchorHour = chargeHour ?? (candidate ? candidate.startHour : null);
  const anchor =
    anchorHour !== null && chargeHourSource !== null
      ? { hour: anchorHour, source: chargeHourSource }
      : null;

  let stayHours: number[] = [];
  let stayBasis: StayBasis = 'worst-case';
  if (anchor) {
    const block = candidate ? blockHoursOf(candidate) : [];
    if (block.includes(anchor.hour)) {
      // Our own detection, or a household answer that agrees with it: price
      // the hours the readings actually put the energy in.
      stayHours = block;
      stayBasis = 'block';
    } else {
      // They told us an hour we did NOT see (a 7 PM charge never turns up in
      // the night window): trust them, ±1 h of habit drift.
      stayHours = anchorBand(anchor.hour);
      stayBasis = 'band';
    }
  }
  const stayLabel = stayHours.length > 0 ? clockRange(stayHours) : '';
  const pricing = priceStayHours({
    rows,
    hours: stayHours,
    basis: stayBasis,
    currentPlan,
    rates: activeRates,
    tieredRateCents,
  });
  // A band we have no readings for at all is not a measured band — every hour
  // in it fell back to the plan's worst case, so call the basis what it is
  // rather than claiming "we priced your hours from your data".
  if (
    stayBasis === 'band' &&
    pricing.breakdown.length > 0 &&
    pricing.breakdown.every((b) => b.upperBound)
  ) {
    stayBasis = 'worst-case';
  }
  const chargeMove = anchor
    ? buildChargeMove({
        anchor,
        stayHours,
        stayLabel,
        stayBasis,
        pricing,
        dailyKwh,
        currentPlan,
        rates: activeRates,
      })
    : null;

  // --- Where did the number come from? Say so, and flag a mismatch.
  let source: EvScenario['source'] = 'tagged';
  if (candidate && Math.abs(dailyKwh - candidate.kwhPerNight) <= Math.max(0.1, TAG_MISMATCH_SHARE * candidate.kwhPerNight)) {
    source = 'detected';
  }

  if (candidate) {
    assumptions.push(
      source === 'detected'
        ? t('ev.assumeDetected', { label: candidate.label, detail: candidate.detail })
        : t('ev.assumeTagged', {
            tagged: dailyKwh.toFixed(1),
            actual: candidate.kwhPerNight.toFixed(1),
            label: candidate.label,
            basis:
              stayBasis === 'block'
                ? t('ev.assumeBasisBlock')
                : t('ev.assumeBasisHour', { hour: pad2(input.chargeHour ?? candidate.startHour) }),
          }),
    );
  } else if (!chargeMove) {
    // Nobody has answered the hour question and we found no block: the old
    // honest fallback stands — most expensive hours, called an upper bound.
    assumptions.push(
      t('ev.assumeNoBlockBound'),
    );
  } else {
    assumptions.push(
      t('ev.assumeNoBlockHour', { hour: pad2(chargeMove.hour) }),
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
      // "What this energy costs today" is the SAME number the stay side of
      // the counterfactual uses: the anchor hours, priced from the readings'
      // own period charges — or the honest worst case when we do not know the
      // hour and found no block. One credit, paid once, in both views.
      const currentRate = pricing.rateCents[plan];

      currentEvCost[plan] = evKwh * (currentRate / 100);
      overnightEvCost[plan] =
        evKwh * (overnightRateCents(plan, activeRates, tieredRateCents) / 100);
      withChargeOnOvernight[plan] =
        baselineTotals[plan] - currentEvCost[plan] + overnightEvCost[plan];
    }
  }

  const planComparison: EvPlanComparison | null = baselineTotals
    ? { baseline: baselineTotals, withChargeOnOvernight, currentEvCost, overnightEvCost, evKwh, days }
    : null;

  assumptions.push(
    t('ev.assumePerCharge'),
    t('ev.assumePerMonth', { nights: CHARGING_NIGHTS_PER_MONTH }),
    t('ev.assumeCommodityOnly'),
  );
  if (peakExposure) {
    assumptions.push(
      t('ev.assumePeakExposure', { label: peakExposure.windowLabel, rate: fmtCents(peakExposure.rateCents, 1) }),
    );
  }

  // --- The hour anchor, in plain language.
  if (chargeMove) {
    if (chargeMove.stayBasis === 'worst-case') {
      assumptions.push(
        t('ev.assumeWorstCase', { label: chargeMove.stayLabel }),
      );
    } else if (chargeMove.stayBasis === 'band') {
      assumptions.push(
        t('ev.assumeBand', {
          band: chargeMove.bandLabel,
          hour: pad2(chargeMove.hour),
          seasons: chargeMove.seasons.join(t('ev.seasonsAnd')) || t('ev.noSeason'),
        }),
      );
    } else {
      assumptions.push(
        t('ev.assumeStay', { label: chargeMove.stayLabel }),
      );
    }
    assumptions.push(
      t('ev.assumeDoubleCount'),
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
    chargeMove,
    assumptions,
  };
}
