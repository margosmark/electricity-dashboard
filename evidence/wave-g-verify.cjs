/**
 * Wave G browser verification on the DEPLOYED stack (electricity.markarslan.ca).
 *
 * Covers the four gates the task names, plus the season band:
 *   1. SW cache version bump — an installed client updates after a real deploy
 *      (the script performs a second deploy mid-run and watches the update)
 *   2. backup round-trip with a real localStorage snapshot (Oakville export)
 *   3. DST crossing synthetic (spring-forward Mar 8 2026 = 23 hours,
 *      fall-back Nov 1 2026 = 25 hours, both asserted through the CSV export)
 *   4. tolerant-parse samples (Hydro One / Toronto Hydro / espi-prefixed) and
 *      the first-run diagnostic for a file that is not an export
 *   5. season band + season-aware tier threshold across the May 1 boundary
 *
 * Run:  cd <worktree> && TZ=America/Toronto NODE_PATH=webapp/node_modules \
 *         node evidence/wave-g-verify.cjs
 * Env:  WAVE_G_BASE_URL (default the public URL), WAVE_G_CHROMIUM (binary),
 *       WAVE_G_SKIP_DEPLOY=1 to skip the second deploy (SW update check then
 *       only asserts the installed version matches the served one).
 *
 * Writes evidence/wave-g-verification.json + wave-g-*.png.
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.WAVE_G_BASE_URL || 'https://electricity.markarslan.ca/';
const CHROMIUM = process.env.WAVE_G_CHROMIUM || '/usr/bin/chromium';
const DOCS = '/home/hermes/.hermes/profiles/pm/cache/documents';
const OAKVILLE = path.join(
  DOCS,
  'doc_936968b747af_oakvillehydro_Electricity_60_Minute_01-07-2026_02-10-2026.xml',
);
const FIXTURES = path.join(__dirname, '..', 'webapp', 'tests', 'fixtures');
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

/** Upload XML into the first-run modal and wait for it to disappear. */
async function uploadXml(page, file) {
  await page.setInputFiles('input[type="file"][accept=".xml"]', file);
  await page.getByText('Drop XML Here').waitFor({ state: 'hidden', timeout: 45_000 });
}

/** Dismiss one-shot overlay modals (e.g. the always-on floor explainer). */
async function dismissOverlays(page) {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  for (let i = 0; i < 3; i++) {
    if ((await gotIt.count()) === 0) break;
    await gotIt.first().click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

/** Feed with one UsagePoint, one IntervalBlock; `rows` = [{t, v}]. */
function buildFeed(rows) {
  const body = rows
    .map(
      (r) =>
        `      <IntervalReading>\n        <timePeriod><start>${r.t}</start><duration>3600</duration></timePeriod>\n        <value>${r.v}</value>\n      </IntervalReading>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link href="https://utility.example/UsagePoint/wave-g-1/MeterReading/m1/IntervalBlock/b1" rel="self"/>
    <content>
      <IntervalBlock>
${body}
      </IntervalBlock>
    </content>
  </entry>
</feed>`;
}

/**
 * One local-hour step from `fromDay` 00:00 to `toDay` 00:00 (America/Toronto).
 * Hour arithmetic in local time is exactly how a DST boundary is crossed:
 * spring-forward yields 23 steps on the day, fall-back 25 (01:00 twice).
 */
function localHourSteps(fromDay, toDay, valueFor) {
  const out = [];
  const end = new Date(`${toDay}T00:00:00`).getTime();
  for (let t = new Date(`${fromDay}T00:00:00`).getTime(); t < end; t += 3600_000) {
    const d = new Date(t);
    out.push({ t: Math.floor(t / 1000), v: valueFor(d) });
  }
  return out;
}

const parseCsv = (text) => {
  const [header, ...lines] = text.trim().split('\n');
  const cols = header.split(',');
  return lines.map((l) => {
    const cells = l.split(',');
    const row = {};
    cols.forEach((c, i) => (row[c] = cells[i]));
    return row;
  });
};

/** After a deploy the container restarts; poll until /sw.js serves again. */
async function fetchSwWhenUp(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  for (;;) {
    try {
      const r = await fetch(new URL('sw.js', BASE), { cache: 'no-store' });
      const text = await r.text();
      if (r.ok && /const VERSION = 'oeo-v\d+-[a-z0-9]+'/.test(text)) return text;
      last = `status=${r.status}`;
    } catch (e) {
      last = e && e.message;
    }
    if (Date.now() > deadline) throw new Error(`site did not serve /sw.js after deploy (${last})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const pad = (n) => String(n).padStart(2, '0');
/** Local (America/Toronto) day / hour for a unix epoch. */
const localDayOf = (epoch) => {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localHourOf = (epoch) => pad(new Date(epoch * 1000).getHours());
/** Local day / hour for an ISO-8601 string (CSV `datetime` column). */
const isoLocalDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isoLocalHour = (iso) => pad(new Date(iso).getHours());

/* ========================================================================== */

(async () => {
  const browser = await launch();
  const summary = { baseUrl: BASE, generatedAt: new Date().toISOString(), checks };

  /* ---------------------------------------------------------------------- *
   * 1 + 5. SW version, installed client, then a REAL second deploy.
   * ---------------------------------------------------------------------- */
  try {
    const servedBefore = await (await fetch(new URL('sw.js', BASE))).text();
    const servedMatch = servedBefore.match(/const VERSION = '([^']+)'/);
    check('deployed /sw.js carries a per-build cache version', /^oeo-v\d+-[a-z0-9]+$/.test(servedMatch?.[1] || ''), `VERSION=${servedMatch?.[1]}`);
    fs.writeFileSync(path.join(OUT, 'wave-g-sw-before.js'), servedBefore);

    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });

    const installed = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const script = await (await fetch('/sw.js')).text();
      const m = script.match(/const VERSION = '([^']+)'/);
      return {
        scriptURL: reg.active && reg.active.scriptURL,
        version: m ? m[1] : null,
        caches: await caches.keys(),
        controller: !!navigator.serviceWorker.controller,
      };
    });
    check('installed service worker serves the current version', installed.version === (servedMatch && servedMatch[1]), `${installed.version} controller=${installed.controller}`);
    check('shell/runtime caches are keyed by that version', installed.caches.some((c) => c.startsWith(installed.version)) && installed.caches.every((c) => c.startsWith(installed.version)), installed.caches.join(', '));
    await page.screenshot({ path: path.join(OUT, 'wave-g-sw-installed-before.png'), fullPage: false });

    let deployTail = '(skipped)';
    if (!process.env.WAVE_G_SKIP_DEPLOY) {
      console.log('... performing a second real deploy to prove the update path ...');
      deployTail = execSync("ssh hermescomputer '~/bin/deploy-energy-dashboard.sh' 2>&1 | tail -3", {
        encoding: 'utf8',
        timeout: 300_000,
      }).trim();
      console.log(deployTail);

      const servedAfter = await fetchSwWhenUp();
      const afterMatch = servedAfter.match(/const VERSION = '([^']+)'/);
      fs.writeFileSync(path.join(OUT, 'wave-g-sw-after.js'), servedAfter);
      // Docker reuses the builder layer when the source is byte-identical, so
      // an unchanged redeploy may legitimately serve the same version; this
      // run follows a commit, so the rebuild MUST produce a new stamp.
      check('a redeploy after a source change serves a DIFFERENT version', !!afterMatch && afterMatch[1] !== servedMatch[1], `${servedMatch[1]} -> ${afterMatch && afterMatch[1]}`);
      check('deploy script reports the pushed commit', /DEPLOY_OK/.test(deployTail), deployTail.split('\n')[0]);

      // The already-installed client now polls and swaps workers.
      const newVersion = afterMatch && afterMatch[1];
      const updated = await page.evaluate(async (expected) => {
        const reg = await navigator.serviceWorker.getRegistration();
        const before = await caches.keys();
        const sawNewWorker = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 25000);
          const finish = (v) => { clearTimeout(timer); resolve(v); };
          if (reg.waiting || reg.installing) {
            const w = reg.waiting || reg.installing;
            w.addEventListener('statechange', () => { if (w.state === 'activated') finish('already-waiting'); });
          }
          reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            if (!w) return;
            w.addEventListener('statechange', () => { if (w.state === 'activated') finish('updatefound'); });
          });
          // first update() can race the container restart — retry once
          reg.update().catch(() => {
            setTimeout(() => reg.update().catch(() => finish('update-error')), 3000);
          });
        });
        // activate -> clients.claim -> drop caches from the old VERSION
        const deadline = Date.now() + 20000;
        let keys = [];
        for (;;) {
          keys = await caches.keys();
          if (keys.length && keys.every((k) => k.startsWith(expected))) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        return { sawNewWorker, before, caches: keys };
      }, newVersion);
      check('installed client installed a new worker after the deploy', updated.sawNewWorker !== 'timeout' && updated.sawNewWorker !== 'update-error', `signal=${updated.sawNewWorker}`);
      check('new caches are keyed by the new version', updated.caches.every((k) => k.startsWith(newVersion)), `${updated.before.join(',')} -> ${updated.caches.join(',')}`);
      check('old-version caches were dropped on activate', updated.caches.every((k) => k.startsWith(newVersion)) && !updated.caches.some((k) => !k.startsWith(newVersion)), updated.caches.join(', '));
      await page.screenshot({ path: path.join(OUT, 'wave-g-sw-updated-after.png'), fullPage: false });
    }
    summary.deployTail = deployTail;
    await ctx.close();
  } catch (e) {
    check('SW version + update path', false, e && e.message);
  }

  /* ---------------------------------------------------------------------- *
   * 2. backup round-trip with a real localStorage snapshot.
   * ---------------------------------------------------------------------- */
  try {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
    await uploadXml(page, OAKVILLE);
    await dismissOverlays(page);
    const before = await stored(page);
    check('real Oakville export loads on the deployed stack', before.length === 2184, `readings=${before.length}`);

    await page.getByTestId('backup-toggle').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('backup-export').click();
    const file = await download;
    // Real meter data: written as *.local.json so the repo's privacy guard
    // (evidence/*.local.json is gitignored) keeps it out of git.
    const jsonPath = path.join(OUT, 'wave-g-backup-export.local.json');
    await file.saveAs(jsonPath);
    const backup = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    check('exported backup declares a schema version', typeof backup.schema === 'string' && typeof backup.version === 'number', `${backup.schema} v${backup.version}`);
    const restoredRows = (backup.payload && backup.payload.energy_data) || backup.energy_data || [];
    check('backup carries every reading', restoredRows.length === before.length, `rows=${restoredRows.length}`);

    // Clobber the stored data (what a bad night in the browser profile looks
    // like), then import the export back. Importing into a *cleared* profile
    // would work too, but the first-run upload modal then covers the page.
    await page.evaluate(() => localStorage.setItem('energy_data', JSON.stringify([{ timestamp: 1, usage_kwh: 0.1 }])));
    await page.setInputFiles('[data-testid="backup-import-input"]', jsonPath);
    await page.waitForFunction(
      (n) => (JSON.parse(localStorage.getItem('energy_data') || '[]')).length === n,
      before.length,
      { timeout: 30_000 },
    );
    const after = await stored(page);
    check('import restores the identical snapshot', JSON.stringify(after) === JSON.stringify(before), `rows=${after.length}`);
    check('app is usable after the import (upload modal not shown)', (await page.getByText('Drop XML Here').count()) === 0, '');
    await dismissOverlays(page);
    await page.screenshot({ path: path.join(OUT, 'wave-g-backup-roundtrip.png'), fullPage: false });

    // A hostile backup must NOT be accepted silently.
    const hostile = path.join(OUT, 'wave-g-hostile-backup.json');
    fs.writeFileSync(hostile, JSON.stringify({
      schema: 'ontario-energy-optimizer.backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      payload: {
        energy_data: [{ timestamp: 'not-a-number', usage_kwh: 'x' }, null, { timestamp: 1780000000, usage_kwh: 99999999 }],
        billing_day: 'first',
      },
    }));
    // A successful import reloads the page, which closes the drawer.
    if ((await page.getByTestId('backup-import-input').count()) === 0) {
      await page.getByTestId('backup-toggle').click();
      await page.getByTestId('backup-import-input').waitFor({ state: 'attached', timeout: 15_000 });
    }
    await page.setInputFiles('[data-testid="backup-import-input"]', hostile);
    await page.waitForTimeout(1500);
    const errText = flat((await page.getByTestId('backup-error').textContent().catch(() => '')) || '');
    const stillIntact = await stored(page);
    check('invalid backup is rejected with a reason', errText.length > 0, errText || '(no error text)');
    check('rejected import left the data untouched', JSON.stringify(stillIntact) === JSON.stringify(before), `rows=${stillIntact.length}`);
    await ctx.close();
  } catch (e) {
    check('backup round-trip', false, e && e.message);
  }

  /* ---------------------------------------------------------------------- *
   * 3. DST crossings — asserted through the CSV export (real app output).
   * ---------------------------------------------------------------------- */
  async function dstScenario(label, fromDay, toDay, expectDay, expectRows, extra) {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
    const xml = buildFeed(localHourSteps(fromDay, toDay, (d) => 800 + (d.getHours() % 6) * 150));
    await page.setInputFiles('input[type="file"][accept=".xml"]', {
      name: `dst-${label}.xml`, mimeType: 'text/xml', buffer: Buffer.from(xml),
    });
    await page.getByText('Drop XML Here').waitFor({ state: 'hidden', timeout: 45_000 });

    // Pin the visible window to the whole file so the CSV export covers it.
    await page.locator('input[type="date"]').first().fill(fromDay);
    await page.locator('input[type="date"]').nth(1).fill(toDay);
    await page.waitForTimeout(400);

    const rows = await stored(page);
    const onDay = rows.filter((r) => localDayOf(r.timestamp) === expectDay);
    check(`${label}: ${expectDay} loaded with ${expectRows} hourly readings`, onDay.length === expectRows, `total=${rows.length}, that day=${onDay.length}`);

    const dl = page.waitForEvent('download');
    await page.getByTestId('export-csv').click();
    const f = await dl;
    const csvPath = path.join(OUT, `wave-g-dst-${label}.csv`);
    await f.saveAs(csvPath);
    const csv = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    const dayRows = csv.filter((r) => isoLocalDay(r.datetime) === expectDay);
    check(`${label}: CSV shows ${expectRows} rows for ${expectDay}`, dayRows.length === expectRows, `csv rows=${dayRows.length}`);
    check(
      `${label}: every row classifies to a TOU and ULO window`,
      dayRows.every((r) => r.tou_category && r.tou_category.length > 2 && r.ulo_category && r.ulo_category.length > 2),
      dayRows.slice(0, 2).map((r) => `${r.datetime} ${r.tou_category}/${r.ulo_category}`).join(' | '),
    );
    if (extra) await extra({ page, csv: dayRows, all: csv });
    await ctx.close();
  }

  try {
    // Spring-forward: 2026-03-08 (Sunday) — the local 02:00 hour does not exist.
    await dstScenario('spring-forward', '2026-03-06', '2026-03-12', '2026-03-08', 23, async ({ page }) => {
      await page.screenshot({ path: path.join(OUT, 'wave-g-dst-spring.png'), fullPage: false });
    });
  } catch (e) {
    check('DST spring-forward scenario', false, e && e.message);
  }

  try {
    // Fall-back: 2026-11-01 (Sunday) — 01:00 happens twice, 25 hourly rows.
    await dstScenario('fall-back', '2026-10-30', '2026-11-03', '2026-11-01', 25, async ({ page, csv }) => {
      const oneAm = csv.filter((r) => isoLocalHour(r.datetime) === '01');
      check(
        'fall-back: local 01:00 occurs twice as two distinct instants',
        oneAm.length === 2 && new Set(oneAm.map((r) => r.datetime)).size === 2 && oneAm.every((r) => isoLocalHour(r.datetime) === '01'),
        oneAm.map((r) => r.datetime).join(' vs '),
      );
      await page.screenshot({ path: path.join(OUT, 'wave-g-dst-fall.png'), fullPage: false });
    });
  } catch (e) {
    check('DST fall-back scenario', false, e && e.message);
  }

  /* ---------------------------------------------------------------------- *
   * 4. tolerant parsing of real utility exports + the first-run diagnostic.
   * ---------------------------------------------------------------------- */
  const samples = [
    ['utility-hydro-one.xml', 48, 3.9546, 'Hydro One (powerOfTenMultiplier −3)'],
    ['utility-toronto-hydro.xml', 96, 0.489, 'Toronto Hydro (15-minute)'],
    ['utility-espi-prefixed-standin.xml', 514, 34, 'espi:-prefixed Connect feed'],
  ];
  for (const [file, count, firstKwh, label] of samples) {
    try {
      const { ctx, page } = await newPage(browser);
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
      await uploadXml(page, path.join(FIXTURES, file));
      const rows = await stored(page);
      check(`${label}: parses on the deployed stack`, rows.length === count, `readings=${rows.length}`);
      check(`${label}: scaled to real kWh`, Math.abs(rows[0].usage_kwh - firstKwh) < 1e-6, `first=${rows[0] && rows[0].usage_kwh}`);
      await ctx.close();
    } catch (e) {
      check(`${label}: parses on the deployed stack`, false, e && e.message);
    }
  }

  try {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
    await page.setInputFiles('input[type="file"][accept=".xml"]', {
      name: 'not-an-export.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<!DOCTYPE html><html><body><h1>Please sign in</h1></body></html>'),
    });
    const panel = page.getByTestId('parse-diagnostic');
    await panel.waitFor({ state: 'visible', timeout: 20_000 });
    const text = flat(await panel.textContent());
    check('bad upload explains WHAT was wrong, not "invalid XML"', /web page, not an export/i.test(text) && /login or error page/i.test(text), text.slice(0, 160));
    check('diagnostic offers a next step', /Download My Data/i.test(text), '');
    await page.screenshot({ path: path.join(OUT, 'wave-g-parse-diagnostic.png'), fullPage: false });
    await ctx.close();
  } catch (e) {
    check('first-run diagnostic', false, e && e.message);
  }

  /* ---------------------------------------------------------------------- *
   * 5. season band + season-aware tier threshold across May 1.
   * ---------------------------------------------------------------------- */
  try {
    const { ctx, page } = await newPage(browser);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByText('Drop XML Here').waitFor({ state: 'visible', timeout: 45_000 });
    const days = [];
    for (let d = new Date('2026-04-20T00:00:00'); d < new Date('2026-05-11T00:00:00'); d.setDate(d.getDate() + 1)) {
      const noon = new Date(d); noon.setHours(13, 0, 0, 0);
      days.push({ t: Math.floor(noon.getTime() / 1000), v: 1500 + (d.getDate() % 4) * 250 });
    }
    await page.setInputFiles('input[type="file"][accept=".xml"]', {
      name: 'season-crossing.xml', mimeType: 'text/xml', buffer: Buffer.from(buildFeed(days)),
    });
    await page.getByText('Drop XML Here').waitFor({ state: 'hidden', timeout: 45_000 });
    await page.locator('input[type="date"]').first().fill('2026-04-20');
    await page.locator('input[type="date"]').nth(1).fill('2026-05-10');
    await page.waitForTimeout(400);
    await dismissOverlays(page);

    const chips = await page.getByTestId('season-chip').allTextContents();
    check('chart shows both rate seasons across May 1', chips.length === 2 && chips.join(' ').includes('Winter') && chips.join(' ').includes('Summer'), chips.map(flat).join(' | '));
    const tier = flat((await page.getByTestId('tier-threshold').textContent().catch(() => '')) || '');
    check('Tiered card names the seasonal threshold in force', /600 kWh\/mo/.test(tier) && /Summer rate window/i.test(tier), tier.slice(0, 200));
    const bands = await page.locator('.recharts-reference-area').count();
    check('season bands are drawn over the bars', bands >= 2, `reference-areas=${bands}`);
    await page.screenshot({ path: path.join(OUT, 'wave-g-season-band.png'), fullPage: true });
    await ctx.close();
  } catch (e) {
    check('season band across May 1', false, e && e && e.message);
  }

  await browser.close();

  summary.total = checks.length;
  summary.passed = checks.filter((c) => c.ok).length;
  summary.failed = checks.filter((c) => !c.ok).length;
  summary.ok = summary.failed === 0;
  fs.writeFileSync(path.join(OUT, 'wave-g-verification.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n${summary.passed}/${summary.total} checks passed`);
  process.exit(summary.ok ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
