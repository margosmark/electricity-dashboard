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
      headline: 'That file is empty.',
      detail: 'It contains no bytes at all.',
      hints: ['Download the export again from your utility portal and retry.'],
    };
  }

  // A page saved instead of the download is the single most common first-run
  // mistake, and it looks exactly like XML from the outside (it starts with
  // "<"), so sniff for it before any validation runs.
  if (/^<!doctype\s+html|^<html[\s>]/i.test(text)) {
    return {
      ok: false,
      headline: 'That looks like a web page, not an export.',
      detail:
        'The file starts with HTML. Portals often hand back a login or error page when the download link expires — the Green Button export itself was never saved.',
      hints: [
        'Sign in to your utility portal again and use the Green Button / “Download My Data” export action.',
        'The file you want is usually named *.xml and starts with “<?xml” or “<feed”.',
      ],
    };
  }

  if (!text.startsWith('<')) {
    const looksJson = text.startsWith('{') || text.startsWith('[');
    return {
      ok: false,
      headline: 'That file is not XML.',
      detail: `The file starts with “${text.slice(0, 40)}…”, which is not the “<” an XML export begins with.`,
      hints: [
        'Use the Green Button / “Download My Data” export from your utility portal (it produces an .xml file).',
        looksJson ? 'JSON exports are not supported — export XML.' : 'CSV and PDF downloads are not supported.',
      ],
    };
  }

  // Security refusal first: fast-xml-parser rejects external entities, and
  // saying so is far more useful than repeating its internal message.
  if (/<!ENTITY\b/i.test(text)) {
    return {
      ok: false,
      headline: 'This file declares XML external entities, which are not accepted.',
      detail:
        'The document contains a DOCTYPE with an <!ENTITY …> declaration. External entities are a known way to read files from the machine doing the parsing, so they are refused on purpose.',
      hints: [
        'Re-export the data from your utility portal — genuine Green Button files do not define entities.',
        'If this file came from somewhere else, treat it as untrusted and do not open it elsewhere either.',
      ],
    };
  }

  const validity = XMLValidator.validate(text);
  if (validity !== true) {
    const err = (validity as { err: { code?: string; msg?: string; line?: number } }).err;
    const where = err.line ? ` at line ${err.line}` : '';
    return {
      ok: false,
      headline: `The XML is not well-formed${where}.`,
      detail: err.msg ? `${err.msg}${where}.` : 'The file ended before its tags were balanced.',
      hints: [
        'Downloads sometimes get truncated — re-download the export and try again.',
        'If you edited the file by hand, restore the original.',
      ],
    };
  }

  const entries = countTag(text, 'entry');
  const readings = countTag(text, 'IntervalReading');
  const starts = countNumericStarts(text);

  if (readings === 0 && entries === 0) {
    return {
      ok: false,
      headline: 'No Green Button data found in this file.',
      detail: 'The XML is readable, but it has no <entry> sections and no <IntervalReading> elements — there is no meter data in it.',
      hints: [
        'Make sure you exported “Green Button Download My Data” (XML), not a bill, summary or usage chart.',
        'Some portals split the file by date range — export the full range and retry.',
      ],
    };
  }

  if (readings === 0 && entries > 0) {
    return {
      ok: false,
      headline: `Found ${entries} ${entries === 1 ? 'entry' : 'entries'}, but no interval readings inside them.`,
      detail:
        'Each <entry> should contain an <IntervalBlock> with <IntervalReading> elements (the actual meter readings). None were present — the export carried only metadata (usage point, meter, or summary information).',
      hints: [
        'Choose the export option that includes interval data (hourly or 15-minute readings).',
        'If the portal offers “summary” and “interval/detail” exports, pick interval/detail.',
      ],
    };
  }

  if (starts === 0 && readings > 0) {
    return {
      ok: false,
      headline: `Found ${readings} ${readings === 1 ? 'reading' : 'readings'}, but none of them has a timestamp.`,
      detail:
        'Every <IntervalReading> needs a <timePeriod><start>…</start></timePeriod> holding a Unix timestamp. Without it a reading cannot be placed on the timeline, so nothing can be imported.',
      hints: [
        'Re-download the export — this one lost its time period block.',
        'If the file was edited or converted, use the original download.',
      ],
    };
  }

  if (parsedReadings === 0) {
    // Structurally complete but the parser still produced nothing: keep the
    // door open with an honest message instead of a silent modal.
    return {
      ok: false,
      headline: 'This file looks like Green Button data but produced no readable rows.',
      detail: `The document has ${entries} ${entries === 1 ? 'entry' : 'entries'} and ${readings} ${readings === 1 ? 'reading' : 'readings'}, but none of them yielded a usable timestamp/value pair.`,
      hints: [
        'Try a different date range or a full export from your utility portal.',
        'If it keeps happening, re-download the file — this one may be truncated.',
      ],
    };
  }

  return { ok: true, entries, readings };
}
