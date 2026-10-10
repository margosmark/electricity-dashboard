/**
 * Wave S — efficiency statistics: what a kWh actually cost, per bill and on
 * average, and whether that number is trending in a direction you can claim.
 *
 * Everything here is PURE: `UsageSummary[]` + the loaded OEB rate sets in,
 * numbers out. No I/O, no Date.now(), no DOM.
 *
 * --------------------------------------------------------------------------------
 * The three numbers
 * --------------------------------------------------------------------------------
 * 1. PER PERIOD — ¢/kWh = the bill's own "Total Electricity Charges" ÷ the
 *    metered usage in the same summary (the per-category "… Usage"
 *    measurements, uom 72 scaled by powerOfTenMultiplier — the same quantity
 *    `billedKwh` returns). Audited on the owner's 24-period export:
 *    Aug 2024 = 15.9¢, Jul 2025 = 13.9¢, Jan 2026 = 19.4¢.
 *
 * 2. ALL-TIME — the kWh-weighted mean over every closed billing period from
 *    every loaded export: Σ(cost) ÷ Σ(kWh). Weighting by kWh (not by bill)
 *    means a 3,101 kWh July moves the headline as much as it should and a
 *    816 kWh January doesn't get an equal vote it didn't earn.
 *
 * 3. IN-VIEW — the same weighted mean, scoped to the window the user is
 *    actually looking at (the date selection, further narrowed by whatever
 *    the chart is zoomed into). Bills whose billing window overlaps the
 *    selection are in; the weight is still each bill's own kWh.
 *
 * --------------------------------------------------------------------------------
 * The verdict, and why it is split (the honesty bar)
 * --------------------------------------------------------------------------------
 * A raw ¢/kWh trend conflates three things that have nothing to do with each
 * other: how you used electricity, what the OEB priced it at, and the season
 * (summer bills are structurally cheaper per kWh — off-peak dominates and the
 * fixed delivery charge is spread over 2.5× the kWh). Declaring "you're
 * getting more efficient!" off a raw slope is exactly the trend-massage this
 * app refuses to do, and during an OEB rate bump (Nov 1) a raw slope would
 * actively lie.
 *
 * So each period is split into two components that sum to it EXACTLY:
 *
 *   behaviour¢/kWh = (usage priced at TODAY's rate set, per category
 *                    + the bill's own delivery/regulatory/other charges as
 *                    billed) ÷ kWh
 *   rate¢/kWh     = observed − behaviour
 *                  = (what the commodity actually cost
 *                     − what today's rates would charge for that same usage)
 *                     ÷ kWh
 *
 * Regression is linear, so slope(observed) = slope(behaviour) + slope(rate)
 * to floating-point precision — the split never loses or invents a cent, and
 * a test asserts it.
 *
 * The VERDICT (the "am I improving?" claim) reads the behaviour component;
 * the rate component and the net are printed beside it. For the owner's data
 * that is the difference between "you're winning" and the truth: over the
 * last 12 bills the behaviour slope is −0.2¢/period while rates pushed
 * +0.2¢/period, netting a statistically-flat ±0.1¢.
 *
 * Honest limits, stated because they change what the panel means:
 *   • "Behaviour" holds the OEB rate SET constant, not the whole bill —
 *     delivery and regulatory charges are utility-set and have no public rate
 *     schedule we can reprice, so they ride with the bill as issued. A
 *     delivery-rate increase therefore lands on the behaviour side. The
 *     counterfactual only claims what it can compute.
 *   • The rate baseline is TODAY's set (`latestRateSet`), so the rate
 *     component reads "how much cheaper/more expensive than right now was
 *     this bill" — zero for bills already priced at the current set, and its
 *     TREND is the rate story (which is why the window must reach back across
 *     a Nov 1 boundary to say anything about rates at all).
 *   • Window: the last up-to-12 closed periods, minimum 4. Twelve months is
 *     one full seasonal cycle — a 6-month window over a twice-yearly seasonal
 *     series is half a cycle, so its slope mostly measures winter→summer.
 *     Below 4 closed bills there aren't enough residuals for a slope standard
 *     error worth quoting, and the panel says so instead of guessing.
 *   • The stable threshold IS the slope's standard error: a slope inside its
 *     own error bar is not a trend. That is the no-massage rule — no
 *     hand-picked band, no "close enough".
 *   • An unmapped usage category (a note this parser can't price against a
 *     rate key) voids the split for that bill rather than guessing a rate;
 *     the ¢/kWh headline still stands, and the panel says the split is off.
 */

import { format } from 'date-fns';

import {
  billedKwh,
  billTotals,
  type BillLineItem,
  type RateSet,
  type UsageSummary,
} from './energy';
import { seasonForDay, type Season } from './season';

/* -------------------------------------------------------------------------- *
 * Window rules
 * -------------------------------------------------------------------------- */

/** Fewest closed bills before a slope + stderr means anything (2 residuals). */
export const TREND_MIN_PERIODS = 4;
/** Never regress over more than this — 12 months is one full seasonal cycle. */
export const TREND_MAX_PERIODS = 12;

/* -------------------------------------------------------------------------- *
 * Per-period efficiency
 * -------------------------------------------------------------------------- */

export type PeriodEfficiency = {
  /** billingPeriod.start, unix seconds (ascending sort key). */
  start: number;
  /** `yyyy-MM-dd` of the period start, from the feed's own stamp. */
  startDate: string;
  /** `yyyy-MM-dd` of the period end. */
  endDate: string;
  /** `MMM yyyy` axis label, e.g. `Aug 2024`. */
  label: string;
  /** Billed kWh — the per-category "… Usage" measurements, same as `billedKwh`. */
  kwh: number;
  /** Total Electricity Charges, dollars (what the bill actually asked for). */
  cost: number;
  /** Observed ¢/kWh: cost ÷ kwh. */
  cents: number;
  /** ¢/kWh had TODAY's rates priced this usage — null when unpriceable. */
  behaviorCents: number | null;
  /** observed − behaviour: the rate-schedule part, null when unpriceable. */
  rateCents: number | null;
  /** Usage kWh this bill's categories we could NOT map to a rate key. */
  unmappedKwh: number;
  season: Season;
};

function usageItems(summary: UsageSummary): BillLineItem[] {
  return summary.items.filter(
    (item) =>
      item.measurement !== null &&
      /usage$/.test(item.note.trim().toLowerCase()),
  );
}

/** The newest loaded set — the "today" every counterfactual is priced at. */
export function latestRateSet(
  rates: readonly RateSet[] | null | undefined,
): RateSet | null {
  if (!rates || rates.length === 0) return null;
  return [...rates].sort((a, b) =>
    b.effectiveDate.localeCompare(a.effectiveDate),
  )[0];
}

/**
 * The rate TODAY's set charges for one metered usage line.
 *
 * Keyed off the utility's own note, the same loose-on-purpose way
 * `classifyBillLine` works: Oakville bills TOU lines as
 * "Off/Mid/On Peak-Summer|Winter" and tiered lines as "BLOCK 1|2 - Winter",
 * and the season word never changes the price (Ontario moves the TOU WINDOWS
 * on Nov 1, not the ¢/kWh). null = we cannot price this note honestly.
 */
export function rateForUsageNote(
  note: string,
  rates: RateSet,
): number | null {
  const n = note.toLowerCase();
  // ULO's labels contain "off-peak" too, so they are tested first.
  if (/overnight|ulo\b/.test(n)) return rates.ulo.overnight;
  if (/weekend/.test(n)) return rates.ulo.weekendOffPeak;
  if (/off[ -]?peak/.test(n)) return rates.tou.offPeak;
  if (/mid[ -]?peak/.test(n)) return rates.tou.midPeak;
  if (/on[ -]?peak/.test(n)) return rates.tou.onPeak;
  if (/block\s*1|tier\s*1|first[ -]?tier/.test(n)) return rates.tiered.tier1;
  if (/block\s*2|tier\s*2|second[ -]?tier/.test(n)) return rates.tiered.tier2;
  return null;
}

/**
 * This bill's usage, repriced at `rates`, plus what we could not price.
 * Dollars are commodity-only: delivery/regulatory stay with the bill.
 */
function counterfactualCommodity(
  summary: UsageSummary,
  rates: RateSet,
): { dollars: number; unmappedKwh: number } {
  let dollars = 0;
  let unmappedKwh = 0;
  for (const item of usageItems(summary)) {
    const qty = item.measurement?.scaled ?? 0;
    const rate = rateForUsageNote(item.note, rates);
    if (rate === null) {
      unmappedKwh += qty;
      continue;
    }
    dollars += (qty * rate) / 100;
  }
  return { dollars, unmappedKwh };
}

/**
 * One row per closed bill, oldest first.
 *
 * Bills with no usable usage measurement are skipped entirely: a ¢/kWh with
 * no kWh is not a small number, it is nonsense.
 */
export function efficiencyPeriods(
  summaries: readonly UsageSummary[],
  rates: readonly RateSet[] | null | undefined,
): PeriodEfficiency[] {
  const latest = latestRateSet(rates);
  const out: PeriodEfficiency[] = [];

  for (const summary of summaries) {
    const kwh = billedKwh(summary);
    if (kwh === null || !(kwh > 0)) continue;
    const totals = billTotals(summary);
    const cost = totals.total;
    if (!Number.isFinite(cost)) continue;

    const cents = (cost / kwh) * 100;
    let behaviorCents: number | null = null;
    let rateCents: number | null = null;
    let unmappedKwh = 0;

    if (latest) {
      const cf = counterfactualCommodity(summary, latest);
      unmappedKwh = cf.unmappedKwh;
      if (cf.unmappedKwh === 0) {
        // Everything the rate set does NOT price rides with the bill as
        // issued, so behaviour + rate recombines to `cents` exactly.
        const nonCommodity = cost - totals.commodity;
        behaviorCents = ((cf.dollars + nonCommodity) / kwh) * 100;
        rateCents = cents - behaviorCents;
      }
    }

    out.push({
      start: summary.start,
      startDate: summary.startDate,
      endDate: summary.endDate,
      label: format(new Date(`${summary.startDate}T00:00:00`), 'MMM yyyy'),
      kwh,
      cost,
      cents,
      behaviorCents,
      rateCents,
      unmappedKwh,
      season: seasonForDay(summary.startDate),
    });
  }

  return out.sort((a, b) => a.start - b.start);
}

export type EfficiencyAverage = {
  /** kWh-weighted mean of the periods' ¢/kWh: Σcost ÷ ΣkWh × 100. */
  cents: number;
  /** Periods that went into it. */
  bills: number;
  /** Period kWh behind the weight. */
  kwh: number;
};

/** Weighted mean over `periods`; null when there is no kWh to divide by. */
export function weightedCentsPerKwh(
  periods: readonly PeriodEfficiency[],
): EfficiencyAverage | null {
  if (periods.length === 0) return null;
  let cost = 0;
  let kwh = 0;
  for (const p of periods) {
    cost += p.cost;
    kwh += p.kwh;
  }
  if (!(kwh > 0)) return null;
  return { cents: (cost / kwh) * 100, bills: periods.length, kwh };
}

/**
 * The same weighted mean, scoped to the window on screen.
 *
 * A bill is "in view" when its billing window overlaps the selection at all;
 * the weight stays the bill's OWN kWh, because a bill is issued whole — we
 * never split a bill's charges across a date edge we cannot see in the file.
 * `start`/`end` are `yyyy-MM-dd`; either may be absent (unbounded).
 */
export function inViewCentsPerKwh(
  periods: readonly PeriodEfficiency[],
  view: { start?: string | null; end?: string | null } | null,
): EfficiencyAverage | null {
  if (!view || (!view.start && !view.end)) return null;
  const start = view.start ?? '';
  const end = view.end ?? '';
  const inView = periods.filter(
    (p) => p.startDate <= end && p.endDate >= start,
  );
  return weightedCentsPerKwh(inView);
}

/* -------------------------------------------------------------------------- *
 * Regression + verdict
 * -------------------------------------------------------------------------- */

export type LinearFit = {
  /** ¢/kWh per period. */
  slope: number;
  intercept: number;
  /** Standard error of the SLOPE — the stable/no-trend threshold. */
  stderr: number;
  n: number;
};

/**
 * Ordinary least squares over evenly spaced periods (index is x).
 * null below 3 points: with 2 there is nothing to test the line against.
 */
export function linearFit(values: readonly number[]): LinearFit | null {
  const n = values.length;
  if (n < 3) return null;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (i - meanX) ** 2;
    sxy += (i - meanX) * (values[i] - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const resid = values[i] - (intercept + slope * i);
    sse += resid * resid;
  }
  const stderr = Math.sqrt(sse / (n - 2) / sxx);
  return { slope, intercept, stderr, n };
}

export type TrendVerdict = 'improving' | 'worsening' | 'stable';
export type TrendDirection = 'down' | 'up' | 'flat';

/**
 * Direction of a fit: `flat` when the slope sits inside its own standard
 * error. That threshold is not a policy choice, it is the error bar — the
 * no-trend-massage rule made numeric.
 */
export function directionOf(fit: LinearFit | null): TrendDirection | null {
  if (!fit) return null;
  if (Math.abs(fit.slope) <= fit.stderr) return 'flat';
  return fit.slope < 0 ? 'down' : 'up';
}

/** ¢/kWh falls = the thing this panel measures got cheaper = improving. */
export function verdictOf(fit: LinearFit | null): TrendVerdict | null {
  const dir = directionOf(fit);
  if (dir === null) return null;
  if (dir === 'flat') return 'stable';
  return dir === 'down' ? 'improving' : 'worsening';
}

/** Signed to one decimal: `+0.2`, `-0.5`. */
export function fmtSigned(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)}` : rounded.toFixed(1);
}

/** Unsigned to one decimal, for ±-style bands. */
export function fmtBand(n: number): string {
  return (Math.round(Math.abs(n) * 10) / 10).toFixed(1);
}

/* -------------------------------------------------------------------------- *
 * The trend report
 * -------------------------------------------------------------------------- */

export type EfficiencyTrend = {
  ready: boolean;
  /** Why it is not ready (null when it is). */
  emptyMessage: string | null;
  /** Every closed period, oldest first — the chart draws all of them. */
  points: PeriodEfficiency[];
  /** The regression window: the newest `windowSize` periods. */
  window: PeriodEfficiency[];
  windowSize: number;
  /** `your last 12 bills`. */
  windowLabel: string;
  /** Fit over observed ¢/kWh. */
  net: LinearFit | null;
  /** Fit over the behaviour component (what today's rates + your usage cost). */
  behavior: LinearFit | null;
  /** Fit over the rate component (what rates did, versus today). */
  rate: LinearFit | null;
  /**
   * The headline claim. Reads BEHAVIOUR when the split is computable — the
   * panel never credits you with a rate change — else the net fit.
   */
  verdict: TrendVerdict | null;
  /** The slope the verdict was read from, ¢/kWh per period. */
  slope: number | null;
  /** Stable threshold: the stderr of the fit the verdict was read from. */
  band: number;
  /** Net (observed) verdict — always reported beside the headline. */
  netVerdict: TrendVerdict | null;
  /** What the rate component did over the window. */
  rateDirection: TrendDirection | null;
  /** One honest sentence; null when there is no verdict to phrase. */
  sentence: string | null;
  splitAvailable: boolean;
  /** Why the split is off (null when it is on). */
  splitNote: string | null;
  /** Rate-set effectiveDates strictly inside the loaded span (Nov 1 ticks). */
  rateBoundaries: string[];
};

/** Rate changes that fall strictly inside the periods on screen. */
export function rateBoundaries(
  periods: readonly PeriodEfficiency[],
  rates: readonly RateSet[] | null | undefined,
): string[] {
  if (periods.length === 0 || !rates || rates.length === 0) return [];
  const firstDay = periods[0].startDate;
  const lastDay = periods[periods.length - 1].endDate;
  return Array.from(new Set(rates.map((r) => r.effectiveDate)))
    .filter((d) => d > firstDay && d <= lastDay)
    .sort();
}

function behaviorClause(dir: TrendDirection, slope: number): string {
  if (dir === 'flat') return `your usage mix is flat (±${fmtBand(slope)}¢ behavior-driven)`;
  if (dir === 'down')
    return `your usage mix improved (${fmtSigned(slope)}¢/kWh behavior-driven)`;
  return `your usage mix got worse (${fmtSigned(slope)}¢/kWh behavior-driven)`;
}

function rateClause(dir: TrendDirection, slope: number): string {
  if (dir === 'flat') return `rates are flat (±${fmtBand(slope)}¢)`;
  if (dir === 'up') return `rates rose (${fmtSigned(slope)}¢/kWh)`;
  return `rates fell (${fmtSigned(slope)}¢/kWh)`;
}

function netClause(verdict: TrendVerdict, fit: LinearFit): string {
  if (verdict === 'stable') return `net stable ±${fmtBand(fit.stderr)}¢`;
  return `net ${fmtSigned(fit.slope)}¢`;
}

/**
 * Build the verdict from the closed periods.
 *
 * `ready` is about the WINDOW (enough bills), not the split: a dataset whose
 * usage notes we cannot price still earns a net verdict, with the split
 * switched off and said out loud.
 */
export function efficiencyTrend(
  periods: readonly PeriodEfficiency[],
  rates: readonly RateSet[] | null | undefined,
): EfficiencyTrend {
  const points = [...periods].sort((a, b) => a.start - b.start);
  const windowSize = Math.min(points.length, TREND_MAX_PERIODS);
  const window = points.slice(points.length - windowSize);
  const windowLabel = `your last ${windowSize} bill${windowSize === 1 ? '' : 's'}`;
  const boundaries = rateBoundaries(points, rates);

  const base: EfficiencyTrend = {
    ready: false,
    emptyMessage: null,
    points,
    window,
    windowSize,
    windowLabel,
    net: null,
    behavior: null,
    rate: null,
    verdict: null,
    slope: null,
    band: 0,
    netVerdict: null,
    rateDirection: null,
    sentence: null,
    splitAvailable: false,
    splitNote: null,
    rateBoundaries: boundaries,
  };

  if (points.length === 0) {
    return {
      ...base,
      emptyMessage:
        'No closed bills loaded yet — upload your Green Button export and each bill’s ¢/kWh lands here.',
    };
  }

  // The split is decided BEFORE the window floor: even a three-bill dataset
  // deserves to be told whether its bills could be priced at today's rates.
  const splitAvailable =
    window.length > 0 &&
    window.every((p) => p.behaviorCents !== null && p.rateCents !== null);
  const splitNote = splitAvailable
    ? null
    : window.some((p) => p.unmappedKwh > 0)
      ? 'A usage category on a recent bill can’t be priced against today’s rates, so the rate/behaviour split is off for this window.'
      : 'No OEB rate set is loaded, so this trend can’t be split into rate vs behaviour yet.';

  if (points.length < TREND_MIN_PERIODS) {
    return {
      ...base,
      splitAvailable,
      splitNote,
      emptyMessage: `Need at least ${TREND_MIN_PERIODS} closed bills for a trend — you have ${points.length}.`,
    };
  }

  const net = linearFit(window.map((p) => p.cents));
  if (!net) {
    return { ...base, splitAvailable, splitNote, emptyMessage: 'Not enough variation in the bills to fit a line.' };
  }

  const behavior = splitAvailable
    ? linearFit(window.map((p) => p.behaviorCents as number))
    : null;
  const rate = splitAvailable
    ? linearFit(window.map((p) => p.rateCents as number))
    : null;

  const headline = behavior ?? net;
  const verdict = verdictOf(headline);
  const netVerdict = verdictOf(net);
  const rateDirection = directionOf(rate);

  let sentence: string | null = null;
  if (behavior && rate && netVerdict) {
    const bDir = directionOf(behavior) as TrendDirection;
    const rDir = directionOf(rate) as TrendDirection;
    // "but" only where the two really conflict: you got better AND paid more.
    const connector = bDir === 'down' && rDir === 'up' ? 'but ' : '';
    sentence =
      `${behaviorClause(bDir, behavior.slope)}, ${connector}` +
      `${rateClause(rDir, rate.slope)} — ${netClause(netVerdict, net)}.`;
  } else if (netVerdict) {
    // Split off (no rate set / an unpriceable category): report what the
    // OBSERVED line did, and put the reason in the same sentence.
    const trendPhrase =
      netVerdict === 'stable'
        ? `is flat (±${fmtBand(net.stderr)}¢ per period)`
        : `is trending ${fmtSigned(net.slope)}¢ per period`;
    sentence =
      `Observed ¢/kWh ${trendPhrase} over ${windowLabel}` +
      `${splitNote ? ` — ${splitNote}` : ''}.`;
  }
  if (sentence) sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);

  return {
    ...base,
    ready: true,
    net,
    behavior,
    rate,
    verdict,
    slope: headline.slope,
    band: headline.stderr,
    netVerdict,
    rateDirection,
    sentence,
    splitAvailable,
    splitNote,
  };
}

/* -------------------------------------------------------------------------- *
 * The whole report
 * -------------------------------------------------------------------------- */

export type EfficiencyReport = {
  /** Every closed bill with a usable kWh, oldest first. */
  periods: PeriodEfficiency[];
  /** All-time kWh-weighted ¢/kWh — the headline stat. */
  allTime: EfficiencyAverage | null;
  /** The same math over the window on screen. */
  inView: EfficiencyAverage | null;
  trend: EfficiencyTrend;
};

export function buildEfficiency(input: {
  summaries: readonly UsageSummary[];
  rates: readonly RateSet[] | null | undefined;
  /** The selection (and zoom) on screen; null = whole dataset. */
  view?: { start?: string | null; end?: string | null } | null;
}): EfficiencyReport {
  const periods = efficiencyPeriods(input.summaries, input.rates);
  return {
    periods,
    allTime: weightedCentsPerKwh(periods),
    inView: inViewCentsPerKwh(periods, input.view ?? null),
    trend: efficiencyTrend(periods, input.rates),
  };
}
