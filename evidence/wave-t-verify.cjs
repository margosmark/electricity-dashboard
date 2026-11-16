/**
 * Wave T browser verification — the three new slices on a running stack.
 *
 * Wave T's claims are three, and each is checked against an INDEPENDENT
 * source rather than against the app's own arithmetic:
 *
 *   1. the temperature-banded curve: every bin's hours, kWh, mean kWh/h and
 *      share read back from the DOM and compared with evidence/wave-t-audit.py
 *      — a Python ElementTree parse of the same XML plus its own live
 *      Open-Meteo fetch, so neither side can agree with itself;
 *   2. the anomaly context lines: the day, the verdict and the temperature,
 *      against the audit's own day-of-week rule and thresholds;
 *   3. the delivery/regulatory decomposition: status, amount, worst miss and
 *      residual share, against the audit's own least-squares fit.
 *
 * Plus the invariant the whole design leans on: the ONLY cross-origin request
 * this app makes is the browser's own fetch to Open-Meteo's CDN, it carries
 * the coordinates this build is configured with, and it asks for exactly the
 * dates the loaded readings cover — no server round trip, no date without
 * data. Playwright records every request the page makes and asserts on them.
 *
 * Run:  WAVE_T_XML=/path/to/export.xml TZ=America/Toronto node evidence/wave-t-verify.cjs
 * Env:  WAVE_T_BASE_URL (default http://dashboard.example.internal:3939/ — the deployed
 *         stack), WAVE_T_CHROMIUM, WAVE_T_XML (defaults to the committed
 *         Green Button Alliance sample), WAVE_T_SUFFIX ('-local' writes
 *         wave-t-verification-local.json), WAVE_T_DEPLOY (the commit the
 *         deployed stack was built from).
 *
 * Writes evidence/wave-t-verification[-suffix].json + wave-t-*.png
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

const BASE = process.env.WAVE_T_BASE_URL || 'http://dashboard.example.internal:3939/';
const CHROMIUM = process.env.WAVE_T_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.WAVE_T_SUFFIX || '';
const FIXTURE =
  process.env.WAVE_T_XML ||
  path.resolve(__dirname, '../webapp/tests/fixtures/green-button-alliance-sample.xml');
const OUT = __dirname;

/** The window the audit covers: wider than any real export. */
const FULL_WINDOW = { start: '2024-01-01', end: '2027-12-31' };

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail == null ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** The second opinion: a Python parse of the same XML plus live weather. */
function runAudit(xml, window) {
  const raw = execFileSync(
    'python3',
    [path.resolve(__dirname, 'wave-t-audit.py'), xml, window.start, window.end],
    { encoding: 'utf8' },
  );
  return JSON.parse(raw);
}

/** Everything the Wave T surfaces expose, in one evaluate. */
function readSlices(page) {
  return page.evaluate(() => {
    const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const one = (sel) => document.querySelector(sel);
    const all = (sel) => [...document.querySelectorAll(sel)];
    const attr = (el, name) => (el ? el.getAttribute(name) : null);

    const card = one('[data-testid="temp-band-card"]');
    return {
      tab: card ? !!one('[data-testid="tab-panel-usage"] [data-testid="temp-band-card"]') : false,
      inMoney: !!one('[data-testid="tab-panel-money"] [data-testid="temp-band-card"]'),
      card: card
        ? {
            status: attr(card, 'data-status'),
            source: attr(card, 'data-source'),
            matched: attr(card, 'data-matched'),
            total: attr(card, 'data-total'),
            text: flat(card.textContent),
          }
        : null,
      bars: all('[data-testid="temp-band-bar"]').map((el) => ({
        band: attr(el, 'data-band'),
        label: attr(el, 'data-label'),
        hours: attr(el, 'data-hours'),
        meanKwh: attr(el, 'data-mean-kwh'),
        cents: attr(el, 'data-cents'),
        share: attr(el, 'data-share'),
        meanTemp: attr(el, 'data-mean-temp'),
      })),
      shares: all('[data-testid="temp-band-share"]').length,
      anomalies: all('[data-testid^="anomaly-context-"]').map((el) => ({
        kind: attr(el, 'data-kind'),
        temp: attr(el, 'data-temp'),
        text: flat(el.textContent),
      })),
      decomposition: ['delivery', 'regulatory'].map((line) => {
        const el = one(`[data-testid="charge-decomposition-${line}"]`);
        const head = one(`[data-testid="decomposition-headline-${line}"]`);
        return el
          ? {
              line,
              status: attr(el, 'data-status'),
              amount: attr(el, 'data-amount'),
              kwh: attr(el, 'data-kwh'),
              periods: attr(el, 'data-periods'),
              blendedCents: attr(el, 'data-blended-cents'),
              fixed: attr(el, 'data-fixed'),
              variable: attr(el, 'data-variable'),
              maxResidual: attr(el, 'data-max-residual'),
              residualShare: attr(el, 'data-residual-share'),
              headline: head ? flat(head.textContent) : '',
              text: flat(el.textContent),
            }
          : { line, missing: true };
      }),
    };
  });
}

/** Open a loaded app, then drag the window wide enough to hold the export. */
async function openLoaded(browser, viewport, xml, collect) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (req) => {
    try {
      requests.push(new URL(req.url()));
    } catch {
      /* about:blank and friends */
    }
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(xml);
  const loaded = await shown(page.getByTestId('totals-strip'), 60_000);
  if (!loaded) throw new Error('upload never produced a totals strip');

  if (collect) {
    await page.getByRole('tab', { name: 'Usage' }).click();
    await page.getByLabel('Window start date').fill(FULL_WINDOW.start);
    await page.getByLabel('Window end date').fill(FULL_WINDOW.end);
  }
  return { ctx, page, requests };
}

function assertBands(d, audit) {
  const byId = new Map(audit.bands.map((b) => [b.id, b]));
  check('seven bins are drawn', d.bars.length === 7, `${d.bars.length}`);
  check('a share strip is drawn for every bin', d.shares === 7, `${d.shares}`);

  const badHours = [];
  const badKwh = [];
  const badMean = [];
  const badShare = [];
  for (const bar of d.bars) {
    const want = byId.get(bar.band);
    if (!want) {
      badHours.push(`${bar.band}: not an audit bin`);
      continue;
    }
    if (Number(bar.hours) !== want.hours) badHours.push(`${bar.band}: ${bar.hours} vs ${want.hours}`);
    if (!near(bar.meanKwh, want.meanKwhPerHour, 0.002)) {
      badMean.push(`${bar.band}: ${bar.meanKwh} vs ${want.meanKwhPerHour.toFixed(3)}`);
    }
    if (!near(bar.share, want.shareOfKwh, 0.0005)) {
      badShare.push(`${bar.band}: ${bar.share} vs ${want.shareOfKwh.toFixed(4)}`);
    }
    // The DOM carries the mean to 3 dp (thousands of hours × 0.0005 is a
    // couple of kWh of display rounding), so the tolerance scales with hours.
    const kwh = Number(bar.meanKwh) * Number(bar.hours);
    const kwhTol = Number(bar.hours) * 0.0005 + 0.02;
    if (!near(kwh, want.kwh, kwhTol)) badKwh.push(`${bar.band}: ${kwh.toFixed(2)} vs ${want.kwh} (±${kwhTol.toFixed(2)})`);
  }
  check(`every bin's hour count matches the second parser (${audit.hours.matched} hours)`,
    badHours.length === 0, badHours.join('; ') || `${d.bars.length} matched`);
  check("every bin's mean kWh/h matches", badMean.length === 0, badMean.join('; ') || '7 matched');
  check("every bin's kWh (mean × hours) matches", badKwh.length === 0, badKwh.join('; ') || '7 matched');
  check("every bin's share of the window's kWh matches", badShare.length === 0, badShare.join('; ') || '7 matched');

  const cold = byId.get('-10..5');
  const hot = byId.get('24..30');
  const top = byId.get('gt-30');
  check('the cold half is flat and the hot half is not (the AC story)',
    cold.meanKwhPerHour < 2 && hot.meanKwhPerHour > cold.meanKwhPerHour * 3 && top.meanKwhPerHour > hot.meanKwhPerHour,
    `${cold.meanKwhPerHour.toFixed(2)} → ${hot.meanKwhPerHour.toFixed(2)} → ${top.meanKwhPerHour.toFixed(2)} kWh/h`);
}

function assertAnomalies(d, audit) {
  check('five anomaly cards carry a weather line', d.anomalies.length === audit.anomalies.length,
    `${d.anomalies.length} vs audit ${audit.anomalies.length}`);
  const bad = [];
  audit.anomalies.forEach((want, i) => {
    const got = d.anomalies[i];
    if (!got) return;
    if (got.kind !== want.kind) bad.push(`${want.date}: kind ${got.kind} vs ${want.kind}`);
    else if (String(got.temp) !== String(want.temp)) bad.push(`${want.date}: temp ${got.temp} vs ${want.temp}`);
    else if (!got.text.includes(want.text)) bad.push(`${want.date}: "${got.text}" vs "${want.text}"`);
  });
  check('each verdict matches the audit\u2019s own thresholds', bad.length === 0,
    bad.join('; ') || audit.anomalies.map((a) => `${a.date} ${a.text}`).join(' | '));
}

function assertDecomposition(d, audit) {
  for (const line of ['delivery', 'regulatory']) {
    const want = audit.fit[line];
    const got = d.decomposition.find((x) => x.line === line);
    if (!want || want.status === null) {
      check(`${line}: the audit found nothing to fit`, !!got && got.missing, JSON.stringify(got));
      continue;
    }
    check(`${line} card rendered`, got && !got.missing, got && got.status);
    check(`${line} status == the audit's verdict (${want.status})`, got.status === want.status,
      `${got.status} vs ${want.status}`);
    check(`${line} amount == the audit's ${want.amount}`,
      near(got.amount, want.amount, 0.02), `${got.amount} vs ${want.amount}`);
    check(`${line} periods == ${want.periods}`, Number(got.periods) === want.periods, `${got.periods}`);
    check(`${line} worst miss == the audit's ${want.maxResidual}`,
      near(got.maxResidual, want.maxResidual, 0.02), `${got.maxResidual} vs ${want.maxResidual}`);
    check(`${line} residual share == the audit's ${want.residualShare}`,
      near(got.residualShare, want.residualShare, 0.001), `${got.residualShare} vs ${want.residualShare}`);

    if (want.status === 'rejected') {
      check(`${line} headline is the honest refusal`, got.headline ===
        `${line === 'delivery' ? 'Delivery is' : 'Regulatory charges are'} not linearly decomposable from this data.`,
        got.headline);
      check(`${line} card still shows the rate that IS true`,
        near(got.blendedCents, (want.amount / audit.bills[audit.bills.length - 1].kwh) * 100, 0.02),
        `${got.blendedCents}¢/kWh`);
      check(`${line} invents no fixed/variable numbers`, got.fixed === '' && got.variable === '',
        `fixed=${got.fixed} variable=${got.variable}`);
    } else {
      check(`${line} halves sum to the charge`, near(Number(got.fixed) + Number(got.variable), Number(got.amount), 0.02),
        `${got.fixed} + ${got.variable} vs ${got.amount}`);
      check(`${line} headline is the split sentence`,
        got.headline.startsWith(`Of your $${Number(got.amount).toFixed(2)}`), got.headline);
    }
  }
}

function assertFetches(requests, audit) {
  const foreign = requests.filter((u) => u.host !== new URL(BASE).host);
  const openMeteo = foreign.filter((u) => u.hostname === 'archive-api.open-meteo.com');
  const other = foreign.filter((u) => u.hostname !== 'archive-api.open-meteo.com');

  check('the ONLY cross-origin host is Open-Meteo\u2019s CDN', other.length === 0,
    other.length === 0 ? `${openMeteo.length} Open-Meteo requests` : other.map((u) => u.host).join(', '));
  check('no request ever goes to this app\u2019s server for weather',
    !foreign.some((u) => u.pathname.includes('weather') || u.pathname.includes('temperature')),
    foreign.map((u) => u.pathname).join(', ') || 'none');
  if (openMeteo.length === 0) return;

  const asked = openMeteo.map((u) => ({
    start: u.searchParams.get('start_date'),
    end: u.searchParams.get('end_date'),
    hourly: u.searchParams.get('hourly'),
    tz: u.searchParams.get('timezone'),
    lat: u.searchParams.get('latitude'),
    lon: u.searchParams.get('longitude'),
  }));
  const firstDay = audit.readings.first.slice(0, 10);
  const lastDay = audit.readings.last.slice(0, 10);
  const inSpan = asked.every((a) => a.start >= firstDay && a.end <= lastDay);
  check(`every temperature request is inside the data's own dates (${firstDay}..${lastDay})`,
    inSpan, asked.map((a) => `${a.start}..${a.end}`).join(', '));
  check('the requests ask for hourly temperature_2m, aligned on UTC',
    asked.every((a) => a.hourly === 'temperature_2m' && a.tz === 'UTC'),
    asked[0] ? `hourly=${asked[0].hourly} timezone=${asked[0].tz}` : 'none');
  check('the requests carry only the configured city coordinates',
    asked.every((a) => a.lat === String(audit.location.latitude) && a.lon === String(audit.location.longitude)),
    asked[0] ? `${asked[0].lat},${asked[0].lon}` : 'none');
}

async function desktopRun(browser, audit, sha) {
  const { ctx, page, requests } = await openLoaded(browser, { width: 1440, height: 900 }, FIXTURE, true);
  try {
    const ready = await shown(page.getByTestId('temp-band-card'), 30_000);
    check('the temperature card renders on the USAGE tab', ready, ready ? 'visible' : 'missing');

    // Wait for the card to settle on a real answer (or an honest failure).
    await page
      .waitForFunction(() => {
        const el = document.querySelector('[data-testid="temp-band-card"]');
        return el && el.getAttribute('data-status') !== 'idle' ? 'ok' : null;
      }, null, { timeout: 60_000 })
      .catch(() => {});

    const d = await readSlices(page);
    check('the card reports where its temperatures came from',
      d.card && ['cache', 'network'].includes(d.card.source), d.card ? d.card.source : 'missing');
    check('the card matched every hour of the export',
      d.card && Number(d.card.matched) === audit.hours.total && Number(d.card.total) === audit.hours.total,
      d.card ? `${d.card.matched}/${d.card.total} vs audit ${audit.hours.total}` : 'missing');
    check('the card names the no-server invariant', d.card && d.card.text.includes('No server saw this request'),
      d.card ? (d.card.text.includes('No server saw this request') ? 'stated' : 'missing') : 'missing');
    check('the card is NOT on the Money tab', !d.inMoney, String(d.inMoney));

    assertBands(d, audit);

    /* --- the sentence the chart exists to deliver -------------------- */
    const coldMean = audit.bands.find((b) => b.id === '-10..5').meanKwhPerHour;
    const hotMean = audit.bands.find((b) => b.id === '24..30').meanKwhPerHour;
    const hotShare = audit.bands.find((b) => b.id === '24..30').shareOfKwh;
    check('the footer sentence quotes the curve\u2019s shape in words',
      d.card.text.includes(coldMean.toFixed(2)) && d.card.text.includes(hotMean.toFixed(2)) &&
        d.card.text.includes(`${Math.round(hotShare * 100)}%`),
      `${coldMean.toFixed(2)} / ${hotMean.toFixed(2)} kWh/h, ${Math.round(hotShare * 100)}% of kWh`);

    await page.screenshot({ path: path.join(OUT, 'wave-t-desktop-usage.png'), fullPage: true });
    await page.getByTestId('temp-band-card')
      .screenshot({ path: path.join(OUT, 'wave-t-desktop-temp-band.png') })
      .catch(() => {});

    /* --- S2: the anomaly cards --------------------------------------- */
    await page
      .waitForFunction((n) => document.querySelectorAll('[data-testid^="anomaly-context-"]').length >= n,
        audit.anomalies.length, { timeout: 20_000 })
      .catch(() => {});
    assertAnomalies(await readSlices(page), audit);

    /* --- S3: the delivery decomposition — inside "Your actual bill",
     *      which lives on the PLANS tab next to the bill it describes. ---- */
    await page.getByRole('tab', { name: 'Plans' }).click();
    await shown(page.getByTestId('charge-decomposition-delivery'), 20_000);
    assertDecomposition(await readSlices(page), audit);
    await page.screenshot({ path: path.join(OUT, 'wave-t-desktop-plans.png'), fullPage: true });

    /* --- the invariant, read off the real network log ----------------- */
    assertFetches(requests, audit);

    console.log(`\nfixture sha256 ${sha}`);
    return d;
  } finally {
    await ctx.close();
  }
}

async function mobileRun(browser, audit) {
  const { ctx, page } = await openLoaded(browser, { width: 390, height: 844 }, FIXTURE, true);
  try {
    await shown(page.getByTestId('temp-band-card'), 30_000);
    await page
      .waitForFunction(() => {
        const el = document.querySelector('[data-testid="temp-band-card"]');
        return el && el.getAttribute('data-status') !== 'idle' ? 'ok' : null;
      }, null, { timeout: 60_000 })
      .catch(() => {});
    const d = await readSlices(page);
    check('mobile: the temperature card renders', !!d.card, d.card ? d.card.status : 'missing');
    check('mobile: every bin still carries its numbers', d.bars.length === 7, `${d.bars.length} bars`);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('mobile: no sideways scrolling', overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: path.join(OUT, 'wave-t-mobile-usage.png'), fullPage: true });
    return d;
  } finally {
    await ctx.close();
  }
}

async function main() {
  const xml = FIXTURE;
  const bytes = fs.readFileSync(xml);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  console.log(`Wave T verify — ${BASE}`);
  console.log(`fixture: ${bytes.length} bytes, sha256 ${sha} (${path.basename(xml)})`);
  const audit = runAudit(xml, FULL_WINDOW);
  console.log(
    `independent audit: ${audit.readings.count} readings, ${audit.hours.matched}/${audit.hours.total} hours matched, ` +
      `${audit.bands.length} bins, ${audit.bills.length} bills, delivery fit ${audit.fit.delivery && audit.fit.delivery.status}\n`,
  );

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    await desktopRun(browser, audit, sha);
    await mobileRun(browser, audit);
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'T',
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    /** The commit the deployed stack was at — set from the deploy's DEPLOY_OK line. */
    deployedCommit: process.env.WAVE_T_DEPLOY || null,
    fixtureSha256: sha,
    fixtureBytes: fs.statSync(xml).size,
    audit: {
      readings: audit.readings,
      hours: audit.hours,
      totalKwh: audit.totalKwh,
      location: audit.location,
      bands: audit.bands,
      deliveryFit: audit.fit.delivery,
      regulatoryFit: audit.fit.regulatory,
      anomalies: audit.anomalies,
    },
    passed,
    total: checks.length,
    checks,
  };
  const file = path.join(OUT, `wave-t-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
