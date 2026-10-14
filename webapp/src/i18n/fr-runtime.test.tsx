/**
 * The i18n RUNTIME gate — the half of the French contract no static gate can
 * reach.
 *
 * Wave U's catalogs are complete and `i18n.test.tsx` pins them against each
 * other; the coverage gate catches a hardcoded literal; `money-contract`
 * catches a hand-built number. None of them can see the deployed defect qa
 * measured on tip 7ee0375: **strings that ARE in `en.json` render untranslated
 * under `lang="fr"`**, because the text is produced inside a `useMemo` that
 * reads the module locale and never re-derives when the locale changes, or is
 * printed from a canonical constant instead of the display-layer label.
 *
 * Three rules, each of which was a real defect on that build:
 *
 *   1. **Parity.** No text node painted in French may be an `en.json` value
 *      whose `fr.json` value differs — the catalog HAS a French rendering and
 *      the page is not showing it.
 *   2. **No raw keys.** `t()` degrades to printing its key, so a painted
 *      `accrual.measuredLine` is an untranslated string in both locales.
 *   3. **No English prose.** Composed sentences that never reached the catalog
 *      (`4h in the same slot 5/5 weeks, flat across every hour (±3%)`) are
 *      caught by vocabulary: a word that appears in the English catalog and
 *      NEVER in the French one is English-only. Words that belong to the
 * utility's own data (bill line names, meter-read notes) and to canonical
 * codes (plan ids, units) are exempt — but a bill line name the CATALOG now
 * carries a localized view of is NOT exempt: the panel renders it through
 * `billNoteText`, so it must paint French like any other label (t_0a96fd14).
 * The fixture's own notes are read out of the file, so the exemption cannot
 * silently grow.
 *
 * BOTH user paths are walked, because they fail differently:
 *
 *   • `cold`  — the stored locale is already French before the first render.
 *     Catches step 2 + step 3 (an unwired label prints English forever).
 *   • `flip` — English first, then the toggle (the real
 *     `I18nProvider` -> `restoreStoredLocale` path). Catches step 1: a memo
 *     that cached last language's text. `src/i18n/locale-deps.test.ts` is the
 *     authoring-time half of the same rule.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Dashboard from '@/components/Dashboard';
import SeriesNotesNotice from '@/components/SeriesNotesNotice';
import { UsagePointPicker } from '@/components/UsagePointPicker';
import MultiFileMerge, { type MergeFileChoice } from '@/components/MultiFileMerge';
import { fmtDate, getLocale, setLocale } from '@/i18n';
import { parseGreenButtonFeed, type DataPoint, type UsagePointGroup } from '@/lib/energy';
import { UnitMultiplierKind, UnitSymbolKind } from '@/lib/greenbutton/espiUnits';
import { ENERGY_KEY_V2, BILLING_DAY_KEY } from '@/lib/storage';
import { USAGE_SUMMARIES_KEY, LOCAL_TIME_KEY } from '@/hooks/useDashboard';
import { TAB_STORAGE_KEY } from '@/lib/tabs';
import en from './en.json';
import fr from './fr.json';
import { billNoteKey } from './billNote';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const XML = fs.readFileSync(path.join(FIXTURES, 'usage-summary-open-tail.xml'), 'utf8');
const FEED = parseGreenButtonFeed(XML);
const POINTS = FEED.groups.flatMap((g) => g.readings);

const RATES = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
    },
  ],
};

/** Every tab, so the sweep covers every surface the app paints. */
const TABS = ['overview', 'plans', 'money'] as const;

/* -------------------------------------------------------------------------- *
 * The vocabulary
 * -------------------------------------------------------------------------- */

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const words = (s: string) => (s.match(/[A-Za-z][A-Za-z'’-]+/g) ?? []).map((w) => w.toLowerCase());

/** Every word the French catalog uses, anywhere, plus the French month and
 *  weekday vocabulary the app's own date formatter produces — a French
 *  "20 sept. 2026" is French even though the catalog never spells `sept`. */
const FRENCH_VOCAB = new Set<string>();
for (const v of Object.values(fr as Record<string, string>)) {
  for (const w of words(v)) FRENCH_VOCAB.add(w);
}
setLocale('fr');
for (let month = 0; month < 12; month++) {
  for (const pattern of ['MMM', 'MMMM', 'MMM yyyy', 'd MMM yyyy', 'EEEE', 'EEE']) {
    for (const w of words(fmtDate(new Date(2026, month, 2), pattern))) FRENCH_VOCAB.add(w);
  }
}
for (let day = 0; day < 7; day++) {
  for (const pattern of ['EEEE', 'EEE', 'EEEE d MMMM yyyy']) {
    for (const w of words(fmtDate(new Date(2026, 2, 1 + day), pattern))) FRENCH_VOCAB.add(w);
  }
}
setLocale('en');

/** A word the English catalog uses and the French one never does. */
function englishOnly(word: string): boolean {
  return !FRENCH_VOCAB.has(word.toLowerCase());
}

/**
 * Canonical codes and units: the same glyph in both languages, so a French
 * page may legitimately print them (I18N.md's "deliberately NOT translated").
 */
const CANONICAL_WORDS = new Set([
  ...['kwh', 'kw', 'w', 'cad', '$', '%', 'ulo', 'tou', 'tiered', 'hst', 'tvh', 'fr', 'en', 'vs'],
  // The active-plan chip and the switch timeline legend print the plan CODE,
  // which is the id the file, the storage and the classifier all use.
  ...['tier', 'oeb', 'c', 'h', 'mo', 'yr', 'an', 'kwh/mo', 'kwh/an'],
  // …and the ESPI vocabulary the ingestion prints INSIDE its own sentences: the
  // unit symbol and multiplier name `uomName()`/`multiplierName()` read off the
  // ReadingType ("VArh (uom 73)", "k (10^3)"), plus the schema's `uom` field
  // name. Imported from the module that prints them, so this cannot drift into
  // an exemption for English prose — a unit is a canonical glyph, a sentence is
  // not (t_12d39853).
  ...Object.values(UnitSymbolKind).flatMap((s) => words(String(s))),
  ...Object.values(UnitMultiplierKind).flatMap((s) => words(String(s))),
  'uom',
]);

/**
 * The utility's own vocabulary, read out of the fixture: every `<note>` on
 * every bill line, plus the meter-read labels. These are the file's data —
 * and the coverage gate's own canonical-data rule (I18N.md) — for as long as
 * the app has no localized view of them.
 */
const DATA_VOCAB = new Set<string>();
const DATA_NOTES = new Set<string>();
for (const summary of FEED.summaries) {
  for (const item of summary.items) {
    DATA_NOTES.add(tidy(item.note));
    for (const w of words(item.note)) DATA_VOCAB.add(w);
  }
}

/** Words a French page may print because they are data or canonical codes. */
const exemptWord = (w: string, extra?: ReadonlySet<string>) =>
  CANONICAL_WORDS.has(w.toLowerCase()) ||
  DATA_VOCAB.has(w.toLowerCase()) ||
  (extra?.has(w.toLowerCase()) ?? false);

/* -------------------------------------------------------------------------- *
 * The detector
 * -------------------------------------------------------------------------- */

export type Node = { where: string; text: string };
export type Hit = { rule: 'parity' | 'raw-key' | 'english'; text: string; detail: string };

/** en.json values whose French rendering differs — the parity index. */
const EN_BY_VALUE = new Map<string, string[]>();
for (const [key, value] of Object.entries(en as Record<string, string>)) {
  if ((fr as Record<string, string>)[key] === value) continue; // legitimately identical
  const t = tidy(value);
  if (!EN_BY_VALUE.has(t)) EN_BY_VALUE.set(t, []);
  EN_BY_VALUE.get(t)!.push(key);
  // A value that interpolates something (a `{placeholder}`, a number) never
  // equals the node it paints, so the template is indexed in its MASKED form
  // too — the same trick `evidence/money-locale-verify.cjs` uses to recognise
  // a sentence that is still English on a French page. Without it a row like
  // the H.S.T. line (whose name carries the utility's registration number)
  // could keep painting English under a French catalog and stay invisible.
  const m = maskValues(t);
  if (m !== t) {
    if (!EN_BY_VALUE.has(m)) EN_BY_VALUE.set(m, []);
    EN_BY_VALUE.get(m)!.push(key);
  }
}

/** Digits and `{placeholders}` → `#`, so a painted string matches its template. */
function maskValues(s: string): string {
  return s.replace(/\{\w+\}/g, '#').replace(/\d[\d.,\u00a0\u202f]*/g, '#');
}

const CATALOG_KEYS = new Set(Object.keys(en as Record<string, string>));
const RAW_KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/;

/** Every rendered text node, with a short label for the failure report. */
export function textNodes(root: HTMLElement): Node[] {
  const out: Node[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = tidy(node.textContent ?? '');
      if (!text) continue;
      out.push({ where: el.tagName.toLowerCase() + (el.getAttribute('data-testid') ?? ''), text });
    }
  }
  return out;
}

/** The three rules, applied to whatever is mounted. */
export function sweep(frRoot: HTMLElement, extraVocab?: ReadonlySet<string>): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of textNodes(frRoot)) {
    // The utility's own line name, printed verbatim: data, not chrome — but
    // ONLY while this app has no localized view of it. A name the display layer
    // translates (`billNoteText`, t_0a96fd14) must paint the translation, so
    // the exemption cannot quietly cover a row the panel forgot to translate.
    if (DATA_NOTES.has(text) && billNoteKey(text) === null) continue;
    const key = EN_BY_VALUE.get(text) ?? EN_BY_VALUE.get(maskValues(text));
    if (key) {
      hits.push({
        rule: 'parity',
        text,
        detail: `${where}: fr.json translates ${key.slice(0, 3).join(', ')} — the page kept the English value`,
      });
      continue;
    }
    if (RAW_KEY.test(text) && (CATALOG_KEYS.has(text) || CATALOG_KEYS.has(`${text}_other`))) {
      hits.push({ rule: 'raw-key', text, detail: `${where}: t() fell through to the key` });
      continue;
    }
    const english = words(text).filter(
      (w) => w.length >= 3 && englishOnly(w) && !exemptWord(w, extraVocab),
    );
    if (english.length > 0) {
      hits.push({ rule: 'english', text, detail: `${where}: English-only word(s) ${[...new Set(english)].join(', ')}` });
    }
  }
  return hits;
}

const describeHits = (hits: Hit[]) =>
  hits.map((h) => `[${h.rule}] ${JSON.stringify(h.text.slice(0, 110))}\n      ${h.detail}`).join('\n    ');

/* -------------------------------------------------------------------------- *
 * The fixture-backed page
 * -------------------------------------------------------------------------- */

function seed(): void {
  const store: Record<string, string> = {
    [ENERGY_KEY_V2]: JSON.stringify({
      version: 2,
      uploadedAt: '2026-01-01T00:00:00Z',
      source: 'usage-summary-open-tail.xml',
      points: POINTS,
    }),
    [USAGE_SUMMARIES_KEY]: JSON.stringify(FEED.summaries),
    [BILLING_DAY_KEY]: '1',
    [TAB_STORAGE_KEY]: 'overview',
    oeo_locale: 'en',
  };
  if (FEED.localTime) store[LOCAL_TIME_KEY] = JSON.stringify(FEED.localTime);
  Storage.prototype.getItem = vi.fn((key: string) => store[key] ?? null);
  Storage.prototype.setItem = vi.fn();
  Storage.prototype.removeItem = vi.fn();
}

async function ready(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (document.querySelector('[data-testid="totals-strip"]')) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
  }
  throw new Error('the dashboard never painted — the sweep would be vacuous');
}

async function visitTabs(user: ReturnType<typeof userEvent.setup>) {
  for (const tab of TABS) {
    await user.click(screen.getByTestId(`tab-${tab}`));
    // A sweep over an empty page proves nothing.
    expect((document.body.textContent ?? '').length, `${tab} painted nothing`).toBeGreaterThan(400);
  }
}

beforeEach(() => {
  seed();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(RATES) }),
  );
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('the fr-CA page the fixture paints', () => {
  it('cold: the stored French locale paints French on every tab', async () => {
    setLocale('fr');
    const user = userEvent.setup();
    const { container } = render(<Dashboard />);
    await ready();
    await visitTabs(user);
    expect(getLocale()).toBe('fr');

    const failures: string[] = [];
    for (const tab of TABS) {
      await user.click(screen.getByTestId(`tab-${tab}`));
      failures.push(...sweep(container).map((h) => `${tab} — ${describeHits([h])}`));
    }
    expect(
      failures,
      failures.length === 0
        ? ''
        : `\nUntranslated text on the ${'fr'}-CA page (stored locale):\n\n    ${failures.join('\n    ')}\n\n` +
          'Fix: put the sentence in src/i18n/areas/<area>.json (en + fr), run\n' +
          '`node scripts/i18n-merge.mjs`, and render it with t() — or, if the value is\n' +
          'data the file itself carries, say so in I18N.md canonical list AND in the\n' +
          'exemption sets at the top of this file.\n',
    ).toEqual([]);
  }, 120_000);

  it('flip: the locale toggle re-derives every memo', async () => {
    setLocale('en');
    const user = userEvent.setup();
    const { container } = render(<Dashboard />);
    await ready();
    // Visit every tab in English FIRST: a memo that caches prose is only
    // caught once its English result already exists.
    await visitTabs(user);
    await user.click(screen.getByTestId('tab-overview'));

    // The user's own path: the toggle, not a direct setLocale().
    await user.click(screen.getByTestId('locale-toggle'));
    expect(getLocale()).toBe('fr');
    expect(screen.getByTestId('locale-toggle')).toHaveAttribute('data-locale', 'fr');

    const failures: string[] = [];
    for (const tab of TABS) {
      await user.click(screen.getByTestId(`tab-${tab}`));
      failures.push(...sweep(container).map((h) => `${tab} — ${describeHits([h])}`));
    }
    expect(
      failures,
      failures.length === 0
        ? ''
        : `\nText that stayed English after the toggle:\n\n    ${failures.join('\n    ')}\n\n` +
          'Fix: the memo that produced it must list `t` (or `locale`) in its deps —\n' +
          '`node scripts/i18n-locale-deps.mjs` names it.\n',
    ).toEqual([]);
  }, 120_000);

  it('sensitivity: on the SAME page in English the parity rule fires, so a clean French sweep means something', async () => {
    setLocale('en');
    const user = userEvent.setup();
    const { container } = render(<Dashboard />);
    await ready();
    const parity = new Set<string>();
    for (const tab of TABS) {
      await user.click(screen.getByTestId(`tab-${tab}`));
      for (const h of sweep(container)) if (h.rule === 'parity') parity.add(h.text);
    }
    // The English page IS the English catalog rendered: the detector has to
    // see it, or the French runs above were passing for the wrong reason.
    expect(parity.size).toBeGreaterThan(30);
  }, 120_000);
});

/* -------------------------------------------------------------------------- *
 * The refusal notice — the surface #91 added, and the one that shipped an
 * English sentence inside French chrome (t_12d39853).
 *
 * The notice paints `SeriesNote`s the PARSER composes in English. The dashboard
 * sweep above never reaches it: the notice only exists after an import commits,
 * and the fixture is seeded straight into storage. These tests mount the same
 * component with the notes a real parse produces, so the class cannot come back
 * through the sibling sentences either.
 * -------------------------------------------------------------------------- */

type RtSpec = { uom?: number | null; mult?: number; commodity?: number; fd?: number | null; kind?: number; ab?: number };

function noticeRt(spec: RtSpec): string {
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

function noticeEntry(self: string, body: string, related: string[] = []): string {
  return `<entry><link rel="self" href="${self}"/>${related
    .map((h) => `<link rel="related" href="${h}"/>`)
    .join('')}<content>${body}</content></entry>`;
}

function noticeBlock(start: number, value: number | string): string {
  return `<espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading></espi:IntervalBlock>`;
}

const NT = 1790000000;

function noticePoint(up: string, mr: string, rtId: string, spec: RtSpec, value: number, related = true, start = NT): string[] {
  return [
    noticeEntry(`/ReadingType/${rtId}`, noticeRt(spec)),
    noticeEntry(`/UsagePoint/${up}/MeterReading/${mr}`, '<espi:MeterReading/>', related ? [`/ReadingType/${rtId}`] : []),
    noticeEntry(`/UsagePoint/${up}/MeterReading/${mr}/IntervalBlock/ib`, noticeBlock(start, value)),
  ];
}

function noticeDoc(parts: (string | string[])[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${parts
    .flat()
    .join('')}</feed>`;
}

/** One document per sentence the ingestion can put in the notice. */
const NOTICE_DOCS: Record<string, string> = {
  unsupportedReactive: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-varh', { uom: 73, mult: 3 }, 4000)]),
  unsupportedGas: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-gas', { commodity: 7 }, 1000)]),
  unsupportedRegister: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-reg', { ab: 1 }, 1000)]),
  unsupportedReverse: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-rev', { fd: 19 }, 1000)]),
  convertedPower: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-pw', { uom: 38, kind: 37 }, 1000)]),
  refusedReading: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-neg', {}, -5)]),
  assumedDirection: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-nofd', { fd: null }, 1000)]),
  unlinkedReadingType: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-lone', {}, 1000, false)]),
  legacyNoUom: noticeDoc([noticePoint('up-B', 'mr-B1', 'rt-none', { uom: null }, 1000)]),
  // One point repeating the same consumption at two sizes: the
  // duplicate-resolution sentence (t_1fca89fa).
  duplicateResolution: noticeDoc([
    noticePoint('up-B', 'mr-B1', 'rt-cons', {}, 1500),
    noticePoint('up-B', 'mr-B2', 'rt-c2', { mult: 3 }, 1000),
  ]),
  // …and two consumption series over DIFFERENT hours, which are additive, so
  // the group says it combined them.
  combinedSeriesDisjoint: noticeDoc([
    noticePoint('up-B', 'mr-B1', 'rt-cons', {}, 1500),
    noticePoint('up-B', 'mr-B2', 'rt-c2', { mult: 3 }, 1000, true, NT + 3600),
  ]),
  ambiguousInline: noticeDoc([
    noticeEntry(
      '/UsagePoint/up-X/MeterReading/mr-X/IntervalBlock/ib',
      `${noticeRt({ uom: 72 })}${noticeRt({ uom: 73 })}${noticeBlock(NT, 1000)}`,
    ),
  ]),
};

/** Every note a real parse puts on the screen — the fixture's own, plus each sibling. */
const NOTICE_NOTES = [
  ...FEED.notes,
  ...Object.values(NOTICE_DOCS).flatMap((xml) => parseGreenButtonFeed(xml).notes),
];

/**
 * The FILE'S OWN series identity, read out of the documents this sweep paints
 * (`up-B · mr-B1 · Wh (uom 72)`) — the same rule as the bill line notes above,
 * and it applies to THIS sweep only.
 *
 * A meter id, a ReadingType id and the unit the file declared are the file's
 * data: a French sentence may quote them verbatim, exactly as the
 * "every line item as the utility wrote it" panel does. The sentence AROUND
 * them is chrome, and stays subject to all three rules — which is why this
 * vocabulary is passed in per-sweep rather than added to the global sets, and
 * why the identity is read from the parse instead of hand-listed.
 */
function identityVocab(docs: string[]): Set<string> {
  const out = new Set<string>();
  for (const xml of docs) {
    for (const g of parseGreenButtonFeed(xml).groups) {
      for (const s of g.series) for (const w of words(s.label)) out.add(w.toLowerCase());
    }
  }
  return out;
}

const NOTICE_IDENTITY = identityVocab([XML, ...Object.values(NOTICE_DOCS)]);

/**
 * Mount the notice alone. No `I18nProvider`: it restores the STORED locale in
 * an effect, and this file's `seed()` pins that to `en` for the dashboard — so
 * these tests drive `setLocale` directly, exactly as the sweeps above do.
 */
const paintNotice = (notes: typeof NOTICE_NOTES) =>
  render(<SeriesNotesNotice notes={notes} onDismiss={() => {}} />);

describe('the refusal notice on the French page', () => {
  it('cold: every refusal the parser can word is painted in French', () => {
    setLocale('fr');
    const { container } = paintNotice(NOTICE_NOTES);

    // The notice is really on the page (one bullet per refusal), and it carries
    // the sentence the deployed build shipped in English.
    const bullets = screen.getAllByTestId('series-note-detail').map((n) => n.textContent ?? '');
    expect(bullets.length).toBe(NOTICE_NOTES.length);
    expect(bullets.length).toBeGreaterThanOrEqual(12);
    expect(bullets.some((b) => b.startsWith('Aucun ReadingType ne décrivait'))).toBe(true);

    expect(sweep(container, NOTICE_IDENTITY)).toEqual([]);
  }, 60_000);

  it('flip: the toggle re-paints the notice, it does not keep the English it started with', async () => {
    setLocale('en');
    const { container } = paintNotice(NOTICE_NOTES);
    const english = screen.getAllByTestId('series-note-detail').map((n) => n.textContent ?? '');
    // The English page IS the catalog rendered — the detector has to see it.
    expect(sweep(container, NOTICE_IDENTITY).map((h) => h.rule)).toContain('parity');

    await act(async () => setLocale('fr'));
    const french = screen.getAllByTestId('series-note-detail').map((n) => n.textContent ?? '');
    expect(french).not.toEqual(english);
    expect(sweep(container, NOTICE_IDENTITY)).toEqual([]);
  }, 60_000);

  it('sensitivity: the ENGLISH detail this card was filed about is what the rule catches', () => {
    // The exact sentence qa found painted on the live fr page (7fadf53). Nothing
    // about the identity exemption may let it through: the sentence is chrome.
    const host = document.createElement('div');
    host.innerHTML =
      '<li>No ReadingType described 2856 reading(s), so they were read as watt-hours scaled by the document-wide multiplier — the legacy compatibility path. The timestamps are exact; the unit is an assumption, not a declaration.</li>';
    document.body.appendChild(host);
    const hits = sweep(host, NOTICE_IDENTITY);
    // Caught as PARITY, not by vocabulary: since t_0a96fd14 the parity index
    // also carries each English value's MASKED template (this sentence
    // interpolates `2856`, so it is a template, not a literal catalog value),
    // which lets the sweep name the key the page should have painted. Either
    // rule failing the node is the point — the vocabulary rule keeps its own
    // planted sentence in the 'planted failures' block below.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.rule)).toContain('parity');
  });
});

/* -------------------------------------------------------------------------- *
 * The UsagePoint picker — the heading is composed in the LIB, and nothing in
 * the battery had ever painted this component (t_203c6445).
 *
 * `lib/energy.ts` words each group's label in English — `UsagePoint <id>` for a
 * point the feed identifies, `Meter` for one it never does — because the parser
 * has no locale. The dashboard sweep above cannot see it: that fixture is a
 * single-UsagePoint file, so the picker never renders (it only exists for 2+
 * groups, and then only after an import is pending). The notice sweep mounts
 * the notice alone. So a French reader read the English word `Meter`, and no
 * gate could have said so.
 *
 * These tests mount the picker on a real parse of a document carrying two
 * identified meters AND one the feed never attributes to a UsagePoint, and
 * sweep it in both locale paths.
 * -------------------------------------------------------------------------- */

/** Two identified points, plus one the document gives no UsagePoint at all. */
const PICKER_DOC = noticeDoc([
  noticePoint('up-bravo', 'mr-b1', 'rt-b1', {}, 1500),
  noticePoint('up-delta', 'mr-c1', 'rt-c1', {}, 1000),
  noticeEntry('/IntervalBlock/unidentified', `${noticeRt({})}${noticeBlock(NT + 7200, 800)}`),
]);
const PICKER_FILE = 'oakville-export.xml';
const PICKER_GROUPS = parseGreenButtonFeed(PICKER_DOC).groups;

/**
 * The file's own identity as THIS dialog prints it: the UsagePoint ids read out
 * of the document (through the same `identityVocab` the notice sweep uses — the
 * id is the file's data, and the picker prints it twice: inside the heading and
 * on the row underneath it) plus the name the user's file carries, which the
 * picker prints verbatim exactly as the bill panel prints the utility's own
 * line notes.
 *
 * Per-sweep, never the global sets: `Meter` must stay subject to all three
 * rules, which is the whole point of this sweep.
 */
const PICKER_IDENTITY = new Set<string>([
  ...identityVocab([PICKER_DOC]),
  ...words(PICKER_FILE).map((w) => w.toLowerCase()),
]);

const paintPicker = () =>
  render(
    <UsagePointPicker
      fileName={PICKER_FILE}
      groups={PICKER_GROUPS}
      onChoose={() => {}}
      onCancel={() => {}}
    />,
  );

describe('the UsagePoint picker on the French page', () => {
  it('cold: the point headings the parser composed are painted in French', () => {
    setLocale('fr');
    const { container } = paintPicker();

    // The picker really painted one row per point, including the one the feed
    // never named — a sweep over an empty dialog proves nothing.
    expect(PICKER_GROUPS.length).toBe(3);
    expect(container.textContent).toContain('Point de consommation up-bravo');
    expect(container.textContent).toContain('Compteur');
    // …and the defect's own wording is gone: no English frame around the id.
    expect(container.textContent).not.toContain('UsagePoint up-bravo');

    expect(sweep(container, PICKER_IDENTITY)).toEqual([]);
  }, 60_000);

  it('flip: the toggle re-paints the headings, it does not keep the English it started with', async () => {
    setLocale('en');
    const { container } = paintPicker();
    expect(container.textContent).toContain('Meter');
    expect(container.textContent).toContain('UsagePoint up-bravo');
    // The English page IS the English catalog rendered — the detector has to
    // see it, or a clean French sweep below means nothing.
    expect(sweep(container, PICKER_IDENTITY).map((h) => h.rule)).toContain('parity');

    await act(async () => setLocale('fr'));
    expect(container.textContent).toContain('Compteur');
    expect(container.textContent).not.toContain('Meter');
    expect(sweep(container, PICKER_IDENTITY)).toEqual([]);
  }, 60_000);

  it('sensitivity: the English heading is caught through the CATALOG, not the vocabulary rule', () => {
    // The heading the parser composed for a point the feed never named, as the
    // pre-fix build painted it.
    //
    // Measured, and worth knowing: the `english` vocabulary rule CANNOT see
    // this word. The fixture's own bill lines say "Current Meter Read", so
    // `meter` is in the data vocabulary this sweep exempts (the utility's own
    // wording, read out of the file) — which is exactly why `Meter` could sit
    // on the French page unexplained. What catches it is the PARITY rule: with
    // `gbseries.point.unidentified` in the catalog, the heading IS an `en.json`
    // value whose `fr.json` value differs, so a render site that goes back to
    // `group.label` repaints that value verbatim. (Probed the other way too:
    // with the key removed this same host sweeps clean, which is the state the
    // defect shipped in.)
    const host = document.createElement('div');
    host.innerHTML = '<span>Meter</span>';
    document.body.appendChild(host);
    const rules = sweep(host, PICKER_IDENTITY).map((h) => h.rule);
    expect(rules, 'the picker’s English heading passed the sweep').toContain('parity');
    // The vocabulary exemption above is the reason the catalog key is not
    // optional. Pinned so the note cannot go stale silently.
    expect(
      DATA_VOCAB.has('meter'),
      'the bill-line vocabulary this file pins no longer covers `meter` — the note above is stale, not the fix',
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * The multi-file merge review — the per-file summary line (t_dd0263c0).
 *
 * The dialog composes `file1.xml: 5 kept · file2.xml: 5 kept, 2 duplicate` in a
 * template literal, so it was invisible to the coverage gate (a literal inside
 * a `.map(...).join(...)` call is not a JSX text node nor a collected
 * expression) and shipped English inside French chrome. Nothing painted this
 * dialog either: the dashboard sweep's fixture is a single file, so the merge
 * review never renders.
 *
 * These tests mount the dialog on the two-file shape its own test builds — a
 * single-meter `file1.xml` and a multi-group `dual.xml` whose first group
 * repeats file1's first timestamp — and sweep it in both locale paths.
 * -------------------------------------------------------------------------- */

const MERGE_BASE = 1790000000;
const mergeReading = (offset: number, kwh = 1): DataPoint => ({
  timestamp: MERGE_BASE + offset,
  usage_kwh: kwh,
});
const mergeGroup = (id: string, readings: DataPoint[]): UsagePointGroup => ({
  id,
  label: `UsagePoint ${id}`,
  readings,
  blocks: 1,
  series: [],
  notes: [],
});

/**
 * Two files at once. `dual.xml` is the picker's second render site (its meter
 * rows carry the heading labels) and its selected group repeats `file1.xml`'s
 * first timestamp, so the summary line paints the duplicate clause too.
 */
const MERGE_FILES: MergeFileChoice[] = [
  {
    name: 'file1.xml',
    groups: [mergeGroup('up-bravo', [mergeReading(0), mergeReading(3600)])],
    chosen: 0,
  },
  {
    name: 'dual.xml',
    groups: [
      mergeGroup('up-delta', [mergeReading(0), mergeReading(7200)]),
      mergeGroup('up-echo', [mergeReading(10800)]),
    ],
    chosen: 0,
  },
];

/**
 * The file's OWN identity as this dialog prints it: the two file names and the
 * UsagePoint ids — data, per the same rule as the picker sweep above. Per-sweep
 * only, so `kept` and `duplicate` stay subject to every rule.
 */
const MERGE_IDENTITY = new Set<string>(
  [...MERGE_FILES.map((f) => f.name), ...MERGE_FILES.flatMap((f) => f.groups.map((g) => g.id))]
    .flatMap((s) => words(s))
    .map((w) => w.toLowerCase()),
);

const paintMerge = () =>
  render(
    <MultiFileMerge
      files={MERGE_FILES}
      onFilesChange={() => {}}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

describe('the multi-file merge review on the French page', () => {
  it('cold: the per-file summary line is painted in French', () => {
    setLocale('fr');
    const { container } = paintMerge();

    const line = screen.getByTestId('merge-summary').textContent ?? '';
    expect(line).toContain('file1.xml : 2 conservés');
    expect(line).toContain('dual.xml : 1 conservé, 1 doublon');
    // The defect's own English wording is gone from the French page.
    expect(line).not.toContain('kept');

    expect(sweep(container, MERGE_IDENTITY)).toEqual([]);
  }, 60_000);

  it('flip: the toggle re-paints the line, it does not keep the English it started with', async () => {
    setLocale('en');
    const { container } = paintMerge();
    const line = () => screen.getByTestId('merge-summary').textContent ?? '';
    expect(line()).toContain('file1.xml: 2 kept');
    expect(line()).toContain('dual.xml: 1 kept, 1 duplicate');
    // The English page IS the English catalog rendered — the detector has to
    // see it, or a clean French sweep below means nothing.
    expect(sweep(container, MERGE_IDENTITY).map((h) => h.rule)).toContain('parity');

    await act(async () => setLocale('fr'));
    expect(line()).toContain('dual.xml : 1 conservé, 1 doublon');
    expect(sweep(container, MERGE_IDENTITY)).toEqual([]);
  }, 60_000);

  it('sensitivity: the exact English summary line is what the rule catches', () => {
    // The line the deployed build shipped on the fr page, verbatim.
    const host = document.createElement('div');
    host.innerHTML = '<div>file2.xml: 5 kept, 2 duplicate</div>';
    document.body.appendChild(host);
    const rules = sweep(host, MERGE_IDENTITY).map((h) => h.rule);
    expect(rules, 'the merge review’s English summary line passed the sweep').toContain('english');
  });
});

describe('the sweep itself (planted failures)', () => {
  const mount = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  };

  it('catches the fr-mode strings the deployed build shipped', () => {
    // Real strings from qa's walk: catalogued English (parity), a raw key, and
    // composed English that never reached the catalog (vocabulary).
    expect(sweep(mount('<p>Requires switching to the ULO plan and moving the load into 23:00–07:00.</p>')).map((h) => h.rule)).toContain('parity');
    expect(sweep(mount('<span>accrual.measuredLine</span>')).map((h) => h.rule)).toContain('raw-key');
    expect(sweep(mount('<li>4h in the same slot 5/5 weeks, flat across every hour (±3%)</li>')).map((h) => h.rule)).toContain('english');
  });

  it('does not flag French, canonical codes or a line name the catalog has no view of', () => {
    expect(sweep(mount('<p>Nécessite de passer à la grille ULO et de déplacer la charge entre 23 h et 7 h.</p>'))).toEqual([]);
    expect(sweep(mount('<span>ULO · TOU · TIERED · kWh · 1 365,03 $</span>'))).toEqual([]);
    // A line name this app has no catalog view of prints verbatim and stays
    // exempt (the fallback half of `billNoteText`): the words are the
    // utility's own vocabulary, read out of the fixture.
    expect(sweep(mount('<table><tr><td>Meter Read Date</td></tr></table>'))).toEqual([]);
  });

  it('flags a line name the catalog HAS a view of — the exemption’s boundary', () => {
    // Exactly the shape the row above is excused for, but these notes ARE in
    // the catalog now, so a French page printing them verbatim is a panel that
    // forgot `billNoteText` (t_0a96fd14). Pinned so the data exemption cannot
    // quietly widen back over a translatable label.
    expect(
      sweep(
        mount(
          '<table><tr><td>Bill Post Date</td></tr>' +
            '<tr><td>On Peak-Summer Usage</td></tr>' +
            '<tr><td>Distribution Loss Factor</td></tr>' +
            '<tr><td>Current Meter Read</td></tr></table>',
        ),
      ).map((h) => h.rule),
    ).toEqual(['parity', 'parity', 'parity', 'parity']);
  });
});
