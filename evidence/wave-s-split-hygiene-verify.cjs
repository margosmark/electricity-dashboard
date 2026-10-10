/**
 * Wave S follow-through — the THREE-WAY split (usage / delivery / rate) on the
 * DEPLOYED stack, against Mark's real 2-year export.
 *
 * The bug this card fixed was a verdict that read 96% of a delivery-charge
 * seasonal swing as "your usage mix improved". So every assertion here is
 * about the VERDICT HALF, and each one is checked twice: once against the
 * independent Python audit (evidence/wave-s-split-hygiene.py — ElementTree
 * over the raw export, no webapp code) and once against the fixed numbers
 * this card publishes. Nothing is asserted from lib/statistics.ts:
 *
 *   1. the three components each equal the audit's own OLS over the same
 *      12-bill window, to ±0.001¢/period:
 *        usage −0.0061 · delivery −0.1508 · rate +0.2122 · net +0.0552;
 *   2. usage + delivery + rate == net (the split is exact, not a partition
 *      of convenience), and usage + delivery == the OLD behaviour term
 *      −0.157 — the decomposition of the number the chip used to print;
 *   3. the chip's data-slope IS data-usage-slope, so the verdict can only
 *      be read off the usage fit — never off delivery, never off rate;
 *   4. the verdict on the owner's data is `stable` (|usage| ≤ stderr), the
 *      delivery chip points `down`, the rates chip points `up`;
 *   5. the sentence says BOTH halves in words: "your usage mix is flat"
 *      and "delivery & fixed charges fell (-0.2¢/kWh)" — and does NOT
 *      contain the claim the card removed ("usage mix improved");
 *   6. the all-time headline is untouched: 16.3¢ over 24 bills, restated
 *      identically inside the existing totals strip.
 *
 * Run:  WAVE_S_SPLIT_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-s-split-hygiene-verify.cjs
 * Env:  WAVE_S_SPLIT_BASE_URL (default http://10.10.11.110:3939/ — deployed),
 *       WAVE_S_SPLIT_CHROMIUM, WAVE_S_SPLIT_XML (REQUIRED — Mark's export is
 *       never committed, only its sha256 lands in the JSON),
 *       WAVE_S_SPLIT_SHA (the commit the deployed stack is serving),
 *       WAVE_S_SPLIT_SUFFIX ('-local' writes -verification-local.json).
 *
 * Writes evidence/wave-s-split-hygiene-verification[-suffix].json
 *            + wave-s-split-hygiene-*.png
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

const BASE = process.env.WAVE_S_SPLIT_BASE_URL || 'http://10.10.11.110:3939/';
const CHROMIUM = process.env.WAVE_S_SPLIT_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.WAVE_S_SPLIT_SUFFIX || '';
const FIXTURE = process.env.WAVE_S_SPLIT_XML;
const OUT = __dirname;

/** TREND_MAX_PERIODS in webapp/src/lib/statistics.ts. */
const WINDOW = 12;

/**
 * The numbers this card publishes, on the owner's data. Each is checked
 * against the audit FIRST (a wrong audit must not be able to pass by
 * agreeing with itself) and then against the DOM.
 */
const PUBLISHED = {
  usage: -0.006,
  delivery: -0.151,
  rate: 0.212,
  net: 0.055,
  behaviourOld: -0.157,
  verdict: 'stable',
  allTimeCents: '16.3',
  bills: 24,
};

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail == null ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

async function shown(locator, timeout = 60_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** The second opinion: the Python audit, run right now against the export. */
function runAudit(xml) {
  const raw = execFileSync('python3', [path.resolve(__dirname, 'wave-s-split-hygiene.py'), xml], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

/** Everything the card exposes about the split, read from the rendered DOM. */
function readCard(page) {
  return page.evaluate(() => {
    const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const one = (sel) => document.querySelector(sel);
    const all = (sel) => [...document.querySelectorAll(sel)];
    const attrs = (el, names) => {
      const out = {};
      for (const n of names) out[n] = el ? el.getAttribute(n) : null;
      return out;
    };
    const card = one('[data-testid="efficiency-card"]');
    const chip = one('[data-testid="efficiency-trend-chip"]');
    const headline = one('[data-testid="efficiency-all-time"]');
    const strip = one('[data-testid="totals-strip"] [data-testid="efficiency-all-time-strip"]');
    const rates = one('[data-testid="efficiency-rates-line"]');
    const delivery = one('[data-testid="efficiency-delivery-line"]');
    const net = one('[data-testid="efficiency-net-line"]');
    const sentence = one('[data-testid="efficiency-sentence"]');
    return {
      card: attrs(card, ['data-bills', 'data-split']),
      headline: headline
        ? {
            cents: headline.getAttribute('data-cents'),
            // The bill count is NOT an attribute: "All time · 24 bills" is
            // the sibling label above the number.
            label: flat(headline.parentElement ? headline.parentElement.textContent : ''),
            text: flat(headline.textContent),
          }
        : null,
      strip: strip
        ? { cents: strip.getAttribute('data-cents'), bills: strip.getAttribute('data-bills') }
        : null,
      chip: chip
        ? {
            ...attrs(chip, [
              'data-verdict',
              'data-window',
              'data-slope',
              'data-usage-slope',
              'data-delivery-slope',
              'data-rate-slope',
              'data-net-slope',
              'data-stable-band',
            ]),
            text: flat(chip.textContent),
          }
        : null,
      ratesLine: rates
        ? { direction: rates.getAttribute('data-direction'), text: flat(rates.textContent) }
        : null,
      deliveryLine: delivery
        ? { direction: delivery.getAttribute('data-direction'), text: flat(delivery.textContent) }
        : null,
      netLine: net
        ? { verdict: net.getAttribute('data-verdict'), text: flat(net.textContent) }
        : null,
      sentence: sentence ? flat(sentence.textContent) : null,
      inOverview: !!one('[data-testid="tab-panel-overview"] [data-testid="efficiency-card"]'),
      deliveryLineCount: all('[data-testid="efficiency-delivery-line"]').length,
    };
  });
}

async function main() {
  if (!FIXTURE) {
    console.error('WAVE_S_SPLIT_XML is required — the committed fixtures carry no 24-bill history.');
    process.exit(2);
  }
  const bytes = fs.readFileSync(FIXTURE);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  console.log(`Wave S split hygiene — deployed verify at ${BASE}`);
  console.log(`fixture: ${bytes.length} bytes, sha256 ${sha} (${path.basename(FIXTURE)})`);

  const audit = runAudit(FIXTURE);
  const fits = audit.windowFits || {};
  const billCount = (audit.perBill || []).length;
  const allTime = (audit.perBill || []).reduce((a, b) => a + b.cost, 0) /
    (audit.perBill || []).reduce((a, b) => a + b.kwh, 0) * 100;
  console.log(
    `independent audit: ${billCount} bills, all-time ${allTime.toFixed(4)}¢/kWh, ` +
      `window fits ${JSON.stringify(
        Object.fromEntries(Object.entries(fits).map(([k, v]) => [k, Number(v.slope.toFixed(4))])),
      )}\n`,
  );

  /* --- 0. the audit itself must reproduce the published table ---------- */
  check(`audit sees ${PUBLISHED.bills} bills`, billCount === PUBLISHED.bills, `${billCount}`);
  check('audit usage slope == published −0.006 (±0.001)', near(fits.mixTerm.slope, PUBLISHED.usage, 0.001),
    `${fits.mixTerm.slope}`);
  check('audit delivery slope == published −0.151 (±0.001)',
    near(fits.nonCommodityTerm.slope, PUBLISHED.delivery, 0.001), `${fits.nonCommodityTerm.slope}`);
  check('audit rate slope == published +0.212 (±0.001)', near(fits.rate.slope, PUBLISHED.rate, 0.001),
    `${fits.rate.slope}`);
  check('audit net slope == published +0.055 (±0.001)', near(fits.observed.slope, PUBLISHED.net, 0.001),
    `${fits.observed.slope}`);
  check('audit: usage + delivery == the OLD behaviour term −0.157 (±0.005)',
    near(fits.mixTerm.slope + fits.nonCommodityTerm.slope, PUBLISHED.behaviourOld, 0.005),
    `${fits.mixTerm.slope + fits.nonCommodityTerm.slope} vs ${PUBLISHED.behaviourOld}`);
  check('audit: usage + delivery + rate == net (±0.001)',
    near(fits.mixTerm.slope + fits.nonCommodityTerm.slope + fits.rate.slope, fits.observed.slope, 0.001),
    `${fits.mixTerm.slope + fits.nonCommodityTerm.slope + fits.rate.slope} vs ${fits.observed.slope}`);
  check('audit: the usage term is FLAT inside its own error bar',
    Math.abs(fits.mixTerm.slope) <= fits.mixTerm.stderr,
    `|${fits.mixTerm.slope}| <= ${fits.mixTerm.stderr}`);
  check('audit: the delivery term is 96% of the old behaviour term',
    Math.abs(fits.nonCommodityTerm.slope / fits.behaviour.slope) >= 0.9,
    `${((fits.nonCommodityTerm.slope / fits.behaviour.slope) * 100).toFixed(0)}%`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  let d;
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      timezoneId: 'America/Toronto',
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
    const loaded = await shown(page.getByTestId('totals-strip'));
    if (!loaded) throw new Error('upload never produced a totals strip');
    await shown(page.getByTestId('efficiency-card'), 30_000);
    d = await readCard(page);

    /* --- 1. the card is there and the split is live --------------------- */
    check('the EFFICIENCY card renders on Overview', d.inOverview && !!d.chip,
      d.chip ? `verdict=${d.chip['data-verdict']}` : 'missing');
    check('the split is available (rate set loaded, every bill priceable)',
      d.card['data-split'] === 'true', `data-split=${d.card['data-split']}`);
    check('exactly one delivery & fixed line', d.deliveryLineCount === 1, `${d.deliveryLineCount}`);

    /* --- 2. the all-time headline is untouched -------------------------- */
    check(`all-time headline prints ${PUBLISHED.allTimeCents}¢`,
      d.headline && d.headline.text.startsWith(PUBLISHED.allTimeCents),
      d.headline ? `${d.headline.text} (data-cents ${d.headline.cents})` : 'missing');
    check(`all-time headline says "${PUBLISHED.bills} bills"`,
      d.headline && d.headline.label.includes(`All time · ${PUBLISHED.bills} bills`),
      d.headline ? d.headline.label : 'missing');
    check(`card data-bills == ${PUBLISHED.bills}`, Number(d.card['data-bills']) === PUBLISHED.bills,
      `${d.card['data-bills']}`);
    check('all-time ¢/kWh == the audit\'s kWh-weighted mean (±0.011)',
      d.headline && near(d.headline.cents, allTime, 0.011),
      `${d.headline && d.headline.cents} vs ${allTime.toFixed(4)}`);
    check('the totals strip restates the same ¢/kWh and bill count',
      d.strip && d.headline && d.strip.cents === d.headline.cents &&
        Number(d.strip.bills) === PUBLISHED.bills,
      d.strip
        ? `${d.strip.cents}¢ / ${d.strip.bills} bills vs headline ${d.headline && d.headline.cents}¢`
        : 'missing');

    /* --- 3. each component equals the independent audit ----------------- */
    check(`chip window == ${WINDOW} bills`,
      d.chip && Number(d.chip['data-window']) === WINDOW,
      d.chip && `${d.chip['data-window']}`);
    check('usage slope == audit mixTerm (±0.001)',
      d.chip && near(d.chip['data-usage-slope'], fits.mixTerm.slope, 0.001),
      `${d.chip && d.chip['data-usage-slope']} vs ${fits.mixTerm.slope}`);
    check('delivery slope == audit nonCommodityTerm (±0.001)',
      d.chip && near(d.chip['data-delivery-slope'], fits.nonCommodityTerm.slope, 0.001),
      `${d.chip && d.chip['data-delivery-slope']} vs ${fits.nonCommodityTerm.slope}`);
    check('rate slope == audit rate (±0.001)',
      d.chip && near(d.chip['data-rate-slope'], fits.rate.slope, 0.001),
      `${d.chip && d.chip['data-rate-slope']} vs ${fits.rate.slope}`);
    check('net slope == audit observed (±0.001)',
      d.chip && near(d.chip['data-net-slope'], fits.observed.slope, 0.001),
      `${d.chip && d.chip['data-net-slope']} vs ${fits.observed.slope}`);

    /* --- 4. the split is exact and the verdict reads USAGE ------------- */
    check('usage + delivery + rate recombine to the net slope (±0.001)',
      d.chip &&
        near(
          Number(d.chip['data-usage-slope']) +
            Number(d.chip['data-delivery-slope']) +
            Number(d.chip['data-rate-slope']),
          Number(d.chip['data-net-slope']),
          0.001,
        ),
      d.chip &&
        `${d.chip['data-usage-slope']} + ${d.chip['data-delivery-slope']} + ${d.chip['data-rate-slope']} ` +
          `vs net ${d.chip['data-net-slope']}`);
    check('data-slope == data-usage-slope (the verdict can only read usage)',
      d.chip && d.chip['data-slope'] === d.chip['data-usage-slope'],
      d.chip && `slope=${d.chip['data-slope']}, usage=${d.chip['data-usage-slope']}`);
    check('data-slope != data-delivery-slope (the old 96% term is not the verdict)',
      d.chip && d.chip['data-slope'] !== d.chip['data-delivery-slope'],
      d.chip && `slope=${d.chip['data-slope']}, delivery=${d.chip['data-delivery-slope']}`);
    check('the verdict on the owner\'s data is STABLE',
      d.chip && d.chip['data-verdict'] === PUBLISHED.verdict,
      d.chip && `${d.chip['data-verdict']} — ${d.chip.text}`);
    check('the chip says STABLE and cites the 12-bill window',
      d.chip && d.chip.text.includes('STABLE') && d.chip.text.includes('12 bill'),
      d.chip && d.chip.text);
    check('usage |slope| ≤ stable band (flat, not improving)',
      d.chip && Math.abs(Number(d.chip['data-usage-slope'])) <= Number(d.chip['data-stable-band']),
      d.chip && `|${d.chip['data-usage-slope']}| vs band ${d.chip['data-stable-band']}`);

    /* --- 5. the three chips say what each component did ----------------- */
    check('rates chip points UP (+0.2¢/period)',
      d.ratesLine && d.ratesLine.direction === 'up' && d.ratesLine.text.includes('+0.2'),
      d.ratesLine && `${d.ratesLine.direction} — ${d.ratesLine.text}`);
    check('delivery & fixed chip points DOWN (−0.15¢/period)',
      d.deliveryLine && d.deliveryLine.direction === 'down' && d.deliveryLine.text.includes('-0.2'),
      d.deliveryLine && `${d.deliveryLine.direction} — ${d.deliveryLine.text}`);
    check('net line says stable', d.netLine && d.netLine.verdict === 'stable',
      d.netLine && `${d.netLine.verdict} — ${d.netLine.text}`);

    /* --- 6. the sentence: both halves, in words ------------------------- */
    const s = d.sentence || '';
    check('sentence contains "usage mix is flat"', /usage mix is flat/i.test(s), s);
    check('sentence contains "delivery & fixed charges fell (-0.2¢/kWh)"',
      s.includes('delivery & fixed charges fell (-0.2¢/kWh)'), s);
    check('sentence contains "rates rose (+0.2¢/kWh)"', s.includes('rates rose (+0.2¢/kWh)'), s);
    check('sentence contains the net verdict', /net (stable|trending)/i.test(s), s);
    check('sentence no longer claims the usage mix improved',
      !/usage mix improved/i.test(s), s);
    check('sentence does not credit delivery as behaviour',
      !/delivery[^;]*behavior-driven/i.test(s), s);

    await page.screenshot({ path: path.join(OUT, 'wave-s-split-hygiene-desktop.png'), fullPage: true });
    await page.getByTestId('efficiency-card')
      .screenshot({ path: path.join(OUT, 'wave-s-split-hygiene-efficiency-card.png') })
      .catch(() => {});

    await ctx.close();
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'S-split-hygiene',
    scope: 'three-way usage/delivery/rate split, verdict read from usage',
    base: BASE,
    deploy: process.env.WAVE_S_SPLIT_SHA || null,
    fixture: path.basename(FIXTURE),
    fixtureSha256: sha,
    fixtureBytes: bytes.length,
    at: new Date().toISOString(),
    tz: 'America/Toronto',
    window: WINDOW,
    expected: PUBLISHED,
    audit: {
      bills: (audit.perBill || []).length,
      allTimeCents: Number(allTime.toFixed(4)),
      slopes: Object.fromEntries(
        Object.entries(fits).map(([k, v]) => [
          k,
          { slope: Number(v.slope.toFixed(4)), stderr: Number(v.stderr.toFixed(4)) },
        ]),
      ),
      recombineCheck: audit.recombineCheck,
    },
    dom: d,
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  const file = path.join(OUT, `wave-s-split-hygiene-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
