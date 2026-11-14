/**
 * What one UNTRUSTED Green Button document is allowed to cost.
 *
 * WHY THIS EXISTS
 * A Green Button export is attacker-reachable input: the upload modal,
 * `/import` and the custodian sync all hand the browser a string it did not
 * write. Two fixes already removed the crashes that input produced —
 * `collectEntries` spread a whole feed's `<entry>` array as call arguments
 * (`RangeError` from 125 487 siblings) and a finite-but-absurd reading could
 * sum every total to `Infinity`. Neither bounds what the DOCUMENT may cost:
 * measured on this tree (node v22.23.3, vitest/jsdom, t_2961ce14), 300 000
 * `<entry>` elements (50.1 MB) took 9.7 s and ~700 MB of heap, 900 000
 * (150.2 MB) took 27.6 s, and 400 000 readings (54.9 MB) took 9.8 s. The
 * largest REAL file this repo has measured is a 2.4-year Oakville export:
 * 6 424 909 bytes, 759 entries, 17 539 readings, 7 elements deep. Every
 * hostile shape below is therefore 1–2 orders of magnitude above anything a
 * utility emits, and each one is refused here — BEFORE the XML parser is
 * handed the text and allocates a tree for it.
 *
 * WHAT IS BOUNDED, AND WHY THESE NUMBERS
 *  - bytes … 32 MiB. The real file is 6.4 MB; a 15-minute export of the same
 *    2.4 years carries ~4× the readings, so ~26 MB must stay importable. The
 *    ceiling is one step above that rather than a round guess at what a
 *    browser tab can hold.
 *  - depth … 64 elements. Real exports nest 7 deep. fast-xml-parser's own
 *    default is 100 nested tags; the app states its own ceiling below that so
 *    the refusal a user sees is this app's sentence, never a library string.
 *  - entries … 200 000. The largest real document carries 759, and the sibling
 *    regression pin (t_941b3ceb) parses 130 000 sibling entries — that shape
 *    must keep working, so the ceiling sits above it.
 *  - readings … 500 000. The largest real document carries 17 539.
 *  - bill periods … 1 200 `<UsageSummary>` / `<ElectricPowerUsageSummary>`
 *    blocks. The real feeds this repo holds carry 10 (Enbridge gas) and 3
 *    (Oakville usage-summary exports); 1 200 is a century of monthly bills.
 *    The measured hostile shape (t_96e1cda0) carried 11 747 blocks placed
 *    OUTSIDE every `<entry>`, which the four dims above admitted because they
 *    counted only `entry` and `IntervalReading` — and each block is a rendered
 *    card (measured 141 DOM nodes each), so this dim is the render budget.
 *  - bill lines … 8 000 `costAdditionalDetailLastPeriod` items in the
 *    document, and 500 inside ONE period. The largest real document carries
 *    370 (Enbridge, 37 per period); the measured hostile shape put 20 000 in
 *    a single bill (render: 1 613 ms / 80 063 DOM nodes). Totals are SUMMED
 *    from these lines (`billTotals`), so an over-budget bill is refused as a
 *    whole — never truncated into a bill that adds up differently.
 * The six are independent on purpose: `<entry/>` is eight bytes, so a byte
 * cap alone would wave 1.7 million of them through, while a counting cap alone
 * would not stop one enormous text node.
 *
 * THE NUMERIC BOUNDS (the money and clock surfaces)
 * `series.ts` bounds what one INTERVAL may hold (`MAX_INTERVAL_KWH`, see
 * espiUnits.ts). The figures a BILL states are the other way into a total, and
 * they were unbounded: `<billLastPeriod>1e308</billLastPeriod>` arrives as a
 * FINITE 1e303 dollars, passes `billNum`'s finiteness check, is persisted into
 * `usage_summaries` and feeds every derived money figure (the charge fit, the
 * bill list, Hindsight). These caps are that same bound one level up — the
 * audited fixture's largest real period is $1,365.03:
 *  - {@link MAX_BILL_DOLLARS}    1e6  … one billing period cannot hold it.
 *  - {@link MAX_UNIT_PRICE_DOLLARS} 1e3 … a dollar-per-unit price is ~0.03–0.40.
 *  - {@link MAX_BILL_MEASUREMENT} 1e12 … a bill's own quantity or a meter read.
 *  - {@link MAX_BILL_PERIOD_SECONDS} 100 y … one billing period's own SPAN.
 *    The figure that sets how much work every duration-driven pass does: the
 *    gas temperature bands walk one step per HOUR of it, so a single
 *    `<espi:duration>` used to price the whole report (1e12 s → 1 327 ms,
 *    1e13 s → 17 299 ms, 1e15 s → ~29 min of main thread; t_3bfd4c3e F1).
 *  - {@link MAX_CLOCK_OFFSET_S}   86 400 … no UTC offset is a day long; a
 *    LocalTimeParameters block outside it is not a clock (see energy.ts).
 * Negative figures are legal on purpose: a bill can be a credit (the fixture
 * carries `-11690000`, −$116.90), so every money bound is on the magnitude.
 *
 * HOW A REFUSAL LEAVES THE APP
 * Every enforcement point throws {@link GreenButtonRefusal}, whose `detail` is
 * composed through `t()` where it is raised — the convention `storage.ts`,
 * `importPlan.ts` and `client.ts` already use, so the copy is translated on the
 * fr page and needs no second message channel. All three ingestion call sites
 * already catch a parse failure and show a diagnostic, so a refusal reaches the
 * user as that diagnostic — and, the point of the exercise, produces NOTHING to
 * persist: no readings, no bills, no example-data flag.
 */

/* Wave U — refusals are shown to the user, so lib code reads the locale. */
import { fmtMoney0, fmtNumberAuto, t } from '@/i18n';

/* ==========================================================================
 * The document budget
 * ========================================================================== */

/**
 * The largest XML text the app will hand to the parser, in UTF-16 code units.
 * Byte-identical on every real export (ASCII), including the 6 424 909-byte
 * Oakville file this bound is derived from.
 */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Elements deep: the deepest real export is 7, and the XML parser nests to 100. */
export const MAX_DOCUMENT_DEPTH = 64;

/** Aggregate `<entry>` elements across the WHOLE document, not per parent. */
export const MAX_ENTRIES = 200_000;

/** Aggregate `<IntervalReading>` elements across the whole document. */
export const MAX_READINGS = 500_000;

/**
 * Aggregate bill blocks (`UsageSummary` / `ElectricPowerUsageSummary`)
 * across the WHOLE document, wherever they appear — the measured hostile
 * shape parked 11 747 of them outside every `<entry>`, where the entry and
 * reading counts never see them, and every block becomes a rendered card.
 */
export const MAX_BILL_PERIODS = 1_200;

/**
 * Aggregate `costAdditionalDetailLastPeriod` line items across the whole
 * document. The flat pre-parse scan has no per-period context, so this is the
 * document-wide half of the line budget; {@link MAX_BILL_LINES_PER_PERIOD} is
 * the per-bill half, judged where the period is known (energy.ts).
 */
export const MAX_BILL_LINES = 8_000;

/** Line items ONE billing period may hold (real: 37; hostile: 20 000). */
export const MAX_BILL_LINES_PER_PERIOD = 500;

export type DocumentStats = {
  bytes: number;
  depth: number;
  entries: number;
  readings: number;
  billPeriods: number;
  billLines: number;
};

/**
 * A dimension a refusal can name. The first six are measured by
 * {@link measureDocument}; `billLinesPerPeriod` (one period's own line count)
 * and `billPeriodSeconds` (one period's own span) are judged after the parse,
 * where that period is known, and are named the same way so every budget
 * refusal renders through one copy path.
 */
export type BudgetDim = keyof DocumentStats | 'billLinesPerPeriod' | 'billPeriodSeconds';

/** The three sentences a refusal is shown with. One source of copy. */
export type RefusalCopy = {
  headline: string;
  detail: string;
  hints: string[];
};

export type BudgetRefusal = RefusalCopy & {
  dim: BudgetDim;
  /** What the scan measured; `bytes` is exact, always. */
  measured: number;
  limit: number;
};

/**
 * A document-level refusal: over budget, or carrying a figure no bill can hold.
 *
 * Carries the numbers behind the sentence AND the copy it is shown with, so a
 * caller does not have to invent a headline for it (or worse, fall back to a
 * generic "could not read this file" over a reason it knows exactly). Tests
 * assert on the numbers and the codes, never on the prose.
 */
export class GreenButtonRefusal extends Error {
  readonly code: 'budget' | 'bill-figure' | 'bill-scale' | 'bill-measurement';
  readonly dim: BudgetDim | null;
  readonly measured: number | null;
  readonly limit: number | null;
  /** Short line for the diagnostic box. */
  readonly headline: string;
  /** The reason, naming the numbers that produced it. */
  readonly detail: string;
  /** What the reader can do about it. */
  readonly hints: string[];

  constructor(args: {
    code: GreenButtonRefusal['code'];
    detail: string;
    headline: string;
    hints: string[];
    dim?: BudgetDim;
    measured?: number;
    limit?: number;
  }) {
    super(args.detail);
    this.name = 'GreenButtonRefusal';
    this.code = args.code;
    this.dim = args.dim ?? null;
    this.measured = args.measured ?? null;
    this.limit = args.limit ?? null;
    this.headline = args.headline;
    this.detail = args.detail;
    this.hints = args.hints;
  }
}

export function isGreenButtonRefusal(value: unknown): value is GreenButtonRefusal {
  return value instanceof GreenButtonRefusal;
}

/* ==========================================================================
 * The scanner — one pass, no allocation
 * ========================================================================== */

/** The element names whose COUNTS are the resource budget. */
const COUNTED: Record<string, 'entries' | 'readings' | 'billPeriods' | 'billLines'> = {
  entry: 'entries',
  IntervalReading: 'readings',
  UsageSummary: 'billPeriods',
  ElectricPowerUsageSummary: 'billPeriods',
  costAdditionalDetailLastPeriod: 'billLines',
};

/** `espi:entry` / `entry` → `entry` (the parser runs with removeNSPrefix). */
function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/**
 * Index of the `>` that closes a tag, honouring quoted attribute values (a
 * `href="a>b"` is legal XML and must not end the tag early). -1 when the tag
 * is never closed — the caller stops scanning; the parser reports the
 * malformed markup itself.
 */
function endOfTag(text: string, from: number): number {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/** Comments, CDATA and DOCTYPE are skipped whole — markup, not elements. */
function endOfMarkup(text: string, from: number): number {
  if (text.startsWith('<!--', from)) {
    const end = text.indexOf('-->', from);
    return end < 0 ? -1 : end + 3;
  }
  if (text.startsWith('<![CDATA[', from)) {
    const end = text.indexOf(']]>', from);
    return end < 0 ? -1 : end + 3;
  }
  return endOfTag(text, from) + 1;
}

/**
 * Bytes, depth, entries, readings and the two bill counts in ONE linear scan
 * of the raw text.
 *
 * The scan is deliberately conservative-cheap: it is the pre-parse estimate,
 * not the security boundary. fast-xml-parser's own `maxNestedTags` (set to
 * {@link MAX_DOCUMENT_DEPTH} in `parseGreenButtonFeed`) is the backstop, so a
 * document this scan mis-reads cannot become an unbounded parse. Entries and
 * readings are counted wherever they appear — inside CDATA they are text, and
 * text is not an element.
 */
export function measureDocument(text: string): DocumentStats {
  const stats: DocumentStats = {
    bytes: text.length,
    depth: 0,
    entries: 0,
    readings: 0,
    billPeriods: 0,
    billLines: 0,
  };
  let depth = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    const marker = text[lt + 1];
    if (marker === '/') {
      if (depth > 0) depth -= 1;
      const gt = endOfTag(text, lt + 2);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    if (marker === '!' || marker === '?') {
      const end = endOfMarkup(text, lt);
      // `endOfMarkup` adds 1 to `endOfTag`, so an UNTERMINATED `<?`/`<!`
      // (a download cut off right after `<?xml`, the most common truncation
      // there is) came back as 0 instead of -1 — which did not match `end < 0`
      // and left `i` pinned at the same `<` forever: `measureDocument` spun
      // at 100% CPU on a six-byte file and the import never returned
      // (t_9dfd150b, found by the hostile-XML corpus). Nothing is gained by
      // scanning past a construct that never closes: stop, and let the
      // validator name the truncation. Byte and depth bounds still hold —
      // bytes are exact from `text.length`, and `maxNestedTags` is the
      // parser's own backstop behind this estimate.
      if (end <= lt) break;
      i = end;
      continue;
    }

    let k = lt + 1;
    while (k < n && text[k] !== ' ' && text[k] !== '\t' && text[k] !== '\n' && text[k] !== '\r' && text[k] !== '/' && text[k] !== '>') {
      k += 1;
    }
    const counted = COUNTED[localName(text.slice(lt + 1, k))];
    const gt = endOfTag(text, k);
    if (gt < 0) break;
    if (counted) stats[counted] += 1;
    if (text[gt - 1] !== '/') {
      depth += 1;
      if (depth > stats.depth) stats.depth = depth;
    }
    i = gt + 1;
  }

  return stats;
}

/**
 * The three sentences a budget refusal is shown with: one headline for every
 * dimension (the detail names the one that broke), and the two hints a
 * person can act on. Read through `t()` where the refusal is built, so the copy
 * is translated on the fr page and the whole app shows the same words.
 */
function budgetCopy(detail: string): RefusalCopy {
  return {
    headline: t('diag.budgetHeadline'),
    detail,
    hints: [t('diag.budgetHint1'), t('diag.budgetHint2')],
  };
}

/** One dimension's refusal, with the numbers it judged. */
function dimRefusal(dim: BudgetDim, measured: number, limit: number): BudgetRefusal {
  let detail: string;
  if (dim === 'bytes') {
    detail = t('parse.refuseBytes', { measured, limit: Math.round(limit / (1024 * 1024)) });
  } else if (dim === 'depth') {
    detail = t('parse.refuseDepth', { measured, limit });
  } else if (dim === 'entries') {
    detail = t('parse.refuseEntries', { measured, limit });
  } else if (dim === 'readings') {
    detail = t('parse.refuseReadings', { measured, limit });
  } else if (dim === 'billPeriods') {
    detail = t('parse.refuseBillPeriods', { measured, limit });
  } else if (dim === 'billLinesPerPeriod') {
    detail = t('parse.refuseBillLinesPerPeriod', { measured, limit });
  } else if (dim === 'billPeriodSeconds') {
    // Days, not seconds: a period is read in days, and the figure that
    // refuses it should be the one the reader can recognise as absurd.
    detail = t('parse.refuseBillPeriod', {
      measured: fmtNumberAuto(Math.round(measured / 86_400)),
      limit: fmtNumberAuto(Math.round(limit / 86_400)),
    });
  } else {
    detail = t('parse.refuseBillLines', { measured, limit });
  }
  return { dim, measured, limit, ...budgetCopy(detail) };
}

/** The first budget dimension `stats` breaks, or null. Pure, so edges are cheap to pin. */
export function budgetRefusal(stats: DocumentStats): BudgetRefusal | null {
  if (stats.bytes > MAX_DOCUMENT_BYTES) return dimRefusal('bytes', stats.bytes, MAX_DOCUMENT_BYTES);
  if (stats.depth > MAX_DOCUMENT_DEPTH) return dimRefusal('depth', stats.depth, MAX_DOCUMENT_DEPTH);
  if (stats.entries > MAX_ENTRIES) return dimRefusal('entries', stats.entries, MAX_ENTRIES);
  if (stats.readings > MAX_READINGS) return dimRefusal('readings', stats.readings, MAX_READINGS);
  if (stats.billPeriods > MAX_BILL_PERIODS) {
    return dimRefusal('billPeriods', stats.billPeriods, MAX_BILL_PERIODS);
  }
  if (stats.billLines > MAX_BILL_LINES) return dimRefusal('billLines', stats.billLines, MAX_BILL_LINES);
  return null;
}

/**
 * `measureDocument` + `budgetRefusal` in one call, for the diagnostics path.
 *
 * The byte dimension is judged from `text.length` BEFORE the scan, so a
 * 50 MB upload is refused without being walked once: the scan is what makes a
 * big document expensive, and there is nothing to learn about a document that
 * is already too big (`stats` then carries only its size — no caller reads the
 * counts of a refused document).
 */
export function inspectDocument(text: string): {
  stats: DocumentStats;
  refusal: BudgetRefusal | null;
} {
  if (text.length > MAX_DOCUMENT_BYTES) {
    return {
      stats: {
        bytes: text.length,
        depth: 0,
        entries: 0,
        readings: 0,
        billPeriods: 0,
        billLines: 0,
      },
      refusal: dimRefusal('bytes', text.length, MAX_DOCUMENT_BYTES),
    };
  }
  const stats = measureDocument(text);
  return { stats, refusal: budgetRefusal(stats) };
}

/**
 * The pre-parse gate: `parseGreenButtonFeed` calls this before it constructs
 * the parser, so an over-budget document never becomes an object tree.
 */
export function assertDocumentBudget(text: string): DocumentStats {
  const { stats, refusal } = inspectDocument(text);
  if (refusal) {
    throw new GreenButtonRefusal({
      code: 'budget',
      dim: refusal.dim,
      measured: refusal.measured,
      limit: refusal.limit,
      headline: refusal.headline,
      detail: refusal.detail,
      hints: refusal.hints,
    });
  }
  return stats;
}

/**
 * The per-bill half of the line budget, judged where the period is known.
 *
 * {@link measureDocument} is a flat scan of raw text: it can count every
 * `costAdditionalDetailLastPeriod` in the document but cannot say which
 * period they belong to, and the document-wide {@link MAX_BILL_LINES} alone
 * would let ONE bill hold all 8 000 of them — a single card whose rows are
 * the render cost the dim exists to bound. `parseUsageSummaryNodes` calls
 * this with the block's own line count before it parses a single line.
 *
 * A refusal is fatal to the whole import, deliberately: `billTotals` SUMS
 * these lines, so keeping the first 500 would render a bill whose totals no
 * longer match its own rows.
 */
export function assertBillLinesPerPeriod(measured: number): void {
  if (measured <= MAX_BILL_LINES_PER_PERIOD) return;
  const refusal = dimRefusal('billLinesPerPeriod', measured, MAX_BILL_LINES_PER_PERIOD);
  throw new GreenButtonRefusal({
    code: 'budget',
    dim: refusal.dim,
    measured: refusal.measured,
    limit: refusal.limit,
    headline: refusal.headline,
    detail: refusal.detail,
    hints: refusal.hints,
  });
}

/**
 * The span half of the same per-bill budget: a billing period longer than
 * {@link MAX_BILL_PERIOD_SECONDS} is refused, whole, before it becomes a
 * `UsageSummary`.
 *
 * Judged where the period is known, exactly like the line count above — the
 * flat pre-parse scan counts `UsageSummary` blocks but cannot read the
 * `duration` inside one without parsing the document first. Fatal to the
 * import by design: a period no meter could have covered is not a bill, and
 * keeping the block while dropping its span would render a bill whose window
 * disagrees with every figure it states. `energy.ts` calls this the moment
 * `duration` is a number, before the block's money, volume or lines are read.
 */
export function assertBillPeriodSeconds(seconds: number): void {
  if (seconds <= MAX_BILL_PERIOD_SECONDS) return;
  const refusal = dimRefusal('billPeriodSeconds', seconds, MAX_BILL_PERIOD_SECONDS);
  throw new GreenButtonRefusal({
    code: 'budget',
    dim: refusal.dim,
    measured: refusal.measured,
    limit: refusal.limit,
    headline: refusal.headline,
    detail: refusal.detail,
    hints: refusal.hints,
  });
}

/* ==========================================================================
 * The numeric bounds — bills, their quantities, and the feed's clock
 * ========================================================================== */

/** Dollars one billing period may hold (largest real period: $1,365.03). */
export const MAX_BILL_DOLLARS = 1_000_000;

/** Dollars per unit one bill line may state as its price. */
export const MAX_UNIT_PRICE_DOLLARS = 1_000;

/** Units (Wh/kWh/reads) one bill quantity may scale to. */
export const MAX_BILL_MEASUREMENT = 1e12;

/** Seconds of UTC offset a LocalTimeParameters block may state (± 24 h). */
export const MAX_CLOCK_OFFSET_S = 24 * 3600;

/**
 * Seconds ONE billing period may span: 100 years.
 *
 * WHY IT IS A BOUND AT ALL. `<billingPeriod><duration>` is a per-bill figure
 * with no limit of its own — `energy.ts` accepted any finite `> 0` — and
 * duration-driven passes price it: `lib/gasTempBands.ts` walked one step per
 * HOUR of it while binning the usage-vs-temperature report, so one
 * `<espi:duration>` element set the report's cost. Measured on this tree
 * (t_3bfd4c3e, F1): 1e12 s → 1 327 ms, 1e13 s → 17 299 ms, 1e15 s → ~1 730 s
 * projected (~29 min of main thread before anything paints), with no upper
 * bound anywhere upstream — re-measured on this branch at 4 449 ms and
 * 59 524 ms for the same two figures (this box runs ~3× slower). Interval
 * readings already carry their own, much tighter ceiling
 * ({@link MAX_INTERVAL_SECONDS}, 366 d); this is the bill's.
 *
 * WHY 100 YEARS, NOT THE 400 DAYS FIRST PROPOSED. A 400-day ceiling refused
 * a REAL document: `tests/fixtures/utility-espi-prefixed-standin.xml` states
 * `<duration>721958400</duration>` — 22.9 years, a cumulative
 * "since 2000-01-01" usage summary that a Green Button Connect utility
 * actually emits — so a 400-day ceiling turned 5 test files / 10 tests red
 * on this branch (usageSummary, billMoneyScale, utilitySamples,
 * parseDiagnostic, limits itself; refusal: "spans 8 356 days, beyond the 400
 * days a single bill may cover"). 100 years is 4.4× above the largest
 * billing period this repo has ever parsed and still refuses every figure the finding measured:
 * 1e12 s is 31 709 years, 1e15 s is 31.7 million. Anything below the ceiling
 * costs nothing downstream either: the gas report no longer walks a period
 * hour by hour (see `gasTempBands.ts`).
 */
export const MAX_BILL_PERIOD_SECONDS = 100 * 365 * 24 * 3600;

/** The copy a refused bill figure is shown with. */
function billCopy(detail: string): RefusalCopy {
  return {
    headline: t('parse.refuseBillHeadline'),
    detail,
    hints: [t('parse.refuseBillHint1'), t('parse.refuseBillHint2')],
  };
}

/** A refused money figure: never shown as prose only — the numbers ride along. */
function billFigureRefusal(
  what: string,
  value: number,
  limit: number,
): GreenButtonRefusal {
  return new GreenButtonRefusal({
    code: 'bill-figure',
    measured: value,
    limit,
    ...billCopy(
      t('parse.refuseBillFigure', {
        what,
        value: String(value),
        limit: fmtMoney0(limit),
      }),
    ),
  });
}

/** A money figure the bill may keep, or a refusal — magnitude, so credits pass. */
export function assertBillDollars(what: string, dollars: number): void {
  if (Number.isFinite(dollars) && Math.abs(dollars) <= MAX_BILL_DOLLARS) return;
  throw billFigureRefusal(what, dollars, MAX_BILL_DOLLARS);
}

/** Divergence still called agreement: the same power of ten computed twice. */
const BILL_SCALE_TOLERANCE = 1e-9;

/**
 * The missing half of {@link assertBillDollars}: a figure scaled by the power
 * of ten the file itself declares, not just a figure small enough to keep.
 *
 * `assertBillDollars` bounds MAGNITUDE, so it refuses the too-large lie
 * (`1e308`) and cannot see the too-small one. Enbridge Gas sends every money
 * line as milli-dollars (`measurement { powerOfTenMultiplier: -3, uom: 80 }`)
 * and `billLastPeriod` as the very same figure the Amount Due line carries:
 * rendering either at the ESPI hundred-thousandths default turns $175.76 into
 * $1.76 — a finite, comfortable, bound-passing figure that no per-figure
 * magnitude check can object to, because $1.76 is a figure a bill CAN hold.
 * What makes it wrong is that the file contradicts it: `raw × 10^power` is
 * the figure, so anything else was scaled by a different power of ten.
 *
 * `powerOfTenMultiplier === null` means the file declares no scale for this
 * figure (Oakville's money lines carry no measurement; the ESPI Currency
 * default of 10^-5 is assumed). There is then nothing to agree with — only
 * the magnitude bound applies, and it has already been applied.
 *
 * The comparison is deliberately computed here from `raw` and `power` rather
 * than handed in, so a renderer that starts dividing by a hard-coded constant
 * again trips this at the first money line instead of shipping a bill that is
 * quietly 100× small.
 */
export function assertDeclaredBillScale(
  what: string,
  raw: number,
  powerOfTenMultiplier: number | null,
  dollars: number,
): void {
  if (powerOfTenMultiplier === null) return;
  const expected = raw / 10 ** -powerOfTenMultiplier;
  const tolerance = Math.max(BILL_SCALE_TOLERANCE, Math.abs(expected) * BILL_SCALE_TOLERANCE);
  if (Math.abs(dollars - expected) <= tolerance) return;
  throw billScaleRefusal(what, dollars, expected, powerOfTenMultiplier);
}

/** A figure kept at the wrong power of ten: both numbers ride on the refusal. */
function billScaleRefusal(
  what: string,
  value: number,
  expected: number,
  power: number,
): GreenButtonRefusal {
  return new GreenButtonRefusal({
    code: 'bill-scale',
    measured: value,
    limit: expected,
    ...billCopy(
      t('parse.refuseBillScale', {
        what,
        value: String(value),
        expected: String(expected),
        power: String(power),
      }),
    ),
  });
}

/** A dollars-per-unit price the bill may keep. */
export function assertUnitPrice(what: string, dollars: number): void {
  if (Number.isFinite(dollars) && Math.abs(dollars) <= MAX_UNIT_PRICE_DOLLARS) return;
  throw billFigureRefusal(what, dollars, MAX_UNIT_PRICE_DOLLARS);
}

/**
 * A bill quantity the document may keep. The scaled value must be a real
 * number: `value × 10^powerOfTenMultiplier` with an absurd multiplier is
 * `Infinity`, which `JSON.stringify` silently turns into `null` on the way
 * into `usage_summaries` — a lie rather than a poison, and refused for the
 * same reason.
 */
export function assertBillMeasurement(what: string, scaled: number): void {
  if (Number.isFinite(scaled) && Math.abs(scaled) <= MAX_BILL_MEASUREMENT) return;
  throw new GreenButtonRefusal({
    code: 'bill-measurement',
    measured: scaled,
    limit: MAX_BILL_MEASUREMENT,
    ...billCopy(
      t('parse.refuseBillMeasurement', {
        what,
        value: String(scaled),
        limit: fmtNumberAuto(MAX_BILL_MEASUREMENT),
      }),
    ),
  });
}

/**
 * True when `seconds` can be a UTC offset. A LocalTimeParameters block outside
 * this is not a clock, and the feed's clock is optional by contract (a block
 * without a tzOffset already describes no clock — see energy.ts), so an
 * impossible one is ignored rather than fatal to the readings.
 */
export function isClockOffset(seconds: number): boolean {
  return Number.isFinite(seconds) && Math.abs(seconds) <= MAX_CLOCK_OFFSET_S;
}
