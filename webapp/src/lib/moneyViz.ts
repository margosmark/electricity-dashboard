/**
 * Wave O — the numbers behind the MONEY section.
 *
 * Every function here is pure and takes the two things the app already holds
 * in localStorage: the `UsageSummary` bills Wave L parses out of the feed, and
 * the priced readings the rest of the app charts. Nothing fetches, nothing
 * stores, nothing guesses a figure the file does not state — where a number
 * cannot be derived honestly the result carries `ready: false` plus a reason
 * the UI shows verbatim instead of drawing a plausible-looking shape.
 *
 * The pieces:
 *
 *   • buildPeriodStacks   — one bar per billing period, split by charge type
 *                           (commodity split into its own TOU windows — or,
 *                           on a Tiered bill, its Tier 1 / Tier 2 blocks —
 *                           because that split is exactly what people scan
 *                           for) with the bill's OWN per-window kWh
 *                           alongside;
 *   • periodDeltaRows     — period → period change per charge type, with an
 *                           explicit baseline column for the first period;
 *   • hourCostProfile     — average ¢/kWh by hour of day (commodity only —
 *                           delivery/regulatory/HST are per-period, not
 *                           per-hour, and pretending otherwise would invent a
 *                           rate the bill never charged);
 *   • billWaterfall       — commodity → delivery → regulatory → HST → rebate
 *                           → amount due, built so the steps ADD UP to the
 *                           bill's own payable figure;
 *   • planOverlay         — the three plans modelled over the SAME covered
 *                           periods, so the lines on the stacked chart are
 *                           comparable to the bars they cross.
 */

import {
  PERIOD_MIN_COVERAGE,
  aggregateChartData,
  billPeriodLabel,
  billTotals,
  billWindow,
  calculateComparison,
  calculateTrueBill,
  classifyBillLine,
  planCostFor,
  summaryStatesMoney,
  tieredRateCentsFor,
  type ExtraCharges,
  type ProcessedPoint,
  type UsageSummary,
} from './energy';
import { type BillingAxis } from './billingAxis';

/* ==========================================================================
 * Slices — one vocabulary for the stacked chart, the tooltip and the table
 * ========================================================================== */

export type CostSliceKey =
  | 'offPeak'
  | 'midPeak'
  | 'onPeak'
  | 'tier1'
  | 'tier2'
  | 'commodityOther'
  | 'delivery'
  | 'regulatory'
  | 'tax'
  | 'other'
  | 'credit';

/**
 * Draw order, bottom of the stack first. The credit is LAST on purpose: it is
 * negative, so Recharts renders it below the zero line no matter where it sits
 * in the stack — keeping it last means the positive stack reads cleanly and
 * the money-back slice hangs under the axis where it belongs.
 *
 * Colours follow the app's existing vocabulary: the three TOU windows reuse
 * the plan-card rate colours (emerald / yellow / red), the two tiers reuse
 * the commodity blue as a light/dark pair (they ARE the commodity, just
 * priced at two rates), delivery + regulatory reuse the ActualBillPanel's
 * violet pair, HST the amber tax bar, and the rebate the same emerald family
 * as every other "money back" surface.
 */
export const COST_SLICE_ORDER: CostSliceKey[] = [
  'offPeak',
  'midPeak',
  'onPeak',
  'tier1',
  'tier2',
  'commodityOther',
  'delivery',
  'regulatory',
  'other',
  'tax',
  'credit',
];

/* Wave U — every user-visible reason/note in this file comes from the
 * locale catalog at call time; the bucket keys and classifier regexes stay
 * canonical English (they are data). */
import { fmtMoney, fmtNumber, fmtPercent, planLabel, t } from '@/i18n';
/** Wave U — the catalog key the display layer translates instead. */
export const ESTIMATE_KEY_LABEL_KEY = 'moneyViz.estimateKeyLabel';

/**
 * The eleven charge types, one colour each, drawn in COST_SLICE_ORDER.
 *
 * Dark mode (t_d5d0a86b): these are DATA hues, so they are kept — a stack
 * whose colours changed meaning between themes would be unreadable across a
 * screenshot. Three are tokens because they could not survive the navy card:
 * `tier1` (#1D4ED8, 2.66:1 — under the 3:1 non-text floor), the two
 * near-blacks on `total`/`payable` (#111111, literally invisible), and the
 * active-bar highlight. Everything else is saturated enough for both themes.
 */
export const COST_SLICE_META: Record<
  CostSliceKey,
  { label: string; short: string; color: string; labelKey: string; shortKey: string }
> = {
  offPeak: { label: 'Commodity · off-peak', short: 'Off-peak', color: 'var(--chart-money-offpeak)', labelKey: 'slice.offPeak.label', shortKey: 'slice.offPeak.short' },
  midPeak: { label: 'Commodity · mid-peak', short: 'Mid-peak', color: 'var(--chart-money-midpeak)', labelKey: 'slice.midPeak.label', shortKey: 'slice.midPeak.short' },
  onPeak: { label: 'Commodity · on-peak', short: 'On-peak', color: 'var(--chart-money-onpeak)', labelKey: 'slice.onPeak.label', shortKey: 'slice.onPeak.short' },
  tier1: { label: 'Tier 1', short: 'Tier 1', color: 'var(--data-tier1)', labelKey: 'rate.tier1', shortKey: 'rate.tier1' },
  tier2: { label: 'Tier 2', short: 'Tier 2', color: 'var(--chart-money-tier2)', labelKey: 'rate.tier2', shortKey: 'rate.tier2' },
  commodityOther: { label: 'Commodity · not split by window', short: 'Commodity', color: 'var(--chart-money-commodity)', labelKey: 'slice.commodityOther.label', shortKey: 'slice.commodityOther.short' },
  delivery: { label: 'Delivery', short: 'Delivery', color: 'var(--chart-money-delivery)', labelKey: 'slice.delivery', shortKey: 'slice.delivery' },
  regulatory: { label: 'Regulatory', short: 'Regulatory', color: 'var(--chart-money-regulatory)', labelKey: 'slice.regulatory', shortKey: 'slice.regulatory' },
  other: { label: 'Other lines', short: 'Other', color: 'var(--chart-money-other)', labelKey: 'slice.other.label', shortKey: 'slice.other.short' },
  tax: { label: 'HST', short: 'HST', color: 'var(--chart-money-tax)', labelKey: 'slice.tax', shortKey: 'slice.tax' },
  credit: { label: 'Ontario Electricity Rebate', short: 'OEB rebate', color: 'var(--chart-money-credit)', labelKey: 'slice.credit.label', shortKey: 'slice.credit.short' },
};

/**
 * Which slice of the COMMODITY a line belongs to, keyed off the utility's own
 * note — the same loose-on-purpose matching `classifyBillLine` and
 * `rateForUsageNote` use, because the wording is the only thing the file
 * guarantees:
 *
 *   • a TOU line names its window ("Off Peak-Summer")   → off/mid/on-peak;
 *   • a TIERED line names its block ("BLOCK 1 - Winter", "BLOCK 1- Summer",
 *     "BLOCK 2 - Summer", "Tier 1")                    → tier 1 / tier 2;
 *   • anything else — "Tiered Electricity", "Overnight",
 *     a wording we have never seen                     → `commodityOther`,
 *     which the chart labels "not split by window".
 *
 * The function predates the tier split (hence "window"): it is this file's
 * ONE note → cost-slice mapping, and the tiers are just two more windows a
 * bill can price its electricity in. ULO's "Overnight" is deliberately not
 * forced into a peak bucket, and a note that names no tier number ("Tiered")
 * is not guessed into one either.
 */
export function commodityWindowOf(note: string): CostSliceKey {
  const n = note.toLowerCase();
  // Wave U: the OEB's French period names classify identically ("Période
  // creuse" → offPeak, "Période normale" → midPeak, "Période de pointe" →
  // onPeak), so a bilingual export buckets the same as an English one.
  if (/\boff[\s-]?peak|p[ée]riode creuse/.test(n)) return 'offPeak';
  if (/\bmid[\s-]?peak|p[ée]riode normale|mi-?pointe/.test(n)) return 'midPeak';
  if (/\bon[\s-]?peak|p[ée]riode de pointe/.test(n)) return 'onPeak';
  // Same patterns `rateForUsageNote` prices with, so the slice and the ¢/kWh
  // can never disagree about which tier a line was billed at. Whitespace
  // tolerance is the point: Oakville writes "BLOCK 1 - Winter" and
  // "BLOCK 1- Summer" in the same bill.
  if (/\bblock\s*1\b|\btier\s*1\b|first[ -]?tier|\bbloc\s*1\b|\bpalier\s*1\b|premier palier/.test(n)) return 'tier1';
  if (/\bblock\s*2\b|\btier\s*2\b|second[ -]?tier|\bbloc\s*2\b|\bpalier\s*2\b|deuxi[èe]me palier/.test(n)) return 'tier2';
  return 'commodityOther';
}

export type UsageSliceKey = 'offPeak' | 'midPeak' | 'onPeak' | 'commodityOther';

/** What one period's bar is made of — billed, a hole, or the open tail. */
export type PeriodStackKind = 'billed' | 'gap' | 'open' | 'derived';

/** What one billing period's bar is made of. */
export type PeriodStack = {
  /** Which slice of the axis this bar is. Everything but `billed` is flagged. */
  kind: PeriodStackKind;
  /** billingPeriod.start — also the map key callers use. */
  start: number;
  /** Window end (unix seconds, exclusive) — the open period's "so far". */
  end: number;
  /** `yyyy-MM-dd` of the billed window's first day. */
  startDate: string;
  /** `yyyy-MM-dd` of its LAST day — what "billed through" prints. */
  endDate: string;
  /** "May 25, 2026 – Jun 23" — the same label ActualBillPanel prints. */
  label: string;
  /** Short label for an axis: "May 25". */
  shortLabel: string;
  days: number;
  /** Dollars per charge type. Sums to `totals.payable` for the whole period. */
  cost: Record<CostSliceKey, number>;
  /**
   * kWh per window, from the bill's own "… Usage" measurement lines
   * (measurement.scaled, already unit-resolved by the parser). Null when the
   * file states none — then the usage mode has nothing honest to draw.
   */
  usage: Record<UsageSliceKey, number> | null;
  /** Billed kWh across all windows (null when the file says nothing usable). */
  usageTotal: number | null;
  /** Readings inside this period, for coverage and for plan modelling. */
  rows: ProcessedPoint[];
  /** Distinct reading days ÷ billed days — the same gate Wave L reconciles on. */
  coverage: number;
  totals: ReturnType<typeof billTotals>;
  /** The bill itself — null for every period that is not one (gap / open). */
  summary: UsageSummary | null;
  /** True when the money here is our own estimate, never a bill. */
  estimated: boolean;
  /** The axis's edge-case flag (a <25-day or >40-day period), or null. */
  flag: 'short' | 'long' | null;
};

const zeroCostSlices = (): Record<CostSliceKey, number> => ({
  offPeak: 0,
  midPeak: 0,
  onPeak: 0,
  tier1: 0,
  tier2: 0,
  commodityOther: 0,
  delivery: 0,
  regulatory: 0,
  tax: 0,
  other: 0,
  credit: 0,
});

const zeroUsageSlices = (): Record<UsageSliceKey, number> => ({
  offPeak: 0,
  midPeak: 0,
  onPeak: 0,
  commodityOther: 0,
});

/**
 * The kWh stack has no tier columns: the bill states tier USAGE in kWh, but
 * this app only ever draws the four windows above, so a tiered usage line
 * folds into `commodityOther` exactly as it did before the money split. The
 * mapping is explicit (not a cast) so a new cost slice cannot silently land
 * as an invisible extra key on `usage` and drop its kWh out of `usageTotal`.
 */
function usageKeyOf(note: string): UsageSliceKey {
  const slice = commodityWindowOf(note);
  if (slice === 'offPeak' || slice === 'midPeak' || slice === 'onPeak') return slice;
  return 'commodityOther';
}

/**
 * One stack per period, oldest first.
 *
 * The commodity split walks the SAME lines `billTotals` sums, so the stack and
 * the panel above it can never disagree: a line that classifies as commodity
 * goes into its window bucket, everything else into its class bucket. A
 * Tiered bill's "BLOCK 1 …" and "BLOCK 2 …" lines get a bucket EACH (tier 1
 * / tier 2) rather than one undifferentiated commodity pile, so the tier
 * split the pace chart marks is a split you can also read off this table —
 * and a wording we do not recognize still falls through to `commodityOther`
 * instead of being guessed into a tier. The
 * stated "Total Electricity Charges" is deliberately NOT stacked — it is the
 * sum of the parts, and stacking it too would double the bar.
 */
export function buildPeriodStacks(
  summaries: UsageSummary[],
  rows: ProcessedPoint[],
): PeriodStack[] {
  return summaries.map((summary) => {
    const cost = zeroCostSlices();
    const usage = zeroUsageSlices();
    let usageSeen = false;

    for (const item of summary.items) {
      // Energy per window: the bill's own "… Usage" lines (billedKwh's rule).
      // This runs BEFORE the class gate below: those lines classify as `info`
      // (their note says "usage"), and skipping them there would silently
      // cost the kWh stack its data.
      if (item.measurement && /usage$/.test(item.note.trim().toLowerCase())) {
        usageSeen = true;
        usage[usageKeyOf(item.note)] += item.measurement.scaled;
      }

      const cls = classifyBillLine(item);
      if (cls === 'total' || cls === 'info') continue;
      if (cls === 'commodity' && item.amount !== null) {
        cost[commodityWindowOf(item.note)] += item.amount;
      } else if (cls === 'delivery' && item.amount !== null) {
        cost.delivery += item.amount;
      } else if (cls === 'regulatory' && item.amount !== null) {
        cost.regulatory += item.amount;
      } else if (cls === 'tax' && item.amount !== null) {
        cost.tax += item.amount;
      } else if (cls === 'credit' && item.amount !== null) {
        cost.credit += item.amount;
      } else if (cls === 'other' && item.amount !== null) {
        cost.other += item.amount;
      }
    }

    const window = billWindow(summary);
    const periodRows = rows.filter((r) => r.timestamp >= window.start && r.timestamp < window.end);
    const periodDays = Math.max(1, Math.round((window.end - window.start) / 86400));
    const coveredDays = new Set(periodRows.map((r) => r.dayStr)).size;
    const usageTotal = usageSeen
      ? usage.offPeak + usage.midPeak + usage.onPeak + usage.commodityOther
      : null;

    const days = summary.days;
    return {
      kind: 'billed' as const,
      start: summary.start,
      end: summary.start + summary.duration,
      startDate: summary.startDate,
      endDate: summary.endDate,
      label: billPeriodLabel(summary.start, summary.duration),
      shortLabel: billPeriodLabel(summary.start, summary.duration).split(' – ')[0],
      days,
      cost,
      usage: usageSeen ? usage : null,
      usageTotal,
      rows: periodRows,
      coverage: Math.min(1, coveredDays / periodDays),
      totals: billTotals(summary),
      summary,
      estimated: false,
      // 25–40 days is an ordinary bill; anything outside that is flagged in
      // the data (the axis computes the same flag from billingPeriod).
      flag: days < 25 ? 'short' : days > 40 ? 'long' : null,
    };
  });
}

/* ==========================================================================
 * The axis's other periods — the open tail and the holes between bills
 * ========================================================================== */

/**
 * One stack per axis period, in timeline order: the billed ones exactly as
 * `buildPeriodStacks` builds them, plus the two kinds of period that are NOT
 * a bill.
 *
 *   `open`  — readings past the last bill, priced with THIS app's plan. Only
 *             the commodity charge is estimated: delivery, regulatory and HST
 *             for that window do not exist yet, so they are left at zero and
 *             every surface that draws this bar says "not billed yet". The
 *             stack's `totals` therefore describe an ESTIMATE of what the
 *             electricity cost, never a payable amount.
 *   `gap` / `derived` — no bill, no money. They keep their place in the
 *             timeline (and their readings, for coverage) so a hole between
 *             two bills cannot silently read as "you paid $0".
 */
export function buildAxisStacks(
  axis: BillingAxis,
  rows: ProcessedPoint[],
  plan: PlanId,
): PeriodStack[] {
  return axis.periods.map((period) => {
    if (period.kind === 'billed' && period.summary) {
      const [stack] = buildPeriodStacks([period.summary], rows);
      return { ...stack, flag: period.flag };
    }
    const inPeriod = rows.filter(
      (r) => r.timestamp >= period.start && r.timestamp < period.end,
    );
    const coveredDays = new Set(inPeriod.map((r) => r.dayStr)).size;
    const periodDays = Math.max(1, Math.round((period.end - period.start) / 86400));
    const base: PeriodStack = {
      kind: period.kind,
      start: period.start,
      end: period.end,
      startDate: period.startDate,
      endDate: period.endDate,
      label: period.label,
      shortLabel: period.shortLabel,
      days: period.days,
      cost: zeroCostSlices(),
      usage: null,
      usageTotal: null,
      rows: inPeriod,
      coverage: Math.min(1, coveredDays / periodDays),
      totals: {
        commodity: 0,
        delivery: 0,
        regulatory: 0,
        tax: 0,
        credit: 0,
        other: 0,
        total: 0,
        amountDue: null,
        preRebate: 0,
        payable: 0,
      },
      summary: null,
      estimated: period.kind === 'open',
      flag: period.flag,
    };

    if (inPeriod.length === 0) return base;

    // Metered energy is real for EVERY kind of period: a hole between two
    // bills still has kWh flowing through the meter, and the kWh view is the
    // one place that can say so. Money, below, is a different question.
    const usage = zeroUsageSlices();
    const isOpen = period.kind === 'open';

    if (plan === 'TOU') {
      for (const r of inPeriod) {
        const key: UsageSliceKey =
          r.touCategory === 'Off-Peak'
            ? 'offPeak'
            : r.touCategory === 'Mid-Peak'
              ? 'midPeak'
              : r.touCategory === 'On-Peak'
                ? 'onPeak'
                : 'commodityOther';
        usage[key] += r.usage_kwh;
        // The open period's ONLY money: commodity, priced the way the plan
        // cards price the same readings. Delivery, regulatory and HST for
        // those days are left at zero — they are not charges yet.
        if (isOpen) base.cost[key] += r.costTOU;
      }
    } else {
      usage.commodityOther = inPeriod.reduce((n, r) => n + r.usage_kwh, 0);
      if (isOpen) base.cost.commodityOther = planCostFor(inPeriod, plan);
    }

    base.usage = usage;
    base.usageTotal = Object.values(usage).reduce((n, v) => n + v, 0);

    if (!isOpen) return base;

    base.totals = {
      ...base.totals,
      commodity: estimateFromSlices(base.cost),
      total: estimateFromSlices(base.cost),
      preRebate: estimateFromSlices(base.cost),
      payable: estimateFromSlices(base.cost),
    };
    return base;
  });
}

/** The estimated commodity of a stack, from its own slices (never retyped). */
function estimateFromSlices(cost: Record<CostSliceKey, number>): number {
  return round2(
    cost.offPeak + cost.midPeak + cost.onPeak + cost.tier1 + cost.tier2 + cost.commodityOther,
  );
}

/* ==========================================================================
 * Period → period deltas
 * ========================================================================== */

/** Rows the delta table can show. `total` / `payable` are bill-level lines. */
export type DeltaRowKey = CostSliceKey | 'total' | 'payable';

export type DeltaRow = {
  key: DeltaRowKey;
  label: string;
  /** One value per period, in dollars (or kWh when `unit` says so). */
  values: number[];
  /** values[i] − values[i−1]; null for the baseline period. */
  deltas: (number | null)[];
};

export type DeltaColumn = {
  start: number;
  label: string;
  /** Which slice of the axis the column is — drives the header's badge. */
  kind: PeriodStackKind;
  /** True when this column's numbers are an estimate, not a bill. */
  estimated: boolean;
  /**
   * Did the bill behind this column state an amount on any of its lines?
   * False only for a bill that quotes no charge at all: its baseline figure
   * and every delta measured against it are derived zeros, so the table
   * prints a dash and says why rather than a money figure nobody stated.
   * Columns that are not a bill (gap / open) are true — their cells already
   * carry the badge-and-dash rules of their own.
   */
  statesMoney: boolean;
};

export type DeltaTable = {
  rows: DeltaRow[];
  /** Period labels, oldest first. */
  columns: DeltaColumn[];
  /** False when there is nothing to compare yet (one period, or none). */
  hasComparison: boolean;
  /** Why there is no comparison, when `hasComparison` is false. */
  note: string;
};

const DELTA_LABELS: Record<DeltaRowKey, string> = {
  offPeak: COST_SLICE_META.offPeak.label,
  midPeak: COST_SLICE_META.midPeak.label,
  onPeak: COST_SLICE_META.onPeak.label,
  tier1: COST_SLICE_META.tier1.label,
  tier2: COST_SLICE_META.tier2.label,
  commodityOther: COST_SLICE_META.commodityOther.label,
  delivery: COST_SLICE_META.delivery.label,
  regulatory: COST_SLICE_META.regulatory.label,
  tax: COST_SLICE_META.tax.label,
  other: COST_SLICE_META.other.label,
  credit: COST_SLICE_META.credit.label,
  total: 'Total electricity charges',
  payable: 'Amount paid (incl. HST, less rebate)',
};

/**
 * Wave U — the DELTA_LABELS values above stay canonical English (pinned by
 * lib/moneyViz.test.ts); the display layer looks the row's text up here.
 */
export const DELTA_LABEL_KEYS: Record<DeltaRowKey, string> = {
  offPeak: COST_SLICE_META.offPeak.labelKey,
  midPeak: COST_SLICE_META.midPeak.labelKey,
  onPeak: COST_SLICE_META.onPeak.labelKey,
  tier1: COST_SLICE_META.tier1.labelKey,
  tier2: COST_SLICE_META.tier2.labelKey,
  commodityOther: COST_SLICE_META.commodityOther.labelKey,
  delivery: COST_SLICE_META.delivery.labelKey,
  regulatory: COST_SLICE_META.regulatory.labelKey,
  other: COST_SLICE_META.other.labelKey,
  tax: COST_SLICE_META.tax.labelKey,
  credit: COST_SLICE_META.credit.labelKey,
  total: 'delta.total',
  payable: 'delta.payable',
};

/**
 * The change between consecutive periods, per charge type.
 *
 * The FIRST column prints that period's own figure and is labelled a
 * baseline — a delta against nothing would be a fabricated number. A single
 * period therefore yields `hasComparison: false` with a note that says so,
 * which is the honest output the spec asks for.
 */
export function periodDeltaRows(stacks: PeriodStack[]): DeltaTable {
  const columns: DeltaColumn[] = stacks.map((s) => ({
    start: s.start,
    label: s.shortLabel,
    kind: s.kind,
    estimated: s.estimated,
    statesMoney: s.summary === null || summaryStatesMoney(s.summary),
  }));
  const keys: DeltaRowKey[] = [
    ...COST_SLICE_ORDER.filter((k) => stacks.some((s) => Math.abs(s.cost[k]) > 0.005)),
    'total',
    'payable',
  ];

  // A change is only meaningful between two REAL bills. Stepping across a
  // hole (no bill) or into the open period (an estimate) would print a delta
  // that describes nothing, so those boundaries carry null and the table
  // prints "—" there while still showing the estimate itself.
  const billable = stacks.map((s) => s.kind === 'billed');
  // …and only between two bills that STATE money: a change measured out of a
  // period the utility quoted no charge for is a change against an absence.
  const silent = stacks.map(
    (s) => s.summary !== null && !summaryStatesMoney(s.summary),
  );

  const rows: DeltaRow[] = keys.map((key) => {
    const values = stacks.map((s) =>
      key === 'total'
        ? s.totals.total
        : key === 'payable'
          ? s.totals.payable
          : s.cost[key as CostSliceKey],
    );
    const deltas: (number | null)[] = values.map((v, i) =>
      i === 0 || !billable[i] || !billable[i - 1] || silent[i] || silent[i - 1]
        ? null
        : round2(v - values[i - 1]),
    );
    return { key, label: DELTA_LABELS[key], values: values.map(round2), deltas };
  });

  const flagged = stacks.filter((s) => s.kind !== 'billed');
  const notBills = t('delta.notBills');
  const billedCount = billable.filter(Boolean).length;
  return {
    rows,
    columns,
    hasComparison: billedCount > 1,
    note:
      stacks.length === 0
        ? t('delta.noteEmpty')
        : billedCount <= 1
          ? `${t('delta.noteBaseline')}${flagged.length > 0 ? ` ${notBills}` : ''}`
          : flagged.length > 0
            ? `${t('delta.noteFlagged')} ${notBills}`
            : t('delta.notePlain'),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/* ==========================================================================
 * Composition — the "what share of my bill is delivery?" answer
 * ========================================================================== */

export type ShareBreakdown = {
  /** All positive charges across the periods given (the rebate excluded). */
  gross: number;
  commodityPct: number;
  deliveryPct: number;
  regulatoryPct: number;
  otherPct: number;
  taxPct: number;
  /** The community's own question: delivery + regulatory, in one number. */
  nonCommodityPct: number;
  /** The rebate as a share of those same charges — money handed back. */
  rebatePct: number;
  /** What was actually paid across these periods (total + HST − rebate). */
  payable: number;
  periods: number;
};

/**
 * Shares of a bill are only well-defined against a denominator that itself
 * adds up, so the denominator here is the sum of the POSITIVE charges: every
 * period contributes exactly 100%, and the rebate is reported separately as
 * the percentage it hands back rather than as a negative share.
 */
export function shareBreakdown(stacks: PeriodStack[]): ShareBreakdown | null {
  // Shares answer "what is my bill made of", so only REAL bills count: the
  // open period is an estimate and a hole between bills is not money at all.
  // Including either would move every percentage away from the bills that
  // were actually charged.
  const billed = stacks.filter((s) => s.kind === 'billed');
  if (billed.length === 0) return null;
  const sum = (read: (s: PeriodStack) => number) => billed.reduce((n, s) => n + read(s), 0);
  const gross = sum((s) =>
    COST_SLICE_ORDER.reduce((n, k) => n + Math.max(0, s.cost[k]), 0),
  );
  if (gross <= 0) return null;
  const pct = (amount: number) => (amount / gross) * 100;
  const credit = sum((s) => Math.abs(Math.min(0, s.cost.credit)));

  return {
    gross: round2(gross),
    commodityPct: pct(
      sum(
        (s) =>
          s.cost.offPeak + s.cost.midPeak + s.cost.onPeak + s.cost.tier1 + s.cost.tier2 +
          s.cost.commodityOther,
      ),
    ),
    deliveryPct: pct(sum((s) => s.cost.delivery)),
    regulatoryPct: pct(sum((s) => s.cost.regulatory)),
    otherPct: pct(sum((s) => s.cost.other)),
    taxPct: pct(sum((s) => s.cost.tax)),
    nonCommodityPct: pct(sum((s) => s.cost.delivery + s.cost.regulatory)),
    rebatePct: pct(credit),
    payable: round2(sum((s) => s.totals.payable)),
    periods: billed.length,
  };
}

/* ==========================================================================
 * ¢/kWh by hour of day
 * ========================================================================== */

export type HourCostBucket = {
  hour: number;
  label: string;
  kwh: number;
  /** Commodity cost of those kWh under `plan`. */
  cost: number;
  /** cost ÷ kwh × 100; null when the bucket holds no energy. */
  cents: number | null;
  /** The TOU window most of this hour's readings fell in (drives the colour). */
  dominant: 'Off-Peak' | 'Mid-Peak' | 'On-Peak' | 'other';
};

export type HourCostProfile = {
  buckets: HourCostBucket[];
  /** kWh-weighted average across the whole window, ¢/kWh. */
  averageCents: number | null;
  ready: boolean;
  /** Shown verbatim when `ready` is false. */
  reason: string;
  rows: number;
};

/**
 * Average commodity ¢/kWh for each hour of the day.
 *
 * Cost is the plan on screen, because "what does 4pm cost me" is
 * plan-dependent; usage is the same readings the heatmap buckets. Only
 * commodity is modelled — delivery, regulatory and HST arrive once per billing
 * period, so there is no per-hour version of them to plot, and the caption
 * says exactly that.
 *
 * Tiered is priced at the WINDOW's own tiered rate (`tieredRateCentsFor`),
 * not at the per-reading tier-1 field: a tiered plan has no time dimension, so
 * every hour costs the same blended number, and the 24 buckets add back up to
 * exactly what the plan card charges for this window. Summing `costTiered`
 * instead made the histogram the one figure on screen that disagreed with the
 * plan card over a threshold month.
 */
export function hourCostProfile(
  rows: ProcessedPoint[],
  plan: 'TOU' | 'Tiered' | 'ULO',
): HourCostProfile {
  const empty: HourCostProfile = {
    buckets: [],
    averageCents: null,
    ready: false,
    reason: t('moneyViz.hourCostNoReadings'),
    rows: 0,
  };
  if (rows.length === 0) return empty;

  type Bucket = HourCostBucket & { windows: Record<string, number> };
  const buckets: Bucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, '0')}:00`,
    kwh: 0,
    cost: 0,
    cents: null,
    dominant: 'other',
    windows: {},
  }));

  const tieredRateCents = plan === 'Tiered' ? tieredRateCentsFor(rows) : null;

  for (const r of rows) {
    const parsed = Number(r.hourStr.slice(0, 2));
    const bucket = buckets[Number.isInteger(parsed) && parsed >= 0 && parsed < 24 ? parsed : 0];
    bucket.kwh += r.usage_kwh;
    bucket.cost +=
      tieredRateCents !== null
        ? (r.usage_kwh * tieredRateCents) / 100
        : plan === 'TOU'
          ? r.costTOU
          : r.costULO;
    // Colour comes from the TOU window the reading was priced in — only
    // meaningful on a TOU bill, which is the only plan with windows.
    if (plan === 'TOU') bucket.windows[r.touCategory] = (bucket.windows[r.touCategory] ?? 0) + 1;
  }

  const out: HourCostBucket[] = [];
  let totalKwh = 0;
  let totalCost = 0;
  for (const b of buckets) {
    if (b.kwh > 0) b.cents = (b.cost / b.kwh) * 100;
    totalKwh += b.kwh;
    totalCost += b.cost;
    const winner = Object.entries(b.windows).sort((a, c) => c[1] - a[1])[0]?.[0];
    out.push({
      hour: b.hour,
      label: b.label,
      kwh: b.kwh,
      cost: b.cost,
      cents: b.cents,
      dominant:
        winner === 'Off-Peak' || winner === 'Mid-Peak' || winner === 'On-Peak' ? winner : 'other',
    });
  }

  if (totalKwh <= 0) {
    return {
      ...empty,
      reason: t('moneyViz.hourCostNoEnergy'),
      rows: rows.length,
    };
  }

  return {
    buckets: out,
    averageCents: (totalCost / totalKwh) * 100,
    ready: true,
    reason: '',
    rows: rows.length,
  };
}

/* ==========================================================================
 * Attribution waterfall for one period
 * ========================================================================== */

export type WaterfallKind = 'start' | 'add' | 'credit' | 'subtotal' | 'total';

export type WaterfallStep = {
  key: string;
  label: string;
  kind: WaterfallKind;
  /** Where the bar starts (the invisible base of the stacked bar). */
  base: number;
  /** Height of the visible bar. */
  value: number;
  /** Running total after this step. */
  running: number;
  /** Tooltip line: what this step did. */
  detail: string;
};

export type Waterfall = {
  steps: WaterfallStep[];
  /** The bill's own payable figure — the last step lands exactly here. */
  amountDue: number;
  ready: boolean;
  reason: string;
};

/**
 * commodity → +delivery → +regulatory → (Total Electricity Charges) → +HST
 * → −rebate → amount due.
 *
 * The steps are built to ADD UP: `billTotals` computes payable as
 * total + tax + credit, so the waterfall's running total is recomputed the
 * same way and the final bar is the same number the "Your actual bill" panel
 * prints. When the utility's stated total differs from the sum of its own
 * itemized lines by more than a cent, the gap gets its own step rather than
 * being quietly absorbed — a bill that does not add up should look like it.
 */
export function billWaterfall(summary: UsageSummary): Waterfall {
  const totals = billTotals(summary);
  const steps: WaterfallStep[] = [];
  let running = 0;

  /**
   * Geometry, in one place: a step that raises the total is drawn from the
   * running total UP to the new one; a step that lowers it is drawn from the
   * new level UP to the old one. Every visible bar is therefore a positive
   * height, and the credit hangs below its neighbours the way a refund reads.
   * Subtotal / total steps restate the whole thing from zero.
   */
  const push = (key: string, label: string, kind: WaterfallKind, delta: number, detail: string) => {
    if (kind === 'subtotal' || kind === 'total') {
      running = round2(delta);
      steps.push({ key, label, kind, base: 0, value: round2(delta), running, detail });
      return;
    }
    const before = running;
    running = round2(before + delta);
    steps.push({
      key,
      label,
      kind,
      base: delta >= 0 ? round2(before) : running,
      value: round2(Math.abs(delta)),
      running,
      detail,
    });
  };

  const kwh = summary.items
    .filter((i) => i.measurement && /usage$/.test(i.note.trim().toLowerCase()))
    .reduce((n, i) => n + (i.measurement?.scaled ?? 0), 0);
  const perKwh = (amount: number) =>
    kwh > 0
      ? t('wf.perKwhSuffix', {
          cents: fmtNumber((amount / kwh) * 100, 2),
          kwh: fmtNumber(kwh),
        })
      : '';

  push(
    'commodity',
    t('wf.commodity'),
    'start',
    totals.commodity,
    t('wf.commodityDetail', { suffix: perKwh(totals.commodity) }),
  );
  if (totals.delivery !== 0) {
    push('delivery', t('wf.delivery'), 'add', totals.delivery, t('wf.deliveryDetail', { suffix: perKwh(totals.delivery) }));
  }
  if (totals.regulatory !== 0) {
    push('regulatory', t('wf.regulatory'), 'add', totals.regulatory, t('wf.regulatoryDetail', { suffix: perKwh(totals.regulatory) }));
  }
  if (totals.other !== 0) {
    push('other', t('wf.otherLines'), 'add', totals.other, t('wf.otherDetail'));
  }

  // The utility's own subtotal. When its stated total and its own itemized
  // lines disagree by more than a cent, the difference becomes a step instead
  // of being absorbed: a bill that does not add up should look like it.
  const stated = summary.items.some((i) => i.amount !== null && classifyBillLine(i) === 'total')
    ? totals.total
    : null;
  if (stated !== null) {
    const gap = round2(stated - running);
    if (Math.abs(gap) > 0.005) {
      push('gap', t('wf.notItemized'), 'add', gap, t('wf.gapDetail'));
    }
    push(
      'subtotal',
      t('delta.total'),
      'subtotal',
      stated,
      t('wf.subtotalStated'),
    );
  } else {
    push(
      'subtotal',
      t('wf.subtotal'),
      'subtotal',
      running,
      t('wf.subtotalItemized'),
    );
  }

  if (totals.tax !== 0) {
    push('tax', t('slice.tax'), 'add', totals.tax, t('wf.taxDetail'));
  }
  if (totals.credit !== 0) {
    push('credit', t('wf.oebRebate'), 'credit', totals.credit, t('wf.creditDetail'));
  }

  // Land on the bill's OWN payable figure. If these steps have not reached it
  // (a line neither classified nor stated), say so with a step rather than
  // drawing a total that quietly disagrees with the panel above.
  const payable = totals.payable;
  const drift = round2(payable - running);
  if (Math.abs(drift) > 0.005) {
    push('drift', t('wf.notItemized'), 'add', drift, t('wf.driftDetail'));
  }

  const amountDueNote =
    totals.amountDue !== null && Math.abs(totals.amountDue - payable) > 0.005
      ? t('wf.amountDueNote', { amount: fmtMoney(totals.amountDue) })
      : '';
  push(
    'payable',
    t('wf.amountDue'),
    'total',
    payable,
    `${t('wf.payableDetail')}${amountDueNote}`,
  );

  /**
   * A bill that states NO charge line sums to a clean $0.00 through
   * `billTotals` — commodity $0.00 → amount due $0.00 drawn as a waterfall
   * would be a picture of a payment nobody made. `summaryStatesMoney` is
   * what separates that from a bill whose stated lines really do add to
   * zero, which still draws.
   */
  const ready = summaryStatesMoney(summary) && steps.length > 2;
  return {
    steps,
    amountDue: round2(payable),
    ready,
    reason: ready ? '' : t('moneyViz.waterfallNoCharges'),
  };
}

/* ==========================================================================
 * Plan overlay — the three plans, modelled over the periods we can see
 * ========================================================================== */

export type { PlanId } from './planIds';
import type { PlanId } from './planIds';

export type PlanOverlayLine = {
  plan: PlanId;
  label: string;
  /** Modelled amount due under this plan, over the SAME covered periods. */
  amount: number;
  /** `amount` ÷ covered periods — what the line on a per-period chart plots. */
  perPeriod: number;
};

export type PlanOverlay = {
  ready: boolean;
  /** Shown verbatim when `ready` is false. */
  reason: string;
  lines: PlanOverlayLine[];
  /** What those periods actually cost (total + HST − rebate), for the black line. */
  actual: number;
  /** `actual` ÷ covered periods — the same scale the bars are drawn on. */
  actualPerPeriod: number;
  /** Periods the comparison covers (coverage ≥ the Wave L gate). */
  covered: number;
  /** Periods in the file. */
  periods: number;
  /** Modelled with the file's own charge rates, or the ones typed in Settings. */
  chargesSource: 'bill' | 'typed' | null;
  /** Observed rebate as a fraction of the subtotal (negative), null when none. */
  rebateRate: number | null;
  /** Everything the numbers assume, printed under the chart. */
  assumptions: string[];
};

/**
 * Model each plan over exactly the billing periods we can both bill AND
 * measure, then compare against what was actually paid for them.
 *
 * Three decisions worth stating out loud:
 *
 *  1. Only periods with ≥90% reading coverage count (the same gate Wave L's
 *     reconciliation uses). Modelling a period we cannot see would be a guess
 *     wearing a chart's clothes — the overlay says so instead.
 *  2. The modelled figures are FULL amounts due, not the plan cards'
 *     commodity-only totals: delivery, regulatory and HST come from
 *     `calculateTrueBill` with the bill's own rates, and the observed rebate
 *     rate is applied on top. The chart plots their per-period average
 *     alongside the per-period bars (both are returned); a whole-span total
 *     would sit an order of magnitude above every bar and be discarded as
 *     out-of-range.
 *  3. Delivery/regulatory are modelled plan-independently (same $/kWh +
 *     fixed). That is an assumption, listed in `assumptions`, not a fact
 *     about the utility's tariff.
 */
export function planOverlay(
  summaries: UsageSummary[],
  rows: ProcessedPoint[],
  charges: ExtraCharges | null,
): PlanOverlay {
  const coveredPeriods = buildPeriodStacks(summaries, rows).filter(
    (s) => s.coverage >= PERIOD_MIN_COVERAGE,
  );
  const base: PlanOverlay = {
    ready: false,
    reason: '',
    lines: [],
    actual: 0,
    actualPerPeriod: 0,
    covered: coveredPeriods.length,
    periods: summaries.length,
    chargesSource: null,
    rebateRate: null,
    assumptions: [],
  };

  if (summaries.length === 0) {
    return { ...base, reason: t('moneyViz.noBillingPeriods') };
  }
  if (coveredPeriods.length === 0) {
    const coveredDays = coveredPeriods.reduce((n, s) => n + s.rows.length, 0);
    return {
      ...base,
      reason: t('moneyViz.noFullCoverage', { rows: coveredDays }),
    };
  }
  if (!charges) {
    return {
      ...base,
      reason: t('moneyViz.noModelRates'),
      covered: coveredPeriods.length,
    };
  }

  const rowsIn = coveredPeriods.flatMap((s) => s.rows);
  const totalKwh = rowsIn.reduce((n, r) => n + r.usage_kwh, 0);
  const days = coveredPeriods.reduce(
    // Every stack here comes from buildPeriodStacks, so `summary` is set —
    // the fallback keeps the arithmetic total if a caller passes stacks built
    // straight off the axis instead.
    (n, s) => n + ((s.summary?.duration ?? s.days * 86400) / 86400),
    0,
  );
  // calculateTrueBill's flat delivery is per month; use the exact fraction so
  // three 29-day periods bill 2.86 months of it, not 3.
  const months = days / 30.44;

  // Price the three plans the way the plan cards do: through the monthly
  // buckets, where the tiered tier-2 threshold is applied and scaled by the
  // days actually covered — the same rule `planCostFor` now applies everywhere
  // (the per-reading `costTiered` is tier 1 only, and pricing the overlay with
  // it put Tiered $8 UNDER the real TOU bill on Mark's July period, contradicting
  // both the plan cards and Wave P's track record for the same period).
  const costs = calculateComparison(aggregateChartData(rowsIn, 'monthly'));
  if (!costs) {
    return {
      ...base,
      reason: t('moneyViz.noReadingsInPeriods'),
      covered: coveredPeriods.length,
    };
  }

  const actual = coveredPeriods.reduce((n, s) => n + s.totals.payable, 0);
  const subtotal = coveredPeriods.reduce((n, s) => n + s.totals.total, 0);
  const credit = coveredPeriods.reduce((n, s) => n + s.totals.credit, 0);
  const rebateRate = subtotal > 0 && credit < 0 ? credit / subtotal : null;

  const lines: PlanOverlayLine[] = [];
  for (const plan of ['TOU', 'Tiered', 'ULO'] as const) {
    const estimate = calculateTrueBill({
      variableCost: costs[plan],
      totalKwh,
      months,
      charges,
    });
    if (!estimate) {
      return {
        ...base,
        reason: t('moneyViz.incompleteCharges'),
        actual: round2(actual),
        covered: coveredPeriods.length,
      };
    }
    const preTax = estimate.variable + estimate.delivery + estimate.regulatory;
    const amount = estimate.total + (rebateRate === null ? 0 : rebateRate * preTax);
    lines.push({
      plan,
      // Display name, so the overlay legend reads "Tarification par paliers"
      // in French. PLAN_LABEL stays the canonical English DATA name; this is
      // the localized view of it (same rule as every other plan label).
      label: planLabel(plan),
      amount: round2(amount),
      // The chart draws ONE horizontal line, and its bars are per period — so
      // the line is the per-period average of this total. Plotting the total
      // would put a $5,000 line over $400 bars, and Recharts discards a
      // reference line that falls outside the axis domain (measured: all four
      // lines vanished on Mark's 23-period export).
      perPeriod: round2(amount / coveredPeriods.length),
    });
  }

  return {
    ready: true,
    reason: '',
    lines,
    actual: round2(actual),
    actualPerPeriod: round2(actual / coveredPeriods.length),
    covered: coveredPeriods.length,
    periods: summaries.length,
    chargesSource: charges.xmlSource ? 'bill' : 'typed',
    rebateRate,
    // Wave U: the modelling notes are read by a person, so they come from the
    // catalog at call time like every other sentence in the panel.
    assumptions: [
      t('moneyViz.assumeCovered', {
        count: coveredPeriods.length,
        periods: fmtNumber(coveredPeriods.length),
        days: fmtNumber(days),
        kwh: fmtNumber(totalKwh),
      }),
      t('moneyViz.assumePerPeriod', { periods: fmtNumber(coveredPeriods.length) }),
      t('moneyViz.assumePriced', {
        source: charges.xmlSource
          ? ` (${charges.xmlSource.label})`
          : t('moneyViz.assumePricedSettings'),
        rebate: fmtPercent((rebateRate ?? 0) * 100, 1),
      }),
      t('moneyViz.assumeModel'),
    ],
  };
}
