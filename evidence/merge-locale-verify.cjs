/**
 * merge-locale-verify — the multi-file merge review's per-file summary line,
 * on a REAL browser.
 *
 * t_dd0263c0: `MultiFileMerge` composed
 * `${name}: ${rows} kept, ${duplicates} duplicate` in a template literal inside
 * JSX, so it was invisible to the i18n coverage gate (the scanner does not
 * descend into a `.map(…).join(…)` call's argument) and no sweep painted the
 * dialog (the dashboard fixture is a single file) — an English line inside
 * French chrome. The line now reads through the catalog.
 *
 * This check answers the question the unit gates cannot: what does a reader
 * actually SEE on the merge review, in both locales, against a real build? It
 * generates TWO Green Button exports whose readings overlap (so the duplicate
 * clause paints with a real count), uploads BOTH at once through the app's own
 * file input, and reads the painted summary line.
 *
 * Run:  NODE_PATH=$PWD/webapp/node_modules TZ=America/Toronto \
 *         node evidence/merge-locale-verify.cjs
 * Env:  MERGE_LOCALE_BASE_URL (default http://127.0.0.1:3100/),
 *       MERGE_LOCALE_CHROMIUM (default /usr/bin/chromium),
 *       MERGE_LOCALE_SUFFIX ('-deployed' writes
 *       merge-locale-verification-deployed.json)
 *
 * Writes evidence/merge-locale-verification[-suffix].json + merge-locale-*.png
 * Exit code 0 only when every check passes.
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const BASE = process.env.MERGE_LOCALE_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.MERGE_LOCALE_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.MERGE_LOCALE_SUFFIX || '';
const OUT = __dirname;

/* -------------------------------------------------------------------------- *
 * Two single-meter exports whose readings overlap
 * -------------------------------------------------------------------------- */

const NT = 1790000000;
const H = 3600;

const el = (n, v) => `<espi:${n}>${v}</espi:${n}>`;
const rt = () =>
  `<espi:ReadingType>${el('uom', 72)}${el('powerOfTenMultiplier', 0)}${el(
    'accumulationBehaviour',
    4,
  )}${el('commodity', 1)}${el('flowDirection', 1)}${el('kind', 12)}${el(
    'intervalLength',
    3600,
  )}</espi:ReadingType>`;
const reading = (start, value) =>
  `<espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading>`;
const block = (start, values) =>
  `<espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:interval>${values.join('')}</espi:IntervalBlock>`;
const entry = (self, body, related = []) =>
  `<entry><link rel="self" href="${self}"/>${related
    .map((h) => `<link rel="related" href="${h}"/>`)
    .join('')}<content>${body}</content></entry>`;

/** ONE UsagePoint / ONE MeterReading carrying every reading, so each file is a
 *  single group and the merge review (not the picker) is what renders. */
function series(up, mr, rtId, values) {
  return [
    entry(`/ReadingType/${rtId}`, rt()),
    entry(`/UsagePoint/${up}/MeterReading/${mr}`, '<espi:MeterReading/>', [`/ReadingType/${rtId}`]),
    entry(
      `/UsagePoint/${up}/MeterReading/${mr}/IntervalBlock/ib`,
      block(NT, values.map(([off, v]) => reading(NT + off, v))),
    ),
  ];
}

const doc = (parts) =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${parts
    .flat()
    .join('')}</feed>`;

/**
 * file-a.xml keeps THREE readings; file-b.xml repeats two of them (2 duplicates)
 * and keeps ONE of its own. So the two summary rows exercise BOTH plural
 * branches on BOTH counts: `3 conservés`/`3 kept`, `1 conservé`/`1 kept` and
 * `2 doublons`/`2 duplicate` (the English quirk kept on purpose).
 */
const FILE_A = {
  name: 'file-a.xml',
  xml: doc([series('up-alpha', 'mr-a1', 'rt-a1', [[0, 1500], [H, 1500], [2 * H, 1500]])]),
};
const FILE_B = {
  name: 'file-b.xml',
  xml: doc([series('up-beta', 'mr-b1', 'rt-b1', [[0, 1000], [H, 1000], [3 * H, 1000]])]),
};

const FR_LINE = 'file-a.xml : 3 conservés · file-b.xml : 1 conservé, 2 doublons';
const EN_LINE = 'file-a.xml: 3 kept · file-b.xml: 1 kept, 2 duplicate';

function fixturePaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-locale-'));
  return [FILE_A, FILE_B].map((f) => {
    const file = path.join(dir, f.name);
    fs.writeFileSync(file, f.xml);
    return file;
  });
}

/* -------------------------------------------------------------------------- *
 * The checks
 * -------------------------------------------------------------------------- */

const checks = [];
function check(name, ok, detail) {
  const e = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(e);
  console.log(`${e.ok ? 'PASS' : 'FAIL'}  ${name}${e.detail ? ` — ${e.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** The painted per-file summary line + the whole summary panel, in paint order. */
async function summary(page) {
  return page.$eval('[data-testid="merge-summary"]', (el) => ({
    all: (el.textContent || '').replace(/\s+/g, ' ').trim(),
  }));
}

async function paint(browser, locale, files) {
  const context = await browser.newContext({ locale: locale === 'fr' ? 'fr-CA' : 'en-CA' });
  // The stored locale is what the app restores before its first render — the
  // same "cold" path the runtime gate walks.
  await context.addInitScript((l) => {
    try {
      localStorage.setItem('oeo_locale', l);
    } catch {
      /* storage disabled — the app's own default applies */
    }
  }, locale);
  const page = await context.newPage();
  await page.goto(BASE);
  // Selected by `accept`, not by aria-label: the label is translated in fr, so
  // the English selector would time out on the fr page.
  await page.locator('input[type="file"][accept*="xml"]').setInputFiles(files);
  await page.locator('[data-testid="merge-summary"]').waitFor({ timeout: 20_000 });
  const painted = await summary(page);
  await page.screenshot({ path: path.join(OUT, `merge-locale-${locale}${SUFFIX}.png`) });
  await context.close();
  return painted.all;
}

(async () => {
  const files = fixturePaths();
  const browser = await chromium.launch({ executablePath: CHROMIUM });

  const fr = flat(await paint(browser, 'fr', files));
  const en = flat(await paint(browser, 'en', files));
  await browser.close();

  console.log(`\nfr summary: ${JSON.stringify(fr)}\nen summary: ${JSON.stringify(en)}\n`);

  check('the dialog painted the per-file summary line', fr.includes('file-') && en.includes('file-'), `fr=${fr}`);

  check('fr: the whole line is French', fr.includes(FR_LINE), fr);
  check('fr: no English `kept`', !/\bkept\b/.test(fr), fr);
  check('fr: no English `duplicate`', !/\bduplicate\b/.test(fr), fr);
  // French agreement on BOTH counts: the rows count (3/1) and the duplicates
  // count (2). One key alone cannot carry two counts.
  check('fr: `{rows} kept` agrees (conservés / conservé)', fr.includes('3 conservés') && fr.includes('1 conservé'), fr);
  check('fr: the duplicate clause agrees (2 doublons)', fr.includes('2 doublons'), fr);

  // The English page is unchanged, byte for byte — including the `2 duplicate`
  // quirk the English plural pair deliberately keeps.
  check('en: the line is byte-identical to the shipped wording', en.includes(EN_LINE), en);
  check('en: the quirk survives (2 duplicate, not 2 duplicates)', en.includes('2 duplicate') && !en.includes('2 duplicates'), en);

  const failed = checks.filter((c) => !c.ok);
  const result = {
    base: BASE,
    files: [FILE_A.name, FILE_B.name],
    locales: { fr, en },
    expected: { fr: FR_LINE, en: EN_LINE },
    checks,
    passed: checks.length - failed.length,
    total: checks.length,
    exit: failed.length === 0 ? 0 : 1,
    at: new Date().toISOString(),
  };
  const file = path.join(OUT, `merge-locale-verification${SUFFIX}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.passed}/${result.total} checks passed — wrote ${file}`);
  process.exit(result.exit);
})().catch((err) => {
  console.error('the merge check could not run:', err);
  const file = path.join(OUT, `merge-locale-verification${SUFFIX}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ base: BASE, error: String(err && err.stack ? err.stack : err), checks, at: new Date().toISOString() }, null, 2) + '\n',
  );
  process.exit(2);
});
