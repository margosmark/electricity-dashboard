/**
 * The RENDERED money sweep — qa's `$$` / money-count script, in the gate.
 *
 * The formatter contract (`src/i18n/money-contract.test.ts`) pins what each
 * formatter PRINTS; this file pins what the app actually PAINTS. That
 * distinction is the whole defect class the card exists for: on the deployed
 * fr-CA build (tip 7ee0375) the formatters were already locale-correct, and
 * the page still showed
 *
 *   - `1 420,89 $$/AN` on all four plan-cost headlines — the fr money value
 *     plus the fr "$/an" unit label, so the symbol printed twice;
 *   - `kWh kWh` three times on Plans — a template that prints the unit handed
 *     a formatter that prints it too;
 *   - `11.9¢` beside `3,9 ¢` — an en `toFixed` decimal on the same page as a
 *     fr one.
 *
 * So the sweep walks the real four-tab page, in BOTH locales, with the
 * open-tail fixture loaded (three audited bills + a month of unbilled
 * readings, so the money views actually have money in them).
 *
 * WHY IT SWEEPS TEXT NODES, NOT `textContent`: a whole-page string glues
 * unrelated cells together, so "±0,00 $102,78 $" out of two neighbouring
 * `<td>`s reads as a `$` before a number nobody ever sees. The rules are
 * therefore applied per TEXT NODE, plus one deliberate cross-node rule: a
 * node ENDING in a currency symbol followed by a sibling STARTING with one is
 * exactly how `1 420,89 $` + `$/AN` painted `$$/AN`, and that IS a doubled
 * symbol on screen even though the two live in different elements.
 *
 * The four locale invariants a French reader is entitled to:
 *
 *   1. no doubled currency symbol, within a node or across adjacent siblings;
 *   2. no French render that puts `$` in front of its number;
 *   3. no unit printed twice (`kWh kWh`, `¢ ¢`, `% %`);
 *   4. no `1.5`-style dot decimal in French, and no `1,5`-style comma decimal
 *      in English.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Dashboard from './Dashboard';
import { getLocale, setLocale, type Locale } from '@/i18n';
import { parseGreenButtonFeed } from '@/lib/energy';
import { ENERGY_KEY_V2, BILLING_DAY_KEY } from '@/lib/storage';
import { USAGE_SUMMARIES_KEY, LOCAL_TIME_KEY } from '@/hooks/useDashboard';
import { TAB_STORAGE_KEY } from '@/lib/tabs';

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

/** Every tab, so the sweep covers every money surface the app paints.
 *  Keyed by `data-testid`, because the tab LABELS translate. */
const TABS = ['overview', 'usage', 'plans', 'money'] as const;

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

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 96);

/** Every rendered text node, with a short label for the failure report. */
function textNodes(root: HTMLElement): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  // `<script>`/`<style>`/`<template>`/`<noscript>` are not painted.
  const PAINTED = (el: Element) => !/^(script|style|template|noscript)$/i.test(el.tagName);
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))].filter(PAINTED)) {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = node.textContent ?? '';
      if (!text.trim()) continue;
      out.push({ where: el.tagName.toLowerCase() + (el.getAttribute('data-testid') ?? ''), text });
    }
  }
  return out;
}

/**
 * Tags that lay out INLINE (jsdom's default stylesheet — block elements are
 * `div`/`p`/`td`/`section`/…). Only inline neighbours can run their text
 * together on screen, which is what makes `1 420,89 $` + `$/AN` one painted
 * `$$/AN` rather than two stacked blocks that merely happen to both end and
 * start with a symbol.
 */
const INLINE_TAGS = new Set([
  'span', 'em', 'strong', 'b', 'i', 'small', 'sup', 'sub', 'a', 'code', 'label', 'time', 'abbr', 'svg',
]);
const isInline = (n: Node) => n.nodeType === Node.TEXT_NODE || INLINE_TAGS.has((n as Element).tagName?.toLowerCase());

/** Adjacent INLINE siblings: the `$` + `$/AN` shape that painted `$$/AN`. */
export function adjacentSymbols(root: HTMLElement): string[] {
  const hits: string[] = [];
  const PAINTED = (el: Element) => !/^(script|style|template|noscript)$/i.test(el.tagName);
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))].filter(PAINTED)) {
    const kids = Array.from(el.childNodes).filter(
      (n) =>
        (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) ||
        n.nodeType === Node.ELEMENT_NODE,
    );
    for (let i = 1; i < kids.length; i++) {
      if (!isInline(kids[i - 1]) || !isInline(kids[i])) continue;
      const a = (kids[i - 1].textContent ?? '').replace(/\s+/g, ' ').trimEnd();
      const b = (kids[i].textContent ?? '').replace(/\s+/g, ' ').trimStart();
      if (/[¢$]$/.test(a) && /^[¢$]/.test(b)) {
        const tag = (n: Node) => (n.nodeType === Node.TEXT_NODE ? '#text' : `<${(n as Element).tagName.toLowerCase()}>`);
        hits.push(
          `adjacent siblings in <${el.tagName.toLowerCase()}>: ` +
          `${tag(kids[i - 1])}…${a.slice(-34)} ⟂ ${tag(kids[i])}${b.slice(0, 34)}…`,
        );
      }
    }
  }
  return hits;
}

type Sweep = {
  doubledSymbol: string[];
  frSymbolBeforeNumber: string[];
  doubledUnit: string[];
  wrongDecimal: string[];
};

const find = (text: string, rx: RegExp, why: string): string[] =>
  [...text.matchAll(rx)].map(() => `${why} — ${clip(text)}`);

export function sweep(root: HTMLElement, locale: Locale): Sweep {
  const out: Sweep = {
    doubledSymbol: adjacentSymbols(root),
    frSymbolBeforeNumber: [],
    doubledUnit: [],
    wrongDecimal: [],
  };
  for (const { text } of textNodes(root)) {
    out.doubledSymbol.push(...find(text, /\$\s*\$/g, 'doubled $'));
    out.doubledUnit.push(
      ...find(text, /kWh\s+kWh/g, 'doubled kWh'),
      ...find(text, /¢\s*¢/g, 'doubled ¢'),
      ...find(text, /%\s+%/g, 'doubled %'),
    );
    if (locale === 'fr') {
      out.frSymbolBeforeNumber.push(...find(text, /\$\s?\d/g, 'fr text with $ before the number'));
      out.wrongDecimal.push(...find(text, /\d+\.\d+/g, 'fr text with an en decimal separator'));
    } else {
      out.wrongDecimal.push(...find(text, /\d+,\d{1,2}(?!\d)/g, 'en text with a fr decimal separator'));
    }
  }
  return out;
}

const describeHits = (s: Sweep, locale: Locale) =>
  Object.entries(s)
    .filter(([, hits]) => hits.length > 0)
    .map(
      ([kind, hits]) =>
        `${locale}: ${kind} × ${hits.length}\n      ${[...new Set(hits)].slice(0, 8).join('\n      ')}`,
    );

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

for (const locale of ['en', 'fr'] as const) {
  describe(`the painted page in ${locale}-CA`, () => {
    it('carries no doubled symbol, doubled unit or foreign decimal on any tab', async () => {
      setLocale(locale);
      const user = userEvent.setup();
      const { container } = render(<Dashboard />);
      await screen.findByTestId('totals-strip', undefined, { timeout: 20_000 });
      expect(getLocale()).toBe(locale);

      const failures: string[] = [];
      for (const tab of TABS) {
        await user.click(screen.getByTestId(`tab-${tab}`));
        const text = container.textContent ?? '';
        // A sweep over an empty page proves nothing: every tab must have
        // painted real content before its text is judged.
        expect(text.length, `${tab} painted nothing`).toBeGreaterThan(400);
        failures.push(
          ...describeHits(sweep(container, locale), locale).map((h) => `${tab} — ${h}`),
        );
      }
      expect(
        failures,
        failures.length === 0
          ? ''
          : `\nMoney-format regressions painted in ${locale}-CA:\n\n${failures.join('\n')}\n`,
      ).toEqual([]);
    }, 60_000);
  });
}

describe('the sweep itself', () => {
  const mount = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  };

  it('catches the four shapes 7ee0375 shipped', () => {
    const host = mount(
      '<div data-testid="h">1 420,89 $$/AN</div>' +
        '<span>8 kWh kWh</span>' +
        '<em>11.9¢</em><em>3,9 ¢</em>',
    );
    const hits = sweep(host, 'fr');
    expect(hits.doubledSymbol.length).toBe(1);
    expect(hits.doubledUnit.length).toBe(1);
    expect(hits.wrongDecimal.length).toBe(1);
  });

  it('catches the headline exactly as it was painted: money + a `$/AN` unit span', () => {
    // The real shape of defect 1 — two elements, so no single text node
    // contains `$$`; only the sibling adjacency does.
    const host = mount('<div><span>1 420,89 $</span><span>$/AN</span></div>');
    expect(sweep(host, 'fr').doubledSymbol.length).toBe(1);
  });

  it('does not flag two neighbours inside their own cells (no cross-cell gluing)', () => {
    const host = mount('<table><tr><td>±0,00 $</td><td>102,78 $</td></tr></table>');
    expect(describeHits(sweep(host, 'fr'), 'fr')).toEqual([]);
  });

  it('does not flag legitimate fr-CA grouping, dates or percentages', () => {
    const host = mount(
      '<p>1 420,89 $ /an · 0,4 ¢/kWh · 63 % · 26 août 2025 · 23:00–07:00 · 19,9 kW</p>',
    );
    expect(describeHits(sweep(host, 'fr'), 'fr')).toEqual([]);
  });

  it('does not flag legitimate en-CA grouping', () => {
    const host = mount('<p>$1,420.89 /yr · 0.4¢/kWh · 63% · Aug 26, 2025 · 23:00–07:00</p>');
    expect(describeHits(sweep(host, 'en'), 'en')).toEqual([]);
  });
});
