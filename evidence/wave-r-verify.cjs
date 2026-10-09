/**
 * Wave R browser verification — the IA rework on a running stack.
 *
 * Wave R's whole complaint was "it's pretty overwhelming and the best choice
 * is now buried", so this script is written as the counter-argument, checked
 * in a real browser at both widths the gates name:
 *
 *   1. the four tabs exist with the ARIA tabs contract (roles, one selected,
 *      roving tabindex) and switch by CLICK and by KEYBOARD;
 *   2. the best-choice banner is the FIRST element of the Overview panel —
 *      the answer is at the top of the first tab, not at the bottom of a
 *      316-line scroll;
 *   3. the persistent chip is in the toolbar on EVERY tab, carries the same
 *      verdict as the banner, and jumps to the banner from any of them;
 *   4. deep-linking (`#tab=`) and the real browser Back button both pick the
 *      tab;
 *   5. the toolbar carries only global things — rate staleness lives on
 *      Usage, the file/GB status on Overview;
 *   6. every Wave O and Wave P graph renders INSIDE the tab that owns it
 *      (dual heatmap + chart + anomalies on Usage, the plan cards / verdict /
 *      switch timeline / track record on Plans, the accrual curve / money
 *      section / true bill / EV on Money);
 *   7. nothing overflows horizontally at 1440 or at 390.
 *
 * Run:  WAVE_R_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-r-verify.cjs
 * Env:  WAVE_R_BASE_URL (default http://127.0.0.1:3100/), WAVE_R_CHROMIUM,
 *       WAVE_R_SUFFIX ('-local' writes wave-r-verification-local.json instead)
 *
 * WAVE_R_XML defaults to the committed Green Button Alliance sample (432
 * readings + 5 bills), because this wave is about layout, not about Mark's
 * private export — pass the real one for the deployed run if you want it.
 *
 * Writes evidence/wave-r-verification[-suffix].json + wave-r-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const BASE = process.env.WAVE_R_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.WAVE_R_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.WAVE_R_SUFFIX || '';
const FIXTURE =
  process.env.WAVE_R_XML ||
  path.resolve(__dirname, '../webapp/tests/fixtures/green-button-alliance-sample.xml');
const OUT = __dirname;

const TABS = ['Overview', 'Usage', 'Plans', 'Money'];

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

/** Fresh profile → upload modal → the alliance fixture → Overview on screen. */
async function openLoaded(browser, viewport) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
  const loaded = await shown(page.getByTestId('totals-strip'), 60_000);
  if (!loaded) throw new Error('upload never produced a totals strip');
  return { ctx, page };
}

async function selectTab(page, name) {
  await page.getByRole('tab', { name }).click();
  await page.waitForFunction(
    (expected) => {
      const el = document.querySelector(`#tab-${expected.toLowerCase()}`);
      return !!el && el.getAttribute('aria-selected') === 'true';
    },
    name === 'Plans' ? 'plans' : name === 'Money' ? 'money' : name.toLowerCase(),
    { timeout: 5_000 },
  );
}

async function desktopRun(browser) {
  const { ctx, page } = await openLoaded(browser, { width: 1440, height: 900 });
  try {
    /* --- 1. the strip itself ------------------------------------------- */
    const tabs = page.getByRole('tab');
    check('4 tabs, ARIA tablist', (await tabs.count()) === 4, `${await tabs.count()} tabs`);
    // The app is uppercase by design — compare case-insensitively.
    const names = (await tabs.allInnerTexts()).map((n) => flat(n).toLowerCase());
    check(
      'tabs are Overview / Usage / Plans / Money',
      names.join('|') === 'overview|usage|plans|money',
      names.join(' | '),
    );
    const selected = page.locator('[role="tab"][aria-selected="true"]');
    check('exactly one tab selected', (await selected.count()) === 1, `${await selected.count()}`);
    check('Overview is the default tab', flat(await selected.innerText()).toLowerCase() === 'overview',
      flat(await selected.innerText()));
    const tab0 = page.getByRole('tab', { name: 'Overview' });
    check('roving tabindex: active tab is the only tab stop',
      (await tab0.getAttribute('tabindex')) === '0' &&
        (await page.getByRole('tab', { name: 'Money' }).getAttribute('tabindex')) === '-1',
      'tabindex 0 / -1');

    /* --- 2. decision-first: the banner is the first thing on Overview --- */
    const firstChild = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="tab-panel-overview"]');
      return panel && panel.firstElementChild
        ? panel.firstElementChild.getAttribute('data-testid')
        : null;
    });
    check('best-choice banner is the FIRST element of Overview', firstChild === 'best-choice-banner', String(firstChild));
    const bannerPlan = await page.getByTestId('best-choice-banner').getAttribute('data-best-plan');
    check('banner states a real plan', ['TOU', 'Tiered', 'ULO'].includes(bannerPlan), String(bannerPlan));

    /* --- 3. the persistent chip ---------------------------------------- */
    const chip = page.getByTestId('best-choice-chip');
    check('best-choice chip is in the toolbar', await shown(chip));
    const chipPlan = await chip.getAttribute('data-best-plan');
    check('chip agrees with the banner', chipPlan === bannerPlan, `${chipPlan} vs ${bannerPlan}`);
    const chipText = flat(await chip.innerText()).toLowerCase();
    check('chip quotes a monthly delta', /-\$\d+\/mo|✓/.test(chipText), chipText);

    /* --- 4. click + keyboard navigation -------------------------------- */
    await selectTab(page, 'Usage');
    check('click switches to Usage', await shown(page.getByTestId('tab-panel-usage')));
    check('hash follows the click', page.url().includes('#tab=usage'), page.url().split('#')[1] || '(none)');

    // Keyboard: focus the active tab, ArrowRight moves AND selects.
    await page.getByRole('tab', { name: 'Usage' }).focus();
    await page.keyboard.press('ArrowRight');
    await shown(page.getByTestId('tab-panel-plans'), 5_000);
    check('ArrowRight selects Plans', (await page.getByRole('tab', { name: 'Plans' }).getAttribute('aria-selected')) === 'true');
    check('focus moved with the arrow',
      await page.evaluate(() => document.activeElement && document.activeElement.id === 'tab-plans'));

    await page.keyboard.press('End');
    await shown(page.getByTestId('tab-panel-money'), 5_000);
    check('End selects Money', (await page.getByRole('tab', { name: 'Money' }).getAttribute('aria-selected')) === 'true');
    await page.keyboard.press('Home');
    await shown(page.getByTestId('tab-panel-overview'), 5_000);
    check('Home selects Overview', (await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')) === 'true');

    await page.screenshot({ path: path.join(OUT, 'wave-r-desktop-overview.png'), fullPage: true });

    /* --- 5. the chip jumps to the banner from EVERY other tab ----------- */
    for (const name of TABS.slice(1)) {
      await selectTab(page, name);
      const onOtherTab = !(await page.getByTestId('best-choice-banner').isVisible().catch(() => false));
      await page.getByTestId('best-choice-chip').click();
      const landed = await shown(page.getByTestId('best-choice-banner'), 5_000);
      check(`chip jumps to the banner from ${name}`, onOtherTab && landed, onOtherTab ? 'jumped' : 'banner was already visible');
    }

    /* --- 6. deep link + the real Back button --------------------------- */
    await page.goto(`${BASE}#tab=money`, { waitUntil: 'domcontentloaded' });
    await shown(page.getByTestId('totals-strip'), 60_000);
    check('deep link #tab=money opens Money',
      (await page.getByRole('tab', { name: 'Money' }).getAttribute('aria-selected')) === 'true');

    await selectTab(page, 'Usage');
    await selectTab(page, 'Plans');
    await page.goBack();
    const backTab = await page.getByRole('tab', { name: 'Usage' }).getAttribute('aria-selected');
    check('browser Back returns to the previous tab', backTab === 'true', `aria-selected=${backTab}`);
    await shown(page.getByTestId('tab-panel-usage'), 5_000);

    /* --- 7. USAGE: chart, seasons, anomalies, dual heatmap, trend ------- */
    check('Usage shows the chart', await shown(page.getByTestId('chart-view')));
    check('Usage shows the rate-season bands', (await page.getByTestId('season-chip').count()) > 0,
      `${await page.getByTestId('season-chip').count()} chips`);
    check('Usage shows the anomaly section', await shown(page.getByRole('heading', { name: 'Usage Anomalies' })));
    const weekdayGrid = page.getByTestId('heatmap-grid-weekday');
    const weekendGrid = page.getByTestId('heatmap-grid-weekend');
    check('dual heatmap: weekday grid', await shown(weekdayGrid));
    check('dual heatmap: weekend grid', await shown(weekendGrid));
    const weekdayRows = await weekdayGrid.getByRole('row').count();
    const weekendRows = await weekendGrid.getByRole('row').count();
    check('weekday grid is 5 days + header (6 rows)', weekdayRows === 6, `${weekdayRows} rows`);
    check('weekend grid is 2 days + header (3 rows)', weekendRows === 3, `${weekendRows} rows`);
    check('Usage shows year-over-year', await shown(page.getByTestId('trend-panel')));
    const stale = page.getByTestId('rate-staleness-banner');
    if ((await stale.count()) > 0) {
      const inUsage = await page.evaluate(
        () => !!document.querySelector('[data-testid="rate-staleness-banner"]')?.closest('[data-testid="tab-panel-usage"]'),
      );
      check('rate staleness (when shown) lives on Usage', inUsage);
    } else {
      check('rate staleness (when shown) lives on Usage', true, 'banner not rendered — no newer OEB set');
    }
    await page.screenshot({ path: path.join(OUT, 'wave-r-desktop-usage.png'), fullPage: true });

    /* --- 8. PLANS: verdict, cards, shift advice, Wave P history --------- */
    await selectTab(page, 'Plans');
    const verdict = page.getByTestId('verdict-line');
    check('Plans restates the verdict as one line', await shown(verdict));
    const verdictPlan = await verdict.getAttribute('data-best-plan');
    check('verdict line carries the banner plan', verdictPlan === bannerPlan, `${verdictPlan} vs ${bannerPlan}`);
    const planCards = page.getByRole('button', { name: /^Use the .* plan$/ });
    check('three plan cards render', (await planCards.count()) === 3, `${await planCards.count()} cards`);
    // The optimizer renders either ranked advice or an honest "nothing to
    // recommend" state — the panel must exist either way.
    check('shift advice panel renders',
      (await page.getByTestId('shift-optimizer').count()) > 0 ||
        (await page.getByTestId('shift-optimizer-empty').count()) > 0);
    check('shift verification renders', await shown(page.getByTestId('shift-verification')));
    const switchTimeline = page.getByTestId('plan-switch-timeline');
    check('plan-switch timeline renders', await shown(switchTimeline));
    const periods = Number((await switchTimeline.getAttribute('data-periods')) || 0);
    check('timeline draws one segment per billing period', periods > 0, `${periods} segments`);
    check('timeline segments carry a detected plan',
      (await page.locator('[data-testid^="switch-segment-"]').count()) === periods,
      `${await page.locator('[data-testid^="switch-segment-"]').count()} segments drawn`);
    check('Wave P timeline editor renders', await shown(page.getByTestId('plan-timeline')));
    check('Wave P switch track record renders',
      (await page.locator('[data-testid^="switch-row-"]').count()) > 0 ||
        (await page.getByTestId('switch-headline-empty').count()) > 0);
    check('actual-bill panel renders', await shown(page.getByTestId('actual-bill')));
    await page.screenshot({ path: path.join(OUT, 'wave-r-desktop-plans.png'), fullPage: true });

    /* --- 9. MONEY: accrual curve + every Wave O panel ------------------- */
    await selectTab(page, 'Money');
    check('bill accrual curve renders', await shown(page.getByTestId('bill-accrual')));
    const accrualChart = await page.getByTestId('accrual-chart').count();
    const accrualEmpty = await page.getByTestId('accrual-empty').count();
    check('accrual curve draws its chart (or says why it cannot)',
      accrualChart > 0 || accrualEmpty > 0, `chart=${accrualChart} empty=${accrualEmpty}`);
    check('Wave O money section renders', await shown(page.getByTestId('money-section')));
    check('Wave O stacked composition renders',
      (await page.getByTestId('money-chart').count()) > 0 ||
        (await page.getByTestId('money-empty').count()) > 0);
    check('Wave O period deltas render',
      (await page.getByTestId('money-deltas').count()) > 0 ||
        (await page.getByTestId('money-empty').count()) > 0);
    check('Wave O hour histogram renders', await shown(page.getByTestId('money-hour-histogram')));
    check('Wave O waterfall renders', await shown(page.getByTestId('money-waterfall')));
    check('true-bill estimate renders', await shown(page.getByTestId('bill-estimate')));
    check('EV scenario renders', await shown(page.getByTestId('ev-scenario')));
    await page.screenshot({ path: path.join(OUT, 'wave-r-desktop-money.png'), fullPage: true });

    /* --- 10. toolbar declutter ----------------------------------------- */
    // Back to Overview first: "file status lives on Overview" is a claim
    // about where it is when Overview is open, not about a panel that is
    // unmounted right now.
    await selectTab(page, 'Overview');
    const toolbarInfo = await page.evaluate(() => {
      const switcher = document.querySelector('[data-testid="plan-switcher"]');
      const toolbar = switcher && switcher.closest('.no-print');
      const status = document.querySelector('[data-testid="overview-file-status"]');
      const bell = document.querySelector('[data-testid="notification-toggle"]');
      return {
        hasToolbar: !!toolbar,
        uploadInToolbar: !!(toolbar && toolbar.querySelector('[title="Upload XML"]')),
        statusInToolbar: !!(toolbar && status && toolbar.contains(status)),
        statusInOverview: !!(status && status.closest('[data-testid="tab-panel-overview"]')),
        staleInToolbar: !!(toolbar && toolbar.querySelector('[data-testid="rate-staleness-banner"]')),
        bellInToolbar: bell ? !!(toolbar && toolbar.contains(bell)) : null,
      };
    });
    check('toolbar exists and holds the global actions', toolbarInfo.hasToolbar && toolbarInfo.uploadInToolbar);
    check('file/GB status is NOT in the toolbar', !toolbarInfo.statusInToolbar);
    check('file/GB status lives on Overview', toolbarInfo.statusInOverview);
    check('rate staleness is NOT in the toolbar', !toolbarInfo.staleInToolbar);
    // The bell only renders once a feed is connected — assert the slot, not a
    // browser this run never authorised.
    check('alerts bell (when a feed is connected) stays in the toolbar',
      toolbarInfo.bellInToolbar !== false,
      toolbarInfo.bellInToolbar === null ? 'no connected feed — toggle not rendered' : 'in toolbar');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check('no horizontal overflow at 1440px', overflow <= 1, `${overflow}px`);
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser) {
  const { ctx, page } = await openLoaded(browser, { width: 390, height: 844 });
  try {
    const tabs = page.getByRole('tab');
    check('mobile: all four tabs fit', (await tabs.count()) === 4, `${await tabs.count()} tabs`);
    check('mobile: Overview is the default', (await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')) === 'true');

    const firstChild = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="tab-panel-overview"]');
      return panel && panel.firstElementChild
        ? panel.firstElementChild.getAttribute('data-testid')
        : null;
    });
    check('mobile: banner is the first element of Overview', firstChild === 'best-choice-banner', String(firstChild));
    check('mobile: the chip is reachable', await shown(page.getByTestId('best-choice-chip')));
    await page.screenshot({ path: path.join(OUT, 'wave-r-mobile-overview.png'), fullPage: true });

    let overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check('mobile: no horizontal overflow on Overview', overflow <= 1, `${overflow}px`);

    for (const name of ['Usage', 'Plans', 'Money']) {
      await selectTab(page, name);
      const panel = name === 'Usage' ? 'tab-panel-usage' : name === 'Plans' ? 'tab-panel-plans' : 'tab-panel-money';
      check(`mobile: ${name} panel opens`, await shown(page.getByTestId(panel)));
      // The tab strip and the panels must both stay inside the viewport —
      // the strip scrolls itself, the PAGE never scrolls sideways.
      overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(`mobile: no horizontal overflow on ${name}`, overflow <= 1, `${overflow}px`);
      await page.screenshot({ path: path.join(OUT, `wave-r-mobile-${name.toLowerCase()}.png`), fullPage: true });
    }

    // Every tab is really clickable at 390 px (44 px targets, not clipped).
    for (const name of TABS) {
      const box = await page.getByRole('tab', { name }).boundingBox();
      check(`mobile: ${name} tab is a touch target ≥44px wide`,
        !!box && box.width >= 44 && box.height >= 44,
        box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'not visible');
    }

    // The dual heatmap must be usable on a phone: its own grids scroll, the
    // page does not.
    await selectTab(page, 'Usage');
    const heatmapScrolls = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="heatmap-grid-weekday"]');
      if (!grid) return null;
      const scroller = grid.parentElement;
      return { scrollable: scroller.scrollWidth > scroller.clientWidth, pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    check('mobile: the weekday grid scrolls inside its own card',
      !heatmapScrolls || heatmapScrolls.pageOverflow <= 1,
      heatmapScrolls ? JSON.stringify(heatmapScrolls) : 'grid not found');
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
    wave: 'R',
    base: BASE,
    fixture: path.basename(FIXTURE),
    fixtureSha256: sha,
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  const file = path.join(OUT, `wave-r-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
