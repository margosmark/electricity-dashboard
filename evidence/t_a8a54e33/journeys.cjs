#!/usr/bin/env node
/**
 * Headless journey evidence for t_a8a54e33 (durable versioned storage).
 *
 * Journeys (each recorded with assertions + a screenshot):
 *   J1 upload XML -> chart renders + payload persisted under energy_data_v2
 *   J2 reload     -> data survives, no upload modal
 *   J3 export file -> scoped reset -> import file -> identical chart fingerprint
 *   J4 reset      -> back to the upload modal, only this app's keys removed
 *   J5 legacy v1 key seeded -> migrated to v2 on read, chart renders
 *
 * Usage: node journeys.cjs
 * Requires a server at BASE_URL (default 127.0.0.1:3111).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require(`${process.env.HOME}/.npm/_npx/705bc6b22212b352/node_modules/playwright`);

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3111';
const EV = __dirname;
const OUR_KEYS = ['energy_data_v2', 'energy_data', 'billing_day'];
const report = { startedAt: new Date().toISOString(), baseUrl: BASE, journeys: [] };

function save(name, data) {
  const p = path.join(EV, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

function check(journey, name, pass, detail) {
  journey.checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

// ---------------------------------------------------------------- fixture ---
function buildSampleXml() {
  const now = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const days = 32;
  const n = days * 24;
  let rows = '';
  for (let i = n - 1; i >= 0; i--) {
    const t = now - i * 3600;
    // deterministic, varied load profile in Wh
    const wh = 250 + ((i * 37) % 400) + Math.round(80 * Math.abs(Math.sin(i / 9)));
    rows +=
      `      <IntervalReading><timePeriod><start>${t}</start><duration>3600</duration></timePeriod>` +
      `<value>${wh}</value></IntervalReading>\n`;
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<feed>\n  <entry>\n    <content>\n      <IntervalBlock>\n' +
    rows +
    '      </IntervalBlock>\n    </content>\n  </entry>\n</feed>\n'
  );
}

// ----------------------------------------------------------------- helpers ---
async function storageSnapshot(page) {
  return page.evaluate((keys) => {
    const out = {};
    for (const k of keys) out[k] = localStorage.getItem(k); // null when absent
    for (const k of Object.keys(localStorage)) if (!(k in out)) out[k] = localStorage.getItem(k);
    out.__allKeys = Object.keys(localStorage);
    return out;
  }, OUR_KEYS);
}

/** Pixel fingerprint of the rendered bars: [x, width, height] per bar shape. */
async function barFingerprint(page) {
  return page.evaluate(() => {
    const shapes = [...document.querySelectorAll('path.recharts-rectangle')];
    return shapes
      .map((s) => {
        const r = s.getBoundingClientRect();
        return [Math.round(r.x * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
      })
      .filter(([, w, h]) => w > 0 && h > 0);
  });
}

/** Wait until the bar set is non-empty and pixel-stable across consecutive reads. */
async function stableBars(page, timeout = 20000) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeout) {
    const cur = await barFingerprint(page);
    if (cur.length > 0) {
      await page.waitForTimeout(400);
      const again = await barFingerprint(page);
      if (JSON.stringify(again) === JSON.stringify(cur)) return again;
      last = again;
    } else {
      last = cur;
    }
    await page.waitForTimeout(300);
  }
  return last;
}

/**
 * The chart lives on the Usage tab since the Wave R IA rework — every
 * bar-count / fingerprint assertion has to be looking at it.
 */
async function openChartTab(page) {
  const tab = page.getByRole('tab', { name: 'Usage' });
  if ((await tab.count()) > 0) {
    await tab.click();
    await page.waitForSelector('[data-testid="chart-view"]', { timeout: 20000 }).catch(() => {});
  }
}

async function storageKeys(page) {
  return page.evaluate(() => Object.keys(localStorage));
}

async function shot(page, name) {
  const p = path.join(EV, name);
  await page.screenshot({ path: p });
  return p;
}

function storedPoints(snap) {
  try {
    return JSON.parse(snap.energy_data_v2).points.length;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- journeys ---
async function main() {
  const xmlPath = path.join(EV, 'sample-upload.xml');
  fs.writeFileSync(xmlPath, buildSampleXml());
  console.log(`fixture: ${xmlPath} (${fs.statSync(xmlPath).size} bytes)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ============================ J1: upload -> chart renders =================
  const j1 = { id: 'J1', title: 'upload XML -> chart renders', checks: [], screenshots: [] };
  report.journeys.push(j1);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('unrelated_app_key', 'keep-me'));
  await page.waitForSelector('text=Link Data', { timeout: 20000 });
  check(j1, 'upload modal shown on empty store', await page.isVisible('text=Drop XML Here'), 'Link Data modal visible');
  j1.screenshots.push(await shot(page, 'j1-01-upload-modal.png'));

  await page.setInputFiles('input[accept=".xml"]', xmlPath);
  await page.waitForSelector('text=Link Data', { state: 'detached', timeout: 30000 });
  await openChartTab(page);
  const bars1 = await stableBars(page);
  check(j1, 'chart renders bars', bars1.length > 0, `${bars1.length} bars rendered`);

  // switch to a wide window so the fingerprint covers the whole dataset
  await page.click('button:has-text("YTD")');
  await page.click('button:text-is("daily")');
  const bars1ytd = await stableBars(page);
  check(j1, 'YTD/daily view has a bar per day', bars1ytd.length >= 20, `${bars1ytd.length} daily bars`);

  const snap1 = await storageSnapshot(page);
  const pts1 = storedPoints(snap1);
  check(j1, 'payload persisted under energy_data_v2', pts1 === 32 * 24, `points=${pts1}, keys=${JSON.stringify(snap1.__allKeys)}`);
  const payload1 = JSON.parse(snap1.energy_data_v2);
  check(j1, 'payload is versioned with explicit fields',
    payload1.version === 2 && typeof payload1.uploadedAt === 'string' && payload1.source === 'upload' && Array.isArray(payload1.points),
    `version=${payload1.version} source=${payload1.source} uploadedAt=${payload1.uploadedAt}`);
  check(j1, 'no legacy energy_data key written', snap1.energy_data === null, `legacy=${String(snap1.energy_data)}`);
  check(j1, 'unrelated key untouched', snap1.__allKeys.includes('unrelated_app_key'), `keys=${JSON.stringify(snap1.__allKeys)}`);
  j1.screenshots.push(await shot(page, 'j1-02-chart-after-upload.png'));

  // ============================ J2: reload -> data survives ================
  const j2 = { id: 'J2', title: 'reload -> data survives', checks: [], screenshots: [] };
  report.journeys.push(j2);
  await page.reload({ waitUntil: 'networkidle' });
  const modalVisibleAfterReload = await page.isVisible('text=Link Data');
  check(j2, 'no upload modal after reload', !modalVisibleAfterReload, `modal visible=${modalVisibleAfterReload}`);
  await openChartTab(page);
  await page.click('button:has-text("YTD")');
  await page.click('button:text-is("daily")');
  const bars2 = await stableBars(page);
  check(j2, 'chart re-renders from storage', bars2.length >= 20, `${bars2.length} daily bars`);
  check(j2, 'identical bar geometry to pre-reload', JSON.stringify(bars2) === JSON.stringify(bars1ytd),
    `${bars2.length} bars, equal=${JSON.stringify(bars2) === JSON.stringify(bars1ytd)}`);
  const snap2 = await storageSnapshot(page);
  check(j2, 'all points survived', storedPoints(snap2) === 32 * 24, `points=${storedPoints(snap2)}`);
  j2.screenshots.push(await shot(page, 'j2-reload-survives.png'));

  // ================= J3: export -> clear -> import -> identical chart ======
  const j3 = { id: 'J3', title: 'export file -> clear -> import -> identical chart', checks: [], screenshots: [] };
  report.journeys.push(j3);
  const beforeExport = await stableBars(page);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('[title="Export Data"]'),
  ]);
  const exportPath = path.join(EV, 'exported-backup.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  check(j3, 'export downloads a JSON payload', Array.isArray(exported.points) && exported.points.length === 32 * 24,
    `file=${download.suggestedFilename()} bytes=${fs.statSync(exportPath).size} points=${exported.points.length}`);
  check(j3, 'export carries the explicit payload shape',
    exported.version === 2 && typeof exported.uploadedAt === 'string' && typeof exported.source === 'string',
    `version=${exported.version} source=${exported.source}`);
  j3.screenshots.push(await shot(page, 'j3-01-before-reset.png'));

  // step 1 of reset: confirm dialog, nothing removed yet
  await page.click('[title="Reset Data"]');
  await page.waitForSelector('[data-testid="reset-confirm"]');
  const midReset = await storageSnapshot(page);
  check(j3, 'reset is two-step (dialog first, data intact)',
    midReset.energy_data_v2 !== null && midReset.__allKeys.includes('unrelated_app_key'),
    `keys=${JSON.stringify(midReset.__allKeys)}`);
  j3.screenshots.push(await shot(page, 'j3-02-reset-confirm.png'));

  // step 2: confirm -> scoped removal + reload -> upload modal
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
    page.click('[title="Confirm Reset"]'),
  ]);
  await page.waitForSelector('text=Drop XML Here', { timeout: 20000 });
  const afterReset = await storageSnapshot(page);
  const leftovers = OUR_KEYS.filter((k) => afterReset[k] !== null);
  check(j3, 'reset removes only our keys', leftovers.length === 0, `leftover our keys=${JSON.stringify(leftovers)} allKeys=${JSON.stringify(afterReset.__allKeys)}`);
  check(j3, 'unrelated key survives reset', afterReset.unrelated_app_key === 'keep-me', `unrelated=${String(afterReset.unrelated_app_key)}`);

  // import the file we just exported
  await page.setInputFiles('input[aria-label="Import JSON backup"]', exportPath);
  await page.waitForSelector('text=Link Data', { state: 'detached', timeout: 30000 });
  await openChartTab(page);
  await page.click('button:has-text("YTD")');
  await page.click('button:text-is("daily")');
  const afterImport = await stableBars(page);
  check(j3, 'import restores every point', storedPoints(await storageSnapshot(page)) === 32 * 24,
    `points=${storedPoints(await storageSnapshot(page))}`);
  check(j3, 'chart fingerprint identical after export->clear->import',
    JSON.stringify(afterImport) === JSON.stringify(beforeExport),
    `before=${beforeExport.length} bars after=${afterImport.length} equal=${JSON.stringify(afterImport) === JSON.stringify(beforeExport)}`);
  j3.screenshots.push(await shot(page, 'j3-03-after-import.png'));

  // ======================= J4: reset -> back to upload modal ===============
  const j4 = { id: 'J4', title: 'reset -> back to upload modal', checks: [], screenshots: [] };
  report.journeys.push(j4);
  await page.click('[title="Reset Data"]');
  await page.waitForSelector('[data-testid="reset-confirm"]');
  await page.click('[title="Confirm Reset"]');
  await page.waitForSelector('text=Drop XML Here', { timeout: 20000 });
  const j4Snap = await storageSnapshot(page);
  check(j4, 'upload modal after reset', await page.isVisible('text=Drop XML Here'), 'Link Data modal visible again');
  check(j4, 'our keys gone', OUR_KEYS.every((k) => j4Snap[k] === null), `keys=${JSON.stringify(j4Snap.__allKeys)}`);
  check(j4, 'unrelated key still present', j4Snap.unrelated_app_key === 'keep-me', `unrelated=${String(j4Snap.unrelated_app_key)}`);
  j4.screenshots.push(await shot(page, 'j4-reset-back-to-upload-modal.png'));

  // ==================== J5: legacy v1 key migrates on read ================
  const j5 = { id: 'J5', title: 'legacy energy_data (v1) migrates to energy_data_v2 on read', checks: [], screenshots: [] };
  report.journeys.push(j5);
  const page2 = await ctx.newPage();
  await page2.goto(BASE, { waitUntil: 'networkidle' });
  const legacyPoints = await page2.evaluate(() => {
    const now = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const pts = [];
    for (let i = 48; i >= 0; i--) pts.push({ timestamp: now - i * 3600, usage_kwh: 1 + (i % 7) / 10 });
    localStorage.setItem('energy_data', JSON.stringify(pts));   // legacy v1 key
    localStorage.setItem('billing_day', '20');
    localStorage.setItem('unrelated_app_key', 'keep-me');
    return pts;
  });
  await page2.reload({ waitUntil: 'networkidle' });
  await page2.waitForSelector('text=Link Data', { state: 'detached', timeout: 20000 }).catch(() => {});
  await openChartTab(page2);
  const bars5 = await stableBars(page2);
  check(j5, 'legacy data renders after migration', bars5.length > 0, `${bars5.length} bars`);
  const snap5 = await storageSnapshot(page2);
  check(j5, 'legacy key migrated to v2 payload', snap5.energy_data === null && storedPoints(snap5) === legacyPoints.length,
    `legacy=${String(snap5.energy_data)} v2points=${storedPoints(snap5)}`);
  const p5 = snap5.energy_data_v2 ? JSON.parse(snap5.energy_data_v2) : null;
  check(j5, 'migrated payload is version 2', p5 && p5.version === 2 && p5.source === 'legacy-migration',
    `version=${p5 && p5.version} source=${p5 && p5.source}`);
  const bday = await page2.inputValue('input[type="number"]');
  check(j5, 'billing_day still drives the UI', bday === '20', `billing day input=${bday}`);
  check(j5, 'no storage notice on a clean migration', (await page2.$('[data-testid="storage-notice"]')) === null, 'notice row absent');
  j5.screenshots.push(await shot(page2, 'j5-legacy-migration.png'));
  await page2.close();

  // ==================== J6: quota failure surfaces a visible row ==========
  const j6 = { id: 'J6', title: 'quota failure -> visible error row, data still exportable', checks: [], screenshots: [] };
  report.journeys.push(j6);
  const ctx6 = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page6 = await ctx6.newPage();
  await page6.goto(BASE, { waitUntil: 'networkidle' });
  const fill = await page6.evaluate(() => {
    const probe = (n) => {
      try { localStorage.setItem('__filler', 'x'.repeat(n)); return true; } catch { return false; }
    };
    let lo = 0;
    let hi = 16 * 1024 * 1024;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi + 1) / 2);
      if (probe(mid)) lo = mid; else hi = mid - 1;
    }
    const ceiling = lo;
    // leave ~10KB headroom: far smaller than the 768-point payload, still room for a billing_day write
    const kept = Math.max(0, ceiling - 10000);
    probe(kept);
    return { ceiling, kept, remaining: ceiling - kept };
  });
  check(j6, 'storage filled to a measured ceiling', fill.ceiling > 1000000, `ceiling=${fill.ceiling} bytes kept=${fill.kept} headroom=${fill.remaining}B`);

  await page6.setInputFiles('input[accept=".xml"]', xmlPath);
  await page6.waitForSelector('text=Link Data', { state: 'detached', timeout: 30000 });
  await openChartTab(page6);
  await page6.waitForSelector('[data-testid="storage-notice"]', { timeout: 15000 });
  const noticeText = (await page6.textContent('[data-testid="storage-notice"]')) || '';
  check(j6, 'quota message shown verbatim',
    noticeText.includes('Data too large for browser storage — export and clear old data'),
    JSON.stringify(noticeText.replace(/\s+/g, ' ').slice(0, 160)));
  const qSnap = await storageSnapshot(page6);
  check(j6, 'failed write is not silently dropped',
    qSnap.energy_data_v2 === null && qSnap.__allKeys.includes('__filler'),
    `energy_data_v2=${String(qSnap.energy_data_v2)} keys=${JSON.stringify(qSnap.__allKeys)}`);
  const qBars = await stableBars(page6, 8000);
  check(j6, 'chart still usable in-memory so the user can export', qBars.length > 0, `${qBars.length} bars rendered from memory`);
  const exportEnabled = await page6.isEnabled('[title="Export Data"]');
  check(j6, 'export button available while storage is full', exportEnabled === true, `enabled=${exportEnabled}`);
  j6.screenshots.push(await shot(page6, 'j6-quota-error-row.png'));
  await ctx6.close();

  report.consoleErrors = consoleErrors;
  report.finishedAt = new Date().toISOString();
  const all = report.journeys.flatMap((j) => j.checks);
  report.totals = { checks: all.length, passed: all.filter((c) => c.pass).length, failed: all.filter((c) => !c.pass).length };
  save('journey-report.json', report);
  console.log(`\nTOTAL: ${report.totals.passed}/${report.totals.checks} checks passed, ${report.totals.failed} failed`);
  console.log(`console errors: ${consoleErrors.length}`);

  await browser.close();
  process.exit(report.totals.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('JOURNEY SCRIPT FAILED:', err);
  try { fs.writeFileSync(path.join(EV, 'journey-report.json'), JSON.stringify({ fatal: String(err), ...report }, null, 2)); } catch {}
  process.exit(2);
});
