/**
 * Wave P — the plan-type timeline: which plan each billing period was billed
 * under, what the alternatives would have cost, and the audited switch
 * track record.
 *
 * Three pure layers, all client-side, no I/O:
 *
 *  1. DETECTION — what plan a period was actually billed under, read off the
 *     bill's own itemized charge lines: "Off Peak-Summer" ⇒ TOU,
 *     "BLOCK 1 - Winter" ⇒ Tiered, "Overnight"/"Weekend Off-Peak" ⇒ ULO.
 *     Matching runs on the VERBATIM note text, never on itemKind (Wave L
 *     established there is no dependable public enumeration) and never on an
 *     enum of our own: the utility's wording is the only thing the file
 *     guarantees, Oakville itself writes "BLOCK 1 - Winter" and
 *     "BLOCK 1- Summer" with different spacing, and every other LDC words it
 *     differently again. Anything that does not match comes back `unknown`
 *     WITH the reason — the caller falls back to the user's timeline instead
 *     of guessing.
 *
 *  2. TIMELINE — what the user SAYS they were on, for ranges no export can
 *     speak for ("I was on Tiered from 2024-11-01 to 2025-03-31"), stored in
 *     localStorage next to `billing_day`. A confident detection wins over a
 *     declaration — the bill is evidence, the declaration is memory — and a
 *     disagreement is surfaced (`conflict`), never silently reconciled.
 *
 *  3. MODELING + REPORT — for every period with readings, the same interval
 *     data repriced under each alternative plan using the OEB rate set in
 *     force during THAT period (each reading carries its `activeRateSet`,
 *     i.e. Wave C's versioned rate history), then turned into a full-bill
 *     payable number and compared with what was actually paid. Every modeled
 *     figure is labelled modeled at the call site; this module only computes.
 *
 * The report answers one question with real numbers: "over-paid by staying
 * on {plan}" — audited history, not a forward-looking recommendation.
 */

import {
  PERIOD_MIN_COVERAGE,
  billPeriodLabel,
  billTotals,
  billWindow,
  classifyBillLine,
  planCostFor,
  summaryStatesMoney,
  type BillLineClass,
  type BillLineItem,
  type ProcessedPoint,
  type UsageSummary,
} from './energy';
// Wave U — detection reasons and skip notes come from the locale catalog;
// the PLAN_PATTERNS regexes above stay canonical (they match the FILE).
import { fmtMoney, t } from '@/i18n';

/* -------------------------------------------------------------------------- *
 * Types shared with the rest of the app
 * -------------------------------------------------------------------------- */

export type PlanType = 'TOU' | 'Tiered' | 'ULO';

export const PLAN_TYPES: readonly PlanType[] = ['TOU', 'Tiered', 'ULO'];

export function isPlanType(value: unknown): value is PlanType {
  return value === 'TOU' || value === 'Tiered' || value === 'ULO';
}

/* -------------------------------------------------------------------------- *
 * 1. Detection from the itemized charge lines
 * -------------------------------------------------------------------------- */

export type PlanTypeDetection = {
  /** The plan the lines fingerprint, or `unknown` — never a guess. */
  plan: PlanType | 'unknown';
  /** Verbatim notes that produced the verdict (all of them when unknown). */
  evidence: string[];
  /** Every plan whose pattern matched, in PLAN_TYPES order (conflict audit). */
  candidates: PlanType[];
  /** Why it is unknown; null when a plan was detected. */
  reason: string | null;
};

/**
 * Signature patterns, matched against a lowercased, whitespace-collapsed
 * note. Order of evaluation is fixed by `detectPlanType`, not here.
 *
 * - ULO: the distinctive period names — Overnight / Ultra-Low / Weekend /
 *   Weekday. Ontario ULO bills word their periods "Ultra-Low Overnight" and
 *   "Weekend Off-Peak", and the latter CONTAINS "Off-Peak", so this check
 *   must run before TOU's or every ULO bill would read as TOU.
 * - TOU: the three peak windows, hyphen- or space-joined, with or without a
 *   season suffix ("Off Peak-Summer", "On-Peak", "Mid-Peak").
 * - Tiered: tier/block wording ("BLOCK 1 - Winter", "BLOCK 1- Summer",
 *   "Tiered", "Tier 2"), or a plain volume charge that names electricity and
 *   none of the peak/tax/total words ("Electricity Used" — the wording many
 *   LDCs use for a flat per-kWh line).
 */
const PLAN_PATTERNS: Record<PlanType, (note: string) => boolean> = {
  // Wave U: every anchor also accepts the OEB's French period wording
  // ("Période basse de nuit", "Période creuse (fin de semaine)",
  // "BLOC 1 - Hiver", "Palier 2"), so a bilingual export classifies the
  // same way the English one does. Oakville's DMD feed emits English only
  // (checked against Mark's own file) — these are here so the classifier is
  // honest about the format it claims to tolerate, not because a French
  // file is on disk today. ORDER still matters: the ULO test runs first
  // because "Période creuse (fin de semaine)" contains BOTH "creuse" and
  // "fin de semaine", exactly like English "Weekend Off-Peak".
  ULO: (n) =>
    /\bovernight\b|ultra[ -]?low|\bweekend\b|\bweekday\b|\bnuit\b|fin de semaine|week-?end|jours? ouvrables?/.test(n),
  TOU: (n) => /(?:off|mid|on)[ -]?peak|p[ée]riode (?:creuse|normale|de pointe)|\bpointe\b|\bmi-?pointe\b/.test(n),
  Tiered: (n) =>
    /\btier(?:ed)?\b|\bblock[ -]?\d|\bbloc[ -]?\d|\bpalier(?:s)?\b/.test(n) ||
    ((n.includes('electricity') || n.includes('électricité')) &&
      !/(peak|total|charge|rebate|credit|tax|hst|pointe|total|cr[ée]dit|taxe|tvh)/.test(n)),
};

/** Line classes that are never plan evidence (totals, taxes, the ride-alongs). */
const NON_EVIDENCE: BillLineClass[] = ['total', 'tax', 'credit', 'delivery', 'regulatory'];

/**
 * Infer the plan a bill was written under from its charge-line notes.
 *
 * Precedence (documented, test-pinned):
 *   1. no matching line at all            → unknown ("no recognizable plan lines")
 *   2. exactly one plan matched           → that plan
 *   3. ULO (+ TOU's peak wording only)    → ULO  (ULO period names contain
 *      "Off-Peak"/"Mid-Peak"/"On-Peak" by design — see PLAN_PATTERNS)
 *   4. any other mix (TOU+Tiered, …)      → unknown ("mixed plan signatures")
 *
 * The evidence list is verbatim: the caller shows the user exactly which of
 * the utility's own lines produced the verdict.
 */
export function detectPlanType(items: BillLineItem[]): PlanTypeDetection {
  // (reasons below come from the locale catalog — Wave U)
  const hits: Record<PlanType, string[]> = { TOU: [], Tiered: [], ULO: [] };
  for (const item of items) {
    const note = item.note;
    if (!note) continue;
    if (NON_EVIDENCE.includes(classifyBillLine(item))) continue;
    const normalized = note.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const plan of PLAN_TYPES) {
      if (PLAN_PATTERNS[plan](normalized) && !hits[plan].includes(note)) {
        hits[plan].push(note);
      }
    }
  }

  const candidates = PLAN_TYPES.filter((p) => hits[p].length > 0);

  if (candidates.length === 0) {
    return {
      plan: 'unknown',
      evidence: [],
      candidates,
      reason: t('planTimeline.noLines'),
    };
  }
  if (candidates.length === 1) {
    const plan = candidates[0];
    return { plan, evidence: hits[plan], candidates, reason: null };
  }
  if (candidates.includes('ULO') && candidates.every((p) => p === 'ULO' || p === 'TOU')) {
    return { plan: 'ULO', evidence: hits.ULO, candidates, reason: null };
  }
  const evidence = candidates.flatMap((p) => hits[p]);
  return {
    plan: 'unknown',
    evidence,
    candidates,
    reason: t('planTimeline.mixedSignatures', { plans: candidates.join(' + ') }),
  };
}

/* -------------------------------------------------------------------------- *
 * 2. The user-editable timeline
 * -------------------------------------------------------------------------- */

/** Stored next to `billing_day`; same localStorage-only contract. */
export const PLAN_TIMELINE_KEY = 'plan_timeline';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in `yyyy-MM-dd` (rejects 2024-02-30 too). */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  // V8 rolls 2024-02-30 forward to 2024-03-01 instead of rejecting it, so
  // the only trustworthy check is round-tripping: parse, then require the
  // parsed instant to render back the exact string it came from.
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export type PlanTimelineEntry = {
  /** Client-generated — storage is local, ids only need to be unique here. */
  id: string;
  plan: PlanType;
  /** First day on the plan, inclusive, `yyyy-MM-dd`. */
  from: string;
  /** Last day on the plan, inclusive, `yyyy-MM-dd`. */
  to: string;
};

export function isValidPlanTimelineEntry(value: unknown): value is PlanTimelineEntry {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    isPlanType(o.plan) &&
    isIsoDay(o.from) &&
    isIsoDay(o.to) &&
    o.from <= o.to
  );
}

/**
 * Read the stored timeline. Storage is a hint, never authority: a corrupt
 * document, a non-array, or individual malformed entries are dropped — a
 * half-valid timeline must not poison every period it touches. (Backup
 * import is the strict path; see lib/backup.ts.)
 */
export function parsePlanTimeline(raw: string | null | undefined): PlanTimelineEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isValidPlanTimelineEntry);
  } catch {
    return [];
  }
}

export function newTimelineId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Inclusive day count between two `yyyy-MM-dd` strings (lexicographic-safe). */
function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * The declaration covering the widest span of `[startDay, endDay]` — ties go
 * to the one that started latest (a later switch is the more specific
 * statement). Returns null when nothing overlaps.
 */
export function declarationFor(
  entries: PlanTimelineEntry[],
  startDay: string,
  endDay: string = startDay,
): PlanTimelineEntry | null {
  let best: PlanTimelineEntry | null = null;
  let bestOverlap = 0;
  for (const entry of entries) {
    if (entry.to < startDay || entry.from > endDay) continue;
    const lo = entry.from > startDay ? entry.from : startDay;
    const hi = entry.to < endDay ? entry.to : endDay;
    const overlap = daySpan(lo, hi);
    if (overlap > bestOverlap || (best !== null && overlap === bestOverlap && entry.from > best.from)) {
      best = entry;
      bestOverlap = overlap;
    }
  }
  return best;
}

export type PeriodPlan = {
  /** Bill window the verdict is for. */
  startDate: string;
  endDate: string;
  /** Detected from the bill, declared by the user, or unknown. */
  plan: PlanType | 'unknown';
  origin: 'detected' | 'declared' | 'unknown';
  /** The raw detection — evidence stays visible whichever origin won. */
  detection: PlanTypeDetection;
  /** The declaration covering this period, if any. */
  declared: PlanTimelineEntry | null;
  /** A declaration covers the period but the bill's own lines disagree.
   *  Detection wins (evidence over memory); the UI must say so. */
  conflict: boolean;
};

/**
 * Resolve one period: a confident detection is the answer; a declaration
 * fills the gap when the lines say nothing; otherwise honestly unknown.
 */
export function assignPeriodPlan(
  detection: PlanTypeDetection,
  entries: PlanTimelineEntry[],
  window: { start: string; end: string },
): PeriodPlan {
  const declared = declarationFor(entries, window.start, window.end);
  const base = { startDate: window.start, endDate: window.end, detection, declared };
  if (detection.plan !== 'unknown') {
    return {
      ...base,
      plan: detection.plan,
      origin: 'detected',
      conflict: declared !== null && declared.plan !== detection.plan,
    };
  }
  if (declared) {
    return { ...base, plan: declared.plan, origin: 'declared', conflict: false };
  }
  return { ...base, plan: 'unknown', origin: 'unknown', conflict: false };
}

/** One chart annotation per billing period — the money-chart overlay. */
export type PeriodPlanAnnotation = {
  /** billingPeriod.start (unix seconds) — the key stacks are keyed by. */
  start: number;
  plan: PlanType | 'unknown';
  origin: PeriodPlan['origin'];
};

/**
 * Resolve every bill period to its plan for the overlay (slice 5): the same
 * detection + declaration rules the timeline and the report use, so the
 * chart can never tell a different story than the table beside it.
 */
export function planAnnotations(
  summaries: UsageSummary[],
  timeline: PlanTimelineEntry[],
): PeriodPlanAnnotation[] {
  return summaries.map((summary) => {
    const assignment = assignPeriodPlan(detectPlanType(summary.items), timeline, {
      start: summary.startDate,
      end: summary.endDate,
    });
    return { start: summary.start, plan: assignment.plan, origin: assignment.origin };
  });
}

/* -------------------------------------------------------------------------- *
 * 3. Per-period alternative modeling
 * -------------------------------------------------------------------------- */

export type PeriodAlternatives = {
  summary: UsageSummary;
  /** Readings inside the billed window (billWindow, same rule as Wave L). */
  rows: ProcessedPoint[];
  periodDays: number;
  coveredDays: number;
  /** Covered days ÷ period days. */
  coverage: number;
  /** ≥90% covered (PERIOD_MIN_COVERAGE) — the same gate reconciliation uses.
   *  When false the modeled numbers must not be shown as an answer. */
  comparable: boolean;
  /** Commodity-only cost of these readings under each plan, priced with the
   *  rate set in force on each reading's day (historical rates). */
  commodity: Record<PlanType, number>;
  /** Full-bill payable under each plan. */
  payable: Record<PlanType, number>;
};

/**
 * Tiered commodity with the month-bucket threshold rule the plan cards use —
 * now literally `planCostFor` from `energy.ts`, which is where that rule
 * lives. A period spanning two calendar months is split the way the LDC bills
 * it, and tier-2 kicks in only above the threshold.
 */
function tieredCommodity(rows: ProcessedPoint[]): number {
  return planCostFor(rows, 'Tiered');
}

/**
 * What the SAME readings would have cost under each plan for one billing
 * period, as a full-bill number.
 *
 * Only the commodity is repriced — that is the one part of the bill a plan
 * switch moves. Tiered comes from `planCostFor`, the app's single month-scoped
 * threshold rule (this module used to carry its own copy of it). Delivery,
 * regulatory and any other billed line are held at
 * their ACTUAL values; HST and the Ontario Electricity Rebate are scaled at
 * this bill's own effective rates (tax ÷ total, credit ÷ total), so the
 * modeled figure sits on exactly the same footing as the $ figure it is
 * compared against. When the bill states no totals at all, HST falls back to
 * the statutory 13% and the rebate to zero — documented, never invented per
 * case.
 *
 * Repricing uses each reading's `activeRateSet`, i.e. the OEB rate set in
 * force on that day (Wave C's versioned history) — historical periods are
 * modeled with historical rates, not today's.
 */
export function modelPeriod(summary: UsageSummary, allRows: ProcessedPoint[]): PeriodAlternatives {
  const { start, end } = billWindow(summary);
  const rows = allRows.filter((r) => r.timestamp >= start && r.timestamp < end);
  const totals = billTotals(summary);
  const periodDays = Math.max(1, Math.round((end - start) / 86400));
  const coveredDays = new Set(rows.map((r) => r.dayStr)).size;
  const coverage = Math.min(1, coveredDays / periodDays);

  const commodity: Record<PlanType, number> = {
    TOU: rows.reduce((sum, r) => sum + r.costTOU, 0),
    ULO: rows.reduce((sum, r) => sum + r.costULO, 0),
    Tiered: tieredCommodity(rows),
  };

  const hstRate = totals.total > 0 ? totals.tax / totals.total : 0.13;
  const creditRate = totals.total > 0 ? totals.credit / totals.total : 0;
  const billedNonCommodity = totals.total - totals.commodity;

  const payable = {} as Record<PlanType, number>;
  for (const plan of PLAN_TYPES) {
    const modeledTotal = billedNonCommodity + commodity[plan];
    payable[plan] = modeledTotal + modeledTotal * hstRate + modeledTotal * creditRate;
  }

  return {
    summary,
    rows,
    periodDays,
    coveredDays,
    coverage,
    comparable: coverage >= PERIOD_MIN_COVERAGE && rows.length > 0,
    commodity,
    payable,
  };
}

/* -------------------------------------------------------------------------- *
 * 4. The switch-decision track record
 * -------------------------------------------------------------------------- */

/** A row's modeled numbers only COUNT toward the report totals when the
 *  model can reproduce the bill it claims to explain — re-pricing the plan
 *  you WERE on must land back on that bill within this tolerance (the same
 *  $1 the commodity cross-check accepts). Wider misses are still shown, with
 *  their delta, but excluded from every total: an unfaithful reconstruction
 *  must not invent savings (the real 24-period export has bills whose reads
 *  straddle a rate change — before billWindow learned to reject them, those
 *  rows claimed a $145 "saving" that was really missing readings). */
export const MODEL_TRUST_TOLERANCE = 1;

export type SwitchPeriodRow = {
  summary: UsageSummary;
  /** "May 25 – Jun 23, 2026" — the bill's own period label. */
  label: string;
  plan: PlanType | 'unknown';
  origin: PeriodPlan['origin'];
  /** Declaration disagrees with the detected plan (detection wins; shown). */
  conflict: boolean;
  detection: PlanTypeDetection;
  /** What was actually paid this period (the bill's payable total). */
  actual: number;
  /** Modeled payable per plan — present only when the period is comparable.
   *  With a known plan these are the two NON-actual plans; with an unknown
   *  plan all three are shown as reference, and no saving is claimed. */
  modeled: Record<PlanType, number> | null;
  /** Cheapest of the two alternatives; null without a known actual plan. */
  bestPlan: PlanType | null;
  /** actual − cheapest alternative; negative means you already had the best. */
  saving: number | null;
  /** Payable(what you were on) − actual: the model's own error bar for this
   *  period. Large values mean the reconstruction should not be trusted. */
  modelDelta: number | null;
  /** Why nothing was modeled (null when it was). */
  skipped: string | null;
  /** True when the saving is trustworthy enough to enter the totals:
   *  known plan + covered period + model reproduces the bill within
   *  MODEL_TRUST_TOLERANCE. */
  counted: boolean;
  /** Non-null when a saving was computed but is NOT counted (the model
   *  misses this bill) — carries the reason for the row's badge. */
  excluded: string | null;
};

export type SwitchPlanTotal = {
  plan: PlanType;
  periods: number;
  /** Net over-payment across those periods (negative = net saving). */
  overpaid: number;
};

export type SwitchReport = {
  rows: SwitchPeriodRow[];
  /** Rows whose plan is known (detected or declared). */
  known: number;
  /** Rows with a known plan AND a covered period (savings computed). */
  modeled: number;
  /** Of those, rows whose model reproduces the bill — the only ones the
   *  totals are built from. */
  counted: number;
  /** Rows with a computed saving that is shown but not counted (model miss). */
  untrusted: number;
  /** Rows skipped from modeling (no / insufficient readings in period). */
  skipped: number;
  /** Σ saving over `modeled` rows; null when nothing could be modeled. */
  overpaid: number | null;
  /** "Over-paid by staying on {plan}" per actual plan, netted. */
  byPlan: SwitchPlanTotal[];
  /** Biggest positive savings, largest first — the callouts. */
  callouts: SwitchPeriodRow[];
};

/**
 * Build the audited track record: one row per billing period, an honest
 * skip when the readings do not cover the period, and an over-paid total
 * that only ever sums rows where BOTH an actual plan and a modeled
 * alternative exist.
 */
export function buildSwitchReport(
  summaries: UsageSummary[],
  allRows: ProcessedPoint[],
  timeline: PlanTimelineEntry[],
): SwitchReport {
  const rows: SwitchPeriodRow[] = summaries.map((summary) => {
    const detection = detectPlanType(summary.items);
    const assignment = assignPeriodPlan(detection, timeline, {
      start: summary.startDate,
      end: summary.endDate,
    });
    const model = modelPeriod(summary, allRows);
    const totals = billTotals(summary);

    const base: SwitchPeriodRow = {
      summary,
      label: billPeriodLabel(summary.start, summary.duration),
      plan: assignment.plan,
      origin: assignment.origin,
      conflict: assignment.conflict,
      detection,
      actual: totals.payable,
      modeled: null,
      bestPlan: null,
      saving: null,
      modelDelta: null,
      skipped: null,
      counted: false,
      excluded: null,
    };

    // A bill that states no charge lines (the Green Button Alliance sample is
    // one: a bare ElectricPowerUsageSummary) has no actual to compare an
    // alternative against. billTotals sums it to a clean $0.00, and modeling
    // against that zero would report a "saving" that is really the whole
    // modeled bill — with a model check "miss" accusing the utility of
    // charging a number it never quoted. This check runs BEFORE the coverage
    // gate: full coverage could not rescue a comparison against nothing, and
    // the reason the row skips has to be the reason that would still hold.
    if (!summaryStatesMoney(summary)) {
      return { ...base, skipped: t('planTimeline.skipNoChargeLines') };
    }

    if (!model.comparable) {
      return {
        ...base,
        skipped:
          model.rows.length === 0
            ? t('planTimeline.skipNoReadings')
            : t('planTimeline.skipCoverage', {
                covered: model.coveredDays,
                days: model.periodDays,
                pct: Math.round(model.coverage * 100),
                needed: Math.round(PERIOD_MIN_COVERAGE * 100),
              }),
      };
    }

    if (assignment.plan === 'unknown') {
      // No actual plan to be "staying on" — show the modeled reference and
      // claim nothing.
      return { ...base, modeled: model.payable };
    }

    const alternatives = PLAN_TYPES.filter((p) => p !== assignment.plan);
    let bestPlan: PlanType | null = null;
    let bestPayable = Infinity;
    for (const p of alternatives) {
      const value = model.payable[p];
      if (value < bestPayable) {
        bestPayable = value;
        bestPlan = p;
      }
    }
    const modelDelta = model.payable[assignment.plan] - totals.payable;
    const trusted = Math.abs(modelDelta) <= MODEL_TRUST_TOLERANCE;
    return {
      ...base,
      modeled: model.payable,
      bestPlan,
      saving: totals.payable - bestPayable,
      modelDelta,
      counted: trusted,
      excluded: trusted
        ? null
        : t('planTimeline.modelExcluded', {
            sign: modelDelta < 0 ? '' : '+',
            amount: fmtMoney(Math.abs(modelDelta)),
          }),
    };
  });

  const known = rows.filter((r) => r.plan !== 'unknown').length;
  const modeledRows = rows.filter((r) => r.saving !== null);
  // The totals are built ONLY from rows whose model reproduces their own
  // bill — everything else is displayed with its reason, never summed.
  const countedRows = modeledRows.filter((r) => r.counted);
  const skipped = rows.filter((r) => r.skipped !== null).length;

  const overpaid = countedRows.length > 0
    ? countedRows.reduce((sum, r) => sum + (r.saving ?? 0), 0)
    : null;

  const byPlan: SwitchPlanTotal[] = PLAN_TYPES.map((plan) => {
    const list = countedRows.filter((r) => r.plan === plan);
    return {
      plan,
      periods: list.length,
      overpaid: list.reduce((sum, r) => sum + (r.saving ?? 0), 0),
    };
  }).filter((g) => g.periods > 0);

  const callouts = countedRows
    .filter((r) => (r.saving ?? 0) > 0)
    .slice()
    .sort((a, b) => (b.saving ?? 0) - (a.saving ?? 0))
    .slice(0, 3);

  return {
    rows,
    known,
    modeled: modeledRows.length,
    counted: countedRows.length,
    untrusted: modeledRows.length - countedRows.length,
    skipped,
    overpaid,
    byPlan,
    callouts,
  };
}
