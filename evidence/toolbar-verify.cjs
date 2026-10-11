/**
 * Toolbar geometry verification — the Wave R follow-up (t_7f224ead).
 *
 * The complaint this script exists to settle: at >=1024px the dashboard's
 * toolbar card wrapped into two rows and left a ~640x175px void in the
 * bottom-left of the card (the right cluster's `lg:ml-auto` right-aligned
 * row 2, so everything between the left edge and the right cluster was
 * dead white).
 *
 * WHAT it measures and the budgets it holds now live in ONE place —
 * webapp/tests/e2e/toolbar-geometry.js — the same module the CI regression
 * gate imports (webapp/tests/e2e/toolbar-layout.spec.ts, a vw/vh breakpoint
 * sweep). This script is the EVIDENCE producer: the screenshots and the json
 * record behind DECISIONS.md's toolbar row. The spec is the gate that runs on
 * every PR. Neither can drift from the other, because both call
 * measureToolbarGeometry() / toolbarChecks().
 *
 * Per width it asserts:
 *
 *   1. the toolbar card exists and holds the global actions;
 *   2. the LARGEST AXIS-ALIGNED EMPTY RECTANGLE inside the card's content
 *      box (sampled at 4px over every descendant box) is small — this is
 *      the dead band, measured instead of eyeballed;
 *   3. each visual row of top-level clusters spans most of the card's
 *      content width (no right-aligned orphan row);
 *   4. no horizontal page overflow, and no internal horizontal scrolling of
 *      the toolbar, at any width including 390.
 *
 * Run:  NODE_PATH=$PWD/webapp/node_modules node evidence/toolbar-verify.cjs
 * Env:  TOOLBAR_BASE_URL (default http://127.0.0.1:3100/), TOOLBAR_CHROMIUM,
 *       TOOLBAR_XML, TOOLBAR_SUFFIX ('-local' writes a separate json),
 *       TOOLBAR_WIDTHS (override the width list for an ad-hoc sweep)
 *
 * Writes evidence/toolbar-verification[-suffix].json + toolbar-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const { bandFor, measureToolbarGeometry, toolbarChecks, layoutSummary } = require('../webapp/tests/e2e/toolbar-geometry.js');

const BASE = process.env.TOOLBAR_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.TOOLBAR_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.TOOLBAR_SUFFIX || '';
const FIXTURE =
  process.env.TOOLBAR_XML ||
  path.resolve(__dirname, '../webapp/tests/fixtures/green-button-alliance-sample.xml');
const OUT = __dirname;

/**
 * Default: the widths the acceptance names — 1440, the 1024-1366 band, and
 * the 390 phone. TOOLBAR_WIDTHS overrides the list for an ad-hoc sweep.
 * (The PR gate sweeps a wider vw/vh set: VIEWPORT_SWEEP in the shared
 * module, driven by webapp/tests/e2e/toolbar-layout.spec.ts.)
 */
const WIDTHS = (process.env.TOOLBAR_WIDTHS || '1440,1366,1024,390').split(',').map((w) => {
  const width = Number(w);
  return { width, height: width < 640 ? 844 : 900, band: bandFor(width) };
});

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}

async function launch() {
  return chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

/** Fresh profile → upload the alliance fixture → totals strip on screen. */
async function openLoaded(browser, viewport) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
  const loaded = await page.getByTestId('totals-strip').waitFor({ timeout: 60_000 }).then(() => true, () => false);
  if (!loaded) throw new Error('upload never produced a totals strip');
  return { ctx, page };
}

async function run(browser, { width, height, band }) {
  const label = `${width}px`;
  const { ctx, page } = await openLoaded(browser, { width, height });
  try {
    const m = await page.evaluate(measureToolbarGeometry);
    for (const c of toolbarChecks(label, m, band)) check(c.name, c.ok, c.detail);
    if (m.error) return;

    const shot = path.join(OUT, `toolbar-${width}.png`);
    await page.locator('[data-testid="plan-switcher"]').locator('xpath=ancestor::*[contains(@class,"no-print")][1]').screenshot({ path: shot });
    console.log(`      rows: ${layoutSummary(m)}`);

    return m;
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture not found: ${FIXTURE}`);
    process.exit(2);
  }
  console.log(`base ${BASE} · fixture ${path.basename(FIXTURE)}`);

  const browser = await launch();
  const layouts = {};
  try {
    for (const w of WIDTHS) layouts[w.width] = (await run(browser, w)) || null;
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'toolbar',
    base: BASE,
    fixture: path.basename(FIXTURE),
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
    layouts,
  };
  const file = path.join(OUT, `toolbar-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
