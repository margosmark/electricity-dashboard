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
 *      utility's own data (bill line names, meter-read notes) and to canonical
 *      codes (plan ids, units) are exempt — they are the untranslated *source*
 *      of translated surfaces (I18N.md's "deliberately NOT translated" list),
 *      and the fixture's own notes are read out of the file, so the exemption
 *      cannot silently grow.
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
import { fmtDate, getLocale, setLocale } from '@/i18n';
import { parseGreenButtonFeed } from '@/lib/energy';
import { ENERGY_KEY_V2, BILLING_DAY_KEY } from '@/lib/storage';
import { USAGE_SUMMARIES_KEY, LOCAL_TIME_KEY } from '@/hooks/useDashboard';
import { TAB_STORAGE_KEY } from '@/lib/tabs';
import en from './en.json';
import fr from './fr.json';

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
const TABS = ['overview', 'usage', 'plans', 'money'] as const;

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
]);

/**
 * The utility's own vocabulary, read out of the fixture: every `<note>` on
 * every bill line, plus the meter-read labels. These are the file's data —
 * "Every line item as the utility wrote it" — and the coverage gate's own
 * canonical-data rule (I18N.md).
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
const exemptWord = (w: string) => CANONICAL_WORDS.has(w.toLowerCase()) || DATA_VOCAB.has(w.toLowerCase());

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
export function sweep(frRoot: HTMLElement): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of textNodes(frRoot)) {
    // The utility's own line name, printed verbatim: data, not chrome.
    if (DATA_NOTES.has(text)) continue;
    const key = EN_BY_VALUE.get(text);
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
    const english = words(text).filter((w) => w.length >= 3 && englishOnly(w) && !exemptWord(w));
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

  it('does not flag French, canonical codes or the file’s own data', () => {
    expect(sweep(mount('<p>Nécessite de passer à la grille ULO et de déplacer la charge entre 23 h et 7 h.</p>'))).toEqual([]);
    expect(sweep(mount('<span>ULO · TOU · TIERED · kWh · 1 365,03 $</span>'))).toEqual([]);
    // The utility's own line names, read verbatim from the fixture.
    expect(
      sweep(
        mount(
          '<table><tr><td>Bill Post Date</td></tr>' +
            '<tr><td>On Peak-Summer Usage</td></tr>' +
            '<tr><td>Distribution Loss Factor</td></tr>' +
            '<tr><td>Current Meter Read</td></tr></table>',
        ),
      ),
    ).toEqual([]);
  });
});
