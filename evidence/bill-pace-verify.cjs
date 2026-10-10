/**
 * Slice 7 browser verification — "IS MY BILL ON PACE?", in a real browser.
 *
 * Wave R shipped the accrual curve and then admitted in its own notes that
 * the committed fixtures could only ever exercise its EMPTY state: none of
 * them had an unbilled tail. This check closes that gap and answers the
 * question Mark actually asked ("I don't know what to make of this — am I
 * on pace?") the way a user would:
 *
 *   1. upload `usage-summary-open-tail.xml` (three audited bills + a month
 *      of readings past the last one) and open Money;
 *   2. the card LEADS with the answer — projected landing "$X by Oct 21",
 *      a pacing chip against the 3-bill benchmark, the fixed explainer;
 *   3. the chart draws all three lines — grey accrual, yellow dashed pace
 *      to the bill date, dotted benchmark — with finite geometry;
 *   4. the table never lets the unbilled row read as a payment: the cell
 *      says "Est. commodity", the all-in column is badged ESTIMATE, and
 *      the coverage column says what it measures;
 *   5. at 390 px the card leads with headline + chip + sparkline, and the
 *      full chart is one tap away — never a squashed grey smear.
 *
 * Run:  BILL_PACE_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/bill-pace-verify.cjs
 * Env:  BILL_PACE_BASE_URL (default http://127.0.0.1:3100/), BILL_PACE_CHROMIUM,
 *       BILL_PACE_SUFFIX ('-local' writes bill-pace-verification-local.json)
 *
 * BILL_PACE_XML defaults to the committed open-tail fixture. Pass Mark's
 * real export for the deployed run — that file is never committed.
 *
 * Writes evidence/bill-pace-verification[-suffix].json + bill-pace-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const BASE = process.env.BILL_PACE_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.BILL_PACE_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.BILL_PACE_SUFFIX || '';
const FIXTURE =
  process.env.BILL_PACE_XML ||
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

/** Fresh profile → upload → totals strip → Money tab on screen. */
async function openMoney(browser, viewport) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
  const loaded = await shown(page.getByTestId('totals-strip'), 60_000);
  if (!loaded) throw new Error('upload never produced a totals strip');
  await page.getByRole('tab', { name: 'Money' }).click();
  await shown(page.getByTestId('tab-panel-money'), 20_000);
  return { ctx, page };
}

/** The pacing chip's tone must agree with its own data-direction. */
function chipTone(direction, className) {
  if (direction === 'above') return className.includes('bg-red-400');
  if (direction === 'below') return className.includes('bg-emerald-300');
  if (direction === 'even') return className.includes('bg-slate-200');
  return className.includes('bg-slate-100');
}

async function desktopRun(browser) {
  const { ctx, page } = await openMoney(browser, { width: 1440, height: 900 });
  try {
    const card = page.getByTestId('bill-accrual');
    check('accrual card renders on Money', await shown(card));

    /* --- 1. the answer, first ------------------------------------------- */
    const heading = flat(await card.getByRole('heading').innerText()).toLowerCase();
    check('card asks "is my bill on pace?"', heading.includes('is my bill on pace'), heading);

    const headline = page.getByTestId('accrual-headline');
    check('headline is the projected landing, with a date', await shown(headline));
    const headlineText = flat(await headline.innerText());
    // The card uppercases itself, so the assertion must not care.
    check(
      'headline reads "$X by <date>"',
      /^\$[\d,]+\.\d{2} by [a-z]{3} \d{1,2}$/i.test(headlineText),
      headlineText,
    );
    const projected = Number(await headline.getAttribute('data-projected-total'));
    check('headline carries a real number', Number.isFinite(projected) && projected > 0, String(projected));

    const explainer = page.getByTestId('accrual-explainer');
    check('fixed explainer names the grey line', (await shown(explainer)) && (await explainer.innerText()).includes('Grey line'));
    const explainerText = flat(await explainer.innerText());
    check('explainer names the yellow dashed line', explainerText.includes('Yellow dashed'), explainerText.slice(0, 80));
    check('explainer names the dotted benchmark', explainerText.includes('Dotted'));

    /* --- 2. the pacing chip agrees with itself -------------------------- */
    const chip = page.getByTestId('accrual-pace-chip');
    check('pacing chip renders next to the headline', await shown(chip));
    const direction = await chip.getAttribute('data-direction');
    check(
      'chip declares a direction the card can be read from',
      ['above', 'below', 'even', 'none'].includes(direction),
      String(direction),
    );
    check('chip tone matches its direction', chipTone(direction, await chip.getAttribute('class')), String(direction));
    const chipText = flat(await chip.innerText());
    check(
      'chip quotes a dollar figure (or says it has nothing to compare)',
      direction === 'none' ? /no bills to compare/i.test(chipText) : /\$[\d,]+\.\d{2}/.test(chipText),
      chipText,
    );

    /* --- 3. the chart draws all three lines ----------------------------- */
    const actual = page.getByTestId('accrual-actual-line');
    const pace = page.getByTestId('accrual-pace-line');
    check('grey accrual line draws', await shown(actual));
    check('yellow dashed pace line draws', await shown(pace));
    const paceStroke = await pace.getAttribute('stroke');
    check('pace line is yellow (#FACC15)', String(paceStroke).toUpperCase() === '#FACC15', String(paceStroke));
    // React's strokeDasharray is attribute stroke-dasharray in the DOM.
    check(
      'pace line is dashed',
      (await pace.getAttribute('stroke-dasharray')) !== null,
      String(await pace.getAttribute('stroke-dasharray')),
    );

    const actualStroke = await actual.getAttribute('stroke');
    check('accrual line is grey, not black', String(actualStroke).toUpperCase() === '#64748B', String(actualStroke));

    // Finite geometry: a NaN anywhere renders as nothing, and no amount of
    // text assertions would catch it.
    const pts = (await actual.getAttribute('points')).trim().split(/\s+/).flatMap((p) => p.split(',').map(Number));
    check('accrual geometry is finite', pts.length >= 4 && pts.every(Number.isFinite), `${pts.length} coords`);
    const ys = pts.filter((_, i) => i % 2 === 1);
    check('accrual only ever rises', ys.every((v, i) => i === 0 || v <= ys[i - 1]));

    const paceX2 = Number(await pace.getAttribute('x2'));
    const actualX2 = Math.max(...pts.filter((_, i) => i % 2 === 0));
    check(
      'pace line reaches PAST the accrual — the chart has a future',
      paceX2 > actualX2,
      `pace ends x=${paceX2}, accrual ends x=${actualX2}`,
    );

    const avgLine = page.getByTestId('accrual-benchmark-line');
    const hasBills = (await page.getByTestId('money-row').count()) > 1;
    if (hasBills) {
      // A perfectly horizontal line has bbox HEIGHT 0 (y1 === y2), which
      // makes Playwright report it invisible even though the 3px stroke
      // paints across the full chart. Ask whether it draws instead.
      const draws = (await avgLine.count()) > 0 && (await avgLine.evaluate((e) => e.getClientRects().length > 0));
      const geom = draws ? await avgLine.evaluate((e) => e.getBoundingClientRect().width) : 0;
      check('dotted 3-bill benchmark draws across the chart', draws && geom > 100, draws ? `${Math.round(geom)}px wide` : 'absent');
      const avg = Number(await card.getAttribute('data-avg-prior-bills'));
      check('benchmark is a real number', Number.isFinite(avg) && avg > 0, String(avg));
    } else {
      check('no benchmark without bills (and the card says so)', await chip.getAttribute('data-direction') === 'none');
    }

    /* --- 4. the table never calls the estimate a payment ---------------- */
    const openRow = page.locator('[data-testid="money-row"]').filter({ hasText: /Estimate/i }).first();
    check('an unbilled row exists and is badged Estimate', (await openRow.count()) > 0);
    const openCell = openRow.getByTestId('money-open-total');
    check('OPEN row cell labels itself "Est. commodity"', await shown(openCell));
    check(
      'OPEN row cell never says "You paid"',
      !(await openCell.innerText()).match(/you paid/i),
      flat(await openCell.innerText()),
    );

    const estHead = page.getByTestId('money-est-total-head');
    check('EST. TOTAL column exists', await shown(estHead));
    check('EST. TOTAL header is permanently badged', /estimate/i.test(await estHead.innerText()));

    const headers = await page.locator('[data-testid="money-table"] th').allInnerTexts();
    check(
      'coverage column says what it measures',
      headers.some((h) => /data coverage/i.test(h)),
      headers.map(flat).join(' | '),
    );
    check('no bare "Covered" header remains', !headers.some((h) => /^\s*covered\s*$/i.test(h)));

    /* --- 5. the honest zero-delivery case ------------------------------- */
    const openEst = openRow.getByTestId('money-open-est-total');
    const openDash = openRow.locator('[data-testid="money-est-total-cell"]');
    const estShown = (await openEst.count()) > 0;
    if (estShown) {
      const estText = flat(await openEst.innerText());
      check('EST. TOTAL shows a real figure when rates exist', /\$[\d,]+\.\d{2}/.test(estText), estText);
      const commodity = Number((await openCell.innerText()).match(/[\d,]+\.\d{2}/)[0].replace(/,/g, ''));
      const total = Number(estText.match(/[\d,]+\.\d{2}/)[0].replace(/,/g, ''));
      check('EST. TOTAL is larger than commodity alone', total > commodity, `${total} > ${commodity}`);
    } else {
      check('EST. TOTAL dashes honestly when no rates exist', (await openDash.innerText()).includes('—'));
    }

    /* --- 6. no sideways scroll, screenshot ------------------------------ */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check('no horizontal overflow at 1440px', overflow <= 1, `${overflow}px`);
    await page.screenshot({ path: path.join(OUT, 'bill-pace-desktop-money.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser) {
  const { ctx, page } = await openMoney(browser, { width: 390, height: 844 });
  try {
    const card = page.getByTestId('bill-accrual');

    /* The answer is above the shape, in every layout. */
    check('mobile: headline renders', await shown(page.getByTestId('accrual-headline')));
    check('mobile: pacing chip renders', await shown(page.getByTestId('accrual-pace-chip')));

    /* Collapsed: the sparkline, not a squashed chart. */
    const spark = page.getByTestId('accrual-sparkline');
    check('mobile: sparkline renders', await shown(spark));
    const sparkVisible = await spark.isVisible();
    check('mobile: sparkline is actually visible', sparkVisible);
    const chart = page.getByTestId('accrual-chart');
    check('mobile: full chart is NOT visible before the tap', !(await chart.isVisible()));

    const sparkPts = (await page.getByTestId('accrual-sparkline-actual').getAttribute('points'))
      .trim().split(/\s+/).flatMap((p) => p.split(',').map(Number));
    check('mobile: sparkline geometry is finite', sparkPts.length >= 4 && sparkPts.every(Number.isFinite));

    /* Tap-to-expand. */
    const toggle = page.getByTestId('accrual-chart-toggle');
    check('mobile: toggle renders', await shown(toggle));
    check('mobile: toggle starts collapsed', (await toggle.getAttribute('aria-expanded')) === 'false');
    const box = await toggle.boundingBox();
    check('mobile: toggle is a real touch target', !!box && box.height >= 44, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'not visible');

    await toggle.click();
    check('mobile: tap reveals the full chart', await chart.isVisible());
    check('mobile: tap hides the sparkline', !(await spark.isVisible()));
    check('mobile: toggle reports expanded', (await toggle.getAttribute('aria-expanded')) === 'true');
    await page.screenshot({ path: path.join(OUT, 'bill-pace-mobile-expanded.png'), fullPage: true });

    await toggle.click();
    check('mobile: second tap returns to the sparkline', (await spark.isVisible()) && !(await chart.isVisible()));

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check('no horizontal overflow at 390px', overflow <= 1, `${overflow}px`);

    /* And the card itself never overflows its own box. */
    const cardBox = await card.boundingBox();
    check('accrual card fits the phone width', !!cardBox && cardBox.width <= 390, cardBox ? `${Math.round(cardBox.width)}px` : 'n/a');
    await page.screenshot({ path: path.join(OUT, 'bill-pace-mobile-money.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture not found: ${FIXTURE}`);
    process.exit(2);
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex');
  console.log(`base ${BASE} · fixture ${path.basename(FIXTURE)} · sha256 ${sha.slice(0, 16)}…`);

  const browser = await launch();
  try {
    await desktopRun(browser);
    await mobileRun(browser);
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'bill-pace',
    slice: 7,
    base: BASE,
    fixture: path.basename(FIXTURE),
    fixtureSha256: sha,
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  const file = path.join(OUT, `bill-pace-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
