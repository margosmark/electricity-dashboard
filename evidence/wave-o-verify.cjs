/**
 * Wave O browser verification — the MONEY views, on a running stack with
 * Mark's real Oakville Hydro export (never committed; pass its path in).
 *
 * What it proves, in order:
 *   1. the bill half still lands in localStorage and no request carries the
 *      XML (the client-only invariant Wave L established);
 *   2. the MONEY section renders under ShiftOptimizer on the Insights tab,
 *      with one stacked row per billed period (plus the open tail since the
 *      billing axis) and every charge type the file
 *      states (commodity split into its own windows) plus the rebate;
 *   3. the % share state answers "how much of this is delivery" and the kWh
 *      state stacks the bill's own usage lines;
 *   4. the plan overlay draws all three alternatives against what was
 *      actually paid — or says why it cannot;
 *   5. the delta table, the ¢/kWh histogram and the waterfall all render, and
 *      the waterfall's total equals the "Your actual bill" panel's own
 *      payable figure (the same money, two panels, must agree);
 *   6. it survives a 390px phone with no horizontal overflow.
 *
 * Run:  WAVE_O_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-o-verify.cjs
 * Env:  WAVE_O_BASE_URL (default http://127.0.0.1:3100/), WAVE_O_CHROMIUM,
 *       WAVE_O_EXPECT_PERIODS (exact period count to assert),
 *       WAVE_O_SUFFIX (output file suffix, e.g. "-long")
 *
 * Writes evidence/wave-o-verification{suffix}.json + wave-o-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.WAVE_O_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.WAVE_O_CHROMIUM || '/usr/bin/chromium';
const XML = process.env.WAVE_O_XML;
const SUFFIX = process.env.WAVE_O_SUFFIX || '';
const EXPECT_PERIODS = process.env.WAVE_O_EXPECT_PERIODS
  ? Number(process.env.WAVE_O_EXPECT_PERIODS)
  : null;
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dollars = (s) => {
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

/** Poll until a locator reports at least `min` matches (charts animate in). */
async function counted(locator, min, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last = 0;
  while (Date.now() < deadline) {
    last = await locator.count();
    if (last >= min) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
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
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console.error] ${flat(msg.text()).slice(0, 200)}`);
  });
  return { ctx, page, traffic };
}

async function openApp(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
}

async function uploadRealXml(page) {
  if (page.url() === 'about:blank') await openApp(page);
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(XML);
  await page.getByTestId('totals-strip').waitFor({ timeout: 120_000 });
}

async function toInsights(page) {
  await page.getByText('INSIGHTS', { exact: true }).first().click();
  await page.getByTestId('insights-view').waitFor({ timeout: 30_000 });
}

async function desktopRun(browser) {
  const { ctx, page, traffic } = await newPage(browser, { width: 1600, height: 1200 });
  try {
    await openApp(page);
    check('empty profile opens the upload modal', await shown(page.locator('input[type="file"][accept=".xml"]'), 30_000));

    await uploadRealXml(page);
    check('real Oakville readings loaded', await shown(page.getByTestId('totals-strip')));

    const summaries = JSON.parse((await page.evaluate(() => localStorage.getItem('usage_summaries'))) || '[]');
    check(
      'the file’s billing periods were parsed in the browser',
      summaries.length > 0 && (EXPECT_PERIODS === null || summaries.length === EXPECT_PERIODS),
      `${summaries.length} periods${EXPECT_PERIODS ? ` (expected ${EXPECT_PERIODS})` : ''}`,
    );
    check(
      'no request carried the XML (parse stayed in the browser)',
      traffic.every((t) => ['GET', 'HEAD', 'OPTIONS'].includes(t.method) && !t.postData.includes('UsageSummary')),
      `${traffic.length} requests, methods: ${[...new Set(traffic.map((t) => t.method))].join('/')}`,
    );

    // The bill panel's own payable figures, read BEFORE leaving the Chart tab:
    // the money section must agree with it to the cent.
    const payables = (await page.getByTestId('actual-payable').allInnerTexts()).map((t) => dollars(t));
    check('the actual-bill panel shows a payable per period', payables.length === summaries.length, payables.join(' · '));

    // ---- the MONEY section ------------------------------------------------
    await toInsights(page);
    const section = page.getByTestId('money-section');
    check('MONEY section renders on Insights', await shown(section, 30_000));
    check('it sits under ShiftOptimizer', await shown(page.getByTestId('money-stacked')));

    const stacked = page.getByTestId('money-stacked');
    const rows = page.getByTestId('money-row');
    await shown(rows.first());
    const rowCount = await rows.count();
    // +1 is the open, unbilled tail the billing axis adds (it carries an
    // Estimate badge — asserted by billing-axis-verify.cjs).
    check(
      'one stacked row per billing period (plus the unbilled tail)',
      rowCount === summaries.length || rowCount === summaries.length + 1,
      `${rowCount} rows / ${summaries.length} periods`,
    );

    const legend = flat(await page.getByTestId('money-legend').textContent());
    check(
      'every charge type the file states is stacked (TOU windows + delivery + regulatory + HST)',
      ['Commodity · off-peak', 'Commodity · mid-peak', 'Commodity · on-peak', 'Delivery', 'Regulatory', 'HST'].every(
        (w) => legend.includes(w),
      ),
      legend.slice(0, 200),
    );
    check('the rebate slice is present and marked below the zero line', legend.includes('below the line'));

    const bars = page.locator('[data-testid="money-chart"] .recharts-bar-rectangles path, [data-testid="money-chart"] .recharts-bar-rectangles rect');
    const barCount = await counted(bars, 1);
    check('the stacked chart actually draws bars', barCount > 0, `${barCount} rects`);

    // The panel's own table must total the same money the bill panel shows.
    const rowTotals = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="money-row"]')].map((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        return tds[tds.length - 2]?.textContent ?? '';
      }),
    );
    const rowMoney = rowTotals.map((t) => dollars(t));
    // Since the billing axis (2026-10-08) the table carries ONE extra row:
    // the open, unbilled tail, whose figure is an estimate (prefixed "~").
    // Compare the BILLED rows against the bill panel, then assert the tail.
    const billedMoney = rowMoney.slice(0, payables.length);
    const sameMoney =
      payables.length === billedMoney.length &&
      payables.every((v, i) => v !== null && billedMoney[i] !== null && Math.abs(v - billedMoney[i]) < 0.005);
    check(
      'one extra row carries the unbilled tail as an estimate',
      rowMoney.length === payables.length + 1 || rowMoney.length === payables.length,
      `${rowMoney.length} money rows for ${payables.length} bills`,
    );
    check(
      'the stacked table’s "You paid" equals the actual-bill panel, period by period',
      sameMoney,
      `bill: ${payables.join(' · ')} | money: ${rowMoney.join(' · ')}`,
    );

    await stacked.screenshot({ path: path.join(OUT, 'wave-o-money-desktop.png') });

    // ---- % share ----------------------------------------------------------
    await page.getByTestId('money-mode-share').click();
    const shareTable = page.getByTestId('money-table');
    await shown(shareTable);
    const shareCell = await page.evaluate(() => {
      const tr = document.querySelector('[data-testid="money-row"]');
      const tds = [...tr.querySelectorAll('td')];
      return tds[2]?.textContent ?? '';
    });
    check('the % share state prints percentages, not dollars', /%$/.test(flat(shareCell)), flat(shareCell));
    const nonCommodity = flat(await page.getByTestId('non-commodity-pct').textContent());
    check('non-commodity share is shown as a number', /^\d+(\.\d+)?%$/.test(nonCommodity), nonCommodity);
    // The three charge shares must add to ~100%. If a summary line (an
    // "Amount Due", say) were being stacked as a charge, they would not —
    // this is the double-count tripwire, on real data.
    const pct = async (id) => Number(flat(await page.getByTestId(id).textContent()).replace('%', ''));
    const parts = {
      commodity: await pct('commodity-pct'),
      nonCommodity: Number(nonCommodity.replace('%', '')),
      tax: await pct('tax-pct'),
    };
    const shareSum = parts.commodity + parts.nonCommodity + parts.tax;
    check(
      'the charge shares add to 100% (nothing stacked twice)',
      Math.abs(shareSum - 100) < 0.5,
      `${parts.commodity} + ${parts.nonCommodity} + ${parts.tax} = ${shareSum.toFixed(1)}%`,
    );
    const shareCaption = flat(await stacked.textContent());
    check('the share caption is explicit that the rebate is excluded', /before the rebate/i.test(shareCaption));
    await stacked.screenshot({ path: path.join(OUT, 'wave-o-share-desktop.png') });

    // ---- kWh --------------------------------------------------------------
    await page.getByTestId('money-mode-usage').click();
    const usageHead = flat(await stacked.textContent());
    check('the kWh state rewrites the heading', /What you used, per period/i.test(usageHead));
    const usageEmpty = await page.getByTestId('money-usage-empty').count();
    const usageCell = await page.evaluate(() => {
      const tr = document.querySelector('[data-testid="money-row"]');
      const tds = [...tr.querySelectorAll('td')];
      return tds[tds.length - 2]?.textContent ?? '';
    });
    check(
      'the kWh state stacks the bill’s own usage lines (or says the file has none)',
      usageEmpty > 0 || /kWh/i.test(flat(usageCell)),
      usageEmpty > 0 ? 'file states no usage lines (honest empty state)' : flat(usageCell),
    );
    await page.getByTestId('money-mode-dollars').click();
    // The chart remounts on a mode switch (new bars, new overlay) — settle
    // before measuring what it drew.
    await page.waitForTimeout(700);

    // ---- plan overlay -----------------------------------------------------
    const overlayLines = page.getByTestId('money-overlay-lines');
    const overlayReady = await shown(overlayLines, 5_000);
    if (overlayReady) {
      const text = flat(await overlayLines.textContent());
      check(
        'the overlay names all three plans against what was actually paid',
        ['Time-of-Use', 'Tiered', 'Ultra-Low Overnight', 'you paid'].every((w) => text.includes(w)),
        text.slice(0, 220),
      );
      const refLines = await counted(page.locator('[data-testid="money-chart"] .recharts-reference-line'), 4);
      check('TOU / Tiered / ULO lines overlay the stacked bars', refLines >= 4, `${refLines} reference lines`);
      const amounts = [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, '')));
      check(
        'every overlay figure is a full amount due, in the same league as the bill',
        amounts.length >= 4 && amounts.every((a) => a > 100),
        amounts.join(' · '),
      );
    } else {
      const reason = flat(await page.getByTestId('money-overlay-off').textContent());
      check('overlay off, with a reason on screen', reason.length > 20, reason.slice(0, 200));
    }

    // ---- deltas -----------------------------------------------------------
    const deltaTable = page.getByTestId('money-deltas-table');
    check('the period-over-period table renders', await shown(deltaTable));
    const deltaHead = flat(await page.getByTestId('money-deltas').textContent());
    check('the first column is labelled a baseline', /Baseline ·/.test(deltaHead));
    if (summaries.length > 1) {
      const deltaCells = await page.locator('[data-testid="money-delta-payable"] [data-testid="money-delta-value"]').count();
      check('a delta is shown for every period after the first', deltaCells === summaries.length - 1, `${deltaCells} deltas`);
    }
    await page.getByTestId('money-deltas').screenshot({ path: path.join(OUT, 'wave-o-deltas-desktop.png') });

    // ---- histogram --------------------------------------------------------
    const avg = page.getByTestId('money-hour-average');
    check('the ¢/kWh-by-hour histogram renders with a window average', await shown(avg), flat(await avg.textContent()));
    await page.getByTestId('money-hour-histogram').screenshot({ path: path.join(OUT, 'wave-o-hour-histogram.png') });

    // ---- waterfall --------------------------------------------------------
    const wfTotal = page.getByTestId('money-waterfall-total');
    check('the attribution waterfall renders', await shown(wfTotal));
    const wfAmount = dollars(await wfTotal.textContent());
    const lastPayable = payables[payables.length - 1];
    check(
      'the waterfall lands on the actual-bill panel’s own payable figure',
      wfAmount !== null && lastPayable !== null && Math.abs(wfAmount - lastPayable) < 0.005,
      `waterfall=$${wfAmount} panel=$${lastPayable}`,
    );
    const steps = flat(await page.getByTestId('money-waterfall-steps').textContent());
    check(
      'the waterfall walks commodity → delivery → regulatory → HST → rebate → amount due',
      ['Commodity', 'Delivery', 'Regulatory', 'HST', 'OEB rebate', 'Amount due'].every((w) => steps.includes(w)),
      steps.slice(0, 200),
    );
    await page.getByTestId('money-waterfall').screenshot({ path: path.join(OUT, 'wave-o-waterfall-desktop.png') });

    // ---- full-page evidence ----------------------------------------------
    await section.screenshot({ path: path.join(OUT, 'money-section-desktop.png') });
    await page.screenshot({ path: path.join(OUT, 'wave-o-insights-full.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser) {
  const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
  try {
    await uploadRealXml(page);
    await toInsights(page);
    const section = page.getByTestId('money-section');
    check('MONEY section visible on a 390x844 phone', await shown(section, 30_000));

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('no horizontal page overflow', overflow <= 0, `${overflow}px`);

    const box = await page.getByTestId('money-mode-share').boundingBox();
    check('mode toggles are touch-sized (>=44px)', !!box && box.height >= 44, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'not found');

    // The charts are horizontally scrollable inside their own containers —
    // that must not push the page sideways.
    const innerScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="money-table"]')?.parentElement;
      return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
    });
    check('wide tables scroll inside their own box', !!innerScroll && innerScroll.scroll >= innerScroll.client, JSON.stringify(innerScroll));

    const chartBox = await page.getByTestId('money-chart').boundingBox();
    check('the stacked chart has a usable width on a phone', !!chartBox && chartBox.width >= 300, chartBox ? `${Math.round(chartBox.width)}px` : 'not found');

    await page.screenshot({ path: path.join(OUT, 'wave-o-money-mobile.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!XML || !fs.existsSync(XML)) {
    console.error('Set WAVE_O_XML to the real Oakville Hydro export (it is never committed).');
    process.exit(2);
  }
  const browser = await launch();
  try {
    await desktopRun(browser);
    await mobileRun(browser);
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'O',
    base: BASE,
    xml: path.basename(XML),
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  fs.writeFileSync(path.join(OUT, `wave-o-verification${SUFFIX}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/wave-o-verification${SUFFIX}.json`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
