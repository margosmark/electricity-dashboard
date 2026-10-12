/**
 * `SeriesNote` → the sentence a person reads (t_12d39853).
 *
 * The ingestion composes its refusal sentences in English, inside the parser.
 * `SeriesNotesNotice` painted them verbatim on the dashboard, so a French page
 * showed an English sentence under a French heading. The fix moves the sentence
 * to the CATALOG, keyed by `note.code` + `params` (`src/i18n/seriesNote.ts`),
 * and keeps `SeriesNote.detail` as the canonical English source and fallback.
 *
 * These tests pin the two halves of that contract:
 *
 *   1. **The catalog reproduces the parser's own English, byte for byte.** Every
 *      note a real parse emits must compose back to its `detail` in English —
 *      otherwise the English page would silently change wording, and `detail`
 *      (the evidence qa reads, the string the refusal tests assert) would drift
 *      away from what the user sees.
 *   2. **Every code is translated, and French is not English.** Each note must
 *      render French in `fr`, with no fallback to `detail`, and every key the
 *      module names must exist in BOTH catalogs with different values.
 *
 * The notes are built by PARSING real ESPI documents (the same inline-fixture
 * style `series.test.ts` uses), never by hand: a hand-built note proves nothing
 * about what the parser emits.
 *
 * Run: `npx vitest run src/i18n/seriesNote.test.ts`
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGreenButtonFeed } from '@/lib/energy';
import { REFUSAL_REASON_KEY, type SeriesNote } from '@/lib/greenbutton/series';
import { CATALOGS, getLocale, setLocale, t } from '@/i18n';
import {
  NOTE_KEY,
  VARIANT_KEY,
  TRANSLATED_CODES,
  seriesNoteKey,
  seriesNoteText,
} from './seriesNote';
import en from './en.json';
import fr from './fr.json';

/* -------------------------------------------------------------------------- *
 * Inline ESPI documents — one per note code (and per variant)
 * -------------------------------------------------------------------------- */

type RtSpec = { uom?: number | null; mult?: number; commodity?: number; fd?: number | null; kind?: number; ab?: number };

function rt(spec: RtSpec): string {
  const el = (n: string, v: number) => `<espi:${n}>${v}</espi:${n}>`;
  return `<espi:ReadingType>${[
    spec.uom === null ? '' : el('uom', spec.uom ?? 72),
    el('powerOfTenMultiplier', spec.mult ?? 0),
    el('accumulationBehaviour', spec.ab ?? 4),
    el('commodity', spec.commodity ?? 1),
    spec.fd === null ? '' : el('flowDirection', spec.fd ?? 1),
    el('kind', spec.kind ?? 12),
    el('intervalLength', 3600),
  ].join('')}</espi:ReadingType>`;
}

function entry(self: string, body: string, related: string[] = []): string {
  return `<entry><link rel="self" href="${self}"/>${related
    .map((h) => `<link rel="related" href="${h}"/>`)
    .join('')}<content>${body}</content></entry>`;
}

function blk(start: number, value: number | string): string {
  return `<espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading></espi:IntervalBlock>`;
}

function pointPart(
  up: string,
  mr: string,
  rtId: string,
  spec: RtSpec,
  value: number | string,
  start: number,
  related = true,
): string[] {
  return [
    entry(`/ReadingType/${rtId}`, rt(spec)),
    entry(`/UsagePoint/${up}/MeterReading/${mr}`, '<espi:MeterReading/>', related ? [`/ReadingType/${rtId}`] : []),
    entry(`/UsagePoint/${up}/MeterReading/${mr}/IntervalBlock/ib`, blk(start, value)),
  ];
}

function doc(parts: (string | string[])[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${parts
    .flat()
    .join('')}</feed>`;
}

const T = 1790000000;

/** One document per refusal clause the classifier can produce. */
const REFUSAL_DOCS: Record<string, string> = {
  register: doc([pointPart('up-B', 'mr-B1', 'rt-reg', { ab: 1 }, 1000, T)]),
  spot: doc([pointPart('up-B', 'mr-B1', 'rt-spot', { ab: 6 }, 1000, T)]),
  otherCommodity: doc([pointPart('up-B', 'mr-B1', 'rt-gas', { commodity: 7 }, 1000, T)]),
  otherQuantity: doc([pointPart('up-B', 'mr-B1', 'rt-varh', { uom: 73, mult: 3 }, 1000, T)]),
  reverseFlow: doc([pointPart('up-B', 'mr-B1', 'rt-rev', { fd: 19 }, 1000, T)]),
  combinedFlow: doc([pointPart('up-B', 'mr-B1', 'rt-net', { fd: 4 }, 1000, T)]),
  // 5 is not in ESPI's interval/register/spot classes: "unconvertible".
  unconvertible: doc([pointPart('up-B', 'mr-B1', 'rt-unk', { ab: 5 }, 1000, T)]),
  // No ReadingType tied to the entry, although the document declares one.
  unresolvedReadingType: doc([
    entry('/ReadingType/rt-other', rt({ uom: 72 })),
    entry('/UsagePoint/up-B/MeterReading/mr-B1/IntervalBlock/ib', blk(T, 1000)),
  ]),
};

const OTHER_DOCS: Record<string, string> = {
  // Power with a duration: converted to energy with its own interval.
  convertedToEnergy: doc([pointPart('up-B', 'mr-B1', 'rt-pw', { uom: 38, kind: 37 }, 1000, T)]),
  // Nothing describes the readings at all: the legacy compatibility path.
  legacyDocumentWide: `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi"><entry><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${T}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${T}</espi:start></espi:timePeriod><espi:value>1000</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry></feed>`,
  // A ReadingType that declares no uom.
  legacyNoUom: doc([pointPart('up-B', 'mr-B1', 'rt-none', { uom: null }, 1000, T)]),
  // One ReadingType in the document, no link on the entry.
  unlinkedReadingType: doc([pointPart('up-B', 'mr-B1', 'rt-lone', {}, 1000, T, false)]),
  // No usable flowDirection.
  assumedDirection: doc([pointPart('up-B', 'mr-B1', 'rt-nofd', { fd: null }, 1000, T)]),
  // A reading the ingest refused (negative value).
  refusedReadings: doc([pointPart('up-B', 'mr-B1', 'rt-neg', {}, -5, T)]),
  // Several ReadingTypes inline with no per-block link.
  ambiguous: doc([
    entry(
      '/UsagePoint/up-X/MeterReading/mr-X/IntervalBlock/ib',
      `${rt({ uom: 72 })}${rt({ uom: 73 })}${blk(T, 1000)}`,
    ),
  ]),
  // One point publishing BOTH energy and interval-average power.
  combinedEnergyAndPower: doc([
    pointPart('up-B', 'mr-B1', 'rt-cons', {}, 1500, T),
    pointPart('up-B', 'mr-B2', 'rt-pw', { uom: 38, kind: 37 }, 1000, T),
  ]),
  // Two billable consumption series under one point.
  combinedConsumptionSeries: doc([
    pointPart('up-B', 'mr-B1', 'rt-c1', {}, 1500, T),
    pointPart('up-B', 'mr-B2', 'rt-c2', { uom: 72, mult: 3 }, 1000, T),
  ]),
};

/** Every note each document produces, parser-built — the app's real surface. */
function notesOf(xml: string): SeriesNote[] {
  const feed = parseGreenButtonFeed(xml);
  return [...feed.notes, ...feed.groups.flatMap((g) => g.notes)];
}

const ALL_NOTES = Object.entries({ ...REFUSAL_DOCS, ...OTHER_DOCS }).flatMap(([name, xml]) =>
  notesOf(xml).map((note) => ({ name, note })),
);

afterEach(() => setLocale('en'));

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/usage-summary-open-tail.xml',
);

/* -------------------------------------------------------------------------- *
 * The contract
 * -------------------------------------------------------------------------- */

describe('every note the parser emits carries the values its sentence needs', () => {
  it('covers every note code, with params', () => {
    const codes = new Set(ALL_NOTES.map(({ note }) => note.code));
    for (const code of codes) {
      expect(TRANSLATED_CODES, `no catalog mapping for ${code}`).toContain(code);
    }
    // The battery has to exercise the whole family, or this test is vacuous.
    expect([...codes].sort()).toEqual(
      [
        'ambiguous-inline-reading-types',
        'assumed-direction',
        'combined-series',
        'converted-to-energy',
        'legacy-assumption',
        'refused-readings',
        'unlinked-reading-type',
        'unsupported-series',
      ].sort(),
    );
    for (const { name, note } of ALL_NOTES) {
      expect(note.params, `${name}: ${note.code} carries no params`).toBeTruthy();
      expect(seriesNoteKey(note), `${name}: ${note.code} has no key`).toBeTruthy();
    }
    // Both variants of the two two-sentence codes are exercised.
    const variants = new Set(ALL_NOTES.map(({ note }) => String(note.params?.variant ?? '')));
    expect(variants).toContain('energy-and-power');
    expect(variants).toContain('several-series');
    expect(variants).toContain('no-uom');
  });
});

describe('the English catalog is the parser’s own sentence', () => {
  it('composes back to `detail` byte for byte, for every note', () => {
    for (const { name, note } of ALL_NOTES) {
      expect(seriesNoteText(note, t), `${name}: ${note.code}`).toBe(note.detail);
    }
  });

  it('holds for the shipped three-bill fixture the runtime gate uses', () => {
    const feed = parseGreenButtonFeed(fs.readFileSync(FIXTURE, 'utf8'));
    expect(feed.notes.length).toBeGreaterThan(0);
    for (const note of feed.notes) expect(seriesNoteText(note, t)).toBe(note.detail);
  });
});

describe('French is composed, not printed', () => {
  it('renders every note in French — no fallback to the English detail', () => {
    setLocale('fr');
    for (const { name, note } of ALL_NOTES) {
      const text = seriesNoteText(note, t);
      expect(text, `${name}: ${note.code} fell back to detail`).not.toBe(note.detail);
      // A raw key would mean the catalog is missing what the module names.
      expect(text, `${name}: ${note.code} printed a raw key`).not.toMatch(/^gbseries\./);
    }
  });
});

describe('the module fails safe', () => {
  const noteWith = (params?: SeriesNote['params'], code: SeriesNote['code'] = 'unsupported-series') =>
    ({ code, detail: 'the parser’s own English sentence', seriesKey: 'k', params }) as SeriesNote;

  it('prints `detail` for a note nothing composed structured values into', () => {
    const note = noteWith(undefined);
    expect(seriesNoteKey(note)).toBeNull();
    expect(seriesNoteText(note, t)).toBe(note.detail);
  });

  it('prints `detail` for a variant it does not know, never the wrong sentence', () => {
    setLocale('fr');
    const note = noteWith({ variant: 'invented-later' }, 'legacy-assumption');
    expect(seriesNoteKey(note)).toBeNull();
    expect(seriesNoteText(note, t)).toBe(note.detail);
  });

  it('prints `detail` for an unsupported series with no known refusal status', () => {
    const note = noteWith({ label: 'x', status: 'brand-new-status' });
    expect(seriesNoteKey(note)).toBeNull();
    expect(seriesNoteText(note, t)).toBe(note.detail);
  });
});

describe('the catalogs carry every key the module names', () => {
  it('defines each key in en and fr, and never leaves French identical to English', () => {
    const keys = [
      ...Object.values(NOTE_KEY),
      ...Object.values(VARIANT_KEY).flatMap((v) => Object.values(v)),
      'gbseries.pointUnidentified',
      ...Object.values(REFUSAL_REASON_KEY),
    ] as string[];
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      expect(en, `en is missing ${key}`).toHaveProperty(key);
      expect(fr, `fr is missing ${key}`).toHaveProperty(key);
      expect(fr[key as keyof typeof fr], `${key} is not translated`).not.toBe(en[key as keyof typeof en]);
    }
  });

  it('names the refusal clause of every refusal status', () => {
    const statuses = [
      'register', 'spot', 'other-commodity', 'other-quantity',
      'reverse-flow', 'combined-flow', 'unconvertible', 'unresolved-reading-type',
    ];
    expect(Object.keys(REFUSAL_REASON_KEY).sort()).toEqual(statuses.sort());
    for (const status of statuses) {
      expect(fr[REFUSAL_REASON_KEY[status as keyof typeof REFUSAL_REASON_KEY] as keyof typeof fr]).toBeTruthy();
    }
  });

  it('renders the clause of EVERY status — the battery leaves none unexercised', () => {
    const seen = new Set(
      ALL_NOTES.filter(({ note }) => note.code === 'unsupported-series').map(({ note }) =>
        String(note.params?.status ?? ''),
      ),
    );
    expect([...seen].sort()).toEqual(Object.keys(REFUSAL_REASON_KEY).sort());
    setLocale('fr');
    for (const { name, note } of ALL_NOTES) {
      if (note.code !== 'unsupported-series') continue;
      const status = String(note.params?.status);
      expect(seriesNoteText(note, t), `${name}: ${status} kept an English clause`).toContain(
        t(REFUSAL_REASON_KEY[status as keyof typeof REFUSAL_REASON_KEY]),
      );
    }
  });

  it('is read through the live catalog, not a copy', () => {
    expect(CATALOGS[getLocale()]).toBe(en);
    expect(Object.keys(CATALOGS.fr).length).toBe(Object.keys(en).length);
  });
});
