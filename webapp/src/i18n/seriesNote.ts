/**
 * The display layer for `SeriesNote` — the sentence the user actually reads.
 *
 * WHY THIS EXISTS
 * The ingestion composes its refusal sentences in the parser
 * (`lib/greenbutton/series.ts`, `lib/energy.ts`), and those sentences are
 * English prose, not canonical data: "No ReadingType described 2856 reading(s),
 * so they were read as watt-hours scaled by the document-wide multiplier — the
 * legacy compatibility path." The multi-UsagePoint picker always carried them;
 * `SeriesNotesNotice` (t_880370e6) started painting them on the dashboard, and
 * a French page then showed an English sentence inside French chrome.
 *
 * The fix keeps both ends honest:
 *
 *   • the LIB keeps `SeriesNote.detail` — the English sentence, unchanged, so
 *     the parser's own account of what it refused stays readable, testable and
 *     comparable to the evidence;
 *   • the NOTE also carries the values that sentence interpolates as data
 *     (`SeriesNote.params`), and this module maps `code` (+ `params.variant`
 *     when one code carries two different sentences) onto the catalog key the
 *     sentence belongs to.
 *
 * `seriesNoteText()` is therefore the ONE place a note becomes text. It returns
 * the catalogued sentence in the reader's language and falls back to `detail`
 * whenever it cannot be sure of a full translation: no `params` (the note was
 * not composed with structured values — e.g. a fixture built by hand), a code
 * with no key yet, a `variant` this module does not know, or a key the catalog
 * does not define. A note can never reach the screen as a raw catalog key.
 *
 * The refusal CLAUSES have keys too (`REFUSAL_REASON_KEY`, exported next to the
 * clauses in `series.ts`): `params.status` travels as the ESPI status code, and
 * the clause is translated here, so a French reader never gets an English
 * clause glued into a French sentence.
 */

import { CATALOGS, getLocale } from './index';
import { REFUSAL_REASON_KEY, type SeriesNote } from '@/lib/greenbutton/series';

/** The translator a component already has (`useTranslation().t`). */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The catalog key of each note code that has exactly ONE sentence. */
export const NOTE_KEY: Partial<Record<SeriesNote['code'], string>> = {
  'unsupported-series': 'gbseries.note.unsupportedSeries',
  'converted-to-energy': 'gbseries.note.convertedToEnergy',
  'volume-series': 'gbseries.note.volumeSeries',
  'account-details': 'gbseries.note.accountDetails',
  'refused-readings': 'gbseries.note.refusedReadings',
  'assumed-direction': 'gbseries.note.assumedDirection',
  'unlinked-reading-type': 'gbseries.note.unlinkedReadingType',
  'ambiguous-inline-reading-types': 'gbseries.note.ambiguousInlineReadingTypes',
};

/**
 * The codes that carry TWO different sentences under one code — a document-wide
 * WH assumption is not the same statement as "this series declares no uom".
 * `params.variant` is the discriminator, and an unknown variant means no key
 * (so the English `detail` is printed rather than the wrong sentence).
 */
export const VARIANT_KEY: Partial<Record<SeriesNote['code'], Record<string, string>>> = {
  'legacy-assumption': {
    'document-wide': 'gbseries.note.legacyAssumption',
    'no-uom': 'gbseries.note.legacyAssumptionNoUom',
  },
  'combined-series': {
    'energy-and-power': 'gbseries.note.combinedEnergyAndPower',
    'several-series': 'gbseries.note.combinedConsumptionSeries',
    // One point repeating the same consumption at several resolutions: the
    // finest series is priced and the rest are refused where they overlap
    // (t_1fca89fa). Two sentences, because whether a refused series kept any
    // reading outside the priced coverage is a different statement.
    'duplicate-resolution': 'gbseries.note.combinedDuplicateResolution',
    'duplicate-resolution-partial': 'gbseries.note.combinedDuplicateResolutionPartial',
  },
};

/**
 * Every note code this module claims to translate: one entry in `NOTE_KEY`, or
 * a variant map. A code absent from both is a code whose sentence still reaches
 * the user in English only — `seriesNote.test.ts` fails on that.
 */
export const TRANSLATED_CODES: ReadonlyArray<SeriesNote['code']> = [
  ...(Object.keys(NOTE_KEY) as SeriesNote['code'][]),
  ...(Object.keys(VARIANT_KEY) as SeriesNote['code'][]),
];

/** A point with no id is printed as a word, not as the parser's sentinel. */
const POINT_UNIDENTIFIED = 'gbseries.pointUnidentified';

/** The clause key for a status code, or null when the code is not a refusal. */
function refusalKey(status: unknown): string | null {
  if (typeof status !== 'string') return null;
  const keys: Record<string, string> = REFUSAL_REASON_KEY;
  return Object.prototype.hasOwnProperty.call(keys, status) ? keys[status] : null;
}

/**
 * Whether the catalog defines a key in the reader's language (or in English —
 * a key the French catalog lacks must still be recognised as *a* key, so a
 * display layer can fall back to its canonical English source instead of
 * printing the raw key).
 */
export function catalogHas(key: string): boolean {
  return key in CATALOGS[getLocale()] || key in CATALOGS.en;
}

/**
 * The catalog key for this note, or null when the note must be printed from its
 * English `detail`: nothing composed structured values into it, its code has no
 * key, or its `variant` is not one this module knows.
 */
export function seriesNoteKey(note: SeriesNote): string | null {
  const params = note.params;
  // No params ⇒ no structured values ⇒ nothing here can rebuild the sentence.
  if (!params) return null;
  const variants = VARIANT_KEY[note.code];
  if (variants) {
    const variant = params.variant;
    const key = typeof variant === 'string' ? variants[variant] : undefined;
    return key && catalogHas(key) ? key : null;
  }
  // An unsupported series needs its refusal clause translated too; without a
  // status there is no clause to translate.
  if (note.code === 'unsupported-series' && !refusalKey(params.status)) return null;
  const key = NOTE_KEY[note.code];
  return key && catalogHas(key) ? key : null;
}

/** The values the catalogued sentence interpolates, translated where they are prose. */
export function seriesNoteParams(note: SeriesNote, t: Translate): Record<string, string | number> {
  const params: Record<string, string | number> = { ...(note.params ?? {}) };
  if (note.code === 'unsupported-series') {
    const key = refusalKey(params.status);
    params.reason = key ? t(key) : '';
  }
  if (note.code === 'combined-series' && !params.point) {
    params.point = t(POINT_UNIDENTIFIED);
  }
  return params;
}

/**
 * The note, in the reader's language — or its canonical English `detail` when
 * no full translation is available. Never a raw key.
 */
export function seriesNoteText(note: SeriesNote, t: Translate): string {
  const key = seriesNoteKey(note);
  if (!key) return note.detail;
  return t(key, seriesNoteParams(note, t));
}

/* ==========================================================================
 * Aggregation of a repeated sentence (t_1d93a874)
 * ========================================================================== */

/**
 * The catalog key of the sentence that words a COLLAPSED group honestly.
 *
 * A per-series sentence names its series in `{label}`, and that slot is unique
 * per series — Mark's gas export rendered 23 volume sentences differing only
 * there, so grouping by the RENDERED text (t_8a9038d6) yielded 23 groups of 1
 * and the wall survived the first aggregation fix. Where the catalog can state
 * the same thing for N series at once, this table names that sentence, and
 * `seriesNoteGroupKey` then drops `{label}` from the group: every collapse is
 * paired with a line that SAYS "N series", never a silent one.
 *
 * Keyed by the note's SENTENCE key rather than its code, because a code can
 * word two sentences (`legacy-assumption`) and only one of them names a series.
 *
 * A sentence absent here keeps grouping by its full rendered text: identical
 * sentences still print once with ×N, and sentences that differ only by label
 * print in full rather than merging into a line that cannot word them.
 */
export const AGGREGATE_KEY: Partial<Record<string, string>> = {
  'gbseries.note.assumedDirection': 'gbseries.note.assumedDirectionMany',
  'gbseries.note.convertedToEnergy': 'gbseries.note.convertedToEnergyMany',
  'gbseries.note.legacyAssumptionNoUom': 'gbseries.note.legacyAssumptionNoUomMany',
  'gbseries.note.refusedReadings': 'gbseries.note.refusedReadingsMany',
  'gbseries.note.unlinkedReadingType': 'gbseries.note.unlinkedReadingTypeMany',
  'gbseries.note.unsupportedSeries': 'gbseries.note.unsupportedSeriesMany',
  'gbseries.note.volumeSeries': 'gbseries.note.volumeSeriesMany',
};

/** The aggregate sentence for this note's sentence, when the catalog has one. */
function aggregateKeyOf(note: SeriesNote): string | null {
  const key = seriesNoteKey(note);
  const aggregate = key ? AGGREGATE_KEY[key] : undefined;
  // A key the reader's catalog lacks is no key at all — `catalogHas` is the
  // same test `seriesNoteKey` applies, so grouping and painting can never
  // disagree about whether this sentence can be collapsed.
  return aggregate && catalogHas(aggregate) ? aggregate : null;
}

/**
 * The key a notice groups by.
 *
 * For a sentence the catalog can word for N series: the sentence key plus every
 * param EXCEPT `label` — so 23 series that say the same thing about different
 * series share one group, while a different uom, count, multiplier, variant or
 * refusal `status` still starts its own line (the VArh refusal and the gas
 * refusal never merge).
 *
 * Otherwise the rendered sentence itself: a note nothing composed structured
 * values into (`detail`), a code with no catalog key, and a sentence with no
 * aggregate form all behave exactly as before this card existed.
 */
export function seriesNoteGroupKey(note: SeriesNote, t: Translate): string {
  if (!aggregateKeyOf(note)) return seriesNoteText(note, t);
  const params = seriesNoteParams(note, t);
  const shared = Object.keys(params)
    .filter((name) => name !== 'label')
    .sort()
    .map((name) => [name, params[name]]);
  return `${seriesNoteKey(note)}|${JSON.stringify(shared)}`;
}

/**
 * The line a group of N > 1 prints — or `null` when the catalog has no honest
 * wording for that group, in which case the caller prints the group's own
 * sentence with its ×N count, exactly as before.
 *
 * `{n}` is the number of SERIES in the group; every other value is the group's
 * shared data (uom, count, multiplier, refusal status …). `label` is dropped:
 * the line speaks for all of them, and the raw disclosure still lists every
 * note — with its own label — in feed order.
 */
export function seriesNoteAggregateText(note: SeriesNote, n: number, t: Translate): string | null {
  const aggregate = aggregateKeyOf(note);
  if (!aggregate) return null;
  const params: Record<string, string | number> = { ...seriesNoteParams(note, t), n };
  delete params.label;
  return t(aggregate, params);
}
