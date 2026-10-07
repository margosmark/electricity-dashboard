/**
 * Wave L browser verification — the real bill, on a running stack.
 *
 * Uploads Mark's actual Oakville Hydro export (NEVER committed; pass its
 * path in) into a fresh browser profile and checks what the feature exists
 * to do:
 *
 *   1. the UsageSummary bills + the feed's clock land in localStorage
 *      (client-side invariant: no server round trip carries the XML),
 *   2. "Your actual bill" shows all three real periods with the utility's own
 *      wording and the real payable amounts,
 *   3. the commodity cross-check passes within a dollar for the period this
 *      browser has full coverage of, and honestly skips the ones it cannot
 *      compare,
 *   4. the True Bill inputs are pre-filled from the file with no typing, and
 *      the estimate-vs-actual delta lands within a dollar,
 *   5. it all fits on a phone.
 *
 * Run:  WAVE_L_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-l-verify.cjs
 * Env:  WAVE_L_BASE_URL (default http://127.0.0.1:3100/), WAVE_L_CHROMIUM
 *
 * Writes evidence/wave-l-verification.json + wave-l-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.WAVE_L_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.WAVE_L_CHROMIUM || '/usr/bin/chromium';
const XML = process.env.WAVE_L_XML;
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** True once the locator shows up within `timeout` (isVisible() alone races). */
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

/** Land on the app with an empty profile (the upload modal is the first screen). */
async function openApp(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
}

/** Fresh profile → upload the real export → wait for the dashboard. */
async function uploadRealXml(page) {
  if (page.url() === 'about:blank') await openApp(page);
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(XML);
  await page.getByTestId('totals-strip').waitFor({ timeout: 90_000 });
}

const stored = (page, key) =>
  page.evaluate((k) => localStorage.getItem(k), key);

/** "Δ −$0.01" / "Δ $0.24" from a strip — U+2212 is the app's minus sign. */
function deltaFrom(text) {
  const m = flat(text).match(/[Δδ] ([-−]?)\$([\d.]+)/);
  if (!m) return null;
  return Number(`${m[1].replace('−', '-')}${m[2]}`);
}

async function desktopRun(browser) {
  const { ctx, page, traffic } = await newPage(browser, { width: 1600, height: 1200 });
  try {
    await openApp(page);
    check('empty profile opens the upload modal', await shown(page.locator('input[type="file"][accept=".xml"]'), 30_000));

    await uploadRealXml(page);
    check('real Oakville readings loaded', await shown(page.getByTestId('totals-strip')));
    const windowHasRows = await shown(page.getByTestId('bill-estimate'));
    check(
      'the estimate window has rows (True Bill card can render)',
      windowHasRows,
      windowHasRows ? flat(await page.getByTestId('variable-estimate').textContent()) : 'no bill-estimate',
    );

    // ---- the bill half landed in localStorage, client-side -----------------
    const summaries = JSON.parse((await stored(page, 'usage_summaries')) || '[]');
    check('usage_summaries written by the browser', summaries.length === 3, `${summaries.length} periods`);
    check(
      'periods are the real 2026-05-25 / 06-23 / 07-22, 29 days each',
      JSON.stringify(summaries.map((s) => s.startDate)) ===
        JSON.stringify(['2026-05-25', '2026-06-23', '2026-07-22']) &&
        summaries.every((s) => s.days === 29),
      JSON.stringify(summaries.map((s) => `${s.startDate}+${s.days}d`)),
    );
    const clock = JSON.parse((await stored(page, 'local_time_parameters')) || 'null');
    check(
      "the feed's own clock (LocalTimeParameters) was captured",
      clock && clock.tzOffset === -18000 && clock.dstStartRule === '360E2000' && clock.dstOffset === 3600,
      JSON.stringify(clock),
    );
    check(
      'no request carried the XML (parse stayed in the browser)',
      traffic.every(
        (t) => ['GET', 'HEAD', 'OPTIONS'].includes(t.method) && !t.postData.includes('UsageSummary'),
      ),
      `${traffic.length} requests, methods: ${[...new Set(traffic.map((t) => t.method))].join('/')}`,
    );

    // ---- the panel ---------------------------------------------------------
    const panel = page.getByTestId('actual-bill');
    const panelShown = await shown(panel);
    check('"Your actual bill" panel is visible', panelShown);
    const periods = page.getByTestId('actual-bill-period');
    const periodCount = panelShown ? await periods.count() : 0;
    check('all three billing periods are shown', periodCount === 3, `${periodCount}`);

    // the card is uppercased in CSS, so compare case-insensitively
    const labels = (await page.getByTestId('actual-bill-period').allInnerTexts()).map((t) =>
      flat(t).toLowerCase(),
    );
    check(
      'the real period labels are on screen',
      ['may 25', 'jun 23', 'jul 22'].every((d) => labels.some((t) => t.includes(d))),
      labels.map((t) => t.slice(0, 46)).join(' | '),
    );

    const paid = await page.getByTestId('actual-payable').allInnerTexts();
    check(
      'the real amounts actually paid per period',
      JSON.stringify(paid.map(flat)) === JSON.stringify(['$406.65', '$419.38', '$395.68']),
      paid.map(flat).join(' · '),
    );

    const panelText = flat(await panel.textContent());
    check(
      "the utility's own line-item wording is verbatim",
      ['Total Electricity Charges', 'Ontario Electricity Rebate', 'Delivery', 'Regulatory Charges', 'Off Peak-Summer'].every(
        (w) => panelText.includes(w),
      ),
    );
    check(
      'the HST line keeps its account number as the file wrote it',
      /H\.S\.T\. # \d{6,}/.test(panelText),
      (panelText.match(/H\.S\.T\. # \d{6,}/) || ['none'])[0],
    );

    // ---- the cross-check ---------------------------------------------------
    const checksOn = await page.getByTestId('commodity-check').count();
    const mismatches = await page.getByTestId('commodity-mismatch').count();
    const skipped = await page.getByTestId('commodity-skip').count();
    check('exactly one period is comparable (full coverage)', checksOn === 1, `check=${checksOn} mismatch=${mismatches} skip=${skipped}`);
    check('periods we cannot cover are skipped, not faked', skipped === 2, `skip=${skipped}`);
    const verdict = checksOn ? flat(await page.getByTestId('commodity-check').textContent()) : '';
    const d = deltaFrom(verdict);
    check(
      'commodity: our estimate vs Oakville within $1',
      checksOn === 1 && d !== null && Math.abs(d) <= 1,
      verdict || 'no check rendered',
    );
    check('no red rate-assumptions banner', (await page.getByTestId('rate-assumptions-banner').count()) === 0);

    // innerText is uppercased by CSS and the delta lowercases too, so match
    // both cases of Δ
    const cross = (await page.getByTestId('kwh-crosscheck').allInnerTexts()).map((t) =>
      flat(t).toLowerCase(),
    );
    const crossDeltas = cross.map((t) => {
      const m = t.match(/[δΔ] ([\d,.]+) kwh/);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    });
    check(
      'billed kWh vs our own interval readings agree',
      crossDeltas.some((d) => d !== null && Math.abs(d) < 50),
      cross.join(' | '),
    );

    // ---- auto-populated True Bill -----------------------------------------
    const val = async (id) => (await page.getByTestId(id).inputValue());
    const deliveryKwh = await val('charge-delivery-per-kwh');
    const deliveryFlat = await val('charge-delivery-flat');
    const regulatory = await val('charge-regulatory-per-kwh');
    const hst = await val('charge-hst-pct');
    check(
      'True Bill inputs are pre-filled with no typing',
      Number(deliveryKwh) > 0 && Number(deliveryFlat) > 0 && Number(regulatory) > 0 && Number(hst) > 0,
      `$/kWh=${deliveryKwh} $/mo=${deliveryFlat} reg=${regulatory} hst=${hst}`,
    );
    check('HST is the file’s 13%', hst === '13', hst);
    check('provenance caption names the period', (await page.getByTestId('xml-charge-source').count()) === 1, flat(await page.getByTestId('xml-charge-source').textContent()).slice(0, 120));
    const billShown = await shown(page.getByTestId('true-bill'));
    check('True Bill Estimate appears untouched', billShown, billShown ? flat(await page.getByTestId('true-bill-total').textContent()) : 'absent');

    const vsCount = await page.getByTestId('true-bill-vs-actual').count();
    const vs = vsCount ? flat(await page.getByTestId('true-bill-vs-actual').textContent()) : '';
    const est = Number((vs.match(/Your estimate\$([\d.]+)/) || [,''])[1]);
    const actual = Number((vs.match(/Oakville billed\$([\d.]+)/) || [,''])[1]);
    check(
      'estimated vs actual for the sourced period, within $1',
      Number.isFinite(est) && Number.isFinite(actual) && Math.abs(est - actual) <= 1,
      `estimate=$${est} actual=$${actual} (Δ $${(est - actual).toFixed(2)})`,
    );

    // ---- screenshots -------------------------------------------------------
    await panel.screenshot({ path: path.join(OUT, 'wave-l-actual-bill-desktop.png') });
    await page.getByTestId('bill-estimate').screenshot({ path: path.join(OUT, 'wave-l-true-bill-desktop.png') });
    await page.screenshot({ path: path.join(OUT, 'wave-l-desktop-full.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser) {
  const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
  try {
    await uploadRealXml(page);
    const panel = page.getByTestId('actual-bill');
    check('panel visible on a 390x844 phone', await shown(panel));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check('no horizontal overflow with the bill open', overflow <= 0, `${overflow}px`);
    const tap = await page.getByTestId('actual-bill-all').boundingBox();
    check(
      'period picker buttons are touch-sized (>=44px)',
      !!tap && tap.height >= 44,
      tap ? `${Math.round(tap.width)}x${Math.round(tap.height)}` : 'not found',
    );
    await panel.screenshot({ path: path.join(OUT, 'wave-l-actual-bill-mobile.png') });
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!XML || !fs.existsSync(XML)) {
    console.error('Set WAVE_L_XML to the real Oakville Hydro export (it is never committed).');
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
    wave: 'L',
    base: BASE,
    xml: path.basename(XML),
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  fs.writeFileSync(path.join(OUT, 'wave-l-verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/wave-l-verification.json`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
