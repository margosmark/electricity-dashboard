/**
 * Tiered-pricing verification — the fix for Wave O finding 6
 * (`planCostFor` priced Tiered at tier 1 only), on a running stack with
 * Mark's real Oakville Hydro export (never committed; pass its path in).
 *
 * What it proves, in order:
 *
 *   PASS A — the whole dataset in one window
 *     1. the file's billing periods parse in the browser and no request
 *        carried the XML (the client-only invariant);
 *     2. the window's own CSV export gives an INDEPENDENT tier-1 baseline:
 *        its `costTiered` column is `usage × tier1`, priced per reading —
 *        exactly the number summing that field would have produced;
 *     3. the Tiered plan card charges MORE than that baseline (tier 2 is
 *        actually applied on real data) and MORE than TOU — the inversion
 *        Wave O hit, where tier-1-only pricing put Tiered $8 below TOU;
 *     4. the True Bill card's variable figure equals the plan card's Tiered
 *        figure for the same window (one rule, two panels);
 *     5. the ¢/kWh-by-hour histogram's window average is that figure ÷ the
 *        window's kWh — the per-hour view of the same total.
 *
 *   PASS B — the newest billing period in the window
 *     6. the vs-actual row is for the newest period, and its "Your estimate"
 *        equals the tiered price of the BILL's own read window plus the four
 *        pre-filled add-ons, to the cent — recomputed here from first
 *        principles (the spec's month-scoped threshold rule, rates from
 *        /api/rates, the row set rebuilt from the bill's reads) rather than
 *        by importing the app's helper. This is the row that used to price
 *        Tiered at tier 1 (or, with an empty per-reading field, at $0);
 *     7. that estimate is materially ABOVE the tier-1-only equivalent built
 *        from the CSV's own `costTiered` column: tier 2 reaches the number
 *        the household reads.
 *
 *   PASS C — a 390×844 phone still fits.
 *
 * Run:  TIERED_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-tiered-verify.cjs
 * Env:  TIERED_BASE_URL (default http://127.0.0.1:3100/), TIERED_CHROMIUM,
 *       TIERED_EXPECT_PERIODS, TIERED_SUFFIX (output file suffix)
 *
 * Writes evidence/wave-tiered-verification{suffix}.json + wave-tiered-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.TIERED_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.TIERED_CHROMIUM || '/usr/bin/chromium';
const XML = process.env.TIERED_XML;
const SUFFIX = process.env.TIERED_SUFFIX || '';
const EXPECT_PERIODS = process.env.TIERED_EXPECT_PERIODS
  ? Number(process.env.TIERED_EXPECT_PERIODS)
  : null;
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const money = (s) => {
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The reading's day on the DATASET clock (process.env.TZ is America/Toronto,
 * and the file's LocalTimeParameters are Toronto too).
 *
 * The CSV's `datetime` column is a UTC ISO string, so slicing it to 10
 * characters puts every reading after 20:00 local in the NEXT day — which is
 * how a 29-day window first looked like 30 days.
 */
const localDay = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

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
    acceptDownloads: true,
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

async function uploadRealXml(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(XML);
  await page.getByTestId('totals-strip').waitFor({ timeout: 120_000 });
}

/** Read the window's rows back out of the app's own CSV export. */
async function exportWindow(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByTestId('export-csv').first().click(),
  ]);
  const file = await download.path();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  const iUsage = header.indexOf('usage_kwh');
  const iTiered = header.indexOf('costTiered');
  const iDate = header.indexOf('datetime');
  const iRate = header.indexOf('activeRateSet.effectiveDate');
  const out = {
    rows: 0,
    kwh: 0,
    tier1: 0,
    days: new Set(),
    first: null,
    last: null,
    file: download.suggestedFilename(),
    /** every row, so a narrower window (the bill's read window) can be cut
     *  out of this one without a second export. */
    list: [],
  };
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    out.rows += 1;
    out.kwh += Number(c[iUsage]);
    out.tier1 += Number(c[iTiered]);
    const iso = String(c[iDate]);
    const day = localDay(iso);
    out.days.add(day);
    if (out.first === null || day < out.first) out.first = day;
    if (out.last === null || day > out.last) out.last = day;
    out.list.push({
      ts: Date.parse(iso),
      kwh: Number(c[iUsage]),
      cost1: Number(c[iTiered]),
      eff: String(c[iRate]),
      day,
      month: Number(day.slice(5, 7)),
    });
  }
  return out;
}

async function setWindow(page, start, end) {
  await page.locator('input[aria-label="Window start date"]').fill(start);
  await page.locator('input[aria-label="Window end date"]').fill(end);
  // The chart, the cards and the True Bill card all recompute off this state.
  await page.waitForTimeout(900);
}

/** The three plan cards: `aria-label="Use the <name> plan"`. */
async function planCardCost(page, name) {
  const text = flat(await page.locator(`[aria-label="Use the ${name} plan"]`).innerText());
  const m = text.match(/\$([\d,]+\.\d{2})/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** billPeriodLabel's own format: "Jul 22, 2026 – Aug 20" (end drops the year). */
function periodLabel(startISO, days) {
  const s = new Date(`${startISO}T00:00:00Z`);
  const e = new Date(s.getTime() + days * 86_400_000);
  const a = `${MONTH[s.getUTCMonth()]} ${s.getUTCDate()}, ${s.getUTCFullYear()}`;
  const b = `${MONTH[e.getUTCMonth()]} ${e.getUTCDate()}`;
  return `${a} – ${b}`;
}
async function readCharges(page) {
  const v = async (id) => (await page.getByTestId(id).inputValue()).trim();
  return {
    deliveryPerKwh: Number(await v('charge-delivery-per-kwh')),
    deliveryFlat: Number(await v('charge-delivery-flat')),
    regulatoryPerKwh: Number(await v('charge-regulatory-per-kwh')),
    hstPct: Number(await v('charge-hst-pct')),
  };
}

/** calculateTrueBill's arithmetic, redone here from what the DOM says. */
function trueBillTotal({ variable, kwh, months, charges }) {
  const delivery = charges.deliveryPerKwh * kwh + charges.deliveryFlat * months;
  const regulatory = charges.regulatoryPerKwh * kwh;
  const preTax = variable + delivery + regulatory;
  return preTax * (1 + charges.hstPct / 100);
}

/**
 * The app's rate table, read from its own /api/rates (the OEB-derived
 * historical sets the chart prices every reading with).
 */
async function loadRates() {
  const json = await (await fetch(`${BASE}/api/rates`)).json();
  return {
    all: json.historicalRates,
    for: (eff) => json.historicalRates.find((h) => h.effectiveDate === eff) || null,
  };
}

/**
 * The tiered rule, written out here FROM THE SPEC instead of imported from the
 * app, so this check is a re-derivation rather than a restatement:
 *
 *   bucket the window's readings by calendar month, prorate that month's
 *   tier-2 threshold by the days the readings actually cover (days / 30.4),
 *   charge tier 1 up to the prorated threshold and tier 2 on the excess.
 *
 * Rates come from /api/rates, keyed by each reading's own
 * `activeRateSet.effectiveDate`. Returns the tier-1-only total alongside, so
 * the "the old number would have been lower" comparison is priced the same way.
 */
function tieredCostOf(list, rates) {
  const buckets = new Map();
  for (const r of list) {
    const key = r.day.slice(0, 7);
    let b = buckets.get(key);
    if (!b) {
      b = { usage: 0, days: new Set(), winter: r.month >= 11 || r.month <= 4, effs: new Set() };
      buckets.set(key, b);
    }
    b.usage += r.kwh;
    b.days.add(r.day);
    b.effs.add(r.eff);
  }
  let total = 0;
  let tier1Only = 0;
  let oneRatePerMonth = true;
  for (const b of buckets.values()) {
    if (b.effs.size !== 1) oneRatePerMonth = false; // rate changes fall on Nov 1/May 1 — month starts
    const t = rates.for([...b.effs][0])?.tiered;
    if (!t) {
      oneRatePerMonth = false;
      continue;
    }
    const th = (b.winter ? t.thresholdWinter : t.thresholdSummer) * (b.days.size / 30.4);
    tier1Only += (b.usage * t.tier1) / 100;
    total +=
      b.usage <= th
        ? (b.usage * t.tier1) / 100
        : (th * t.tier1) / 100 + ((b.usage - th) * t.tier2) / 100;
  }
  return { total, tier1Only, oneRatePerMonth };
}

async function desktopRun(browser) {
  const { ctx, page, traffic } = await newPage(browser, { width: 1600, height: 1200 });
  try {
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
      `${traffic.length} requests`,
    );

    /* ---------------- PASS A — the whole dataset ----------------------- */
    const raw = JSON.parse((await page.evaluate(() => localStorage.getItem('energy_data'))) || '[]');
    const stamps = raw.map((d) => d.timestamp);
    const dayOf = (ts) => localDay(new Date(ts * 1000).toISOString());
    const fullStart = dayOf(Math.min(...stamps));
    const fullEnd = dayOf(Math.max(...stamps));
    await setWindow(page, fullStart, fullEnd);

    const all = await exportWindow(page);
    check(
      'CSV export of the window carries every reading (independent tier-1 baseline)',
      all.rows > 1000 && all.kwh > 1000 && all.days.size > 300,
      `${all.rows} rows · ${all.kwh.toFixed(0)} kWh · ${all.days.size} days · ${all.first}→${all.last}`,
    );

    const cardTiered = await planCardCost(page, 'Tiered Pricing');
    const cardTou = await planCardCost(page, 'Time-of-Use');
    check('the three plan cards price the window', !!cardTiered && !!cardTou, `Tiered $${cardTiered} · TOU $${cardTou}`);

    check(
      'Tiered charges MORE than the CSV’s own tier-1 column (tier 2 is applied)',
      cardTiered > all.tier1 + 1,
      `card $${r2(cardTiered)} vs tier-1 sum $${r2(all.tier1)} (+$${r2(cardTiered - all.tier1)})`,
    );
    check(
      'Tiered models ABOVE TOU on this window (tier-1-only pricing inverted this)',
      cardTiered > cardTou,
      `Tiered $${r2(cardTiered)} vs TOU $${r2(cardTou)}`,
    );

    await page.getByLabel('Use the Tiered Pricing plan').click();
    await page.waitForTimeout(500);
    const cardVar = money(await page.getByTestId('variable-estimate').textContent());
    check(
      'the True Bill card’s variable figure IS the plan card’s Tiered figure',
      cardVar !== null && Math.abs(cardVar - cardTiered) < 0.01,
      `True Bill $${r2(cardVar)} vs plan card $${r2(cardTiered)}`,
    );
    const threshold = flat(await page.getByTestId('tier-threshold').textContent());
    check('the Tiered card states the threshold in force', /Tier 1 cut-off/.test(threshold), threshold.slice(0, 90));

    await page.getByTestId('bill-estimate').screenshot({ path: path.join(OUT, 'wave-tiered-true-bill-desktop.png') });
    await page.screenshot({ path: path.join(OUT, 'wave-tiered-plan-cards-desktop.png'), fullPage: false });

    // The hour histogram prices the WHOLE dataset (rows={allData}), so with
    // this window it must be the same total ÷ the same kWh.
    await page.getByText('INSIGHTS', { exact: true }).first().click();
    await page.getByTestId('insights-view').waitFor({ timeout: 30_000 });
    const avgText = flat((await shown(page.getByTestId('money-hour-average'), 30_000))
      ? await page.getByTestId('money-hour-average').textContent()
      : '');
    const avg = avgText === '' ? null : Number(avgText.replace('¢', ''));
    const fromCard = (cardTiered / all.kwh) * 100;
    check(
      'the ¢/kWh histogram’s window average is the Tiered total ÷ the window’s kWh',
      avg !== null && Number.isFinite(avg) && Math.abs(avg - fromCard) <= 0.1,
      `${avg}¢ vs ${fromCard.toFixed(1)}¢`,
    );
    await page.getByTestId('money-hour-histogram').screenshot({ path: path.join(OUT, 'wave-tiered-hour-histogram.png') });

    /* ---------------- PASS B — the newest billing period --------------- */
    await page.getByText('CHART', { exact: true }).first().click();
    await page.getByTestId('chart-view').waitFor({ timeout: 30_000 });

    const newest = summaries[summaries.length - 1];
    const days = Math.round(
      (Date.parse(`${newest.endDate}T00:00:00Z`) - Date.parse(`${newest.startDate}T00:00:00Z`)) /
        86_400_000,
    );
    // The period's own calendar dates, INCLUSIVE. The vs-actual row is pinned
    // to the bill's read span (previous read → current read, 01:01 local on
    // Jul 22 through 01:01 local on Aug 20 for this period), so the export has
    // to cover both ends of it: a 29-day window stopping the day before would
    // silently drop the last two readings the row prices.
    await setWindow(page, newest.startDate, newest.endDate);

    const period = await exportWindow(page);
    check(
      'the window now holds exactly the newest billing period',
      period.first === newest.startDate &&
        period.last === newest.endDate &&
        period.days.size === days + 1,
      `${period.rows} rows · ${period.days.size} days · ${period.first}→${period.last} (${newest.startDate}..${newest.endDate} inclusive, ${days} days apart)`,
    );

    await page.getByLabel('Select Tiered plan').click();
    await page.waitForTimeout(500);

    const vsActual = page.getByTestId('true-bill-vs-actual');
    check('the estimate-vs-actual row renders', await shown(vsActual, 20_000));
    const vsText = flat(await vsActual.textContent());
    check(
      'it is the newest period we set the window to',
      vsText.includes(periodLabel(newest.startDate, days)),
      vsText.slice(0, 120),
    );

    const estimate = money(vsText.match(/Your estimate\$([\d,.]+)/)?.[1]);
    const billed = money(vsText.match(/Oakville billed\$([\d,.]+)/)?.[1]);
    const variable = money(await page.getByTestId('variable-estimate').textContent());
    const charges = await readCharges(page);
    check(
      'the four add-ons are pre-filled from the file',
      [charges.deliveryPerKwh, charges.deliveryFlat, charges.regulatoryPerKwh, charges.hstPct].every(
        (n) => Number.isFinite(n) && n >= 0,
      ),
      JSON.stringify(charges),
    );

    // Rebuild the row set the vs-actual row actually prices. billWindow is the
    // bill's own read span (falling back to the coarse billingPeriod stamp
    // when the reads' span doesn't match the period) — NOT the calendar window
    // on screen, which is why a first cut of this check was off by 48¢: the
    // reads sit at 01:01 local, two readings inside each calendar edge.
    const readAt = (needle) => {
      const item = (newest.items || []).find(
        (i) =>
          String(i.note || '')
            .toLowerCase()
            .includes(needle) &&
          i.measurement &&
          i.measurement.uom === 27,
      );
      const ts = item ? Number(item.measurement.scaled) : NaN;
      return Number.isFinite(ts) && ts > 0 ? ts : null;
    };
    const prevRead = readAt('previous read date');
    const curRead = readAt('current read date');
    const useReads =
      prevRead !== null &&
      curRead !== null &&
      curRead > prevRead &&
      Math.abs(curRead - prevRead - newest.duration) <= 86_400; // BILL_WINDOW_TOLERANCE
    const bwStart = (useReads ? prevRead : newest.start) * 1000; // items are seconds, the CSV is ms
    const bwEnd = (useReads ? curRead : newest.start + newest.duration) * 1000;
    const billRows = period.list.filter((r) => r.ts >= bwStart && r.ts < bwEnd);
    const billKwh = billRows.reduce((n, r) => n + r.kwh, 0);

    // Price that row set from first principles: the spec's month-scoped
    // threshold rule, with rates read off the app's own /api/rates.
    const rates = await loadRates();
    const priced = tieredCostOf(billRows, rates);
    // The CSV publishes costTiered rounded to 4 decimals, so compare against
    // the rate the same way the app wrote it rather than dividing back out.
    const tier1Matches = billRows.every((r) => {
      const t = rates.for(r.eff)?.tiered;
      return !!t && r.kwh > 0 && Math.abs(r.cost1 - (r.kwh * t.tier1) / 100) <= 5e-5;
    });
    check(
      'every bill-window reading prices off the rate table /api/rates serves',
      billRows.length > 0 && tier1Matches && priced.oneRatePerMonth,
      `${billRows.length} readings · tier-1 column matches the table: ${tier1Matches} · one rate set per month: ${priced.oneRatePerMonth}`,
    );

    const months = Math.max(1, Math.round((bwEnd - bwStart) / 86_400_000 / 30.44));
    const expected = trueBillTotal({ variable: priced.total, kwh: billKwh, months, charges });
    check(
      'THE FIX: "Your estimate" = tiered(bill-window rows) + the add-ons, to the cent',
      estimate !== null && Math.abs(estimate - expected) <= 0.02,
      `shown $${r2(estimate)} vs recomputed $${r2(expected)} (tiered variable $${r2(priced.total)}, ${months} mo, ${r2(billKwh)} kWh over ${billRows.length} readings)`,
    );

    const tier1Only = trueBillTotal({ variable: priced.tier1Only, kwh: billKwh, months, charges });
    check(
      '…and it is materially above the tier-1-only figure (tier 2 reaches the household)',
      estimate !== null && estimate - tier1Only > 1,
      `tiered $${r2(estimate)} vs tier-1 $${r2(tier1Only)} (+$${r2(estimate - tier1Only)})`,
    );
    check(
      'the card’s variable cost itself is above that window’s tier-1 sum',
      variable !== null && variable > period.tier1,
      `variable $${r2(variable)} vs tier-1 $${r2(period.tier1)} for ${period.rows} rows`,
    );
    check(
      'the row still reports what Oakville actually billed',
      billed !== null && billed > 0,
      `billed $${r2(billed)} · estimate $${r2(estimate)}`,
    );

    await vsActual.screenshot({ path: path.join(OUT, 'wave-tiered-vs-actual-desktop.png') });
    await page.screenshot({ path: path.join(OUT, 'wave-tiered-chart-desktop.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser) {
  const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
  try {
    await uploadRealXml(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check('no horizontal page overflow on a phone', overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: path.join(OUT, 'wave-tiered-mobile.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!XML || !fs.existsSync(XML)) {
    console.error('Set TIERED_XML to the real Oakville Hydro export (it is never committed).');
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
    wave: 'tiered',
    base: BASE,
    xml: path.basename(XML),
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  fs.writeFileSync(
    path.join(OUT, `wave-tiered-verification${SUFFIX}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(`\n${passed}/${checks.length} checks passed → evidence/wave-tiered-verification${SUFFIX}.json`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
