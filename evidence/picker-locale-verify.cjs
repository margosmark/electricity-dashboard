/**
 * picker-locale-verify — the UsagePoint picker's headings, on a REAL browser.
 *
 * t_203c6445: the picker's point heading is composed in the LIB
 * (`webapp/src/lib/energy.ts`: `UsagePoint <id>`, or `Meter` when the feed
 * identifies no UsagePoint) and both render sites painted it verbatim, so a
 * French reader read the English word `Meter` inside French chrome. Nothing in
 * the battery had ever painted this component either — the dashboard sweep runs
 * on a single-UsagePoint fixture (the picker only exists for 2+ groups) and the
 * notice sweep mounts the notice alone.
 *
 * This check answers the question the unit gates cannot: what does a reader
 * actually SEE in the dialog, in both locales, against a real build? It
 * generates a feed carrying two identified meters AND one the feed never
 * attributes to a UsagePoint, uploads it through the app's own file input, and
 * reads the painted headings.
 *
 * Run:  TZ=America/Toronto node evidence/picker-locale-verify.cjs
 * Env:  PICKER_LOCALE_BASE_URL (default http://127.0.0.1:3100/),
 *       PICKER_LOCALE_CHROMIUM (default /usr/bin/chromium),
 *       PICKER_LOCALE_XML (use this feed instead of generating one),
 *       PICKER_LOCALE_SUFFIX ('-deployed' writes
 *       picker-locale-verification-deployed.json)
 *
 * Writes evidence/picker-locale-verification[-suffix].json + picker-locale-*.png
 * Exit code 0 only when every check passes.
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const BASE = process.env.PICKER_LOCALE_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.PICKER_LOCALE_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.PICKER_LOCALE_SUFFIX || '';
const OUT = __dirname;

/* -------------------------------------------------------------------------- *
 * The feed — two identified meters, plus one the document never names
 * -------------------------------------------------------------------------- */

const NT = 1790000000;

const el = (n, v) => `<espi:${n}>${v}</espi:${n}>`;
const rt = (uom = 72) =>
  `<espi:ReadingType>${el('uom', uom)}${el('powerOfTenMultiplier', 0)}${el(
    'accumulationBehaviour',
    4,
  )}${el('commodity', 1)}${el('flowDirection', 1)}${el('kind', 12)}${el(
    'intervalLength',
    3600,
  )}</espi:ReadingType>`;
const blk = (start, value) =>
  `<espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading></espi:IntervalBlock>`;
const entry = (self, body, related = []) =>
  `<entry><link rel="self" href="${self}"/>${related
    .map((h) => `<link rel="related" href="${h}"/>`)
    .join('')}<content>${body}</content></entry>`;

function point(up, mr, rtId, value, start) {
  return [
    entry(`/ReadingType/${rtId}`, rt()),
    entry(`/UsagePoint/${up}/MeterReading/${mr}`, '<espi:MeterReading/>', [`/ReadingType/${rtId}`]),
    entry(`/UsagePoint/${up}/MeterReading/${mr}/IntervalBlock/ib`, blk(start, value)),
  ];
}

/** The two ids the labels must print, and the shape of the French heading. */
const POINTS = ['up-bravo', 'up-delta'];

function feedXml() {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${[
    ...point('up-bravo', 'mr-b1', 'rt-b1', 1500, NT),
    ...point('up-delta', 'mr-c1', 'rt-c1', 1000, NT),
    // No /UsagePoint/<id>/ link anywhere: the group the picker must word as
    // `Meter` (en) / `Compteur` (fr).
    entry('/IntervalBlock/unidentified', `${rt()}${blk(NT + 7200, 800)}`),
  ].join('')}</feed>`;
}

function fixturePath() {
  if (process.env.PICKER_LOCALE_XML) return process.env.PICKER_LOCALE_XML;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-locale-'));
  const file = path.join(dir, 'two-points-export.xml');
  fs.writeFileSync(file, feedXml());
  return file;
}

/* -------------------------------------------------------------------------- *
 * The checks
 * -------------------------------------------------------------------------- */

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Every meter row's heading, in paint order. */
async function headings(page) {
  return page.$$eval('[data-testid^="usage-point-"]', (els) =>
    els
      .filter(
        (e) => e.tagName === 'BUTTON' && e.getAttribute('data-testid') !== 'usage-point-combine',
      )
      .map((b) => {
        const span = b.querySelector('span');
        return span ? (span.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }),
  );
}

async function paint(browser, locale, xml) {
  const context = await browser.newContext({ locale: locale === 'fr' ? 'fr-CA' : 'en-CA' });
  // The stored locale is what the app restores before its first render — the
  // same "cold" path the runtime gate walks. Seeded before any page script
  // runs (addInitScript), so the FIRST load is already in the locale; the
  // picker's overlay covers the toolbar, so the toggle is not reachable while
  // it is up.
  await context.addInitScript((l) => {
    try {
      localStorage.setItem('oeo_locale', l);
    } catch {
      /* storage disabled — the app's own default applies */
    }
  }, locale);
  const page = await context.newPage();
  await page.goto(BASE);
  // Selected by `accept`, not by aria-label: the label is translated
  // ("Téléverser le XML Green Button" in fr — which is exactly the class this
  // check exists for), so the English selector would time out on the fr page.
  await page.locator('input[type="file"][accept*="xml"]').setInputFiles(xml);
  await page.locator('[data-testid="usage-point-picker"]').waitFor({ timeout: 20_000 });
  const rows = await headings(page);
  await page.screenshot({ path: path.join(OUT, `picker-locale-${locale}${SUFFIX}.png`) });
  await context.close();
  return rows;
}

(async () => {
  const xml = fixturePath();
  const browser = await chromium.launch({ executablePath: CHROMIUM });

  const fr = await paint(browser, 'fr', xml);
  const en = await paint(browser, 'en', xml);
  await browser.close();

  console.log(`\nfr rows: ${JSON.stringify(fr)}\nen rows: ${JSON.stringify(en)}\n`);

  const frFr = fr.join(' | ');
  const enEn = en.join(' | ');

  check('the picker rendered one row per point (3)', fr.length === 3, `got ${fr.length}: ${frFr}`);
  // The defect itself: English chrome on the French page.
  check(
    'fr: no English frame around the id',
    !/UsagePoint /.test(frFr),
    frFr,
  );
  check('fr: no English `Meter` heading', !/\bMeter\b/.test(frFr), frFr);
  check('fr: the identified points are French', fr.filter((h) => /^Point de consommation /.test(h)).length === 2, frFr);
  check(
    'fr: the unidentified point is `Compteur`',
    fr.includes('Compteur'),
    frFr,
  );
  // The id is the file's own data and stays canonical inside the fr heading.
  check(
    'fr: the canonical ids survive the French frame',
    POINTS.every((p) => frFr.includes(p)),
    frFr,
  );

  // The English page is unchanged, byte for byte: the canonical labels the lib
  // composes and the tests assert.
  check('en: the lib’s own labels are painted', enEn === POINTS.map((p) => `UsagePoint ${p}`).join(' | ') + ' | Meter', enEn);
  check('en: the unidentified point is `Meter`', en.includes('Meter'), enEn);

  const failed = checks.filter((c) => !c.ok);
  const result = {
    base: BASE,
    xml,
    locales: { fr, en },
    checks,
    passed: checks.length - failed.length,
    total: checks.length,
    exit: failed.length === 0 ? 0 : 1,
    at: new Date().toISOString(),
  };
  const file = path.join(OUT, `picker-locale-verification${SUFFIX}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.passed}/${result.total} checks passed — wrote ${file}`);
  process.exit(result.exit);
})().catch((err) => {
  console.error('the picker check could not run:', err);
  const file = path.join(OUT, `picker-locale-verification${SUFFIX}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ base: BASE, error: String(err && err.stack ? err.stack : err), checks, at: new Date().toISOString() }, null, 2) + '\n',
  );
  process.exit(2);
});
