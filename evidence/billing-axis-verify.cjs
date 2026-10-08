/**
 * Billing-axis browser verification — the file's own periods as the view's
 * timeline, the OPEN (unbilled) period, and the estimate ledger, on a running
 * stack with a REAL Oakville Hydro export (never committed; pass its path in).
 *
 * What it proves, in order:
 *   1. the export parses in the browser (readings + bills), no request
 *      carries the XML;
 *   2. the view OPENS on the period the newest readings are in — computed
 *      from localStorage, not from a hardcoded expectation;
 *   3. prev/next step one REAL billed period at a time and stop at the ends;
 *   4. the open period says what has been billed and what has not, with the
 *      estimate on its own and delivery/regulatory/HST explicitly unbilled;
 *   5. the stacked chart draws the open bar HATCHED (a fill referencing the
 *      estimate pattern) with an Estimate badge, and the delta column is
 *      flagged instead of showing a change against an unbilled window;
 *   6. the claim lands in `open_estimate_ledger`, unsettled, with the empty-state
 *      promise on screen;
 *   7. a claim the bills DO cover is scored automatically (the record shape
 *      the panel itself writes is seeded to exercise the close path) and the
 *      accuracy % appears once;
 *   8. none of it overflows a 390px phone.
 *
 * Run:  AXIS_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/billing-axis-verify.cjs
 * Env:  AXIS_BASE_URL (default http://127.0.0.1:3100/), AXIS_CHROMIUM,
 *       AXIS_SUFFIX (output suffix, e.g. "-long" / "-short")
 *
 * Writes evidence/billing-axis-verification{suffix}.json + axis-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.AXIS_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.AXIS_CHROMIUM || '/usr/bin/chromium';
const XML = process.env.AXIS_XML;
const SUFFIX = process.env.AXIS_SUFFIX || '';
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dollars = (s) => {
  const n = Number(String(s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(s ?? '').includes('$') ? n : null;
};
const dayKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function launch() {
  return chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({
    timezoneId: 'America/Toronto',
    locale: 'en-CA',
    viewport,
  });
  const page = await ctx.newPage();
  const traffic = [];
  page.on('request', (req) => traffic.push({ method: req.method(), url: req.url(), postData: req.postData() || '' }));
  return { ctx, page, traffic };
}

async function upload(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(XML);
  await page.getByTestId('totals-strip').waitFor({ timeout: 180_000 });
}

async function toInsights(page) {
  await page.getByText('INSIGHTS', { exact: true }).first().click();
  await page.getByTestId('insights-view').waitFor({ timeout: 30_000 });
}

const windows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('input[type="date"]')].map((i) => i.value),
  );

/**
 * The timeline the FILE describes, read straight out of localStorage so the
 * assertions below compare the UI against the data rather than against a
 * number somebody typed: the last bill's window (billingPeriod, extended to
 * the meter reads when the file states them — Wave L's rule) and the newest
 * reading.
 */
async function expectedTimeline(page) {
  return page.evaluate(() => {
    const summaries = JSON.parse(localStorage.getItem('usage_summaries') || '[]');
    const rows = JSON.parse(localStorage.getItem('energy_data') || '[]');
    const lastReading = rows.reduce((m, r) => Math.max(m, r.timestamp), 0);
    const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

    const withEnds = summaries.map((s) => {
      const readAt = (needle) => {
        for (const item of s.items) {
          if (!item.note.toLowerCase().includes(needle)) continue;
          if (!item.measurement || item.measurement.uom !== 27) continue;
          if (Number.isFinite(item.measurement.scaled) && item.measurement.scaled > 0) {
            return item.measurement.scaled;
          }
        }
        return null;
      };
      const prev = readAt('previous read date');
      const cur = readAt('current read date');
      const stampEnd = s.start + s.duration;
      const readsMatch =
        prev !== null && cur !== null && cur > prev && Math.abs(cur - prev - s.duration) <= 86400;
      // The open tail starts where the bill was READ (the later of the
      // billingPeriod stamp and the reads) — the same rule billingAxis uses.
      const billedThrough = Math.max(stampEnd, readsMatch ? cur : stampEnd);
      return {
        start: s.start,
        stampEnd,
        billedThrough,
        endDate: day(billedThrough),
        startDate: day(s.start),
      };
    });
    const last = withEnds[withEnds.length - 1];
    return {
      periods: withEnds,
      lastBilledThrough: last.endDate,
      openStart: day(last.billedThrough),
      openEnd: day(lastReading),
      lastReading: day(lastReading),
      count: summaries.length,
    };
  });
}

/* --------------------------------------------------------- desktop run --- */

async function desktopRun(browser) {
  const { ctx, page, traffic } = await newPage(browser, { width: 1600, height: 1200 });
  try {
    await upload(page);
    check('real export loaded (readings + totals strip)', await shown(page.getByTestId('totals-strip')));

    const summaries = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('usage_summaries') || '[]'),
    );
    check('the file’s billing periods parsed in the browser', summaries.length > 0, `${summaries.length} periods`);
    check(
      'no request carried the XML (parse stayed in the browser)',
      traffic.every((t) => ['GET', 'HEAD', 'OPTIONS'].includes(t.method) && !t.postData.includes('UsageSummary')),
      `${traffic.length} requests`,
    );

    // The bill panel lives on the Chart tab — read its figures before
    // switching, then compare the money panel against them.
    await shown(page.getByTestId('actual-payable'), 30_000);
    const payables = (await page.getByTestId('actual-payable').allInnerTexts()).map((t) => dollars(t));

    const expected = await expectedTimeline(page);

    // ---- 2. the window opens on the file's own period --------------------
    const opened = await windows(page);
    check(
      'first load opens the file’s own period (the unbilled tail), not a calendar month',
      opened[0] === expected.openStart && opened[1] === expected.openEnd,
      `window ${opened.join(' → ')} / expected ${expected.openStart} → ${expected.openEnd}`,
    );

    // ---- 3. prev/next step real bills ------------------------------------
    await page.getByRole('button', { name: 'Previous period' }).click();
    const prev = await windows(page);
    const lastBilled = expected.periods[expected.periods.length - 1];
    check(
      'previous steps to the last REAL billed period',
      prev[0] === lastBilled.startDate && prev[1] === lastBilled.endDate,
      `${prev.join(' → ')} / billed ${lastBilled.startDate} → ${lastBilled.endDate}`,
    );
    await page.getByRole('button', { name: 'Next period' }).click();
    await page.getByRole('button', { name: 'Next period' }).click();
    const again = await windows(page);
    check('next returns to the open tail', again[0] === expected.openStart && again[1] === expected.openEnd, again.join(' → '));
    await page.getByRole('button', { name: 'Next period' }).click();
    const clamped = await windows(page);
    check(
      'the last next clamps instead of wrapping to the oldest bill',
      clamped[0] === expected.openStart,
      clamped.join(' → '),
    );

    // ---- 4. the open-period panel ----------------------------------------
    await toInsights(page);
    const panel = page.getByTestId('open-period');
    check('OPEN PERIOD panel renders on Insights', await shown(panel, 30_000));

    const billedThroughDate = flat(await page.getByTestId('billed-through-date').textContent());
    check(
      '“billed through” is the last bill’s own end date',
      billedThroughDate === expected.lastBilledThrough,
      `${billedThroughDate} / expected ${expected.lastBilledThrough}`,
    );

    const billedThroughAmount = dollars(await page.getByTestId('billed-through-amount').textContent());
    check(
      '“billed through: $X actual” equals the actual-bill panel’s own figure',
      billedThroughAmount !== null && payables.length > 0 &&
        Math.abs(billedThroughAmount - payables[payables.length - 1]) < 0.005,
      `$${billedThroughAmount} vs panel $${payables[payables.length - 1]}`,
    );

    const unbilledDate = flat(await page.getByTestId('unbilled-since-date').textContent());
    const unbilledText = flat(await page.getByTestId('unbilled-since-amount').textContent());
    const unbilled = dollars(unbilledText);
    check('“unbilled since” is the day after the last bill was read', unbilledDate === expected.openStart, unbilledDate);
    check(
      'the unbilled figure is an ESTIMATE of commodity only',
      /estimated commodity/i.test(unbilledText) && unbilled !== null && unbilled > 0,
      unbilledText,
    );

    const caveat = flat(await page.getByTestId('open-period-caveat').textContent());
    check(
      'delivery / regulatory / HST are declared NOT billed yet',
      /not billed yet/i.test(caveat) && /delivery, regulatory and hst/i.test(caveat),
      caveat.slice(0, 220),
    );
    await panel.screenshot({ path: path.join(OUT, `axis-open-period${SUFFIX}.png`) });

    // ---- 5. the chart and the delta table --------------------------------
    const rows = page.getByTestId('money-row');
    await shown(rows.first());
    const rowCount = await rows.count();
    check(
      'one chart row per billed period PLUS the open period',
      rowCount === summaries.length + 1,
      `${rowCount} rows / ${summaries.length} bills`,
    );
    const badges = await page.getByTestId('money-row-badge').allInnerTexts();
    check('exactly one row carries the Estimate badge', badges.length === 1 && /estimate/i.test(badges[0]), badges.join(' | '));

    const flagged = await page.getByTestId('money-chart-flagged').count();
    check('the chart says hatched bars are not bills', flagged === 1);

    const hatched = await page.locator('[data-testid="money-chart"] [fill^="url(#est-hatch"]').count();
    check('the open bar is actually drawn with the hatch pattern', hatched > 0, `${hatched} hatched shapes`);

    const columnFlags = await page.getByTestId('money-column-flag').allInnerTexts();
    check('the delta table flags the open column', columnFlags.length === 1 && /estimate/i.test(columnFlags[0]), columnFlags.join(' | '));
    const deltaEstimates = await page.getByTestId('money-delta-estimate').count();
    check('the open column prints estimates, not changes', deltaEstimates >= 1, `${deltaEstimates} estimated cells`);

    await page.getByTestId('money-stacked').screenshot({ path: path.join(OUT, `axis-money-stacked${SUFFIX}.png`) });

    // ---- 6. the ledger ----------------------------------------------------
    const ledger = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('open_estimate_ledger') || 'null'),
    );
    check(
      'the claim is recorded in open_estimate_ledger',
      !!ledger && Array.isArray(ledger.open) && ledger.open.length === 1,
      ledger ? `open=${ledger.open.length} closed=${(ledger.closed || []).length}` : 'no ledger',
    );
    if (ledger && ledger.open[0]) {
      const rec = ledger.open[0];
      const startKey = new Date(rec.windowStart * 1000).toISOString().slice(0, 10);
      check(
        'the recorded window starts where the last bill was read',
        startKey === expected.openStart && rec.estimated > 0 && rec.meteredKwh > 0,
        `${startKey}, $${rec.estimated.toFixed(2)} over ${rec.meteredKwh.toFixed(1)} kWh (${rec.plan})`,
      );
    }
    check(
      'nothing has been billed for it yet, and the panel says so',
      await shown(page.getByTestId('estimate-accuracy-empty')),
      'waiting for a bill to close the window',
    );

    // ---- 7. the reconciliation loop --------------------------------------
    // Seed the record this browser WOULD have written when the last bill's
    // window was itself open (5% high), then reload: the app must close it
    // against the real bill and print the accuracy once.
    await page.evaluate(() => {
      const summariesNow = JSON.parse(localStorage.getItem('usage_summaries') || '[]');
      const target = summariesNow[summariesNow.length - 1];
      let actual = 0;
      for (const item of target.items) {
        const note = item.note.toLowerCase();
        if (item.amount === null || item.amount === undefined) continue;
        if (/^total\b|total electricity/.test(note)) continue;
        if (/h\.?s\.?t\.?|g\.?s\.?t\.?|\btax\b/.test(note)) continue;
        if (/delivery|distribution/.test(note) || /regulatory/.test(note)) continue;
        if (item.amount < 0 || /rebate|\bcredit\b/.test(note)) continue;
        if (/(off|mid|on)[ -]?peak|tiered|-peak|block|supply|commodity|energy charge/.test(note)) {
          actual += item.amount;
        }
      }
      const kwh = target.items
        .filter((i) => i.measurement && /usage$/.test(i.note.trim().toLowerCase()))
        .reduce((n, i) => n + i.measurement.scaled, 0);
      localStorage.setItem(
        'open_estimate_ledger',
        JSON.stringify({
          open: [
            {
              windowStart: target.start,
              windowEnd: target.start + target.duration,
              plan: 'TOU',
              estimated: actual * 1.05,
              meteredKwh: kwh,
              ratePerKwh: kwh > 0 ? (actual * 1.05) / kwh : 0,
            },
          ],
          closed: [],
        }),
      );
      return actual;
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('totals-strip').waitFor({ timeout: 120_000 });
    await toInsights(page);
    const accuracy = page.getByTestId('estimate-accuracy');
    check('a settled claim prints its accuracy once', await shown(accuracy, 30_000), flat(await accuracy.textContent()));
    const accuracyText = flat(await accuracy.textContent());
    check('the accuracy figure is a percentage', /\d+(\.\d+)?%/.test(accuracyText), accuracyText);
    const checkRow = page.getByTestId('estimate-check');
    check('the settled claim names both numbers', await shown(checkRow), flat(await checkRow.textContent()).slice(0, 240));
    await page.getByTestId('estimate-track-record').screenshot({
      path: path.join(OUT, `axis-estimate-accuracy${SUFFIX}.png`),
    });

    await page.screenshot({ path: path.join(OUT, `axis-insights-full${SUFFIX}.png`), fullPage: true });
  } finally {
    await ctx.close();
  }
}

/* ----------------------------------------------------------- mobile run -- */

async function mobileRun(browser) {
  const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
  try {
    await upload(page);
    await toInsights(page);
    const panel = page.getByTestId('open-period');
    check('OPEN PERIOD panel visible on a 390x844 phone', await shown(panel, 30_000));

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('no horizontal page overflow', overflow <= 0, `${overflow}px`);

    const badge = page.getByTestId('open-period-badge');
    const box = await badge.boundingBox();
    check('the estimate badge is readable on a phone', !!box && box.width > 40, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'not found');

    const innerScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="money-table"]')?.parentElement;
      return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
    });
    check('the wide table scrolls inside its own box', !!innerScroll && innerScroll.scroll >= innerScroll.client, JSON.stringify(innerScroll));

    await page.screenshot({ path: path.join(OUT, `axis-open-period-mobile${SUFFIX}.png`), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!XML || !fs.existsSync(XML)) {
    console.error('Set AXIS_XML to the real Oakville Hydro export (it is never committed).');
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
    wave: 'billing-axis',
    base: BASE,
    xml: path.basename(XML),
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  const file = path.join(OUT, `billing-axis-verification${SUFFIX}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`\n${passed}/${checks.length} checks passed — ${file}`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
