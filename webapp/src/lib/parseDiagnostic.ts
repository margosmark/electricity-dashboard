/**
 * Wave G item 4 — first-run parse diagnostics.
 *
 * "Invalid XML" tells a first-time user nothing. When an upload cannot be
 * turned into readings, this module says WHAT was missing (no entries, no
 * IntervalReadings, no <start> timestamps, an HTML page saved instead of the
 * export, a malformed tag with a line number) and what to do next.
 *
 * It deliberately inspects the RAW TEXT rather than re-running the parser, so
 * it can explain documents the parser refuses outright (external entities,
 * broken markup) instead of throwing the same way the parser did.
 */

import { XMLValidator } from 'fast-xml-parser';
/* Wave U — the diagnostics are shown in the upload modal, so they translate.
 * Lib code reads the module locale at call time (see I18N.md). */
import { t } from '@/i18n';

export type ParseDiagnostic =
  | { ok: true; entries: number; readings: number }
  | { ok: false; headline: string; detail: string; hints: string[] };

/** Count `<name>` / `<prefix:name>` openings, requiring a tag boundary. */
function countTag(text: string, name: string): number {
  const re = new RegExp(`<(?:\\w+:)?${name}(?=[\\s>/])`, 'gi');
  return (text.match(re) ?? []).length;
}

/** Readings whose `<start>` actually carries a number. */
function countNumericStarts(text: string): number {
  const re = /<(?:\w+:)?start>\s*-?\d+\s*<\/(?:\w+:)?start>/gi;
  return (text.match(re) ?? []).length;
}

/**
 * Explain why `xmlText` did not become a usable dataset — or, when the
 * document is structurally sound, report what it contained.
 *
 * `parsedReadings` is the count the real parser produced. Pass 0 when the
 * parser returned nothing despite (apparently) valid structure: that is the
 * case worth spelling out instead of leaving the modal blank.
 */
export function diagnoseGreenButtonDocument(xmlText: string, parsedReadings?: number): ParseDiagnostic {
  const text = xmlText.replace(/^\uFEFF/, '').trim();

  if (text === '') {
    return {
      ok: false,
      headline: t('diag.emptyHeadline'),
      detail: t('diag.emptyDetail'),
      hints: [t('diag.emptyHint')],
    };
  }

  // A page saved instead of the download is the single most common first-run
  // mistake, and it looks exactly like XML from the outside (it starts with
  // "<"), so sniff for it before any validation runs.
  if (/^<!doctype\s+html|^<html[\s>]/i.test(text)) {
    return {
      ok: false,
      headline: t('diag.htmlHeadline'),
      detail: t('diag.htmlDetail'),
      hints: [t('diag.htmlHint1'), t('diag.htmlHint2')],
    };
  }

  if (!text.startsWith('<')) {
    const looksJson = text.startsWith('{') || text.startsWith('[');
    return {
      ok: false,
      headline: t('diag.notXmlHeadline'),
      detail: t('diag.notXmlDetail', { head: text.slice(0, 40) }),
      hints: [
        t('diag.notXmlHint1'),
        looksJson ? t('diag.notXmlHintJson') : t('diag.notXmlHintOther'),
      ],
    };
  }

  // Security refusal first: fast-xml-parser rejects external entities, and
  // saying so is far more useful than repeating its internal message.
  if (/<!ENTITY\b/i.test(text)) {
    return {
      ok: false,
      headline: t('diag.entityHeadline'),
      detail: t('diag.entityDetail'),
      hints: [t('diag.entityHint1'), t('diag.entityHint2')],
    };
  }

  const validity = XMLValidator.validate(text);
  if (validity !== true) {
    const err = (validity as { err: { code?: string; msg?: string; line?: number } }).err;
    return {
      ok: false,
      headline: err.line
        ? t('diag.malformedHeadlineLine', { line: err.line })
        : t('diag.malformedHeadline'),
      detail: err.msg ? t('diag.malformedDetailMsg', { msg: err.msg }) : t('diag.malformedDetail'),
      hints: [t('diag.malformedHint1'), t('diag.malformedHint2')],
    };
  }

  const entries = countTag(text, 'entry');
  const readings = countTag(text, 'IntervalReading');
  const starts = countNumericStarts(text);

  if (readings === 0 && entries === 0) {
    return {
      ok: false,
      headline: t('diag.noDataHeadline'),
      detail: t('diag.noDataDetail'),
      hints: [t('diag.noDataHint1'), t('diag.noDataHint2')],
    };
  }

  if (readings === 0 && entries > 0) {
    return {
      ok: false,
      headline: t('diag.entriesHeadline', { count: entries }),
      detail: t('diag.entriesDetail'),
      hints: [t('diag.entriesHint1'), t('diag.entriesHint2')],
    };
  }

  if (starts === 0 && readings > 0) {
    return {
      ok: false,
      headline: t('diag.noTimeHeadline', { count: readings }),
      detail: t('diag.noTimeDetail'),
      hints: [t('diag.noTimeHint1'), t('diag.noTimeHint2')],
    };
  }

  if (parsedReadings === 0) {
    // Structurally complete but the parser still produced nothing: keep the
    // door open with an honest message instead of a silent modal.
    return {
      ok: false,
      headline: t('diag.noRowsHeadline'),
      detail: t('diag.noRowsDetail', { count: entries, readings }),
      hints: [t('diag.noRowsHint1'), t('diag.noRowsHint2')],
    };
  }

  return { ok: true, entries, readings };
}
