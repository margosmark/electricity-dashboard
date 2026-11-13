/**
 * The picker's point heading → the words a person reads (t_203c6445).
 *
 * `lib/energy.ts` composes each UsagePoint group's label in English — the
 * parser has no locale — and both render sites (`UsagePointPicker`,
 * `MultiFileMerge`) painted it verbatim, so a French reader got the English
 * word `Meter` for a point the file never identified.
 *
 * These tests pin the two halves of the contract, the same way
 * `seriesNote.test.ts` does for the parser's sentences:
 *
 *   1. **The English catalog reproduces the lib's own label, byte for byte.**
 *      Every group a real parse emits must render back to its `label` in
 *      English — otherwise the English page silently changes wording while the
 *      English `label` (the value the picker printed, and what the libs' own
 *      tests assert) stops being what the user sees.
 *   2. **Every shape is translated, French is not English, and the fallback
 *      holds.** The two shapes are an identified point (`UsagePoint <id>`, id
 *      truncated exactly as the lib truncates it) and an unidentifiable one
 *      (`Meter` / `Compteur`); every key the module names exists in BOTH
 *      catalogs with different values; and a catalog missing the key prints the
 *      canonical English label rather than a raw key.
 *
 * The groups are built by PARSING a real ESPI document, never by hand: a
 * hand-built group proves nothing about what the parser emits.
 *
 * Run: `npx vitest run src/i18n/usagePointLabel.test.ts`
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POINT_LABEL_ID_LENGTH, parseGreenButtonFeed, type UsagePointGroup } from '@/lib/energy';
import { CATALOGS, getLocale, setLocale, t } from '@/i18n';
import {
  POINT_LABEL_KEY,
  POINT_LABEL_UNIDENTIFIED_KEY,
  usagePointLabel,
} from './usagePointLabel';
import en from './en.json';
import fr from './fr.json';

/* -------------------------------------------------------------------------- *
 * The document — the shapes a real feed can carry
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

function blk(start: number, value: number): string {
  return `<espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading></espi:IntervalBlock>`;
}

function pointPart(up: string, mr: string, rtId: string, spec: RtSpec, value: number, start: number): string[] {
  return [
    entry(`/ReadingType/${rtId}`, rt(spec)),
    entry(`/UsagePoint/${up}/MeterReading/${mr}`, '<espi:MeterReading/>', [`/ReadingType/${rtId}`]),
    entry(`/UsagePoint/${up}/MeterReading/${mr}/IntervalBlock/ib`, blk(start, value)),
  ];
}

const NT = 1790000000;

/**
 * Two identified meters, plus one the document never attributes to a
 * UsagePoint: the entry carries its own ReadingType and an IntervalBlock but no
 * `/UsagePoint/<id>/` link — the group the picker must word as `Meter`.
 */
const DOC = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${[
  ...pointPart('up-bravo', 'mr-b1', 'rt-b1', {}, 1500, NT),
  ...pointPart('up-delta', 'mr-c1', 'rt-c1', {}, 1000, NT),
  entry('/IntervalBlock/unidentified', `${rt({})}${blk(NT + 7200, 800)}`),
].join('')}</feed>`;

const GROUPS: UsagePointGroup[] = parseGreenButtonFeed(DOC).groups;

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/usage-summary-open-tail.xml',
);

afterEach(() => setLocale('en'));

/* -------------------------------------------------------------------------- *
 * The contract
 * -------------------------------------------------------------------------- */

describe('the document exercises both shapes the labeller must handle', () => {
  it('paints two identified points and one the feed never names', () => {
    // Or the rest of this file would prove nothing about one of them. Both ids
    // are short enough that the label's truncation is a no-op here — the
    // truncating case has its own test below.
    expect(GROUPS.map((g) => g.id)).toEqual(['up-bravo', 'up-delta', '']);
    expect(GROUPS.map((g) => g.label)).toEqual([
      'UsagePoint up-bravo',
      'UsagePoint up-delta',
      'Meter',
    ]);
  });
});

describe('the English catalog is the lib’s own label', () => {
  it('composes back to `label` byte for byte, for every group a real parse emits', () => {
    for (const g of GROUPS) {
      expect(usagePointLabel(g, t), g.id || '(no id)').toBe(g.label);
    }
  });

  it('holds for the shipped three-bill fixture the runtime gate uses', () => {
    const feed = parseGreenButtonFeed(fs.readFileSync(FIXTURE, 'utf8'));
    expect(feed.groups.length).toBeGreaterThan(0);
    for (const g of feed.groups) expect(usagePointLabel(g, t)).toBe(g.label);
  });

  it('shortens a long id exactly as the lib does — the truncation is real', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const g: UsagePointGroup = { id, label: 'whatever the lib said', readings: [], blocks: 0, series: [], notes: [] };
    // The lib's own composition, restated: the label is the first
    // POINT_LABEL_ID_LENGTH characters of the id, never the whole UUID.
    const fromLib = `UsagePoint ${id.slice(0, POINT_LABEL_ID_LENGTH)}`;
    expect(fromLib).toBe('UsagePoint aaaaaaaa');
    expect(usagePointLabel({ ...g, label: fromLib }, t)).toBe(fromLib);
  });
});

describe('French is composed, not printed', () => {
  it('renders every heading in French — no fallback to the English label', () => {
    setLocale('fr');
    const rendered = GROUPS.map((g) => usagePointLabel(g, t));
    expect(rendered).toEqual([
      'Point de consommation up-bravo',
      'Point de consommation up-delta',
      'Compteur',
    ]);
    for (const [i, g] of GROUPS.entries()) {
      expect(rendered[i], `${g.id || '(no id)'} kept the English label`).not.toBe(g.label);
      expect(rendered[i], `${g.id || '(no id)'} printed a raw key`).not.toMatch(/^gbseries\./);
    }
  });

  it('keeps the canonical UsagePoint id inside the French frame — it is data', () => {
    setLocale('fr');
    expect(usagePointLabel({ id: 'up-bravo', label: 'UsagePoint up-bravo' }, t)).toContain('up-bravo');
  });
});

describe('the module fails safe', () => {
  it('prints the canonical English label when the catalog lacks its key', () => {
    const saved = CATALOGS.en[POINT_LABEL_UNIDENTIFIED_KEY];
    delete CATALOGS.en[POINT_LABEL_UNIDENTIFIED_KEY];
    try {
      const g = { id: '', label: 'Meter' };
      expect(usagePointLabel(g, t)).toBe('Meter');
      expect(usagePointLabel(g, t)).not.toBe(POINT_LABEL_UNIDENTIFIED_KEY);
    } finally {
      CATALOGS.en[POINT_LABEL_UNIDENTIFIED_KEY] = saved;
    }
  });

  it('falls back in French too, rather than printing a raw key under lang="fr"', () => {
    setLocale('fr');
    const saved = CATALOGS.fr[POINT_LABEL_KEY];
    delete CATALOGS.fr[POINT_LABEL_KEY];
    try {
      // The English catalog still has it, so `catalogHas` sees a real key and
      // the translator answers from the English catalog — never the key text.
      expect(usagePointLabel({ id: 'up-bravo', label: 'UsagePoint up-bravo' }, t)).toBe(
        'UsagePoint up-bravo',
      );
    } finally {
      CATALOGS.fr[POINT_LABEL_KEY] = saved;
    }
    expect(getLocale()).toBe('fr');
  });
});

describe('the catalogs carry every key the module names', () => {
  it('defines each key in en and fr, and never leaves French identical to English', () => {
    for (const key of [POINT_LABEL_KEY, POINT_LABEL_UNIDENTIFIED_KEY]) {
      expect(en, `en is missing ${key}`).toHaveProperty(key);
      expect(fr, `fr is missing ${key}`).toHaveProperty(key);
      expect(fr[key as keyof typeof fr], `${key} is not translated`).not.toBe(
        en[key as keyof typeof en],
      );
    }
    // Both locales interpolate the same placeholder, and the fr heading names
    // the point in French rather than keeping the English frame.
    expect(en[POINT_LABEL_KEY as keyof typeof en]).toContain('{id}');
    expect(fr[POINT_LABEL_KEY as keyof typeof fr]).toContain('{id}');
    expect(fr[POINT_LABEL_KEY as keyof typeof fr]).toBe('Point de consommation {id}');
  });
});
