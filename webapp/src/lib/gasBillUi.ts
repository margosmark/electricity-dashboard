/**
 * The Enbridge Gas (commodity 7) bill model the UI renders — the gas half of
 * "Your actual bill" (t_6c2606d1 / UX spec t_860756c3).
 *
 * Why this file exists next to `lib/energy.ts` and does not extend it: the
 * parser/contract chain owns `energy.ts` (one card at a time, serialized), and
 * everything here is a *view* decision — which line is a rate, which line the
 * money group promotes, which interval block belongs to which billing period,
 * which of the three legitimate volume numbers a row prints. `energy.ts`
 * answers what the FILE says; this module answers what the PANEL shows, and it
 * only ever reads `energy.ts`.
 *
 * The three contracts this module encodes (epic t_ace035c5 DoD):
 *
 *   1. Money honesty — Amount Due and Total Gas Charges are read from their
 *      own feed lines and their difference is computed from THOSE two only.
 *      No bucket sum, no `totals.payable` (which double-counts HST on gas:
 *      P1 would print $176.21 against a stated $175.76), no line-item sum
 *      anywhere. A feed that states no figure renders a dash, never a derived
 *      substitute.
 *   2. Gas speaks gas — m³, ¢/m³ (rate lines are amounts with potm −4, display
 *      only, never summed, never dollars), monthly billing periods. No
 *      kWh-shaped helper is called from a gas surface.
 *   3. Absence is a state — the five periods without an IntervalBlock are
 *      labelled "absent" (a stored `_gasInterval` is the only way to say
 *      "present"; nothing here ever produces a 0 m³ row for missing data).
 *
 * Enrichment (`enrichGasSummaries`) is applied by the import layer in
 * `hooks/useDashboard.ts` at parse time, so the two facts a panel cannot
 * re-derive later — which period an IntervalBlock belongs to, and whether an
 * Account Details file enriched labels — ride on the summary and therefore
 * survive the localStorage round trip with the summaries themselves.
 */
import {
  classifyBillLine,
  meterReadVolume,
  usageUnadjusted,
  type BillLineItem,
  type GreenButtonFeed,
  type UsageSummary,
} from './energy';

/* ==========================================================================
 * Recognition — is this bill natural gas?
 * ========================================================================== */

/**
 * Notes that only an Enbridge gas extract carries. Matched verbatim-ish on
 * the utility's own wording (the same rule `classifyBillLine`'s exact gas
 * vocabulary uses): an electricity bill has none of these, so an Ontario
 * Hydro file can never be mistaken for gas.
 */
const GAS_NOTE_MARKERS: readonly RegExp[] = [
  /¢\s*\/\s*m/i, // "Gas Supply Rate ¢/m3" — the unit-price lines
  /total gas charges/i,
  /gas supply/i,
  /gas delivery/i,
  /gas cost adjustment/i,
  /enbridge/i,
];

/** ESPI uom 42 = cubic metres: what `currentBillingPeriodOverAllConsumption`
 *  declares in all ten Enbridge periods. No electricity feed stamps it. */
const CUBIC_METRES_UOM = 42;

/**
 * True when this billing period is a natural-gas bill.
 *
 * The `volume` guard is `!= null`, not `!== null`: summaries stored before
 * the Enbridge wave (and both e2e seeds) carry NO `volume` key at all, so
 * `summary.volume` is `undefined`, `undefined !== null` is `true`, and
 * `undefined.uom` threw inside `summaries.some(isGasSummary)` — the
 * AppErrorBoundary crash (ERR-4887C2) that took the whole dashboard down on
 * any pre-wave localStorage. Absent and null both mean "states no volume".
 */
export function isGasSummary(summary: UsageSummary): boolean {
  if (summary.volume != null && summary.volume.uom === CUBIC_METRES_UOM) return true;
  return summary.items.some((item) => GAS_NOTE_MARKERS.some((re) => re.test(item.note)));
}

/** True when the dataset should render its bill panels in the gas variant. */
export function isGasFeed(summaries: readonly UsageSummary[]): boolean {
  return summaries.some(isGasSummary);
}

/* ==========================================================================
 * Enrichment — parse-time facts that must survive the storage round trip
 * ========================================================================== */

/** One IntervalBlock reading, as the panel needs it. */
export type GasIntervalInfo = {
  /** `present` — the block sits inside this billing period (its monthly
   *  reading). `stub` — a short block that ENDS where this period starts
   *  (Enbridge period 5's 1-day window, which is not a monthly reading). */
  state: 'present' | 'stub';
  /** UTC epoch seconds of the block's start. */
  timestamp: number;
  /** Block length in seconds (2851200 = 33 days for P1). */
  duration_s: number;
  /** The block's published volume in m³. */
  m3: number;
};

/** A summary as the import layer stores it: energy.ts's shape plus the two
 *  gas-only labels. Absent fields mean exactly that — no interval block in
 *  the feed, no account file loaded — never "zero". */
export type GasBillSummary = UsageSummary & {
  _gasInterval?: GasIntervalInfo;
  _gasSupplier?: string | null;
};

/** Raw volume readings anywhere in the feed (commodity-7 `volume` series). */
type RawInterval = { timestamp: number; duration_s: number | null; m3: number };

export function gasIntervalsOf(feed: GreenButtonFeed): RawInterval[] {
  const out: RawInterval[] = [];
  for (const group of feed.groups) {
    for (const series of group.series) {
      if (series.status !== 'volume') continue;
      for (const r of series.readings) {
        if (typeof r.m3 === 'number') {
          out.push({ timestamp: r.timestamp, duration_s: r.duration_s, m3: r.m3 });
        }
      }
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Which block (if any) describes this billing period.
 *
 * - Inside `[start, end)` → that block IS the period's monthly reading.
 * - Ends exactly when the period starts → the stub: kept, labelled, never
 *   presented as the period's volume (period 5's 1-day window sits before
 *   the period it belongs to).
 * - Anything else (including nothing) → null, which the panel prints as
 *   "absent interval data" — never 0 m³, never an interpolation.
 */
export function intervalFor(
  summary: UsageSummary,
  intervals: readonly RawInterval[],
): GasIntervalInfo | null {
  const start = summary.start;
  const end = start + summary.duration;
  const inside = intervals.find((r) => r.timestamp >= start && r.timestamp < end);
  if (inside) {
    return {
      state: 'present',
      timestamp: inside.timestamp,
      duration_s: inside.duration_s ?? 0,
      m3: inside.m3,
    };
  }
  const stub = intervals.find(
    (r) => r.duration_s !== null && r.timestamp + r.duration_s === start,
  );
  if (stub) {
    return {
      state: 'stub',
      timestamp: stub.timestamp,
      duration_s: stub.duration_s ?? 0,
      m3: stub.m3,
    };
  }
  return null;
}

/**
 * Attach the two facts a bill panel cannot recover later: the IntervalBlock
 * that belongs to each period, and the supplier an Account Details file
 * stated (labels only — a usage file alone imports fine with neither).
 * Applied at parse time in `useDashboard`, so both ride `summaries` into
 * localStorage and back without a second storage channel.
 */
export function enrichGasSummaries(feed: GreenButtonFeed): UsageSummary[] {
  const intervals = gasIntervalsOf(feed);
  const supplier = feed.account?.supplier ?? null;
  return feed.summaries.map((summary) => {
    if (!isGasSummary(summary)) return summary;
    const copy: GasBillSummary = { ...(summary as GasBillSummary) };
    const hit = intervalFor(summary, intervals);
    if (hit) copy._gasInterval = hit;
    if (supplier) copy._gasSupplier = supplier;
    return copy;
  });
}

/** The IntervalBlock state of a stored period: `present` / `stub` / `absent`. */
export function gasIntervalState(
  summary: UsageSummary,
): 'present' | 'stub' | 'absent' {
  return (summary as GasBillSummary)._gasInterval?.state ?? 'absent';
}

/** The block itself, when the feed carried one for this period. */
export function gasInterval(summary: UsageSummary): GasIntervalInfo | null {
  return (summary as GasBillSummary)._gasInterval ?? null;
}

/** Supplier label from a paired Account Details file; null when the usage
 *  file stood alone (the badge then omits the segment — it never blanks). */
export function gasSupplier(summary: UsageSummary): string | null {
  return (summary as GasBillSummary)._gasSupplier ?? null;
}

/* ==========================================================================
 * Money — the two feed figures and their difference, and nothing else
 * ========================================================================== */

export type GasMoney = {
  /** The feed's own `Amount Due` line, or null when it states none. */
  amountDue: number | null;
  /** The feed's own `Total Gas Charges ($)` line (already includes HST), or
   *  null. Never replaced by a bucket sum: a feed that states no total gets
   *  a dash, because a derived substitute is a different number. */
  total: number | null;
  /** amountDue − total, rounded to cents; null when either figure is absent. */
  delta: number | null;
};

const cents = (n: number): number => Math.round(n * 100) / 100;

export function gasMoney(summary: UsageSummary): GasMoney {
  const dueItem = summary.items.find((i) => /amount due/i.test(i.note));
  const totalItem = summary.items.find((i) => classifyBillLine(i) === 'total');
  const amountDue = dueItem?.amount ?? null;
  const total = totalItem?.amount ?? null;
  const delta = amountDue !== null && total !== null ? cents(amountDue - total) : null;
  return { amountDue, total, delta };
}

/* ==========================================================================
 * Charges / rates — what lists, what never sums
 * ========================================================================== */

/** Rate lines declare cents-per-unit (`¢/m3`, potm −4): display-only, one
 *  dedicated group, never a dollar row and never part of any total. */
export function isRateLine(item: BillLineItem): boolean {
  return /¢\s*\//.test(item.note);
}

/** The three balance lines stay VISIBLE even at $0.00: they are the
 *  discrepancy banner's evidence ("the feed reports them as zero"). */
const BALANCE_NOTES = new Set([
  'previous balance ($)',
  'payments received ($)',
  'balance forward ($)',
]);

/** Headline rows promoted into the money group, never repeated in the
 *  charges list. */
function isPromoted(item: BillLineItem): boolean {
  return /amount due/i.test(item.note) || classifyBillLine(item) === 'total';
}

export type GasCharges = {
  /** Nonzero money lines plus the three balance lines, in feed order. */
  visible: BillLineItem[];
  /** All-zero money lines the disclosure collapses (never dropped). */
  zero: BillLineItem[];
};

export function gasCharges(summary: UsageSummary): GasCharges {
  const moneyLines = summary.items.filter(
    (i) =>
      i.amount !== null && !isPromoted(i) && !isRateLine(i),
  );
  return {
    visible: moneyLines.filter(
      (i) => i.amount !== 0 || BALANCE_NOTES.has(i.note.trim().toLowerCase()),
    ),
    zero: moneyLines.filter(
      (i) => i.amount === 0 && !BALANCE_NOTES.has(i.note.trim().toLowerCase()),
    ),
  };
}

/** The `¢/m3` lines, in feed order. `item.amount` is already scaled by the
 *  line's own potm (204037 × 10⁻⁴ → 20.4037) — cents per cubic metre. */
export function gasRates(summary: UsageSummary): BillLineItem[] {
  return summary.items.filter((i) => i.amount !== null && isRateLine(i));
}

/* ==========================================================================
 * Volume — three legitimate numbers, never cross-substituted
 * ========================================================================== */

/** The bill-date / read-date / factor facts the "Bill facts" group and the
 *  volume group print. Every lookup is by the utility's own line name and
 *  every value is the file's own; a missing line is null (rendered as a
 *  dash), never guessed. */
export type GasFacts = {
  billDate: number | null;
  dueDate: number | null;
  readStart: number | null;
  readEnd: number | null;
  /** The feed's own `Number of days in bill period` (33 for P1 — one MORE
   *  than the 32-day billingPeriod, by design; see UX spec edge 7). */
  days: BillLineItem | null;
  /** `Adjustment Factor (atmospheric)` — 1.0057, displayed, never applied
   *  to anything the panel shows except the labeled "usage ×" caption. */
  adjustment: BillLineItem | null;
  /** `Pressure factor` — 0 in all ten periods, displayed as reported. */
  pressure: BillLineItem | null;
};

const lineByName = (summary: UsageSummary, note: string): BillLineItem | null =>
  summary.items.find((i) => i.note.trim() === note) ?? null;

const dateLine = (summary: UsageSummary, note: string): number | null => {
  const m = lineByName(summary, note)?.measurement ?? null;
  if (!m) return null;
  // uom 27 (date-time): the raw epoch, potm 0 in every Enbridge export.
  return m.uom === 27 ? m.scaled : null;
};

export function gasFacts(summary: UsageSummary): GasFacts {
  return {
    billDate: dateLine(summary, 'Bill Date'),
    dueDate: dateLine(summary, 'Due Date'),
    readStart: dateLine(summary, 'Billing Period - Previous Read Date'),
    readEnd: dateLine(summary, 'Billing Period - Current Read Date'),
    days: lineByName(summary, 'Number of days in bill period'),
    adjustment: lineByName(summary, 'Adjustment Factor (atmospheric)'),
    pressure: lineByName(summary, 'Pressure factor'),
  };
}

export type GasVolume = {
  /** `currentBillingPeriodOverAllConsumption` — the ADJUSTED m³ the bill
   *  charges for (429 for P1). Header figure. */
  billed: number | null;
  /** `Usage (unadjusted)` — 426.569 m³ for P1: × 1.0057 = billed. */
  unadjusted: number | null;
  /** Previous → Current meter read and their difference (427 for P1). A
   *  third number, labeled as such — never swapped for billed or interval. */
  reads: { previous: number; current: number; delta: number } | null;
  /** `Previous Usage consumption` — the feed's OWN prior-period figure,
   *  stated as 0 in every committed Enbridge document (the published sample
   *  and all ten synthetic periods). Shown as reported, with the feed's own
   *  label, because a line the document carries and no group printed was a
   *  line a reader could not check at all; it is never used as this period's
   *  volume, and null when the line is absent (no row, never a made-up 0). */
  previousUsage: number | null;
};

export function gasVolume(summary: UsageSummary): GasVolume {
  return {
    billed: summary.volume?.scaled ?? null,
    unadjusted: usageUnadjusted(summary),
    reads: meterReadVolume(summary),
    previousUsage:
      lineByName(summary, 'Previous Usage consumption')?.measurement?.scaled ?? null,
  };
}
