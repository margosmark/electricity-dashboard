/**
 * Wave EV-2 browser verification — the "when do you charge?" hour anchor,
 * on a running production stack.
 *
 * What it proves, in a real browser against real DOM text:
 *
 *   SYNTHETIC 7 PM-HEAVY WINTER FIXTURE (generated here, never committed):
 *     1. a household that charges at 19:00 has NOTHING detected overnight, so
 *        the hour wheel starts unanswered and the card asks instead of
 *        inventing an hour;
 *     2. answering 19:00 prices STAYING PUT at the winter rates the readings
 *        were actually charged at (12.3¢ blended over the ±1 h band), NOT the
 *        summer blend and NOT a static window table;
 *     3. the ULO delta in the three-plan comparison differs from the shipped
 *        "assume the worst / assume overnight" number — 39.1¢ was the answer
 *        before, because with no hour to price against it fell back to each
 *        plan's most expensive rate;
 *     4. the stay-vs-move answer splits into shift + plan, and they add up;
 *     5. switching the plan switcher to ULO re-prices the stay side on ULO
 *        (30.7¢) — the prop really is wired from Dashboard down to the card.
 *
 *   REAL OAKVILLE HYDRO EXPORT (path via WAVE_EV_XML, NEVER committed):
 *     6. the card, the wheel and the comparison render on the app owner's own
 *        data, with the wheel prefilled from whatever block that data holds —
 *        plus what the 7 PM counterfactual says on real readings.
 *
 * Run:  WAVE_EV_XML=/path/to/export.xml TZ=America/Toronto \
 *         node evidence/wave-ev-verify.cjs
 * Env:  WAVE_EV_BASE_URL (default http://127.0.0.1:3100/), WAVE_EV_CHROMIUM
 *
 * Writes evidence/wave-ev-verification.json + wave-ev-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.WAVE_EV_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.WAVE_EV_CHROMIUM || '/usr/bin/chromium';
const OAKVILLE = process.env.WAVE_EV_XML;
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** True once the locator shows up within `timeout`. */
async function shown(locator, timeout = 20_000) {
  try {
    await locator.waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- *
 * The fixture: a winter household that charges at 7 PM.
 *
 * Mon 2026-01-05 → Sun 2026-02-01: 28 days, 20 weekdays + 8 weekend days,
 * and NO Ontario holiday inside the window (New Year is before it, Family Day
 * is after it) — so the weekday/weekend arithmetic below is exact.
 * -------------------------------------------------------------------------- */
const FIXTURE = {
  startIso: '2026-01-05T00:00:00-05:00',
  days: 28,
  weekdays: 20,
  weekends: 8,
  /** Hourly kWh: quiet house plus a 3.4 kW charge at 19:00 and 20:00. */
  kwhAt: (h) => (h === 19 || h === 20 ? 3.4 : 0.4),
  /** The number the household types into the card. */
  typedKwh: 10,
  chargeHour: '19',
};

/** Green Button Atom feed in the shape tests/fixtures/synthetic.xml uses (value in Wh). */
function buildFixtureXml() {
  const startSec = Math.floor(Date.parse(FIXTURE.startIso) / 1000);
  const rows = [];
  for (let d = 0; d < FIXTURE.days; d++) {
    for (let h = 0; h < 24; h++) {
      rows.push(
        `    <IntervalReading><timePeriod><start>${startSec + d * 86400 + h * 3600}</start>` +
          `<duration>3600</duration></timePeriod><value>${Math.round(FIXTURE.kwhAt(h) * 1000)}</value></IntervalReading>`,
      );
    }
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://schemas.opengroup.org/espi/1.0">\n` +
    `  <entry>\n    <IntervalBlock>\n${rows.join('\n')}\n    </IntervalBlock>\n  </entry>\n</feed>\n`
  );
}

/**
 * Every expected number, derived from the OEB windows and the fixture's own
 * calendar — NOT read back off the page, so the assertions can actually fail.
 */
function expectations() {
  const { weekdays, weekends, days, typedKwh } = FIXTURE;
  const n = weekdays + weekends;
  // Winter weekday 18:00 = On-Peak 20.3¢ (17:00–19:00); weekend = Off-Peak.
  const rate18 = (weekdays * 20.3 + weekends * 9.8) / n;
  // 19:00 and 20:00 are Off-Peak in BOTH seasons: TOU on-peak ENDS at 19:00.
  const rate1920 = 9.8;
  // ULO weekday 16:00–21:00 = On-Peak 39.1¢, weekends 9.8¢ — ULO has no season.
  const uloAtAnchor = (weekdays * 39.1 + weekends * 9.8) / n;
  // The same 18:00 hour in summer would be Mid-Peak 15.7¢ — the number the
  // shipped static-table assumption would have produced for May–Oct.
  const summerRate18 = (weekdays * 15.7 + weekends * 9.8) / n;

  const stayRate = (rate18 + rate1920 + rate1920) / 3;
  const summerStayRate = (summerRate18 + rate1920 + rate1920) / 3;
  const perMonth = (cents) => (typedKwh * (cents / 100) * 30).toFixed(2);
  const evKwh = typedKwh * days;

  return {
    stayRateCents: stayRate,
    summerStayRateCents: summerStayRate,
    uloAtAnchorCents: uloAtAnchor,
    stayPerMonth: perMonth(stayRate),
    summerStayPerMonth: perMonth(summerStayRate),
    movePerMonth: perMonth(3.9),
    totalPerMonth: (typedKwh * stayRate / 100 * 30 - typedKwh * 3.9 / 100 * 30).toFixed(2),
    shiftPerMonth: (typedKwh * (uloAtAnchor - 3.9) / 100 * 30).toFixed(2),
    planPerMonth: (typedKwh * (stayRate - uloAtAnchor) / 100 * 30).toFixed(2),
    evKwh,
    /** What the shipped build printed: no hour, so each plan's worst case. */
    shippedUloDelta: (evKwh * (39.1 - 3.9)) / 100,
    /** What the anchor prints: the hours it actually charges at, today. */
    actualUloDelta: (evKwh * (uloAtAnchor - 3.9)) / 100,
    /** ULO re-priced on the stay side once the switcher says ULO. */
    uloStayPerMonth: perMonth(uloAtAnchor),
    uloStayRateCents: uloAtAnchor,
  };
}

async function launch() {
  return chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

async function freshPage(browser, extra = {}) {
  const context = await browser.newContext({
    timezoneId: 'America/Toronto',
    locale: 'en-CA',
    viewport: { width: 1440, height: 960 },
    ...extra,
  });
  const page = await context.newPage();
  return { context, page };
}

/** Upload an XML file through the app's own import modal. */
async function upload(page, file) {
  await page.goto(BASE);
  if (!(await shown(page.getByText('Drop XML Here'), 25_000))) return false;
  await page.locator('input[type="file"]').setInputFiles(file);
  // The modal hides the moment the file is SELECTED — the parse lands a beat
  // later. Wait for the readings themselves, not for the prompt to vanish.
  await page
    .getByText('Drop XML Here')
    .waitFor({ state: 'hidden', timeout: 30_000 })
    .catch(() => {});
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('energy_data') || '[]').length,
    );
    if (n > 0) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function openInsights(page) {
  await page.getByRole('button', { name: 'INSIGHTS' }).click();
  return shown(page.getByTestId('ev-scenario'), 25_000);
}

async function shot(page, name) {
  const file = path.join(OUT, `wave-ev-${name}.png`);
  const card = page.getByTestId('ev-scenario');
  if (await shown(card, 5_000)) await card.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  return path.basename(file);
}

/* -------------------------------------------------------------------------- *
 * Scenario A — the synthetic winter 7 PM charger
 * -------------------------------------------------------------------------- */
async function verifySynthetic(browser) {
  const xmlPath = path.join(require('os').tmpdir(), 'wave-ev-winter-7pm.xml');
  fs.writeFileSync(xmlPath, buildFixtureXml());
  const exp = expectations();
  const facts = { fixture: { ...FIXTURE }, expected: exp };

  const { context, page } = await freshPage(browser);
  const uploaded = await upload(page, xmlPath);
  check('fixture uploads through the import modal', uploaded, `${FIXTURE.days} days × 24 h = ${FIXTURE.days * 24} readings`);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('energy_data') || '[]'));
  check('all readings landed in localStorage', stored.length === FIXTURE.days * 24, `${stored.length} readings`);

  check('Insights tab renders the EV card', await openInsights(page));

  const wheel = page.getByTestId('ev-charge-hour');
  const card = page.getByTestId('ev-scenario');
  if (await shown(wheel)) {
    const value = await wheel.inputValue();
    check('hour wheel starts UNANSWERED (a 7 PM charge is invisible to night detection)', value === '', `wheel value "${value}"`);
    check('the card does not pretend it found a charging block', (await card.getAttribute('data-source')) !== 'detected', `data-source=${await card.getAttribute('data-source')}`);
  } else {
    check('hour wheel is on the card', false, 'ev-charge-hour not found');
  }

  // Type the nightly kWh — the comparison must still refuse to invent an hour.
  const kwhInput = page.getByTestId('ev-kwh-input');
  await kwhInput.fill(String(FIXTURE.typedKwh));
  check(
    'card asks the hour question instead of guessing one',
    await shown(page.getByTestId('ev-charge-move-empty'), 10_000),
    flat(await page.getByTestId('ev-charge-move-empty').textContent()),
  );

  // …and answers it the moment the household says 19:00.
  await wheel.selectOption(FIXTURE.chargeHour);
  const move = page.getByTestId('ev-charge-move');
  check('stay-vs-move comparison appears for 19:00', await shown(move, 10_000));

  const stay = page.getByTestId('ev-stay-side');
  const moved = page.getByTestId('ev-move-side');
  const result = page.getByTestId('ev-move-result');
  const assumptions = page.getByTestId('ev-assumptions');
  const comparison = page.getByTestId('ev-plan-comparison');

  const stayText = flat(await stay.textContent());
  const moveText = flat(await moved.textContent());
  const resultText = flat(await result.textContent());
  const assumptionText = flat(await assumptions.textContent());
  const comparisonText = flat(await comparison.textContent());

  facts.rendered = { stay: stayText, move: moveText, result: resultText, comparison: comparisonText };

  // 1. Winter, from the readings: 12.3¢ blended (not summer's 11.2¢, not 20.3¢).
  check(
    'stay side prices the anchor at WINTER rates read from the readings',
    stayText.includes(`${exp.stayRateCents.toFixed(1)}¢/kWh`) &&
      stayText.includes(`$${exp.stayPerMonth}`) &&
      !stayText.includes(`${exp.summerStayRateCents.toFixed(1)}¢/kWh`),
    `${exp.stayRateCents.toFixed(2)}¢/kWh → $${exp.stayPerMonth}/mo (summer would be ${exp.summerStayRateCents.toFixed(2)}¢ → $${exp.summerStayPerMonth}/mo)`,
  );
  check('stay side names the ±1 h band it blended', stayText.includes('18:00–21:00'), stayText.slice(0, 120));
  check('assumptions say the season the rates came from', assumptionText.includes('Winter rates'), '');

  // 2. Move side: 3.9¢, 23:00–07:00.
  check(
    'move side prices 23:00–07:00 on ULO overnight',
    moveText.includes('3.9¢/kWh') && moveText.includes(`$${exp.movePerMonth}`),
    `3.9¢/kWh → $${exp.movePerMonth}/mo`,
  );

  // 3. The answer, split honestly.
  check(
    'total is stay − move',
    resultText.includes(`$${exp.totalPerMonth}/mo better off`),
    `$${exp.stayPerMonth} − $${exp.movePerMonth} = $${exp.totalPerMonth}/mo`,
  );
  check(
    'and it splits into shift + plan, which add up',
    resultText.includes(`+$${exp.shiftPerMonth}/mo for moving the hour`) &&
      resultText.includes(`−$${Math.abs(Number(exp.planPerMonth)).toFixed(2)}/mo for changing plan`) &&
      resultText.includes('never counted twice'),
    `+$${exp.shiftPerMonth}/mo shift, ${exp.planPerMonth}/mo plan → $${exp.totalPerMonth}/mo`,
  );

  // 4. The ULO delta is NOT the shipped "assume the worst" number.
  const shipped = `−$${exp.shippedUloDelta.toFixed(2)} vs today`;
  const actual = `−$${exp.actualUloDelta.toFixed(2)} vs today`;
  check(
    'three-plan ULO delta differs from the shipped assume-overnight version',
    comparisonText.includes(actual) && !comparisonText.includes(shipped),
    `shipped ${shipped} → anchored ${actual}`,
  );

  // 5. Evidence line: the exact hours and windows it blended.
  check(
    'evidence line lists the hours and windows it blended',
    /18:00 On-Peak/.test(resultText) && /19:00 Off-Peak/.test(resultText),
    resultText.slice(resultText.indexOf('Priced from'), resultText.indexOf('Priced from') + 140),
  );

  facts.shots = [await shot(page, 'winter-7pm-desktop')];

  // 6. The plan switcher really drives the stay side (Dashboard → card).
  // Named by visible text since t_d5cc9a2d (no aria-label on the switcher).
  await page.getByTestId('plan-switcher').getByRole('button', { name: 'ULO' }).click();
  const uloStay = flat(await page.getByTestId('ev-stay-side').textContent());
  facts.rendered.stayOnUlo = uloStay;
  check(
    'stay side re-prices on the plan the switcher selected',
    uloStay.includes(`${exp.uloStayRateCents.toFixed(1)}¢/kWh`) && uloStay.includes(`$${exp.uloStayPerMonth}`),
    `ULO: ${exp.uloStayRateCents.toFixed(2)}¢/kWh → $${exp.uloStayPerMonth}/mo`,
  );
  check(
    'on ULO the plan half of the answer is zero (it is already the plan)',
    flat(await page.getByTestId('ev-move-result').textContent()).includes('+$0.00/mo for changing plan'),
    '',
  );

  // 7. Phone viewport — the answer must fit on the device that asked it.
  const phone = await freshPage(browser, { viewport: { width: 390, height: 844 } });
  await upload(phone.page, xmlPath);
  await openInsights(phone.page);
  await phone.page.getByTestId('ev-kwh-input').fill(String(FIXTURE.typedKwh));
  await phone.page.getByTestId('ev-charge-hour').selectOption(FIXTURE.chargeHour);
  const phoneMove = phone.page.getByTestId('ev-charge-move');
  if (await shown(phoneMove, 10_000)) {
    const box = await phoneMove.boundingBox();
    check('comparison fits a 390px phone', !!box && box.width <= 390, `width ${box ? Math.round(box.width) : '?'}px`);
    facts.shots.push(await shot(phone.page, 'winter-7pm-mobile'));
  } else {
    check('comparison renders on a phone', false, 'ev-charge-move not found');
  }
  await phone.context.close();
  await context.close();
  return facts;
}

/* -------------------------------------------------------------------------- *
 * Scenario B — the app owner's real Oakville Hydro export
 * -------------------------------------------------------------------------- */
async function verifyRealExport(browser) {
  const facts = { xml: path.basename(OAKVILLE) };
  const { context, page } = await freshPage(browser);
  const uploaded = await upload(page, OAKVILLE);
  check('real Oakville export uploads', uploaded, facts.xml);
  if (!uploaded) {
    await context.close();
    return facts;
  }

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('energy_data') || '[]'));
  facts.readings = stored.length;
  check('real readings landed in localStorage', stored.length > 1000, `${stored.length} readings`);

  check('Insights tab renders the EV card on real data', await openInsights(page));
  const card = page.getByTestId('ev-scenario');
  const wheel = page.getByTestId('ev-charge-hour');
  const wheelShown = await shown(wheel);
  facts.dataSource = wheelShown ? await card.getAttribute('data-source') : null;
  facts.wheelPrefilled = wheelShown ? await wheel.inputValue() : null;
  check('hour wheel is present on the real data', wheelShown, `value "${facts.wheelPrefilled}"`);

  const state = {
    move: await shown(page.getByTestId('ev-charge-move'), 3_000),
    empty: await shown(page.getByTestId('ev-charge-move-empty'), 3_000),
  };
  check(
    'the card prices a comparison OR says it still needs the hour — never both, never neither',
    state.move !== state.empty,
    JSON.stringify(state),
  );

  // The user's own complaint, on their own data: charge at 19:00.
  await page.getByTestId('ev-kwh-input').fill('10');
  await wheel.selectOption('19');
  if (await shown(page.getByTestId('ev-charge-move'), 10_000)) {
    facts.at7pm = {
      stay: flat(await page.getByTestId('ev-stay-side').textContent()),
      move: flat(await page.getByTestId('ev-move-side').textContent()),
      result: flat(await page.getByTestId('ev-move-result').textContent()),
      comparison: flat(await page.getByTestId('ev-plan-comparison').textContent()),
    };
    check(
      '7 PM counterfactual renders on the real export',
      /\d+\.\d¢\/kWh/.test(facts.at7pm.stay) && /\$\d+\.\d\d/.test(facts.at7pm.move),
      facts.at7pm.result.slice(0, 160),
    );
    facts.shots = [await shot(page, 'oakville-7pm')];
  } else {
    check('7 PM counterfactual renders on the real export', false, 'ev-charge-move not found');
  }

  await context.close();
  return facts;
}

(async () => {
  const started = new Date().toISOString();
  const browser = await launch();
  let facts = {};
  try {
    facts.synthetic = await verifySynthetic(browser);
    if (OAKVILLE && fs.existsSync(OAKVILLE)) {
      facts.real = await verifyRealExport(browser);
    } else {
      check('real Oakville export supplied via WAVE_EV_XML', false, `not set or missing: ${OAKVILLE || '(unset)'}`);
    }
  } catch (err) {
    check('verification run completed without throwing', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const report = {
    wave: 'EV-2 (hour anchor + counterfactual bill)',
    started,
    finished: new Date().toISOString(),
    base: BASE,
    summary: { total: checks.length, passed, failed: checks.length - passed },
    checks,
    facts,
  };
  fs.writeFileSync(path.join(OUT, 'wave-ev-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/wave-ev-verification.json`);
  process.exit(passed === checks.length ? 0 : 1);
})();
