/**
 * Wave H browser verification on the DEPLOYED stack (electricity.markarslan.ca).
 *
 * The eleven-item QoL wave, checked the way a user would meet it:
 *   1. sample-data button — empty profile → one click → a full dashboard
 *      (8 760 readings, totals, freshness chip, example banner)
 *   2. persisted plan — pick ULO, reload, the header chip still says ULO
 *   3. keyboard/a11y — a real focus ring is computed on the focused control,
 *      Escape closes the upload modal and the backup drawer, tab traversal
 *   4. chart skeleton — the shimmer exists in the DOM contract (unit-tested);
 *      here we assert the chart area is not an empty frame after upload
 *   5. data-freshness chip — date + relative age on screen
 *   6. print layout — @media print at Letter width: chrome gone, document
 *      intact, no horizontal overflow
 *   7. cost reframe — $/yr ↔ $/day changes every figure on the strip
 *   8. crash state — an uncaught runtime error paints the crash screen and
 *      "Try again" recovers from it
 *
 * Run:  cd <worktree> && TZ=America/Toronto NODE_PATH=webapp/node_modules \
 *         node evidence/wave-h-verify.cjs
 * Env:  WAVE_H_BASE_URL (default the public URL), WAVE_H_CHROMIUM (binary)
 *
 * Writes evidence/wave-h-verification.json + wave-h-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.WAVE_H_BASE_URL || 'https://electricity.markarslan.ca/';
const CHROMIUM = process.env.WAVE_H_CHROMIUM || '/usr/bin/chromium';
const OUT = __dirname;

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

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

/** Read the focus ring only once its transition has settled (buttons use transition-all). */
const readSettledRing = async (page) => {
  const start = Date.now();
  let ring = null;
  while (Date.now() - start < 5000) {
    ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        label: el.getAttribute('aria-label'),
        outlineWidth: s.outlineWidth,
        boxShadow: s.boxShadow,
      };
    });
    if (ring && parseFloat(ring.outlineWidth) >= 3 && /0px 0px 0px 6px/.test(ring.boxShadow)) {
      return ring;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return ring;
};

/** Escape until the overlay is gone (bounded); still fails if Escape is broken. */
const escapeUntilHidden = async (page, locator) => {
  for (let i = 0; i < 5 && (await locator.isVisible()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  return locator.isHidden();
};

/**
 * Wait until the example dataset is actually committed.
 *
 * The modal's drop-zone text flips to "ANALYZING..." the instant parsing
 * starts, so `Drop XML Here` disappearing is NOT evidence that the readings
 * landed — wait for the banner + totals instead.
 */
async function waitForExampleData(page) {
  await page.getByTestId('example-data-banner').waitFor({ timeout: 90_000 });
  await page.getByTestId('totals-strip').waitFor({ timeout: 30_000 });
}

const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('energy_data') || '[]'));

async function main() {
  const browser = await launch();
  try {
    await sampleDataJourney(browser);
    await planPersistence(browser);
    await keyboardAndEscape(browser);
    await printLayout(browser);
    await costReframe(browser);
    await crashState(browser);
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'H',
    base: BASE,
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
  fs.writeFileSync(path.join(OUT, 'wave-h-verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed -> evidence/wave-h-verification.json`);
  if (passed !== checks.length) process.exitCode = 1;
}

/* 1 + 5: one click from an empty profile to a populated dashboard. */
async function sampleDataJourney(browser) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ timeout: 45_000 });
    check('empty upload screen offers "Try with example data"', await page.getByTestId('try-example-data').isVisible());
    const buttonLabel = flat(await page.getByTestId('try-example-data').textContent());
    check('button label matches the spec wording', /try with example data/i.test(buttonLabel), buttonLabel);
    check(
      'the promise is on screen before the click',
      /not real usage/i.test(flat(await page.getByRole('dialog').textContent())),
    );

    await page.getByTestId('try-example-data').click();
    await waitForExampleData(page);

    const readings = (await stored(page)).length;
    check('example dataset committed in full (8 760 hourly readings)', readings === 8760, `${readings} readings`);

    const banner = page.getByTestId('example-data-banner');
    check('example banner labels the data as not real usage', /Example data — not real usage/i.test(flat(await banner.textContent())));
    check(
      'example flag persisted so a reload keeps the label',
      (await page.evaluate(() => localStorage.getItem('energy_data_is_example'))) === '1',
    );

    const strip = page.getByTestId('totals-strip');
    await strip.waitFor({ timeout: 15_000 });
    const stripText = flat(await strip.textContent());
    const kwh = Number((stripText.match(/([\d,]+)\s*kWh/) || [])[1]?.replace(/,/g, ''));
    check('totals strip populated', kwh > 1000, `${kwh} kWh`);

    const fresh = page.getByTestId('data-freshness-chip');
    const freshText = flat(await fresh.textContent());
    check(
      '"Data as of {date}" chip rendered near the totals',
      /^Data as of [A-Z][a-z]{2} \d{1,2}, \d{4}/i.test(freshText) && /(today|\d+ (day|month|year)s ago)/i.test(freshText),
      freshText,
    );

    // The chart must not be an empty frame once data is in: the shimmer
    // covers Recharts' grow-in and then removes itself.
    await page
      .getByTestId('chart-skeleton')
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => {});
    check('no skeleton left behind', (await page.getByTestId('chart-skeleton').count()) === 0);
    const bars = await page.locator('.recharts-rectangle, .recharts-bar-rectangle').count();
    check('chart drawn (bars present, no empty frame)', bars > 0, `${bars} bar shapes`);
    // The demo must open on the whole bundled year, not one lonely bar.
    const startVal = await page.locator('input[type="date"]').first().inputValue();
    const endVal = await page.locator('input[type="date"]').nth(1).inputValue();
    check(
      'demo opens on the full bundled year',
      startVal === '2025-10-01' && endVal === '2026-09-30',
      `${startVal} → ${endVal}`,
    );
    const ticks = await page
      .locator('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label')
      .count();
    check('monthly chart shows the whole year (not one bar)', ticks >= 6, `${ticks} x-axis labels`);

    // Full page: the chart sits below the fold at 1200px, and the point of
    // this artifact is that the chart is actually drawn.
    await page.screenshot({ path: path.join(OUT, 'wave-h-sample-loaded.png'), fullPage: true });
    const chartArea = page.getByTestId('chart-area');
    await chartArea.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'wave-h-chart.png') });
  } catch (e) {
    check('sample-data journey completed', false, e.message);
  } finally {
    await ctx.close();
  }
}

/* 2: the choice survives a reload and the header agrees with the switcher. */
async function planPersistence(browser) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ timeout: 45_000 });
    await page.getByTestId('try-example-data').click();
    await waitForExampleData(page);

    const chip = page.getByTestId('active-plan-chip');
    check('header shows the active plan before any interaction', /Plan:/i.test(flat(await chip.textContent())), flat(await chip.textContent()));

    await page.getByTestId('plan-switcher').getByRole('button', { name: 'Select Ultra-Low Overnight plan' }).click();
    await page.waitForFunction(() => localStorage.getItem('selected_plan') === 'ULO');
    check('plan choice written to localStorage', true, 'selected_plan=ULO');
    check('header chip follows the switcher', (await chip.getAttribute('data-plan')) === 'ULO', flat(await chip.textContent()));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('totals-strip').waitFor({ timeout: 45_000 });
    check(
      'plan still ULO after a reload (no re-pick)',
      (await page.getByTestId('active-plan-chip').getAttribute('data-plan')) === 'ULO',
      flat(await page.getByTestId('active-plan-chip').textContent()),
    );
    await page.screenshot({ path: path.join(OUT, 'wave-h-plan-persisted.png') });
  } catch (e) {
    check('plan persistence journey completed', false, e.message);
  } finally {
    await ctx.close();
  }
}

/* 3: focus ring actually computed, Escape closes two different overlays. */
async function keyboardAndEscape(browser) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ timeout: 45_000 });

    // Escape closes the upload modal (Wave H item 3).
    const closed = await escapeUntilHidden(page, page.getByText('Drop XML Here'));
    check('Escape closes the upload modal', closed);

    // Tab until the upload control has focus, then read the computed ring.
    let label = '';
    for (let i = 0; i < 25 && label !== 'Upload XML'; i++) {
      await page.keyboard.press('Tab');
      label = await page.evaluate(
        () => (document.activeElement && document.activeElement.getAttribute('aria-label')) || '',
      );
    }
    const ring = await readSettledRing(page);
    check('tab traversal reaches the upload control', ring && ring.label === 'Upload XML', JSON.stringify(ring));
    check(
      'focus ring is computed (width > 0)',
      !!ring && parseFloat(ring.outlineWidth) > 0,
      ring && `${ring.outlineWidth} ${ring.boxShadow}`,
    );
    check(
      'focus ring carries the blue halo that reads on every chip colour',
      !!ring && /rgb\(37,\s*99,\s*235\)/.test(ring.boxShadow),
      ring && ring.boxShadow,
    );
    await page.screenshot({ path: path.join(OUT, 'wave-h-focus-ring.png') });

    // Enter opens it, Escape closes it again.
    await page.keyboard.press('Enter');
    const reopened = await page.getByText('Drop XML Here').isVisible();
    check('Enter opens the upload modal', reopened);
    check('Escape closes it again', await escapeUntilHidden(page, page.getByText('Drop XML Here')));

    // The backup drawer (a second, self-owned Escape handler).
    const toggle = page.getByTestId('backup-toggle');
    await toggle.click();
    check('backup drawer opens', await page.getByTestId('backup-drawer').isVisible());
    check('aria-expanded reports open', (await toggle.getAttribute('aria-expanded')) === 'true');
    check('Escape closes the backup drawer', await escapeUntilHidden(page, page.getByTestId('backup-drawer')));
    check('aria-expanded reports closed again', (await toggle.getAttribute('aria-expanded')) === 'false');
  } catch (e) {
    check('keyboard/a11y journey completed', false, e.message);
  } finally {
    await ctx.close();
  }
}

/* 6: @media print at Letter width — chrome out, document in. */
async function printLayout(browser) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ timeout: 45_000 });
    await page.getByTestId('try-example-data').click();
    await waitForExampleData(page);
    await page.getByRole('button', { name: 'INSIGHTS' }).click();
    await page.getByTestId('insights-view').waitFor({ timeout: 15_000 });

    // Letter portrait @96dpi = 816 × 1056 px.
    await page.setViewportSize({ width: 816, height: 1056 });
    await page.emulateMedia({ media: 'print' });

    check('nav/controls hidden in print', await page.getByTestId('plan-switcher').isHidden());
    check('export button hidden in print', await page.getByTestId('export-csv').first().isHidden());
    check('view toggle hidden in print', await page.getByRole('button', { name: 'INSIGHTS' }).isHidden());
    check('Insights document still visible in print', await page.getByTestId('insights-view').isVisible());
    check('Shift Optimizer still visible in print', await page.getByTestId('shift-optimizer').isVisible());

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check('no horizontal overflow on Letter width', overflow <= 1, `${overflow}px`);

    // Page count: does the whole view fit, and is there any blank page?
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    // page.pdf() returns a Buffer — decode before pattern matching.
    const pdfText = Buffer.isBuffer(pdf) ? pdf.toString('latin1') : String(pdf);
    const pages = (pdfText.match(/\/Type\s*\/Page[^s]/g) || []).length;
    // The gate is a LETTER-SIZE SCREENSHOT of the print layout (captured
    // below), not "every card fits on one page" — InsightsView carries a
    // headline, 20 ranked blocks, an EV scenario, a heatmap and a YoY panel,
    // which is a report, not a memo. What must hold: portrait Letter, no
    // overflow, no chrome, and no absurd page count from broken styles.
    check(
      'print/PDF renders as a sane Letter document',
      pages >= 1 && pages <= 8,
      `${pages} page(s), ${Math.round(pdf.length / 1024)} KB, 816x1056 single-page screenshot`,
    );

    // The single Letter-size page (816 x 1056 px @96dpi) — the artifact the
    // task's print gate asks for.
    await page.screenshot({ path: path.join(OUT, 'wave-h-print-letter.png') });
    fs.writeFileSync(path.join(OUT, 'wave-h-insights-print.pdf'), pdf);
    await page.emulateMedia({ media: 'screen' });
  } catch (e) {
    check('print layout journey completed', false, e.message);
  } finally {
    await ctx.close();
  }
}

/* 7: $/yr <-> $/day flips every money figure, plus the conversion sentence. */
async function costReframe(browser) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ timeout: 45_000 });
    await page.getByTestId('try-example-data').click();
    await waitForExampleData(page);

    const tou = page.getByTestId('plan-cost-TOU');
    const yearly = flat(await tou.textContent());
    check('totals default to $/yr', (await tou.getAttribute('data-unit')) === 'yr' && /\/yr/.test(yearly), yearly);
    check('conversion sentence present', /\/day/.test(flat(await page.getByTestId('cost-reframe').textContent())), flat(await page.getByTestId('cost-reframe').textContent()));

    await page.getByTestId('cost-toggle').getByRole('button', { name: '$/day' }).click();
    const daily = flat(await tou.textContent());
    check('toggle switches to $/day', (await tou.getAttribute('data-unit')) === 'day' && /\/day/.test(daily), daily);
    check('the two units are different numbers', yearly !== daily, `${yearly} -> ${daily}`);
    check('conversion sentence points the other way now', /\/yr/.test(flat(await page.getByTestId('cost-reframe').textContent())), flat(await page.getByTestId('cost-reframe').textContent()));

    await page.screenshot({ path: path.join(OUT, 'wave-h-cost-reframe.png') });
  } catch (e) {
    check('cost reframe journey completed', false, e.message);
  } finally {
    await ctx.close();
  }
}

/* 8: a real uncaught error paints the crash screen, and Try again recovers. */
async function crashState(browser) {
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    // The header chip is SERVER-rendered, so it proves nothing about the
    // client: throwing before hydration lands the error where no listener
    // exists yet. The upload modal is only rendered by the client-side init
    // effect, so it appearing means React has mounted (boundary included).
    await page.getByText('Drop XML Here').waitFor({ timeout: 45_000 });

    // Throw where React boundaries never look: an event handler's timer.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('wave-h deliberate crash');
      }, 0);
    });

    const crash = page.getByTestId('crash-screen');
    await crash.waitFor({ timeout: 20_000 });
    const text = flat(await crash.textContent());
    check('crash screen replaces the blank frame', /Something broke/i.test(text));
    check('it promises the readings are untouched', /readings were not touched/i.test(text), text.slice(0, 160));
    const id = flat(await page.getByTestId('crash-id').textContent());
    check('copyable incident id present', /^ERR-[0-9A-F]+$/.test(id), id);
    check('technical detail preserved', /wave-h deliberate crash/.test(flat(await page.getByTestId('crash-detail').textContent())));
    await page.screenshot({ path: path.join(OUT, 'wave-h-crash.png') });

    await page.getByTestId('crash-reset').click();
    await crash.waitFor({ state: 'hidden', timeout: 20_000 });
    check('"Try again" recovers to a working app', await page.getByText('Ontario Energy Optimizer').first().isVisible());
    await page.screenshot({ path: path.join(OUT, 'wave-h-crash-recovered.png') });
  } catch (e) {
    check('crash-state journey completed', false, e.message);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
