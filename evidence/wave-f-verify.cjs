/**
 * Wave F browser verification on the DEPLOYED stack (electricity.markarslan.ca)
 * using the real Oakville Hydro export, plus a synthetic sustained-load file
 * that exercises the appliance-signature anomaly labels end to end.
 *
 * Run:  NODE_PATH=webapp/node_modules node evidence/wave-f-verify.cjs
 * Env:  WAVE_F_BASE_URL (default the public URL), WAVE_F_CHROMIUM (binary)
 *
 * Writes evidence/wave-f-verification.json + the wave-f-*.png screenshots.
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = process.env.WAVE_F_BASE_URL || 'https://electricity.markarslan.ca/';
const CHROMIUM = process.env.WAVE_F_CHROMIUM || '/usr/bin/chromium';
const DOCS = '/home/hermes/.hermes/profiles/pm/cache/documents';
const OAK1 = path.join(
  DOCS,
  'doc_936968b747af_oakvillehydro_Electricity_60_Minute_01-07-2026_02-10-2026.xml',
);
const OAK2 = path.join(
  DOCS,
  'doc_0d82612a6e96_oakvillehydro_Electricity_60_Minute_01-07-2026_02-10-2026.xml',
);
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

async function launch() {
  return chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

async function newPage(browser) {
  const ctx = await browser.newContext({
    timezoneId: 'America/Toronto',
    locale: 'en-CA',
    viewport: { width: 1600, height: 1200 },
  });
  return { ctx, page: await ctx.newPage() };
}

const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('energy_data') || '[]'));

/* --------------------------------------------------------------------------
 * A synthetic Green Button feed: a flat month of 0.8 kW hours, plus one
 * weekday that runs 4.0 kW for five straight hours — above detectAnomalies'
 * 1.5x / +5 kWh bar AND above classifyDayShape's 3 kW / 4 h sustained rule.
 * ------------------------------------------------------------------------ */
function buildSpikeXml() {
  const readings = [];
  const baseHours = [0, 7, 10, 11, 12, 13, 14, 16, 19, 22];
  for (let d = 1; d <= 30; d++) {
    const spikeDay = d === 16;
    for (const h of baseHours) {
      const dt = new Date(2026, 8, d, h, 0, 0);
      const sustained = spikeDay && h >= 10 && h <= 14;
      readings.push({ t: Math.floor(dt.getTime() / 1000), v: sustained ? 4000 : 800 });
    }
  }
  const body = readings
    .map(
      (r) =>
        `      <IntervalReading>\n        <timePeriod><start>${r.t}</start><duration>3600</duration></timePeriod>\n        <value>${r.v}</value>\n      </IntervalReading>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://schemas.opengroup.org/espi/1.0">
  <entry>
    <IntervalBlock>
${body}
    </IntervalBlock>
  </entry>
</feed>
`;
}

async function main() {
  const browser = await launch();

  /* ---------------- main journey: load real Oakville file ---------------- */
  const { ctx, page } = await newPage(browser);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
  await page.locator('input[type="file"]').setInputFiles(OAK1);
  await page.getByText('Drop XML Here').waitFor({ state: 'hidden', timeout: 45_000 });

  const readings = (await stored(page)).length;
  check('real Oakville XML loads on the deployed stack', readings > 0, `readings=${readings}`);

  /* ---- 4. bill projection banner (Chart view) ---- */
  const proj = page.getByTestId('bill-projection');
  await proj.waitFor({ state: 'visible', timeout: 15_000 });
  const projState = await proj.getAttribute('data-state');
  const projText = flat(await proj.innerText());
  check('bill projection banner renders', true, `data-state=${projState}`);
  if (projState === 'gated') {
    check(
      'gated banner states the exact reason instead of guessing',
      /switches on at day 5|no readings/i.test(projText),
      projText,
    );
    check('gated banner shows no projected number', !/\$\d/.test(projText), projText);
  } else {
    check(
      'ready banner carries a projected number + commodity framing',
      /\$\d+\.\d{2}/.test(projText) && /commodity cost only/i.test(projText),
      projText,
    );
  }

  /* ---- cheap win: WFH annotation ---- */
  const wfh = page.getByTestId('wfh-annotation');
  await wfh.waitFor({ state: 'visible', timeout: 15_000 });
  const wfhText = flat(await wfh.innerText());
  check('WFH annotation shows a % of kWh in the 07-19 weekday window', /^\d+%/.test(wfhText), wfhText);

  /* ---- cheap win: always-on floor ---- */
  const floorBtn = page.locator('button[title="Always-on floor"]');
  check(
    'always-on floor replaces the vampire-load button',
    (await floorBtn.count()) === 1,
    flat(await floorBtn.innerText()),
  );
  await floorBtn.first().click();
  const modalText = flat(
    await page
      .locator('h2:has-text("always-on floor")')
      .locator('xpath=..')
      .innerText(),
  );
  check(
    'always-on floor modal states kWh/day, $/yr and the ~10% benchmark',
    /kwh a day/i.test(modalText) && /\$\d+ a year/i.test(modalText) && /10%/.test(modalText),
    modalText.slice(0, 700),
  );
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'wave-f-chart-banner.png'), fullPage: true });

  /* ---- 1 + 2. Insights: EV scenario + shift verification ---- */
  await page.getByRole('button', { name: 'INSIGHTS' }).click();

  const ver = page.getByTestId('shift-verification');
  await ver.waitFor({ state: 'visible', timeout: 15_000 });
  const verdict = await ver.getAttribute('data-verdict');
  const verHead = (await page.getByTestId('shift-verification-headline').count())
    ? flat(await page.getByTestId('shift-verification-headline').innerText())
    : flat(await page.getByTestId('shift-verification-empty').innerText());
  check(
    'shift before/after verification renders with an honest verdict',
    verdict !== null,
    `verdict=${verdict} — ${verHead}`,
  );
  check(
    'verification carries the one-week caveat',
    /one week is a hint, not proof/.test(flat(await ver.innerText())),
    '',
  );
  const windows = await ver.locator('text=/Last 7 days|Prior 7 days/').count();
  check('both 7-day windows are on screen', windows >= 2, `windowLabels=${windows}`);

  const ev = page.getByTestId('ev-scenario');
  await ev.waitFor({ state: 'visible', timeout: 15_000 });
  const evSource = await ev.getAttribute('data-source');
  if (await page.getByTestId('ev-scenario-empty').count()) {
    await page.getByTestId('ev-kwh-input').fill('10');
  }
  const perCharge = page.locator('[data-testid^="ev-per-charge-"]');
  await perCharge.first().waitFor({ state: 'visible', timeout: 10_000 });
  const charges = flat((await perCharge.allInnerTexts()).join(' | '));
  check(
    'EV card prices a charge under all three plans',
    (await perCharge.count()) === 3,
    `source=${evSource} — ${charges}`,
  );
  const perMonth = flat(
    (await page.locator('[data-testid^="ev-per-month-"]').allInnerTexts()).join(' | '),
  );
  check('EV card prices a month of charging', /\$/.test(perMonth), perMonth);
  const exposure = page.getByTestId('ev-peak-exposure');
  const exposureText = (await exposure.count()) ? flat(await exposure.first().innerText()) : '';
  check(
    'weekday 16:00-21:00 ULO peak exposure flagged with kWh + $',
    /kwh\/mo/i.test(exposureText) && /\$\d/.test(exposureText),
    exposureText,
  );
  const assumptions = flat(await page.getByTestId('ev-assumptions').innerText());
  check('EV card states its assumptions', assumptions.length > 40, assumptions.slice(0, 340));

  const sigs = page.locator('[data-testid^="anomaly-signature-"]');
  const sigCount = await sigs.count();
  const emptyState = await page.getByText(/No significant spikes detected/i).count();
  check(
    'anomalies section on the real Oakville file (cards or honest empty state)',
    sigCount > 0 || emptyState === 1,
    sigCount > 0 ? `count=${sigCount}` : '0 days above the 1.5x/+5 kWh bar — empty state shown',
  );

  await page.screenshot({ path: path.join(OUT, 'wave-f-insights.png'), fullPage: true });

  /* ---------------- multi-export merge review ---------------- */
  const second = await newPage(browser);
  await second.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await second.page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
  await second.page.locator('input[type="file"]').setInputFiles([OAK1, OAK2]);

  const review = second.page.getByTestId('merge-review');
  await review.waitFor({ state: 'visible', timeout: 45_000 });
  const range = flat(await second.page.getByTestId('merge-range').innerText());
  const rows = flat(await second.page.getByTestId('merge-rows').innerText());
  const dups = flat(await second.page.getByTestId('merge-duplicates').innerText());
  check(
    'merge review shows the merged date range + total rows',
    /→/.test(range) && /\d/.test(rows),
    `${range} — rows=${rows}`,
  );
  check('merge review counts duplicate timestamps before import', /of/i.test(dups), dups);
  const before = (await stored(second.page)).length;
  check('nothing is imported until the household confirms', before === 0, `stored=${before}`);
  await second.page.screenshot({ path: path.join(OUT, 'wave-f-merge-review.png'), fullPage: true });

  await second.page.getByTestId('merge-confirm').click();
  await review.waitFor({ state: 'hidden', timeout: 20_000 });
  const after = (await stored(second.page)).length;
  const expected = Number(rows.replace(/,/g, ''));
  check(
    'confirm imports exactly the reviewed row count',
    after === expected,
    `stored=${after} expected=${expected}`,
  );
  await second.page.screenshot({ path: path.join(OUT, 'wave-f-merged-chart.png'), fullPage: true });
  await second.ctx.close();

  /* ---------------- 5. appliance-signature anomaly labels ---------------- */
  const spikePath = path.join(os.tmpdir(), 'wave-f-spike.xml');
  fs.writeFileSync(spikePath, buildSpikeXml());
  const third = await newPage(browser);
  await third.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await third.page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
  await third.page.locator('input[type="file"]').setInputFiles(spikePath);
  await third.page.getByText('Drop XML Here').waitFor({ state: 'hidden', timeout: 45_000 });
  await third.page.getByRole('button', { name: 'INSIGHTS' }).click();

  const spikeSigs = third.page.locator('[data-testid^="anomaly-signature-"]');
  await spikeSigs.first().waitFor({ state: 'visible', timeout: 20_000 });
  const spikeCount = await spikeSigs.count();
  const kinds = [];
  for (let i = 0; i < spikeCount; i++) {
    kinds.push(await spikeSigs.nth(i).getAttribute('data-signature'));
  }
  const label = flat(await spikeSigs.first().innerText());
  check(
    'anomalies carry an appliance signature derived from the day shape',
    spikeCount > 0 && kinds.every((k) => !!k) && kinds.includes('sustained-high'),
    `count=${spikeCount} kinds=${[...new Set(kinds)].join(',')} — ${label}`,
  );
  await third.page.screenshot({
    path: path.join(OUT, 'wave-f-anomaly-signature.png'),
    fullPage: true,
  });
  await third.ctx.close();

  await ctx.close();
  await browser.close();

  const report = {
    ok: checks.every((c) => c.ok),
    baseUrl: BASE,
    generatedAt: new Date().toISOString(),
    checks,
  };
  const outPath = path.join(OUT, 'wave-f-verification.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `\n${report.ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} (${checks.filter((c) => c.ok).length}/${checks.length}) → ${outPath}`,
  );
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('WAVE F VERIFY FAILED:', err);
  process.exit(2);
});
