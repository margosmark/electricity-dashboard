/**
 * money-locale-verify — qa's `$$` / money-count script, on a REAL browser.
 *
 * Wave U translated 165 strings and a later fix (7ee0375) was titled "French
 * money". The deployed fr-CA build still printed `1 420,89 $$/AN` on all four
 * plan-cost headlines, `kWh kWh` three times on Plans, and `11.9¢` beside
 * `3,9 ¢` on one page — because the formatters were right and the RENDER
 * SITES were not. This check answers the only question that matters about
 * that class: what does a French reader actually SEE?
 *
 * What it does, in one browser profile:
 *
 *   1. upload a Green Button export (default: the committed three-bill +
 *      open-tail fixture, so the money views have real money in them);
 *   2. walk the four tabs in en-CA and, after the locale toggle, in fr-CA;
 *   3. sweep every rendered text node for the four locale invariants
 *      (doubled currency symbol, a French `$` in front of its number, a unit
 *      printed twice, the wrong decimal separator) and count the money renders
 *      it DID find, so "0 defects" can never be a broken sweep;
 *   4. screenshot each tab in both locales.
 *
 * Run:  TZ=America/Toronto node evidence/money-locale-verify.cjs
 * Env:  MONEY_LOCALE_BASE_URL (default http://127.0.0.1:3100/),
 *       MONEY_LOCALE_CHROMIUM, MONEY_LOCALE_XML (default the committed
 *       open-tail fixture), MONEY_LOCALE_SUFFIX ('-deployed' writes
 *       money-locale-verification-deployed.json)
 *
 * Writes evidence/money-locale-verification[-suffix].json + money-locale-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.MONEY_LOCALE_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.MONEY_LOCALE_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.MONEY_LOCALE_SUFFIX || '';
const FIXTURE =
  process.env.MONEY_LOCALE_XML ||
  path.resolve(__dirname, '../webapp/tests/fixtures/usage-summary-open-tail.xml');
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function launch() {
  return chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

/**
 * The sweep, evaluated in the page. It walks TEXT NODES rather than
 * `textContent` so two neighbouring table cells cannot be glued into a `$` in
 * front of a number nobody sees; the one cross-node rule is limited to INLINE
 * siblings, which is the shape that painted `1 420,89 $` + `$/AN` as `$$/AN`.
 */
function sweepInPage({ locale, enPhrases, frPhrases }) {
  const INLINE = new Set([
    'span', 'em', 'strong', 'b', 'i', 'small', 'sup', 'sub', 'a', 'code', 'label', 'time', 'abbr', 'svg',
  ]);
  const isInline = (n) =>
    n.nodeType === Node.TEXT_NODE || INLINE.has((n.tagName || '').toLowerCase());
  const clip = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 90);

  const hits = { doubledSymbol: [], frSymbolBeforeNumber: [], doubledUnit: [], wrongDecimal: [] };
  const untranslated = [];
  let moneyRenders = 0;
  let textLength = 0;

  // Mask digits/placeholders so a painted sentence can be matched against the
  // ENGLISH catalog template it came from.
  const mask = (t) => t.replace(/\{\w+\}/g, '#').replace(/[¢$]?\d[\d.,\u00a0\u202f]*[¢$]?/g, '#');
  const maskedNode = (t) => mask(t);

  // `<script>`/`<style>`/`<template>`/`<noscript>` are not painted: the RSC
  // payload in a script tag carries the ENGLISH server render, which would
  // report every French page as untranslated.
  const PAINTED = (el) => !/^(script|style|template|noscript)$/i.test(el.tagName || '');
  for (const el of [document.body, ...document.body.querySelectorAll('*')].filter(PAINTED)) {
    const kids = Array.from(el.childNodes);
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = node.textContent || '';
      if (!text.trim()) continue;
      textLength += text.length;
      // Is this node an ENGLISH catalog sentence still painted under fr? Then
      // its money is en-formatted because the SENTENCE is, which is
      // t_5e0926f1's defect class (the locale toggle does not recompute every
      // memo) — not a money render that ignored the formatter.
      const nodeMasked = maskedNode(text);
      // …and NOT also a French catalog phrase: the product name and other
      // bilingually-identical strings are in BOTH catalogs and are not defects.
      const stillEnglish =
        locale === 'fr' &&
        enPhrases.some((p) => nodeMasked.includes(p)) &&
        !frPhrases.some((p) => nodeMasked.includes(p));
      if (stillEnglish) untranslated.push(clip(text));

      for (const m of text.matchAll(/\$\s*\$/g)) hits.doubledSymbol.push(clip(text) + ` «${m[0]}»`);
      for (const m of text.matchAll(/kWh\s+kWh|¢\s*¢|%\s+%/g)) hits.doubledUnit.push(clip(text) + ` «${m[0]}»`);
      if (locale === 'fr' && !stillEnglish) {
        for (const m of text.matchAll(/\$\s?\d/g)) hits.frSymbolBeforeNumber.push(clip(text) + ` «${m[0]}»`);
        for (const m of text.matchAll(/\d+\.\d+/g)) hits.wrongDecimal.push(clip(text) + ` «${m[0]}»`);
        for (const m of text.matchAll(/\d,\d{1,2}\s?\$/g)) moneyRenders += m.length;
        moneyRenders += [...text.matchAll(/\d[\d\s\u00a0\u202f]*,\d\d\s\$/g)].length;
      } else if (locale === 'en') {
        for (const m of text.matchAll(/\d+,\d{1,2}(?!\d)/g)) hits.wrongDecimal.push(clip(text) + ` «${m[0]}»`);
        for (const m of text.matchAll(/\$[\d,]+\.\d{2}/g)) moneyRenders += m.length;
      }
      // The cross-node rule: an inline neighbour ending in a symbol whose
      // next inline sibling starts with one.
      const prev = kids[i - 1];
      const next = kids[i + 1];
      if (next && isInline(next)) {
        const after = (next.textContent || '').replace(/\s+/g, ' ').trimStart();
        if (/[¢$]$/.test(text.replace(/\s+$/, '')) && /^[¢$]/.test(after) && isInline(node)) {
          hits.doubledSymbol.push(`${clip(text)} ⟂ ${clip(after)}`);
        }
      }
      if (prev && isInline(prev)) {
        const before = (prev.textContent || '').replace(/\s+/g, ' ').trimEnd();
        if (/[¢$]$/.test(before) && /^[¢$]/.test(text.replace(/\s+/g, ' ').trimStart())) {
          hits.doubledSymbol.push(`${clip(before)} ⟂ ${clip(text)}`);
        }
      }
    }
  }
  return { hits, untranslated: [...new Set(untranslated)], moneyRenders, textLength };
}

/**
 * English catalog phrases (>= 8 chars, at least one space, digits masked) —
 * the fingerprint of a sentence that is still English on a French page.
 */
const MASK = (v) => v.replace(/\{\w+\}/g, '#').replace(/[¢$]?\d[\d.,\u00a0\u202f]*[¢$]?/g, '#');
const CATALOG = (loc) =>
  [...new Set(
    Object.values(JSON.parse(fs.readFileSync(path.resolve(__dirname, `../webapp/src/i18n/${loc}.json`), 'utf8')))
      .filter((v) => typeof v === 'string' && v.length >= 8 && v.includes(' '))
      .map(MASK),
  )];
const EN_PHRASES = CATALOG('en');
const FR_PHRASES = CATALOG('fr');

const TABS = [
  ['overview', 'tab-overview'],
  ['usage', 'tab-usage'],
  ['plans', 'tab-plans'],
  ['money', 'tab-money'],
];

async function loadAndSweep(browser, locale, viewport, shotPrefix) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const input = page.locator('input[type="file"][accept=".xml"]');
  if (!(await shown(input, 30_000))) throw new Error('upload input never appeared');
  await input.setInputFiles(FIXTURE);
  if (!(await shown(page.getByTestId('totals-strip'), 60_000))) {
    throw new Error('upload never produced a totals strip');
  }

  // The toggle names the OTHER language, so in en it reads "FR".
  if (locale === 'fr') {
    await page.getByTestId('locale-toggle').click();
    await page.waitForFunction(() => document.documentElement.lang === 'fr', undefined, { timeout: 15_000 });
  }

  const per = {};
  for (const [name, testid] of TABS) {
    await page.getByTestId(testid).click();
    // Let the panel's own data settle before the sweep reads it.
    await page.waitForTimeout(900);
    per[name] = await page.evaluate(sweepInPage, { locale, enPhrases: EN_PHRASES, frPhrases: FR_PHRASES });
    await page.screenshot({ path: path.join(OUT, `${shotPrefix}-${name}.png`), fullPage: false });
  }
  await ctx.close();
  return per;
}

(async () => {
  const browser = await launch();
  const report = { base: BASE, fixture: path.basename(FIXTURE), locales: {} };
  try {
    for (const locale of ['en', 'fr']) {
      const per = await loadAndSweep(
        browser,
        locale,
        { width: 1440, height: 1000 },
        `money-locale-${locale}`,
      );
      report.locales[locale] = per;

      const totals = { doubledSymbol: 0, frSymbolBeforeNumber: 0, doubledUnit: 0, wrongDecimal: 0 };
      let money = 0;
      let chars = 0;
      for (const [tab, r] of Object.entries(per)) {
        for (const k of Object.keys(totals)) totals[k] += r.hits[k].length;
        money += r.moneyRenders;
        chars += r.textLength;
        check(`${locale}/${tab} painted real content`, r.textLength > 400, `${r.textLength} chars`);
      }
      report.locales[locale].totals = totals;
      report.locales[locale].moneyRenders = money;
      const untranslated = Object.entries(per)
        .filter(([, r]) => r && r.untranslated)
        .flatMap(([tab, r]) => r.untranslated.map((t) => `${tab}: ${t}`));
      report.locales[locale].untranslated = [...new Set(untranslated)];
      if (untranslated.length > 0) {
        console.log(
          `NOTE  ${untranslated.length} text node(s) are still ENGLISH on the ${locale} page ` +
          `— t_5e0926f1's class, reported here, not counted as a money-format defect:\n      ` +
          [...new Set(untranslated)].slice(0, 4).join('\n      '),
        );
      }

      check(`${locale}: money renders found (a sweep that sees nothing is broken)`, money > 0, `${money} money strings`);
      check(`${locale}: 0 doubled currency symbols`, totals.doubledSymbol === 0, firstFew(per, 'doubledSymbol'));
      check(`${locale}: 0 doubled units (kWh kWh / ¢ ¢ / % %)`, totals.doubledUnit === 0, firstFew(per, 'doubledUnit'));
      check(
        `${locale}: 0 ${locale === 'fr' ? 'en-dot' : 'fr-comma'} decimals`,
        totals.wrongDecimal === 0,
        firstFew(per, 'wrongDecimal'),
      );
      if (locale === 'fr') {
        check(`fr: 0 money strings with $ in front of the number`, totals.frSymbolBeforeNumber === 0, firstFew(per, 'frSymbolBeforeNumber'));
      }
    }
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  report.checks = checks;
  report.passed = checks.length - failed.length;
  report.failed = failed.length;
  fs.writeFileSync(
    path.join(OUT, `money-locale-verification${SUFFIX}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(`\n${report.passed}/${checks.length} checks passed`);
  console.log(`wrote evidence/money-locale-verification${SUFFIX}.json`);
  process.exit(failed.length === 0 ? 0 : 1);
})();

function firstFew(per, key) {
  const all = Object.entries(per)
    .filter(([, r]) => r && r.hits)
    .flatMap(([tab, r]) => r.hits[key].map((h) => `${tab}: ${h}`));
  return all.length === 0 ? 'none' : `${all.length} — e.g. ${all.slice(0, 3).join(' | ')}`;
}
