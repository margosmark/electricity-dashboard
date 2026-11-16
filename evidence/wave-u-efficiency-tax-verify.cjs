/**
 * Wave U — the EFFICIENCY card's ¢/kWh HONESTY: what the numerator contains,
 * checked on the DEPLOYED stack against Mark's real exports.
 *
 * The card used to print a bare "16.3¢/kWh" whose numerator nobody had
 * stated. Mark asked "does the avg kWh cost include all fees?" and the UI
 * could not answer. Verified from the source: the numerator IS the bill's
 * own "Total Electricity Charges" line — commodity + Delivery + Regulatory —
 * and HST is a SEPARATE line beneath it, so the headline was never all-in.
 *
 * Every assertion here is about that fix, and each number is checked twice:
 * once against the independent Python audit (evidence/
 * wave-u-efficiency-tax-audit.py — ElementTree over the raw export, no
 * webapp code) and once against what the DOM actually prints. Nothing is
 * asserted from lib/statistics.ts:
 *
 *   1. the SUBTITLE names the charges, the divisor and the tax exclusion —
 *      the answer to the question, printed where the number is;
 *   2. the headline is published TWICE, simultaneously (no toggle): the
 *      pre-tax figure relabelled "excl. tax" beside a new "incl. tax"
 *      figure, each equal to the audit's own arithmetic to ±0.011¢;
 *   3. the incl-tax figure is the SAME bills and the SAME kWh with each
 *      bill's OWN tax line added back — Σ(cost+tax) ÷ ΣkWh — not the
 *      pre-tax mean scaled by 1.13, and not a different bill set;
 *   4. the footnote quotes the tax rate the FILE states (ΣHST ÷ Σcharges),
 *      not the 13% Ontario happens to charge, and says that water and gas
 *      are billed separately and never appear in these numbers;
 *   5. the totals strip carries the SAME subtitle and the SAME pair for
 *      all-time AND in-view, so no view of the same bills disagrees;
 *   6. every bill the mini-line draws carries both readings;
 *   7. the verdict and the usage/rate/delivery split are UNCHANGED by the
 *      tax dimension — a tax line is a constant multiplier and moves no
 *      slope. On the 2-year export that still means STABLE.
 *
 * Run:  WAVE_U_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-u-efficiency-tax-verify.cjs
 * Env:  WAVE_U_BASE_URL (default http://dashboard.example.internal:3939/ — deployed),
 *       WAVE_U_CHROMIUM (default /usr/bin/chromium),
 *       WAVE_U_XML (REQUIRED — Mark's export never enters the repo; only
 *                   its sha256 lands in the JSON),
 *       WAVE_U_SHA (the commit the deployed stack is serving),
 *       WAVE_U_SUFFIX ('-local' writes -verification-local.json).
 *
 * Writes evidence/wave-u-efficiency-tax-verification[-suffix].json
 *            + wave-u-efficiency-tax-*.png
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

const BASE = process.env.WAVE_U_BASE_URL || 'http://dashboard.example.internal:3939/';
const CHROMIUM = process.env.WAVE_U_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.WAVE_U_SUFFIX || '';
const FIXTURE = process.env.WAVE_U_XML;
const OUT = __dirname;

const SUBTITLE =
  'ALL electricity charges (commodity + delivery + regulatory) ÷ billed kWh — tax excluded';

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail == null ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;
/** Display rounding: 16.2575 → '16.3'. */
const shown = (cents) => Number(cents).toFixed(1);

async function shownWait(locator, timeout = 60_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** The second opinion: the Python audit, run right now against the export. */
function runAudit(xml) {
  const raw = execFileSync(
    'python3',
    [path.resolve(__dirname, 'wave-u-efficiency-tax-audit.py'), xml],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

/** Everything the card and strip expose about the tax dimension. */
function readDom(page) {
  return page.evaluate(() => {
    const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const one = (sel) => document.querySelector(sel);
    const all = (sel) => [...document.querySelectorAll(sel)];
    const attrs = (el, names) => {
      const out = {};
      for (const n of names) out[n] = el ? el.getAttribute(n) : null;
      return out;
    };
    const block = one('[data-testid="efficiency-headline"]');
    const strip = one('[data-testid="efficiency-strip"]');
    const note = one('[data-testid="efficiency-tax-footnote"]');
    const range = one('[data-testid="efficiency-range"]');
    const chip = one('[data-testid="efficiency-trend-chip"]');
    return {
      subtitle: one('[data-testid="efficiency-subtitle"]')
        ? flat(one('[data-testid="efficiency-subtitle"]').textContent)
        : null,
      headline: {
        ...attrs(block, ['data-cents', 'data-cents-incl-tax', 'data-tax']),
        excl: one('[data-testid="efficiency-all-time"]')
          ? {
              text: flat(one('[data-testid="efficiency-all-time"]').textContent),
              label: flat(
                one('[data-testid="efficiency-all-time"]').parentElement
                  ? one('[data-testid="efficiency-all-time"]').parentElement.textContent
                  : '',
              ),
            }
          : null,
        incl: one('[data-testid="efficiency-all-time-incl-tax"]')
          ? {
              text: flat(one('[data-testid="efficiency-all-time-incl-tax"]').textContent),
              cents: one('[data-testid="efficiency-all-time-incl-tax"]').getAttribute(
                'data-cents',
              ),
              label: flat(
                one('[data-testid="efficiency-all-time-incl-tax"]').parentElement
                  ? one('[data-testid="efficiency-all-time-incl-tax"]').parentElement.textContent
                  : '',
              ),
            }
          : null,
        billLabel: block ? flat(block.textContent).slice(0, 40) : null,
      },
      footnote: note
        ? { text: flat(note.textContent), pct: note.getAttribute('data-tax-pct') }
        : null,
      strip: strip
        ? {
            text: flat(strip.textContent),
            subtitleHasTaxExcluded: /tax excluded/i.test(flat(strip.textContent)),
            subtitleHasAllCharges: /ALL electricity charges/i.test(flat(strip.textContent)),
            allTime: one('[data-testid="efficiency-all-time-strip"]')
              ? attrs(one('[data-testid="efficiency-all-time-strip"]'), [
                  'data-cents',
                  'data-bills',
                ])
              : null,
            allTimeIncl: one('[data-testid="efficiency-all-time-strip-incl-tax"]')
              ? attrs(one('[data-testid="efficiency-all-time-strip-incl-tax"]'), ['data-cents'])
              : null,
            inView: one('[data-testid="efficiency-in-view"]')
              ? attrs(one('[data-testid="efficiency-in-view"]'), ['data-cents', 'data-bills'])
              : null,
            inViewIncl: one('[data-testid="efficiency-in-view-incl-tax"]')
              ? attrs(one('[data-testid="efficiency-in-view-incl-tax"]'), ['data-cents'])
              : null,
          }
        : null,
      range: range
        ? {
            text: flat(range.textContent),
            ...attrs(range, [
              'data-first-cents',
              'data-first-cents-incl-tax',
              'data-last-cents',
              'data-last-cents-incl-tax',
            ]),
          }
        : null,
      points: all('[data-testid="efficiency-point"]').map((el) => ({
        start: el.getAttribute('data-start'),
        cents: el.getAttribute('data-cents'),
        centsInclTax: el.getAttribute('data-cents-incl-tax'),
        tax: el.getAttribute('data-tax'),
        kwh: el.getAttribute('data-kwh'),
      })),
      chip: chip
        ? attrs(chip, ['data-verdict', 'data-slope', 'data-usage-slope', 'data-net-slope'])
        : null,
      inOverview: !!one('[data-testid="tab-panel-overview"] [data-testid="efficiency-card"]'),
    };
  });
}

async function main() {
  if (!FIXTURE) {
    console.error('WAVE_U_XML is required — the committed fixtures carry no real tax history.');
    process.exit(2);
  }
  const bytes = fs.readFileSync(FIXTURE);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = path.basename(FIXTURE);

  console.log(`Wave U efficiency tax honesty — verify at ${BASE}`);
  console.log(`fixture: ${bytes.length} bytes, sha256 ${sha} (${file})`);

  const audit = runAudit(FIXTURE);
  const bills = audit.bills || [];
  const at = audit.allTime;
  console.log(
    `independent audit: ${at.bills} bills, Σcharges $${at.cost} + ΣHST $${at.tax} over ${at.kwh} kWh ` +
      `→ ${at.cents.toFixed(4)}¢ excl / ${at.centsInclTax.toFixed(4)}¢ incl (HST ${at.taxPct.toFixed(3)}%)\n`,
  );

  /* --- 0. the audit itself must reproduce the published pair ------------- */
  check('audit sees bills', at.bills > 0, `${at.bills}`);
  check('audit: every bill carries a tax line', audit.billsWithoutTax === 0,
    `${audit.billsWithoutTax} without`);
  check('audit: the implied rate rounds to 13.0%', near(at.taxPct, 13.0, 0.01),
    `${at.taxPct.toFixed(4)}%`);
  check('audit: incl = Σ(cost+tax) ÷ ΣkWh exactly (±0.0001)',
    near(at.centsInclTax, ((at.cost + at.tax) / at.kwh) * 100, 0.0001),
    `${at.centsInclTax.toFixed(4)} vs ${(((at.cost + at.tax) / at.kwh) * 100).toFixed(4)}`);
  check('audit: incl > excl on every bill',
    bills.every((b) => b.centsInclTax > b.cents), `${bills.length} bills`);

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
    const loaded = await shownWait(page.getByTestId('totals-strip'));
    if (!loaded) throw new Error('upload never produced a totals strip');
    await shownWait(page.getByTestId('efficiency-card'), 30_000);
    d = await readDom(page);

    /* --- 1. the subtitle answers the question ---------------------------- */
    check('the card subtitle names the charges, the divisor and the exclusion',
      d.subtitle === SUBTITLE, d.subtitle);
    check('the card subtitle says "tax excluded"',
      /tax excluded/i.test(d.subtitle || ''), d.subtitle);
    check('the card subtitle names all three charge classes',
      /commodity \+ delivery \+ regulatory/i.test(d.subtitle || ''), d.subtitle);

    /* --- 2. the headline is published twice, both matching the audit ----- */
    check('the card is on Overview', d.inOverview, String(d.inOverview));
    check(`all-time EXCL. TAX prints ${shown(at.cents)}¢`,
      d.headline.excl && d.headline.excl.text.startsWith(shown(at.cents)),
      d.headline.excl ? `${d.headline.excl.text} (data-cents ${d.headline['data-cents']})` : 'missing');
    check('all-time excl. tax == the audit (±0.011)',
      near(d.headline['data-cents'], at.cents, 0.011),
      `${d.headline['data-cents']} vs ${at.cents.toFixed(4)}`);
    check(`all-time INCL. TAX prints ${shown(at.centsInclTax)}¢`,
      d.headline.incl && d.headline.incl.text.startsWith(shown(at.centsInclTax)),
      d.headline.incl ? `${d.headline.incl.text} (data-cents ${d.headline.incl.cents})` : 'missing');
    check('all-time incl. tax == the audit (±0.011)',
      near(d.headline.incl && d.headline.incl.cents, at.centsInclTax, 0.011),
      `${d.headline.incl && d.headline.incl.cents} vs ${at.centsInclTax.toFixed(4)}`);
    check('the excl figure is LABELLED "excl. tax"',
      /excl\. tax/i.test(d.headline.excl ? d.headline.excl.label : ''),
      d.headline.excl ? d.headline.excl.label : 'missing');
    check('the incl figure is LABELLED "incl. tax"',
      /incl\. tax/i.test(d.headline.incl ? d.headline.incl.label : ''),
      d.headline.incl ? d.headline.incl.label : 'missing');
    check('BOTH figures live in the same headline block (not a toggle)',
      d.headline.excl && d.headline.incl &&
        d.headline.excl.text !== d.headline.incl.text,
      `excl ${d.headline.excl && d.headline.excl.text} · incl ${d.headline.incl && d.headline.incl.text}`);
    check('headline block carries the tax dollars the file states',
      near(d.headline['data-tax'], at.tax, 0.011),
      `${d.headline['data-tax']} vs ${at.tax}`);
    check(`the bill count still reads ${at.bills}`,
      d.headline.billLabel && d.headline.billLabel.includes(`${at.bills} bill`),
      d.headline.billLabel);

    /* --- 3. the incl figure is Σ(cost+tax) ÷ ΣkWh, same bills ----------- */
    // The DOM publishes cents to 2dp (data-cents, the convention every card
    // in this app follows), so the ratio is compared at THAT precision —
    // the audit's own figures rounded the same way. Comparing a 2dp ratio
    // against an unrounded one would fail on rounding, not on the arithmetic.
    const domRatio = Number(d.headline.incl.cents) / Number(d.headline['data-cents']);
    const auditRatio =
      Number(Number(at.cents).toFixed(2)) !== 0
        ? Number(Number(at.centsInclTax).toFixed(2)) / Number(Number(at.cents).toFixed(2))
        : NaN;
    check('incl ÷ excl == Σ(cost+tax) ÷ Σcost, both at the published 2dp (±1e-9)',
      near(domRatio, auditRatio, 1e-9),
      `${domRatio.toFixed(6)} vs ${auditRatio.toFixed(6)}`);
    check('the incl figure is derived from the file\'s dollars, not scaled (±0.011)',
      near(Number(d.headline.incl.cents), ((at.cost + at.tax) / at.kwh) * 100, 0.011),
      `${d.headline.incl.cents} vs ${(((at.cost + at.tax) / at.kwh) * 100).toFixed(4)}`);

    /* --- 4. the footnote quotes the FILE's rate and the exclusions ------ */
    check(`the footnote quotes the file's own rate (${at.taxPct.toFixed(1)}%)`,
      d.footnote && d.footnote.text.includes(`HST on your bills is ${at.taxPct.toFixed(1)}%`),
      d.footnote ? d.footnote.text : 'missing');
    check("the footnote's data attribute is the audit's rate (±0.01)",
      near(d.footnote && d.footnote.pct, at.taxPct, 0.01),
      `${d.footnote && d.footnote.pct} vs ${at.taxPct.toFixed(4)}`);
    check('the footnote says the incl figure adds the line back over the same kWh',
      d.footnote && /adds that line back over the same kWh/i.test(d.footnote.text),
      d.footnote ? d.footnote.text : 'missing');
    check('the footnote says water and gas are billed separately',
      d.footnote && /water and gas are billed separately/i.test(d.footnote.text),
      d.footnote ? d.footnote.text : 'missing');
    check('the footnote says those are never in these numbers',
      d.footnote && /never in these numbers/i.test(d.footnote.text),
      d.footnote ? d.footnote.text : 'missing');
    check('the footnote leaks no undefined/NaN',
      d.footnote && !/undefined|NaN|null/i.test(d.footnote.text),
      d.footnote ? d.footnote.text : 'missing');

    /* --- 5. the totals strip carries the same subtitle and the pair ----- */
    check('the totals strip uses the SAME subtitle',
      d.strip && d.strip.subtitleHasTaxExcluded && d.strip.subtitleHasAllCharges,
      d.strip ? d.strip.text.slice(0, 120) : 'missing');
    check('the strip restates the all-time EXCL figure identically',
      d.strip && d.strip.allTime && d.strip.allTime['data-cents'] === d.headline['data-cents'],
      d.strip && d.strip.allTime ? `${d.strip.allTime['data-cents']} vs ${d.headline['data-cents']}` : 'missing');
    check('the strip restates the all-time INCL figure identically',
      d.strip && d.strip.allTimeIncl &&
        d.strip.allTimeIncl['data-cents'] === d.headline.incl.cents,
      d.strip && d.strip.allTimeIncl ? `${d.strip.allTimeIncl['data-cents']} vs ${d.headline.incl.cents}` : 'missing');
    check('the strip labels both readings excl/incl',
      d.strip && /excl\. tax/i.test(d.strip.text) && /incl\. tax/i.test(d.strip.text),
      d.strip ? d.strip.text.slice(0, 160) : 'missing');
    check('the strip carries the bill count',
      d.strip && d.strip.allTime && Number(d.strip.allTime['data-bills']) === at.bills,
      d.strip && d.strip.allTime ? `${d.strip.allTime['data-bills']}` : 'missing');
    check('the in-view block carries BOTH readings too',
      d.strip && d.strip.inView && d.strip.inViewIncl &&
        Number(d.strip.inViewIncl['data-cents']) > 0,
      d.strip && d.strip.inView
        ? `excl ${d.strip.inView['data-cents']} / incl ${d.strip.inViewIncl['data-cents']}`
        : 'missing');
    check('no view disagrees: in-view bills == the bills its incl figure covers',
      d.strip && d.strip.inView && Number(d.strip.inView['data-bills']) >= 1,
      d.strip && d.strip.inView ? `${d.strip.inView['data-bills']} bills` : 'missing');

    /* --- 6. every mini-line point carries both readings ----------------- */
    check(`the mini-line draws ${bills.length} bills`, d.points.length === bills.length,
      `${d.points.length} vs ${bills.length}`);
    const byDate = new Map(bills.map((b) => [b.date, b]));
    let perBillMismatches = 0;
    for (const p of d.points) {
      const b = byDate.get(p.start);
      if (!b) { perBillMismatches += 1; continue; }
      if (!near(p.cents, b.cents, 0.011)) perBillMismatches += 1;
      if (!near(p.centsInclTax, b.centsInclTax, 0.011)) perBillMismatches += 1;
      if (!near(p.tax, b.tax, 0.011)) perBillMismatches += 1;
    }
    check('every drawn bill matches the audit on excl, incl AND tax (±0.011)',
      perBillMismatches === 0, `${perBillMismatches} mismatches`);
    check('every drawn bill carries a non-null incl-tax figure',
      d.points.length > 0 && d.points.every((p) => p.centsInclTax !== null),
      `${d.points.length} points`);
    check('the range line prints both readings at both endpoints',
      d.range && /excl/i.test(d.range.text) && /incl/i.test(d.range.text),
      d.range ? d.range.text : 'missing');
    check('the range line carries the incl-tax endpoints as data',
      d.range && d.range['data-first-cents-incl-tax'] && d.range['data-last-cents-incl-tax'],
      d.range
        ? `first ${d.range['data-first-cents-incl-tax']} / last ${d.range['data-last-cents-incl-tax']}`
        : 'missing');

    /* --- 7. the verdict and the split are untouched --------------------- */
    if (d.chip) {
      check('the trend chip still reads a verdict (unchanged by the tax dimension)',
        !!d.chip['data-verdict'],
        `verdict=${d.chip['data-verdict']} slope=${d.chip['data-slope']}`);
      check('the chip\'s slope is still the PRE-TAX usage slope',
        d.chip['data-slope'] === d.chip['data-usage-slope'],
        `slope=${d.chip['data-slope']} usage=${d.chip['data-usage-slope']}`);
      if (at.bills >= 12) {
        check('on the 2-year export the verdict is still STABLE',
          d.chip['data-verdict'] === 'stable', `${d.chip['data-verdict']}`);
      }
    } else {
      check('a short file still earns the stat with no verdict (trend floor)',
        at.bills < 4, `${at.bills} bills, no chip`);
    }

    await page.screenshot({ path: path.join(OUT, 'wave-u-efficiency-tax-desktop.png'), fullPage: true });
    await page.getByTestId('efficiency-card')
      .screenshot({ path: path.join(OUT, 'wave-u-efficiency-tax-card.png') })
      .catch(() => {});

    /* --- mobile: the pair must survive a 390px viewport ----------------- */
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: 'America/Toronto',
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const mpage = await mobile.newPage();
    await mpage.goto(BASE, { waitUntil: 'domcontentloaded' });
    await mpage.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
    if (await shownWait(mpage.getByTestId('totals-strip'), 60_000)) {
      await shownWait(mpage.getByTestId('efficiency-card'), 30_000);
      const md = await readDom(mpage);
      check('mobile: both headline readings still render',
        md.headline.excl && md.headline.incl &&
          md.headline['data-cents'] === d.headline['data-cents'] &&
          md.headline.incl.cents === d.headline.incl.cents,
        `excl ${md.headline['data-cents']} / incl ${md.headline.incl && md.headline.incl.cents}`);
      check('mobile: the subtitle still says tax excluded',
        /tax excluded/i.test(md.subtitle || ''), md.subtitle);
      await mpage.screenshot({ path: path.join(OUT, 'wave-u-efficiency-tax-mobile.png'), fullPage: true });
    }
    await mobile.close();
    await ctx.close();
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'U-efficiency-tax',
    scope: '¢/kWh numerator honesty — subtitle, excl/incl pair, tax footnote',
    base: BASE,
    deploy: process.env.WAVE_U_SHA || null,
    fixture: file,
    fixtureSha256: sha,
    fixtureBytes: bytes.length,
    at: new Date().toISOString(),
    tz: 'America/Toronto',
    subtitle: SUBTITLE,
    audit: {
      bills: at.bills,
      cost: at.cost,
      tax: at.tax,
      kwh: at.kwh,
      cents: Number(at.cents.toFixed(4)),
      centsInclTax: Number(at.centsInclTax.toFixed(4)),
      taxPct: Number(at.taxPct.toFixed(4)),
    },
    dom: d,
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  const outFile = path.join(OUT, `wave-u-efficiency-tax-verification${SUFFIX}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(outFile)}`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
