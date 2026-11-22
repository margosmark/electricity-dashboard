/**
 * Wave S — efficiency statistics: what a kWh actually cost, per bill and on
 * average, and whether that number is trending in a direction you can claim.
 *
 * Everything here is PURE: `UsageSummary[]` + the loaded OEB rate sets in,
 * numbers out. No I/O, no Date.now(), no DOM.
 *
 * --------------------------------------------------------------------------------
 * The three numbers — and the tax dimension every one of them carries
 * --------------------------------------------------------------------------------
 * 1. PER PERIOD — ¢/kWh = the bill's own "Total Electricity Charges" ÷ the
 *    metered usage in the same summary (the per-category "… Usage"
 *    measurements, uom 72 scaled by powerOfTenMultiplier — the same quantity
 *    `billedKwh` returns). Audited on the owner's 24-period export:
 *    Aug 2024 = 15.9¢, Jul 2025 = 13.9¢, Jan 2026 = 19.4¢.
 *
 *    THE NUMERATOR EXCLUDES TAX. "Total Electricity Charges" is the utility's
 *    own pre-tax line — commodity + delivery + regulatory — and HST is a
 *    SEPARATE line beneath it on the itemized bill (verified against the
 *    owner's real file: every bill's tax line is exactly 13% of its Total
 *    Electricity Charges). So every ¢/kWh here is a pre-tax figure, and
 *    `centsInclTax` is the same bill with that tax line added back over the
 *    same kWh. Both are published because both are legitimate ways to read a
 *    bill: compare against a rate schedule pre-tax, or against what actually
 *    left the bank account. Neither is "the" number, so neither is hidden.
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
 * The incl-tax variants of 2 and 3 are the SAME weighted mean over
 * Σ(cost + tax) — never a second pass over a different bill set, never the
 * pre-tax mean multiplied by 1.13 (which would be wrong the moment a bill
 * carries a rebate line or a tax that is not 13%).
 *
 * --------------------------------------------------------------------------------
 * The verdict, and why it is split three ways (the honesty bar)
 * --------------------------------------------------------------------------------
 * A raw ¢/kWh trend conflates three things that have nothing to do with each
 * other: how you used electricity, what the OEB priced it at, and the season
 * (summer bills are structurally cheaper per kWh — off-peak dominates and the
 * fixed delivery charge is spread over 2.5× the kWh). Declaring "you're
 * getting more efficient!" off a raw slope is exactly the trend-massage this
 * app refuses to do, and during an OEB rate bump (Nov 1) a raw slope would
 * actively lie.
 *
 * So each period splits into THREE components that sum to it EXACTLY:
 *
 *   usage¢/kWh     = (this bill's commodity, repriced at TODAY's rate set,
 *                     per category) ÷ kWh — what your usage would cost under
 *                     today's OEB prices and today's schedule.
 *   delivery¢/kWh  = (delivery + regulatory + anything else the OEB schedule
 *                     does not price, as billed) ÷ kWh.
 *   rate¢/kWh      = observed − usage − delivery
 *                   = (what the commodity actually cost − what today's rates
 *                     would charge for that same usage) ÷ kWh.
 *
 * Regression is linear, so slope(observed) = slope(usage) + slope(delivery) +
 * slope(rate) to floating-point precision — the split never loses or invents
 * a cent, and a test asserts it.
 *
 * The VERDICT (the "am I improving?" claim) reads the USAGE component and
 * nothing else; the delivery and rate slopes are printed beside it. That
 * separation is not cosmetic — it was audited on the owner's 24-bill export
 * (evidence/wave-s-split-hygiene.py, a second parser that reproduces this
 * module's split to the cent): the older two-way split folded delivery into
 * "behaviour", and 96% of the slope it then called an improvement
 * (−0.157¢/period) was the DELIVERY term (−0.151¢/period) — the fixed charge
 * spread over a winter's worth of kWh, a seasonal arithmetic artefact the
 * module's own docs already described. The usage slope behind that same
 * window was −0.006¢/period against a 0.033¢ error bar: flat. The panel was
 * crediting the household with an efficiency gain it had not made.
 *
 * Honest limits, stated because they change what the panel means:
 *   • "Usage" holds the OEB rate SET (prices AND today's schedule) constant
 *     but keeps each bill's own billed block split: TOU windows are re-drawn
 *     on Nov 1 and tiered thresholds move (600 kWh/month summer, 1,000
 *     winter), so a rate-schedule season change can still move this component
 *     without any change in usage. Measured on the owner's data: re-splitting
 *     the same metered hours under one fixed window set moves it by ≤0.13¢
 *     (TOU), and the tier-threshold season by 0.63–0.88¢ on tiered bills
 *     (a winter bill is 100% BLOCK 1 at the cheap tier). Both are small next
 *     to a full ¢/kWh headline but not next to a 0.15¢ slope — hence the
 *     12-bill window below.
 *   • A plan switch (TOU ↔ tiered, which this owner made four times in two
 *     years) reprices the counterfactual in the bill's OWN structure, so the
 *     usage component steps by +0.89¢ / +0.55¢ at the two switches inside the
 *     current window. The Money tab shows the switch; this panel does not
 *     smooth it away.
 *   • Delivery and regulatory charges are utility-set with no public rate
 *     schedule we can reprice, so they ride with the bill as issued and get
 *     their OWN component — never the verdict. A delivery-rate increase shows
 *     up as the delivery slope, which is where it belongs.
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


import {
  billedKwh,
  billTotals,
  type BillLineItem,
  type RateSet,
  type UsageSummary,
} from './energy';
import { seasonForDay, type Season } from './season';
// Wave U — trend prose reads the locale catalog at call time.
import { fmtDate, fmtNumber, t } from '@/i18n';

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
  /** Total Electricity Charges, dollars — the utility's own PRE-TAX line. */
  cost: number;
  /** The bill's tax line (HST), dollars — zero when the file states none. */
  tax: number;
  /** Observed ¢/kWh: cost ÷ kwh. PRE-TAX, by construction. */
  cents: number;
  /**
   * The same bill with its tax line added back over the same kWh:
   * (cost + tax) ÷ kwh. What the bill cost per kWh all-in, before any
   * rebate. Equals `cents` exactly when the file states no tax line.
   */
  centsInclTax: number;
  /**
   * ¢/kWh of this bill's COMMODITY repriced at today's rate set — what your
   * usage would cost under today's OEB prices. null when unpriceable.
   */
  usageCents: number | null;
  /** ¢/kWh of delivery + regulatory + other, as billed (never repriced). */
  deliveryCents: number | null;
  /** observed − usage − delivery: the price-schedule part, null when unpriceable. */
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
  // Wave U: the OEB's French period names price the same as the English
  // ones ("Période basse de nuit" → overnight, "Période creuse" → offPeak,
  // "Palier 1" → tier 1) — see I18N.md's canonical-data rule.
  if (/overnight|ulo\b|\bnuit\b|nuit tr[èe]s basse/.test(n)) return rates.ulo.overnight;
  if (/weekend|fin de semaine|week-?end/.test(n)) return rates.ulo.weekendOffPeak;
  if (/off[ -]?peak|p[ée]riode creuse/.test(n)) return rates.tou.offPeak;
  if (/mid[ -]?peak|p[ée]riode normale|mi-?pointe/.test(n)) return rates.tou.midPeak;
  if (/on[ -]?peak|p[ée]riode de pointe/.test(n)) return rates.tou.onPeak;
  if (/block\s*1|tier\s*1|first[ -]?tier|\bbloc\s*1|\bpalier\s*1|premier palier/.test(n)) return rates.tiered.tier1;
  if (/block\s*2|tier\s*2|second[ -]?tier|\bbloc\s*2|\bpalier\s*2|deuxi[èe]me palier/.test(n)) return rates.tiered.tier2;
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
    // The bill's own tax line (HST), separate from Total Electricity Charges
    // on the itemized bill. Zero when the file states no tax line, in which
    // case the incl-tax figure collapses onto the pre-tax one exactly.
    const tax = Number.isFinite(totals.tax) ? totals.tax : 0;

    const cents = (cost / kwh) * 100;
    const centsInclTax = ((cost + tax) / kwh) * 100;
    let usageCents: number | null = null;
    let deliveryCents: number | null = null;
    let rateCents: number | null = null;
    let unmappedKwh = 0;

    if (latest) {
      const cf = counterfactualCommodity(summary, latest);
      unmappedKwh = cf.unmappedKwh;
      if (cf.unmappedKwh === 0) {
        // Three components, exact by construction: the commodity repriced at
        // today's rates, the bill's own delivery/regulatory/other as issued,
        // and the residual — which is precisely the price-schedule delta.
        // Delivery gets its own slice because folding it into the usage half
        // made the verdict read a seasonal fixed-charge artefact as an
        // efficiency gain (see the module header: 96% of the old "behaviour"
        // slope on the owner's export was this term).
        usageCents = (cf.dollars / kwh) * 100;
        deliveryCents = ((cost - totals.commodity) / kwh) * 100;
        rateCents = cents - usageCents - deliveryCents;
      }
    }

    // Parse the start day exactly as `fmtDate` would — once — so the
    // validity check IS the throw condition: an undateable start
    // (`NaN-NaN-NaN` stamped from an out-of-range `<billingPeriod><start>`,
    // or a payload with no `startDate` at all) parses to an Invalid Date,
    // and date-fns `format()` THROWS RangeError on it. This runs inside
    // Dashboard's `buildEfficiency` useMemo on every render, so one such
    // stored bill fell the whole dashboard to the AppErrorBoundary
    // (t_b9fe7438 — `readStoredBillFeed` validates only that `start` is a
    // number, never the day key). The label degrades to the app's marker
    // and the season to the same default `seasonForDay` picks for an
    // unreadable month; the period and its ¢/kWh are untouched — keep +
    // degrade, dropping the bill is refused (t_2a09ca9d).
    const startAt = new Date(`${summary.startDate}T00:00:00`);
    const dateable = !Number.isNaN(startAt.getTime());

    out.push({
      start: summary.start,
      startDate: summary.startDate,
      endDate: summary.endDate,
      // `fmtDate`, not date-fns' bare `format`: the axis label is read by a
      // person, so it follows the toggle ("May 2026" / "mai 2026").
      label: dateable ? fmtDate(startAt, 'MMM yyyy') : t('axis.unavailableDate'),
      kwh,
      cost,
      tax,
      cents,
      centsInclTax,
      usageCents,
      deliveryCents,
      rateCents,
      unmappedKwh,
      // Same guard as the label: an absent/non-string start would be a
      // `.slice` TypeError one line later. `''` routes through
      // seasonForDay's own unreadable-month default (→ winter), and for a
      // dateable start `String()` is the identity, so healthy bills are
      // byte-identical to before.
      season: seasonForDay(dateable ? String(summary.startDate) : ''),
    });
  }

  return out.sort((a, b) => a.start - b.start);
}

export type EfficiencyAverage = {
  /** kWh-weighted mean of the periods' ¢/kWh: Σcost ÷ ΣkWh × 100. PRE-TAX. */
  cents: number;
  /**
   * The same weighted mean over Σ(cost + tax) — every bill's own tax line
   * added back, over the SAME kWh. Never `cents × 1.13`: a file that states
   * no tax line, or a rebate-aware bill, must not be silently scaled.
   */
  centsInclTax: number;
  /** Periods that went into it. */
  bills: number;
  /** Period kWh behind the weight. */
  kwh: number;
  /** Total Electricity Charges behind the pre-tax mean, dollars. */
  cost: number;
  /** The tax lines behind the incl-tax mean, dollars. */
  tax: number;
};

/** Weighted mean over `periods`; null when there is no kWh to divide by. */
export function weightedCentsPerKwh(
  periods: readonly PeriodEfficiency[],
): EfficiencyAverage | null {
  if (periods.length === 0) return null;
  let cost = 0;
  let tax = 0;
  let kwh = 0;
  for (const p of periods) {
    cost += p.cost;
    tax += p.tax;
    kwh += p.kwh;
  }
  if (!(kwh > 0)) return null;
  return {
    cents: (cost / kwh) * 100,
    centsInclTax: ((cost + tax) / kwh) * 100,
    bills: periods.length,
    kwh,
    cost,
    tax,
  };
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
 * What the two headline figures mean, in words the card can print
 * -------------------------------------------------------------------------- */

/**
 * The subtitle every ¢/kWh headline in this app is published under.
 *
 * It exists because the card used to print a bare number whose numerator
 * nobody had defined, and the owner's own question — "does the avg kWh cost
 * include all fees?" — went unanswered by the UI. One line settles it: the
 * charges named, the divisor named, and the tax called out as excluded
 * (the incl-tax figure is printed right beside it, not hidden behind it).
 */
export const EFFICIENCY_SUBTITLE =
  'ALL electricity charges (commodity + delivery + regulatory) ÷ billed kWh — tax excluded';
/** Wave U — the display translates this; EFFICIENCY_SUBTITLE stays canonical
 *  (lib/statistics.test.ts pins its wording). */
export const EFFICIENCY_SUBTITLE_KEY = 'efficiency.subtitle';

/**
 * The tax rate implied by the loaded bills themselves: Σtax ÷ ΣTotal
 * Electricity Charges, as a percentage.
 *
 * Derived, never assumed — the card must say the rate the FILE states, not
 * the 13% Ontario happens to charge this year, and a file with no tax line
 * must read 0% rather than borrow a rate from nowhere. Rounded to one
 * decimal because that is the precision at which a rate is worth quoting.
 */
export function impliedTaxPct(average: EfficiencyAverage | null): number | null {
  if (!average || !(average.cost > 0)) return null;
  return Math.round((average.tax / average.cost) * 1000) / 10;
}

/**
 * The one-line footnote under the excl/incl pair: what the tax rate was, and
 * the two things these numbers are NOT — a whole-utility bill (water and gas
 * are billed separately and never enter a Green Button electricity export),
 * and a post-rebate figure (the rebate is its own line on the Money tab).
 */
export function taxFootnote(average: EfficiencyAverage | null): string {
  const pct = impliedTaxPct(average);
  if (pct === null) {
    return t('efficiency.taxNoteNone');
  }
  if (pct === 0) {
    return t('efficiency.taxNoteNoTax');
  }
  return t('efficiency.hstNote', { pct: fmtNumber(pct, 1) });
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
  // `+ 0` folds a rounded-away -0.04 into a plain 0: Intl would print "-0".
  const rounded = Math.round(n * 10) / 10 + 0;
  const shown = fmtNumber(rounded, 1);
  return rounded > 0 ? `+${shown}` : shown;
}

/** Unsigned to one decimal, for ±-style bands. */
export function fmtBand(n: number): string {
  return fmtNumber(Math.round(Math.abs(n) * 10) / 10, 1);
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
  /** Fit over the usage component (your commodity at today's rates). */
  usage: LinearFit | null;
  /** Fit over delivery/regulatory/other per kWh — reported, never credited. */
  delivery: LinearFit | null;
  /** Fit over the rate component (what rates did, versus today). */
  rate: LinearFit | null;
  /**
   * The headline claim. Reads USAGE when the split is computable — the panel
   * never credits you with a rate change, and never with the delivery/fixed
   * charge riding along either — else the net fit.
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
  /** What delivery/other per kWh did over the window. */
  deliveryDirection: TrendDirection | null;
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

/* Wave U — the trend's prose comes from the catalog at call time, so the
 * same computation emits "IMPROVING −0.4¢/kWh per period" or
 * "AMÉLIORATION −0,4 ¢/kWh par période" without a second code path. */

function behaviorClause(dir: TrendDirection, slope: number): string {
  if (dir === 'flat') return t('trend.behaviorFlat', { band: fmtBand(slope) });
  if (dir === 'down') return t('trend.behaviorImproved', { slope: fmtSigned(slope) });
  return t('trend.behaviorWorse', { slope: fmtSigned(slope) });
}

function deliveryClause(dir: TrendDirection, slope: number): string {
  if (dir === 'flat') return `delivery & fixed charges flat (±${fmtBand(slope)}¢)`;
  if (dir === 'up') return `delivery & fixed charges rose (${fmtSigned(slope)}¢/kWh)`;
  return `delivery & fixed charges fell (${fmtSigned(slope)}¢/kWh)`;
}

function rateClause(dir: TrendDirection, slope: number): string {
  if (dir === 'flat') return t('trend.ratesFlat', { band: fmtBand(slope) });
  if (dir === 'up') return t('trend.ratesRose', { slope: fmtSigned(slope) });
  return t('trend.ratesFell', { slope: fmtSigned(slope) });
}

function netClause(verdict: TrendVerdict, fit: LinearFit): string {
  if (verdict === 'stable') return t('trend.netStable', { band: fmtBand(fit.stderr) });
  return t('trend.net', { slope: fmtSigned(fit.slope) });
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
  const windowLabel = t('trend.window', { count: windowSize, bills: windowSize });
  const boundaries = rateBoundaries(points, rates);

  const base: EfficiencyTrend = {
    ready: false,
    emptyMessage: null,
    points,
    window,
    windowSize,
    windowLabel,
    net: null,
    usage: null,
    delivery: null,
    rate: null,
    verdict: null,
    slope: null,
    band: 0,
    netVerdict: null,
    rateDirection: null,
    deliveryDirection: null,
    sentence: null,
    splitAvailable: false,
    splitNote: null,
    rateBoundaries: boundaries,
  };

  if (points.length === 0) {
    return {
      ...base,
      emptyMessage: t('trend.emptyNoBills'),
    };
  }

  // The split is decided BEFORE the window floor: even a three-bill dataset
  // deserves to be told whether its bills could be priced at today's rates.
  const splitAvailable =
    window.length > 0 &&
    window.every(
      (p) => p.usageCents !== null && p.deliveryCents !== null && p.rateCents !== null,
    );
  const splitNote = splitAvailable
    ? null
    : window.some((p) => p.unmappedKwh > 0)
      ? t('trend.splitUnpriceable')
      : t('trend.splitNoRates');

  if (points.length < TREND_MIN_PERIODS) {
    return {
      ...base,
      splitAvailable,
      splitNote,
      emptyMessage: t('trend.emptyNeedBills', { min: TREND_MIN_PERIODS, have: points.length }),
    };
  }

  const net = linearFit(window.map((p) => p.cents));
  if (!net) {
    return { ...base, splitAvailable, splitNote, emptyMessage: t('trend.emptyNoVariation') };
  }

  const usage = splitAvailable
    ? linearFit(window.map((p) => p.usageCents as number))
    : null;
  const delivery = splitAvailable
    ? linearFit(window.map((p) => p.deliveryCents as number))
    : null;
  const rate = splitAvailable
    ? linearFit(window.map((p) => p.rateCents as number))
    : null;

  const headline = usage ?? net;
  const verdict = verdictOf(headline);
  const netVerdict = verdictOf(net);
  const rateDirection = directionOf(rate);
  const deliveryDirection = directionOf(delivery);

  let sentence: string | null = null;
  if (usage && delivery && rate && netVerdict) {
    const bDir = directionOf(usage) as TrendDirection;
    const dDir = deliveryDirection as TrendDirection;
    const rDir = directionOf(rate) as TrendDirection;
    // "but" only where the two really conflict: you got better AND paid more.
    const connector = bDir === 'down' && rDir === 'up' ? t('trend.connectorBut') : '';
    sentence =
      `${behaviorClause(bDir, usage.slope)}, ${connector}` +
      `${rateClause(rDir, rate.slope)}; ${deliveryClause(dDir, delivery.slope)}` +
      ` — ${netClause(netVerdict, net)}.`;
  } else if (netVerdict) {
    // Split off (no rate set / an unpriceable category): report what the
    // OBSERVED line did, and put the reason in the same sentence.
    const trendPhrase =
      netVerdict === 'stable'
        ? t('trend.observedFlat', { band: fmtBand(net.stderr) })
        : t('trend.observedTrend', { slope: fmtSigned(net.slope) });
    sentence =
      `${t('trend.observedPrefix')} ${trendPhrase} ${t('trend.observedOver', { window: windowLabel })}` +
      `${splitNote ? ` — ${splitNote}` : ''}.`;
  }
  if (sentence) sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);

  return {
    ...base,
    ready: true,
    net,
    usage,
    delivery,
    rate,
    verdict,
    slope: headline.slope,
    band: headline.stderr,
    netVerdict,
    rateDirection,
    deliveryDirection,
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
