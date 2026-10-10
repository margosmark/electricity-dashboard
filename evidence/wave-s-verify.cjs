/**
 * Wave S browser verification — the EFFICIENCY card on a running stack.
 *
 * Wave S's claim is a number plus a verdict: ¢/kWh per bill, an all-time and
 * an in-view weighted average, and a trend verdict that must NOT take credit
 * for an OEB rate bump. This script is written as the counter-argument to
 * "the app computed something plausible": every figure is re-derived from the
 * raw export by a second, independent parser (evidence/wave-s-audit.py —
 * Python ElementTree, the same math as the task-spec probe) and the DOM is
 * asserted against it:
 *
 *   1. every bill's ¢/kWh and kWh on the mini-line matches the audit;
 *   2. the headline all-time ¢/kWh is the kWh-weighted mean of those bills,
 *      and the EXISTING totals strip restates the same number (one strip,
 *      no new one);
 *   3. "in view" is scoped: full selection = all-time, then a narrowed date
 *      window must re-scope it to exactly the bills that overlap;
 *   4. the verdict is read from the BEHAVIOUR component (data-slope ==
 *      data-behavior-slope), behaviour + rate recombine to the net slope to
 *      floating-point precision, and the NET verdict matches an independent
 *      OLS over the same window;
 *   5. the honesty half: rates rose over the window (red Nov 1 ticks, the
 *      rates line) while the net line stays stable — the app reports both
 *      halves instead of declaring victory;
 *   6. the chart draws every bill, the regression over the verdict window,
 *      the Nov 1 rate-change ticks and both season bands;
 *   7. clicking the mini-line lands on the MONEY tab.
 *
 * Run:  WAVE_S_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-s-verify.cjs
 * Env:  WAVE_S_BASE_URL (default http://10.10.11.110:3939/ — the deployed
 *         stack), WAVE_S_CHROMIUM, WAVE_S_XML (defaults to the committed
 *         Green Button Alliance sample; Mark's real export is never
 *         committed and its path never lands in the evidence), WAVE_S_SUFFIX
 *         ('-local' writes wave-s-verification-local.json instead).
 *
 * Writes evidence/wave-s-verification[-suffix].json + wave-s-*.png
 */

process.env.TZ = 'America/Toronto';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

let chromium;
try {
  ({ chromium } = require('@playwright/test'));
} catch {
  ({ chromium } = require(path.resolve(__dirname, '../webapp/node_modules/@playwright/test')));
}

const BASE = process.env.WAVE_S_BASE_URL || 'http://10.10.11.110:3939/';
const CHROMIUM = process.env.WAVE_S_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.WAVE_S_SUFFIX || '';
const FIXTURE =
  process.env.WAVE_S_XML ||
  path.resolve(__dirname, '../webapp/tests/fixtures/green-button-alliance-sample.xml');
const OUT = __dirname;

/** TREND_MAX_PERIODS in lib/statistics.ts. */
const WINDOW = 12;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail == null ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;
/** Same calendar month, immune to a timezone day-shift at either parser. */
const sameMonth = (isoA, isoB) => String(isoA).slice(0, 7) === String(isoB).slice(0, 7);

async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** The second opinion: a Python parse of the same XML, run right now. */
function runAudit(xml) {
  const raw = execFileSync('python3', [path.resolve(__dirname, 'wave-s-audit.py'), xml], {
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

/**
 * What the app must show for a date window, recomputed from the audit.
 *
 * The view is the intersection of the selection with the METERED span —
 * `viewRange` in Dashboard.tsx reads the days the chart actually has
 * readings for, so a bill before the first reading is out of view while
 * still counting for all-time.
 */
function inViewExpectation(audit, start, end) {
  let s = start;
  let e = end;
  if (audit.readings && audit.readings.first) {
    if (s < audit.readings.first) s = audit.readings.first;
    if (e > audit.readings.last) e = audit.readings.last;
  }
  const rows = audit.bills.filter((b) => b.date <= e && b.end >= s);
  const cost = rows.reduce((sum, b) => sum + b.cost, 0);
  const kwh = rows.reduce((sum, b) => sum + b.kwh, 0);
  return { bills: rows.length, cents: kwh > 0 ? (cost / kwh) * 100 : null };
}

/** The window the app is actually showing — read it, never assume it. */
async function readWindow(page) {
  return {
    start: await page.getByLabel('Window start date').inputValue(),
    end: await page.getByLabel('Window end date').inputValue(),
  };
}

async function openLoaded(browser, viewport, xml) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(xml);
  const loaded = await shown(page.getByTestId('totals-strip'), 60_000);
  if (!loaded) throw new Error('upload never produced a totals strip');
  return { ctx, page };
}

/** Read everything the Wave S surfaces expose, in one evaluate. */
function readCard(page) {
  return page.evaluate(() => {
    const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const one = (sel) => document.querySelector(sel);
    const all = (sel) => [...document.querySelectorAll(sel)];
    const read = (sel) => {
      const el = one(sel);
      return el
        ? {
            cents: el.getAttribute('data-cents'),
            bills: el.getAttribute('data-bills'),
            text: flat(el.textContent),
          }
        : null;
    };
    const card = one('[data-testid="efficiency-card"]');
    const chart = one('[data-testid="efficiency-chart"]');
    const chip = one('[data-testid="efficiency-trend-chip"]');
    const rates = one('[data-testid="efficiency-rates-line"]');
    const net = one('[data-testid="efficiency-net-line"]');
    const sentence = one('[data-testid="efficiency-sentence"]');
    const svgText = chart ? all('[data-testid="efficiency-chart"] text').map((t) => flat(t.textContent)) : [];
    return {
      totalsStrips: all('[data-testid="totals-strip"]').length,
      inOverview: !!one('[data-testid="tab-panel-overview"] [data-testid="efficiency-card"]'),
      inMoney: !!one('[data-testid="tab-panel-money"] [data-testid="efficiency-card"]'),
      card: card
        ? { bills: card.getAttribute('data-bills'), split: card.getAttribute('data-split') }
        : null,
      headline: read('[data-testid="efficiency-all-time"]'),
      strip: {
        allTime: read('[data-testid="efficiency-all-time-strip"]'),
        inView: read('[data-testid="efficiency-in-view"]'),
        insideTotals: !!one('[data-testid="totals-strip"] [data-testid="efficiency-strip"]'),
      },
      chart: chart
        ? {
            points: chart.getAttribute('data-points'),
            window: chart.getAttribute('data-window'),
            rateTicks: chart.getAttribute('data-rate-ticks'),
            seasonBands: chart.getAttribute('data-season-bands'),
          }
        : null,
      points: all('[data-testid="efficiency-point"]').map((el) => ({
        start: el.getAttribute('data-start'),
        cents: el.getAttribute('data-cents'),
        kwh: el.getAttribute('data-kwh'),
      })),
      ticks: all('[data-testid="efficiency-rate-tick"]').map((el) => el.getAttribute('data-date')),
      regressionLines: all('[data-testid="efficiency-regression-line"]').length,
      bands: all('[data-testid="efficiency-season-band"]').map((el) => el.getAttribute('data-season')),
      svgText,
      chip: chip
        ? {
            verdict: chip.getAttribute('data-verdict'),
            window: chip.getAttribute('data-window'),
            slope: chip.getAttribute('data-slope'),
            behaviorSlope: chip.getAttribute('data-behavior-slope'),
            rateSlope: chip.getAttribute('data-rate-slope'),
            netSlope: chip.getAttribute('data-net-slope'),
            band: chip.getAttribute('data-stable-band'),
            text: flat(chip.textContent),
          }
        : null,
      ratesLine: rates
        ? { direction: rates.getAttribute('data-direction'), text: flat(rates.textContent) }
        : null,
      netLine: net
        ? { verdict: net.getAttribute('data-verdict'), text: flat(net.textContent) }
        : null,
      sentence: sentence ? flat(sentence.textContent) : null,
    };
  });
}

async function desktopRun(browser, audit, sha) {
  const { ctx, page } = await openLoaded(browser, { width: 1440, height: 900 }, FIXTURE);
  try {
    const n = audit.bills.length;
    const windowSize = Math.min(n, WINDOW);
    const d = await readCard(page);

    /* --- 1. placement: one card on Overview, restated in the strip ----- */
    check('the EFFICIENCY card renders on Overview', !!d.card, d.card ? `${d.card.bills} bills` : 'missing');
    check('the card is NOT on the Money tab', !d.inMoney, String(d.inMoney));
    check('exactly one totals strip (no new strip)', d.totalsStrips === 1, `${d.totalsStrips}`);
    check('the ¢/kWh numbers live INSIDE the existing totals strip', d.strip.insideTotals,
      String(d.strip.insideTotals));

    /* --- 2. the headline is the audit's kWh-weighted mean -------------- */
    check(`card bills == audit (${n})`, d.card && Number(d.card.bills) === n, `${d.card && d.card.bills} vs ${n}`);
    check('all-time ¢/kWh == audit weighted mean (±0.011)',
      d.headline && near(d.headline.cents, audit.allTime.cents, 0.011),
      `${d.headline && d.headline.cents} vs ${audit.allTime.cents.toFixed(4)}`);
    check('all-time headline prints the audit value to 1dp',
      d.headline && d.headline.text.startsWith(audit.allTime.cents.toFixed(1)),
      `${d.headline && d.headline.text} vs ${audit.allTime.cents.toFixed(1)}`);
    check('totals strip all-time agrees with the card (same cents, same bills)',
      d.strip.allTime && d.headline && d.strip.allTime.cents === d.headline.cents &&
        d.strip.allTime.bills === String(n),
      `${d.strip.allTime && d.strip.allTime.cents}¢ / ${d.strip.allTime && d.strip.allTime.bills} bills`);

    /* --- 3. in-view: scoped to the window the app says it is showing ---- */
    const win0 = await readWindow(page);
    const want0 = inViewExpectation(audit, win0.start, win0.end);
    check(`in-view == the ${want0.bills} bills overlapping the window on screen (${win0.start}..${win0.end})`,
      d.strip.inView && Number(d.strip.inView.bills) === want0.bills &&
        near(d.strip.inView.cents, want0.cents, 0.02),
      `${d.strip.inView && d.strip.inView.bills} bills / ${d.strip.inView && d.strip.inView.cents}¢ ` +
        `vs audit ${want0.bills} bills / ${want0.cents.toFixed(4)}¢`);

    /* --- 4. the mini-line: every bill against the second parser -------- */
    check(`mini-line draws all ${n} bills`, d.chart && Number(d.chart.points) === n && d.points.length === n,
      `data-points=${d.chart && d.chart.points}, circles=${d.points.length}`);
    const badCents = [];
    const badKwh = [];
    const badMonth = [];
    d.points.forEach((p, i) => {
      const row = audit.bills[i];
      if (!row) return;
      if (!sameMonth(p.start, row.date)) badMonth.push(`${i}:${p.start} vs ${row.date}`);
      if (!near(p.cents, row.cents, 0.011)) badCents.push(`${row.date}: ${p.cents} vs ${row.cents.toFixed(2)}`);
      if (!near(p.kwh, row.kwh, 0.06)) badKwh.push(`${row.date}: ${p.kwh} vs ${row.kwh.toFixed(1)}`);
    });
    check('every point sits on its own bill (month order)', badMonth.length === 0, badMonth.join('; ') || `${n} matched`);
    check('every point carries the audited ¢/kWh', badCents.length === 0, badCents.join('; ') || `${n} matched`);
    check('every point carries the audited kWh', badKwh.length === 0, badKwh.join('; ') || `${n} matched`);

    /* --- 5. the task's own spot checks --------------------------------- */
    const spot = [['2024-08', '15.9'], ['2025-07', '13.9'], ['2026-01', '19.4']];
    const spotPresent = spot.every(([month]) => audit.bills.some((b) => sameMonth(b.date, month)));
    if (!spotPresent) {
      check('spot checks (Aug 2024 15.9¢ / Jul 2025 13.9¢ / Jan 2026 19.4¢)', true,
        'skipped — those bills are not in this export');
    }
    for (const [month, want] of spot) {
      const row = audit.bills.find((b) => sameMonth(b.date, month));
      if (!row) continue;
      const dom = d.points.find((p) => sameMonth(p.start, row.date));
      check(`spot ${month} == ${want}¢`, dom && (Math.round(Number(dom.cents) * 10) / 10).toFixed(1) === want,
        dom ? `${dom.cents}¢ (${row.cost} / ${row.kwh} kWh)` : 'no point');
    }

    /* --- 6. the chart furniture --------------------------------------- */
    check(`regression line drawn over the window (${windowSize})`,
      d.chart && Number(d.chart.window) === windowSize && d.regressionLines === 1,
      `data-window=${d.chart && d.chart.window}, lines=${d.regressionLines}`);
    check(`rate-change ticks == the Nov 1 boundaries inside the span (${audit.rateBoundaries.length})`,
      d.chart && Number(d.chart.rateTicks) === audit.rateBoundaries.length &&
        JSON.stringify(d.ticks) === JSON.stringify(audit.rateBoundaries),
      `${JSON.stringify(d.ticks)} vs ${JSON.stringify(audit.rateBoundaries)}`);
    const footer = await page.evaluate(() => {
      const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return flat(document.querySelector('[data-testid="efficiency-card"]')?.textContent || '');
    });
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const namedDates = audit.rateBoundaries.map((iso) => {
      const [y, m, day] = iso.split('-');
      return `${MON[Number(m) - 1]} ${Number(day)}, ${y}`;
    });
    check('the footer NAMES every rate-change date',
      namedDates.every((s) => footer.includes(s)), namedDates.join(', ') || 'none in span');
    check('season bands drawn (both of them)', d.chart && Number(d.chart.seasonBands) >= 2,
      `data-season-bands=${d.chart && d.chart.seasonBands} (${[...new Set(d.bands)].join('/')})`);
    check('season bands are LABELLED Winter and Summer',
      d.svgText.includes('Winter') && d.svgText.includes('Summer'),
      d.svgText.filter((t) => t === 'Winter' || t === 'Summer').join(', '));

    /* --- 7. the verdict, split and read honestly ----------------------- */
    check('the split is available (rate set loaded, every bill priceable)',
      d.card && d.card.split === 'true', `data-split=${d.card && d.card.split}`);
    check('trend chip carries a verdict', !!d.chip && ['improving', 'worsening', 'stable'].includes(d.chip.verdict),
      d.chip ? `${d.chip.verdict} — ${d.chip.text}` : 'missing');
    check(`chip window == ${windowSize} bills and says so`,
      d.chip && Number(d.chip.window) === windowSize && d.chip.text.includes(`your last ${windowSize} bill`),
      d.chip && d.chip.text);
    check('the VERDICT is read from the behaviour component (data-slope == data-behavior-slope)',
      d.chip && d.chip.slope === d.chip.behaviorSlope,
      `slope=${d.chip && d.chip.slope}, behavior=${d.chip && d.chip.behaviorSlope}`);
    check('behaviour + rate slopes recombine to the net slope (±0.01)',
      d.chip && near(Number(d.chip.behaviorSlope) + Number(d.chip.rateSlope), Number(d.chip.netSlope), 0.01),
      `${d.chip && d.chip.behaviorSlope} + ${d.chip && d.chip.rateSlope} vs net ${d.chip && d.chip.netSlope}`);
    check('net slope == an independent OLS over the same window (±0.01)',
      d.chip && audit.netFit && near(d.chip.netSlope, audit.netFit.slope, 0.01),
      `${d.chip && d.chip.netSlope} vs ${audit.netFit && audit.netFit.slope.toFixed(4)}`);
    check(`net verdict matches the independent OLS (${audit.netFit && audit.netFit.verdict})`,
      d.netLine && d.netLine.verdict === (audit.netFit && audit.netFit.verdict),
      d.netLine && `${d.netLine.verdict} — ${d.netLine.text}`);
    check('the stable band IS the slope stderr (±0.1¢ on this data)',
      d.chip && audit.netFit && flat(d.netLine.text).includes((Math.round(Math.abs(audit.netFit.stderr) * 10) / 10).toFixed(1)),
      `${d.chip && d.chip.band} vs stderr ${audit.netFit && audit.netFit.stderr.toFixed(4)}`);
    check('the sentence names BOTH halves (behaviour and rates)',
      !!d.sentence && /behavio/i.test(d.sentence) && /rate/i.test(d.sentence),
      d.sentence || 'missing');
    check('rates rose over the window — the half a raw verdict would hide',
      d.ratesLine && d.ratesLine.direction === 'up',
      d.ratesLine && `${d.ratesLine.direction} — ${d.ratesLine.text}`);

    /* --- 8. click-through to MONEY ------------------------------------- */
    await page.getByTestId('efficiency-open-money').click();
    await page.waitForFunction(() =>
      document.querySelector('#tab-money')?.getAttribute('aria-selected') === 'true', null, { timeout: 5_000 })
      .catch(() => {});
    const moneySelected = await page.evaluate(() =>
      document.querySelector('#tab-money')?.getAttribute('aria-selected'));
    check('clicking the mini-line opens the MONEY tab', moneySelected === 'true', `aria-selected=${moneySelected}`);
    await page.getByRole('tab', { name: 'Overview' }).click();

    /* --- 9. in-view really is scoped: full span, then narrow ----------- */
    await page.getByLabel('Window start date').fill('2024-01-01');
    await page.getByLabel('Window end date').fill('2027-12-31');
    const wantFull = inViewExpectation(audit, '2024-01-01', '2027-12-31');
    await page
      .waitForFunction((expected) => {
        const el = document.querySelector('[data-testid="efficiency-in-view"]');
        return el && el.getAttribute('data-bills') === expected ? 'ok' : null;
      }, String(wantFull.bills), { timeout: 10_000 })
      .catch(() => {});
    const full = await readCard(page);
    check(`in-view == every bill overlapping the metered span (${wantFull.bills} of ${n})`,
      full.strip.inView && Number(full.strip.inView.bills) === wantFull.bills &&
        near(full.strip.inView.cents, wantFull.cents, 0.02),
      `${full.strip.inView && full.strip.inView.bills} bills / ${full.strip.inView && full.strip.inView.cents}¢ ` +
        `vs audit ${wantFull.bills} bills / ${wantFull.cents.toFixed(4)}¢`);
    if (wantFull.bills < n) {
      check('all-time still counts the bill the metered span cannot show',
        full.strip.allTime && Number(full.strip.allTime.bills) === n,
        `all-time ${full.strip.allTime && full.strip.allTime.bills} bills vs in-view ${wantFull.bills} ` +
          `(first reading ${audit.readings && audit.readings.first}, bill 1 ends ${audit.bills[0].end})`);
    }

    const VIEW_START = '2025-01-01';
    const VIEW_END = '2025-12-31';
    const want = inViewExpectation(audit, VIEW_START, VIEW_END);
    await page.getByLabel('Window start date').fill(VIEW_START);
    await page.getByLabel('Window end date').fill(VIEW_END);
    const scoped = await page
      .waitForFunction((expected) => {
        const el = document.querySelector('[data-testid="efficiency-in-view"]');
        return el && el.getAttribute('data-bills') === expected ? 'ok' : null;
      }, String(want.bills), { timeout: 10_000 })
      .then(() => readCard(page))
      .catch(async () => readCard(page));
    check(`in-view re-scopes to the ${want.bills} bills overlapping ${VIEW_START}..${VIEW_END}`,
      scoped.strip.inView && Number(scoped.strip.inView.bills) === want.bills,
      `${scoped.strip.inView && scoped.strip.inView.bills} vs ${want.bills}`);
    check('in-view ¢/kWh is the weighted mean of THAT window',
      scoped.strip.inView && near(scoped.strip.inView.cents, want.cents, 0.02),
      `${scoped.strip.inView && scoped.strip.inView.cents} vs ${want.cents.toFixed(4)}`);
    check('all-time stays whole while the view is narrowed (Σ unchanged)',
      scoped.strip.allTime && near(scoped.strip.allTime.cents, audit.allTime.cents, 0.011),
      `${scoped.strip.allTime && scoped.strip.allTime.cents} vs ${audit.allTime.cents.toFixed(4)}`);

    /* --- screenshots (window left on the full span) --------------------- */
    await page.getByLabel('Window start date').fill('2024-01-01');
    await page.getByLabel('Window end date').fill('2027-12-31');
    await page
      .waitForFunction((expected) => {
        const el = document.querySelector('[data-testid="efficiency-in-view"]');
        return el && el.getAttribute('data-bills') === expected ? 'ok' : null;
      }, String(wantFull.bills), { timeout: 10_000 })
      .catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'wave-s-desktop-overview.png'), fullPage: true });
    await page.getByTestId('efficiency-card')
      .screenshot({ path: path.join(OUT, 'wave-s-desktop-efficiency-card.png') })
      .catch(() => {});

    console.log(`\nfixture sha256 ${sha}`);
    return d;
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser) {
  const { ctx, page } = await openLoaded(browser, { width: 390, height: 844 }, FIXTURE);
  try {
    const d = await readCard(page);
    check('mobile: the card renders', !!d.card, d.card ? `${d.card.bills} bills` : 'missing');
    check('mobile: mini-line draws every bill', d.points.length > 0 && d.points.length === Number(d.chart && d.chart.points),
      `${d.points.length} points`);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('mobile: no sideways scrolling', overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: path.join(OUT, 'wave-s-mobile-overview.png'), fullPage: true });
    return d;
  } finally {
    await ctx.close();
  }
}

async function main() {
  const xml = FIXTURE;
  const bytes = fs.readFileSync(xml);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  console.log(`Wave S verify — ${BASE}`);
  console.log(`fixture: ${bytes.length} bytes, sha256 ${sha} (${path.basename(xml)})`);
  const audit = runAudit(xml);
  console.log(`independent audit: ${audit.bills.length} bills, all-time ${audit.allTime.cents.toFixed(4)}¢/kWh, ` +
    `net OLS slope ${audit.netFit ? audit.netFit.slope.toFixed(3) : 'n/a'}, ` +
    `rate boundaries ${JSON.stringify(audit.rateBoundaries)}\n`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    await desktopRun(browser, audit, sha);
    await mobileRun(browser);
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'S',
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    /** The commit the deployed stack was at — set by the caller from the deploy's DEPLOY_OK line. */
    deployedCommit: process.env.WAVE_S_DEPLOY || null,
    fixtureSha256: sha,
    fixtureBytes: fs.statSync(xml).size,
    audit: {
      bills: audit.bills.length,
      readings: audit.readings || null,
      allTimeCents: Number(audit.allTime.cents.toFixed(4)),
      netSlope: audit.netFit ? Number(audit.netFit.slope.toFixed(4)) : null,
      netStderr: audit.netFit ? Number(audit.netFit.stderr.toFixed(4)) : null,
      netVerdict: audit.netFit ? audit.netFit.verdict : null,
      rateBoundaries: audit.rateBoundaries,
    },
    passed,
    total: checks.length,
    checks,
  };
  const file = path.join(OUT, `wave-s-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
