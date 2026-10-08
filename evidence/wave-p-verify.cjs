/**
 * Wave P browser verification — the real 24-period Oakville export on a
 * running stack.
 *
 * Uploads Mark's actual 2024→2026 export (NEVER committed; pass its path in)
 * into a fresh browser profile and checks what Wave P exists to do:
 *
 *   1. the file's identity is pinned (sha256) before anything runs — the
 *      assertions below are ground truth for THIS file only;
 *   2. plan-type detection fingerprints all 24 billing periods from the
 *      bill's own charge lines: TOU×3 · Tiered×5 · TOU×5 · Tiered×6 · TOU×5;
 *   3. the timeline editor works end to end (add → plan_timeline in
 *      localStorage → invalid range refused with a message → remove);
 *   4. the switch track record: 24 rows, 2 honest skips, 22 counted rows
 *      whose model reproduces its own bill within $1, the audited net
 *      saving headline, and the per-period alternatives for the audited
 *      2026-07 period (Total Electricity Charges $442.10, paid $395.68,
 *      Tiered/ULO modeled ABOVE it — the overnight folklore dies here);
 *   5. it all fits on a phone.
 *
 * Run:  WAVE_P_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-p-verify.cjs
 * Env:  WAVE_P_BASE_URL (default http://10.10.11.110:3939/), WAVE_P_CHROMIUM
 *
 * Writes evidence/wave-p-verification.json + wave-p-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const BASE = process.env.WAVE_P_BASE_URL || 'http://10.10.11.110:3939/';
const CHROMIUM = process.env.WAVE_P_CHROMIUM || '/usr/bin/chromium';
const XML = process.env.WAVE_P_XML;
const OUT = __dirname;

/** The exact file every expectation below was computed from. */
const XML_SHA256 = 'e292de50a560f56e117dc1bdb12a6c7f3d2b650525e421e437281853677b2f37';

/** Detection ground truth for that file (24 periods, oldest first). */
const PLAN_SEQUENCE = [
  ...Array(3).fill('TOU'),
  ...Array(5).fill('Tiered'),
  ...Array(5).fill('TOU'),
  ...Array(6).fill('Tiered'),
  ...Array(5).fill('TOU'),
];

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

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({
    timezoneId: 'America/Toronto',
    locale: 'en-CA',
    viewport,
  });
  const page = await ctx.newPage();
  const traffic = [];
  page.on('request', (req) => {
    traffic.push({ method: req.method(), url: req.url(), postData: req.postData() || '' });
  });
  return { ctx, page, traffic };
}

async function uploadRealXml(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(XML);
  await page.getByTestId('totals-strip').waitFor({ timeout: 180_000 });
}

const stored = (page, key) =>
  page.evaluate((k) => localStorage.getItem(k), key);

async function desktopRun(browser) {
  const { ctx, page, traffic } = await newPage(browser, { width: 1600, height: 1200 });
  try {
    await uploadRealXml(page);
    check('real 24-period export loaded', await shown(page.getByTestId('totals-strip')));

    // ---- the file half landed in localStorage, client-side ----------------
    const summaries = JSON.parse((await stored(page, 'usage_summaries')) || '[]');
    check('usage_summaries: 24 billing periods', summaries.length === 24, `${summaries.length}`);
    check(
      'the periods are the real 2024-08-26 … 2026-07-22',
      summaries[0]?.startDate === '2024-08-26' &&
        summaries[23]?.startDate === '2026-07-22' &&
        JSON.stringify(summaries.map((s) => s.startDate).slice(0, 3)) ===
          JSON.stringify(['2024-08-26', '2024-09-25', '2024-10-25']),
      `${summaries[0]?.startDate} … ${summaries[23]?.startDate}`,
    );
    const jul = summaries.find((s) => s.startDate === '2026-07-22');
    const julTotal = (jul?.items || [])
      .filter((i) => i.note === 'Total Electricity Charges')
      .reduce((t, i) => t + (i.amount ?? 0), 0);
    check('audited Total Electricity Charges $442.10 for 2026-07-22', julTotal.toFixed(2) === '442.10', `$${julTotal.toFixed(2)}`);
    check(
      'no request carried the XML (parse stayed in the browser)',
      traffic.every((t) => ['GET', 'HEAD', 'OPTIONS'].includes(t.method) && !t.postData.includes('UsageSummary')),
      `${traffic.length} requests, methods: ${[...new Set(traffic.map((t) => t.method))].join('/')}`,
    );

    // ---- slice 1: detection off the bill's own lines ----------------------
    const timeline = page.getByTestId('plan-timeline');
    check('plan-type timeline panel is visible', await shown(timeline));
    const periodNodes = page.locator('[data-testid^="plan-timeline-period-"]');
    const periodCount = await periodNodes.count();
    check('all 24 periods are fingerprinted', periodCount === 24, `${periodCount}`);
    const plans = [];
    const origins = [];
    for (let i = 0; i < periodCount; i += 1) {
      plans.push(await periodNodes.nth(i).getAttribute('data-plan'));
      origins.push(await periodNodes.nth(i).getAttribute('data-origin'));
    }
    check(
      'detection sequence: TOU×3 · Tiered×5 · TOU×5 · Tiered×6 · TOU×5',
      JSON.stringify(plans) === JSON.stringify(PLAN_SEQUENCE),
      plans.map((p) => (p === 'Tiered' ? 'T' : 'O')).join(''),
    );
    check('every period detected from bill lines (no guesses)', origins.every((o) => o === 'detected'), [...new Set(origins)].join(','));

    const tieredEvidence = await page
      .getByTestId('plan-timeline-period-2024-11-25')
      .getByTestId('plan-timeline-evidence')
      .textContent();
    check('Tiered row shows the BLOCK line as evidence', /BLOCK 1/i.test(flat(tieredEvidence)), flat(tieredEvidence).slice(0, 80));
    const touEvidence = await page
      .getByTestId('plan-timeline-period-2026-07-22')
      .getByTestId('plan-timeline-evidence')
      .textContent();
    check('TOU row shows the Peak-Summer line as evidence', /Peak-Summer/i.test(flat(touEvidence)), flat(touEvidence).slice(0, 80));

    // ---- slice 2: the timeline editor -------------------------------------
    await page.getByTestId('plan-timeline-add').click();
    check('adding an entry writes plan_timeline (next to billing_day)', await shown(page.getByTestId('plan-timeline-entry')));
    let tl = JSON.parse((await stored(page, 'plan_timeline')) || '[]');
    check('plan_timeline persisted in localStorage', tl.length === 1, JSON.stringify(tl).slice(0, 120));
    // billing_day is only WRITTEN when the user changes it (a fresh profile
    // runs on the default without storing anything), so touch it and prove
    // both keys live in the same store the timeline was written to.
    const bday = page.getByLabel('Billing day of month');
    if (await shown(bday, 5_000)) await bday.fill('5');
    check(
      'billing_day writes to the same localStorage, next to the timeline',
      (await stored(page, 'billing_day')) === '5' && (await stored(page, 'plan_timeline')) !== null,
      `billing_day=${await stored(page, 'billing_day')}`,
    );

    await page.getByTestId('plan-timeline-entry-to').fill('2020-01-01');
    const err = page.getByTestId('plan-timeline-error');
    check('an end date before the start is refused, with a message', await shown(err, 5_000), flat(await err.textContent()).slice(0, 90));
    tl = JSON.parse((await stored(page, 'plan_timeline')) || '[]');
    check('nothing invalid ever reaches storage', tl.length === 1 && tl[0].from !== '2020-01-01' && tl[0].to !== '2020-01-01', JSON.stringify(tl[0] || {}).slice(0, 120));

    await page.getByTestId('plan-timeline-entry-plan').selectOption('Tiered');
    await page.getByTestId('plan-timeline-entry-from').fill('2024-01-01');
    await page.getByTestId('plan-timeline-entry-to').fill('2024-06-30');
    tl = JSON.parse((await stored(page, 'plan_timeline')) || '[]');
    check('editing plan + range persists', tl[0]?.plan === 'Tiered' && tl[0]?.from === '2024-01-01' && tl[0]?.to === '2024-06-30', JSON.stringify(tl[0] || {}).slice(0, 140));

    // a declaration covering NO loaded period must change nothing (the bill
    // still wins / detection is untouched)
    const badgeBefore = await page.getByTestId('plan-timeline-period-2026-07-22').getAttribute('data-plan');
    check('a declaration outside the file does not disturb detection', badgeBefore === 'TOU', badgeBefore);

    await page.getByTestId('plan-timeline-entry-remove').click();
    tl = JSON.parse((await stored(page, 'plan_timeline')) || '[]');
    check('removing empties the timeline again', tl.length === 0, JSON.stringify(tl));

    await page.getByTestId('plan-timeline').screenshot({ path: path.join(OUT, 'wave-p-timeline-desktop.png') });

    // ---- slices 3+4: the switch track record ------------------------------
    const record = page.getByTestId('switch-track-record');
    check('switch track record is visible', await shown(record));
    const rows = page.locator('[data-testid^="switch-row-"]');
    check('one row per billing period (24)', (await rows.count()) === 24, `${await rows.count()}`);

    const sub = flat(await page.getByTestId('switch-headline-sub').textContent());
    check(
      'headline counts 22 modeled-and-trusted periods of 24',
      /across 22 counted periods of 24/.test(sub),
      sub,
    );
    const total = flat(await page.getByTestId('switch-overpaid-total').textContent());
    // report.overpaid = −$251.89 → headline prints the saving as $251.89
    check('audited net saving headline = $251.89', total === '$251.89', total);
    const byPlan = flat(await page.getByTestId('switch-by-plan').textContent());
    check(
      'per-plan breakdown: TOU 11 periods $210.25 saved · Tiered 11 periods $41.64 saved',
      /Time-of-Use: 11 periods.*\$210\.25 saved/.test(byPlan) && /Tiered: 11 periods.*\$41\.64 saved/.test(byPlan),
      byPlan.slice(0, 200),
    );

    const skips = page.getByTestId('switch-skip');
    const skipCount = await skips.count();
    check('exactly 2 periods honestly skipped (no readings / 67% cover)', skipCount === 2, `${skipCount}`);
    const skipTexts = skipCount === 2 ? [(await skips.nth(0).textContent()), (await skips.nth(1).textContent())].map((t) => flat(t).toLowerCase()) : [];
    check('skip reasons name the coverage, not a number', skipTexts.some((t) => t.includes('no readings')) && skipTexts.some((t) => t.includes('67%')), skipTexts.join(' | ').slice(0, 160));

    const chips = page.getByTestId('switch-model-check');
    const chipCount = await chips.count();
    let passedChips = 0;
    let excludedChips = 0;
    for (let i = 0; i < chipCount; i += 1) {
      const t = flat(await chips.nth(i).textContent());
      if (t.includes('Model check ✓')) passedChips += 1;
      if (t.includes('excluded from the total')) excludedChips += 1;
    }
    check('all 22 modeled rows reproduce their own bill (✓, counted)', passedChips === 22 && excludedChips === 0, `✓=${passedChips} excluded=${excludedChips}`);

    // the audited period: what was paid vs the alternatives (modeled)
    const julRow = page.getByTestId('switch-row-2026-07-22');
    check('2026-07-22 row is on TOU', (await julRow.getAttribute('data-plan')) === 'TOU', await julRow.getAttribute('data-plan'));
    const julActual = flat(await julRow.getByTestId('switch-actual').textContent());
    check('paid $395.68 in 2026-07-22', julActual === '$395.68', julActual);
    const tieredModeled = flat(await julRow.getByTestId('switch-modeled-Tiered').textContent());
    const uloModeled = flat(await julRow.getByTestId('switch-modeled-ULO').textContent());
    check('Tiered modeled ABOVE the bill ($428.87)', tieredModeled.includes('$428.87'), flat(tieredModeled).slice(0, 60));
    check('ULO modeled ABOVE the bill ($463.67) — his load is NOT overnight-heavy', uloModeled.includes('$463.67'), flat(uloModeled).slice(0, 60));
    const julSaving = flat(await julRow.getByTestId('switch-saving').textContent());
    check('negative saving shown honestly (−$33.19 = already cheapest)', julSaving.includes('−$33.19'), julSaving);
    check('every alternative cell is labelled modeled', (await julRow.getByText('modeled', { exact: false }).count()) >= 2, `${await julRow.getByText('modeled', { exact: false }).count()} labels`);

    const callouts = page.locator('[data-testid^="switch-callout-"]');
    check('3 biggest-miss callouts', (await callouts.count()) === 3, `${await callouts.count()}`);

    await page.getByTestId('switch-track-record').screenshot({ path: path.join(OUT, 'wave-p-track-record-desktop.png') });
    await page.screenshot({ path: path.join(OUT, 'wave-p-desktop-full.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser) {
  const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
  try {
    await uploadRealXml(page);
    check('timeline visible on a 390x844 phone', await shown(page.getByTestId('plan-timeline')));
    check('track record visible on the phone', await shown(page.getByTestId('switch-track-record')));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check('no horizontal overflow', overflow <= 0, `${overflow}px`);
    const tap = await page.getByTestId('plan-timeline-add').boundingBox();
    check('add-entry button is touch-sized (>=44px)', !!tap && tap.height >= 44, tap ? `${Math.round(tap.width)}x${Math.round(tap.height)}` : 'not found');
    await page.getByTestId('plan-timeline').scrollIntoViewIfNeeded();
    await page.getByTestId('plan-timeline').screenshot({ path: path.join(OUT, 'wave-p-timeline-mobile.png') });
    await page.getByTestId('switch-track-record').screenshot({ path: path.join(OUT, 'wave-p-track-record-mobile.png') });
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!XML || !fs.existsSync(XML)) {
    console.error('Set WAVE_P_XML to the real Oakville Hydro export (it is never committed).');
    process.exit(2);
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(XML)).digest('hex');
  if (sha !== XML_SHA256) {
    console.error(`Refusing: sha256 ${sha} is not the audited file (${XML_SHA256}).`);
    process.exit(3);
  }
  console.log(`sha256 ok: ${sha.slice(0, 16)}… ${path.basename(XML)}`);

  const browser = await launch();
  try {
    await desktopRun(browser);
    await mobileRun(browser);
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'P',
    base: BASE,
    xml: path.basename(XML),
    xmlSha256: sha,
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  fs.writeFileSync(path.join(OUT, 'wave-p-verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/wave-p-verification.json`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
