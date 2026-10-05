/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: run with `node scripts/…`, not bundled. */
/**
 * Wave I helper — responsive + touch audit at phone viewports.
 *
 * Usage: node scripts/mobile-audit.cjs <baseURL> <outdir>
 *
 * For each viewport (390x844 iPhone-ish, 360x800 small-Android floor) and each
 * app state (empty / chart / insights / floor-help modal / backup drawer) it
 * records:
 *
 *  - CLS with per-shift attribution (element + previous/current rect)
 *  - DOCUMENT horizontal overflow (scrollWidth vs clientWidth) — the only
 *    overflow that actually scrolls the page. Elements that stick out inside a
 *    deliberately scrollable or overflow-hidden ancestor (the 600px weekday×hour
 *    heatmap, which is `overflow-x:auto` behind a "scroll horizontally" hint)
 *    are counted separately as `inScrollRegion` so they never drown the real
 *    signal.
 *  - interactive elements whose hit box is under 44x44 CSS px. A native
 *    radio/checkbox wrapped in a <label> is scored on the LABEL, because that
 *    is the region a tap actually activates.
 *  - form fields under 16px font (iOS auto-zooms the page on focus)
 *  - occlusion: whether the element at a surface's centre really is that
 *    surface (catches a popover painted behind a later sibling)
 *  - the two dismissal paths each overlay must offer on a phone: Escape AND a
 *    tap (Cancel / Close / tap-outside)
 *
 * Writes audit.json plus a full-page screenshot per state per viewport.
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:3199';
const OUT = process.argv[3] || path.join(__dirname, '..', 'evidence', 'wave-i-audit-after');
// Optional second dataset: a real utility export, uploaded through the same
// file input a user would use. Without it the run loads the bundled example
// year through the "Try with example data" button instead.
const XML = process.env.WAVE_I_XML || null;

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, dsf: 3, mobile: true },
  { name: '360x800', width: 360, height: 800, dsf: 3, mobile: true },
];

const CLS_HOOK = `
  window.__cls = { total: 0, shifts: [] };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__cls.total += e.value;
      window.__cls.shifts.push({
        value: e.value,
        time: e.startTime,
        sources: (e.sources || []).map((s) => ({
          node: describe(s.node),
          prev: rect(s.previousRect),
          cur: rect(s.currentRect),
        })),
      });
    }
    function rect(r) { return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null; }
    function describe(n) {
      if (!n) return null;
      try {
        if (n.nodeType !== 1) return n.nodeName;
        let d = n.tagName.toLowerCase();
        if (n.id) d += '#' + n.id;
        if (typeof n.className === 'string' && n.className.trim()) {
          d += '.' + n.className.trim().split(/\\s+/).slice(0, 5).join('.');
        }
        const t = n.getAttribute && n.getAttribute('data-testid');
        if (t) d += '[' + t + ']';
        return d;
      } catch (err) { return 'node'; }
    }
  }).observe({ type: 'layout-shift', buffered: true });
`;

const AUDIT = `(() => {
  const out = {
    doc: { scrollWidth: 0, clientWidth: 0, overflowPx: 0 },
    overflow: [], inScrollRegion: [], smallTargets: [], smallFonts: [], occlusion: [],
  };
  out.doc.scrollWidth = document.documentElement.scrollWidth;
  out.doc.clientWidth = document.documentElement.clientWidth;
  out.doc.overflowPx = out.doc.scrollWidth - out.doc.clientWidth;

  function describe(n) {
    if (!n) return null;
    if (n.nodeType !== 1) return n.nodeName;
    let d = n.tagName.toLowerCase();
    if (n.id) d += '#' + n.id;
    if (typeof n.className === 'string' && n.className.trim()) {
      d += '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.');
    }
    const t = n.getAttribute && n.getAttribute('data-testid');
    if (t) d += '[' + t + ']';
    return d;
  }

  // An element inside an overflow-x auto/scroll/hidden ancestor is contained by
  // that ancestor: it never scrolls the page, so it is not a page overflow.
  function hasClippingAncestor(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
    }
    return false;
  }

  const vw = window.innerWidth;
  const all = Array.from(document.querySelectorAll('body *'));
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      const rec = { sel: describe(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), pos: cs.position };
      if (cs.position === 'fixed') continue;
      if (hasClippingAncestor(el)) out.inScrollRegion.push(rec);
      else out.overflow.push(rec);
    }
  }

  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role=button], [role=tab], [role=switch], [onclick], [tabindex]:not([tabindex="-1"])';
  for (const el of all) {
    if (!el.matches || !el.matches(INTERACTIVE)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.pointerEvents === 'none') continue;
    let target = el;
    // A radio/checkbox fires through its label: score the label, which is what
    // a thumb actually lands on.
    if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
      const label = el.closest('label');
      if (label) target = label;
    }
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.width < 44 || r.height < 44) {
      out.smallTargets.push({
        sel: describe(target),
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (target.innerText || target.value || target.getAttribute('aria-label') || '').slice(0, 40),
      });
    }
  }

  for (const el of all) {
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
    if (el.type === 'radio' || el.type === 'checkbox' || el.type === 'file' || el.type === 'range') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < 16) out.smallFonts.push({ sel: describe(el), fontSize: fs, type: el.type || el.tagName });
  }

  // Is this surface really the top thing where it says it is?
  for (const sel of ['[data-testid=backup-drawer]', '[data-testid=upload-modal]', '[data-testid=floor-help-modal]']) {
    const node = document.querySelector(sel);
    if (!node) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Clamp into the viewport: elementFromPoint returns null off-screen, which
    // would report a false "covered".
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + Math.min(24, r.height / 2)));
    const hit = document.elementFromPoint(x, y);
    out.occlusion.push({
      sel,
      topAtCentre: hit ? describe(hit) : null,
      covered: !(hit === node || node.contains(hit)),
    });
  }

  return out;
})()`;

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    ...(process.env.PW_CHROMIUM_PATH ? {} : { channel: 'chrome' }),
  });
  const report = {};

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dsf,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      locale: 'en-CA',
      timezoneId: 'America/Toronto',
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('  pageerror', String(e).slice(0, 200)));

    await page.addInitScript(CLS_HOOK);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await settle(page);

    const entry = { cls: await page.evaluate(() => window.__cls), states: {} };

    // State A: no stored data — the app auto-opens the upload modal.
    entry.states.empty = await page.evaluate(AUDIT);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-empty.png`), fullPage: true });

    // The modal must be dismissible without a hardware keyboard: tap Cancel.
    const cancel = page.locator('[data-testid=upload-modal] button', { hasText: /cancel/i });
    if (await cancel.count()) await cancel.first().tap().catch(() => {});
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    entry.tapClosedModal = (await page.locator('[data-testid=upload-modal]').count()) === 0;

    // State B: a real dataset through the real parser — either a Green Button
    // export from disk (WAVE_I_XML) or the bundled example year.
    await page.locator('button[aria-label="Upload XML"]').first().click();
    await page.waitForSelector('[data-testid=upload-modal]', { timeout: 5000 });
    if (XML) {
      await page.setInputFiles('[data-testid=upload-modal] input[type=file]', XML);
    } else {
      await page.locator('[data-testid=try-example-data]').tap().catch(() => {});
    }
    await page.waitForSelector('[data-testid=totals-strip]', { timeout: 60000 });
    await page.waitForTimeout(1500);
    entry.dataset = XML ? path.basename(XML) : 'bundled-example-year';

    entry.states.chart = await page.evaluate(AUDIT);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-chart.png`), fullPage: true });

    // State C: Insights (the heatmap is a deliberate horizontal scroller).
    await page.getByRole('button', { name: 'INSIGHTS' }).first().tap().catch(() => {});
    await page.waitForTimeout(900);
    entry.states.insights = await page.evaluate(AUDIT);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-insights.png`), fullPage: true });

    // State D: always-on floor help modal.
    const floorBtn = page.locator('button[aria-label^="Always-on floor"]');
    if (await floorBtn.count()) {
      await floorBtn.first().tap().catch(() => {});
      await page.waitForTimeout(500);
      entry.states.floorModal = await page.evaluate(AUDIT);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-floor-modal.png`), fullPage: false });
      const close = page.locator('[data-testid=floor-help-modal] button[aria-label="Close"]');
      if (await close.count()) await close.first().tap().catch(() => {});
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      entry.tapClosedFloorModal = (await page.locator('[data-testid=floor-help-modal]').count()) === 0;
    }

    // State E: backup drawer — its two mobile failure modes were horizontal
    // page overflow and having no touch path to dismiss.
    const backupToggle = page.locator('[data-testid=backup-toggle]');
    if (await backupToggle.count()) {
      await backupToggle.first().tap().catch(() => {});
      await page.waitForTimeout(500);
      entry.states.backup = await page.evaluate(AUDIT);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-backup.png`), fullPage: false });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      entry.escClosedBackup = (await page.locator('[data-testid=backup-drawer]').count()) === 0;

      // The touch path: reopen, then tap somewhere the drawer definitely is
      // NOT — the page title at the top of the document.
      await backupToggle.first().tap().catch(() => {});
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await page.locator('main h1').tap().catch(() => {});
      await page.waitForTimeout(400);
      entry.outsideTapClosedBackup = (await page.locator('[data-testid=backup-drawer]').count()) === 0;
    }

    report[vp.name] = entry;
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(report, null, 2));

  let findings = 0;
  for (const [vp, e] of Object.entries(report)) {
    console.log(`\n=== ${vp} === CLS=${e.cls.total.toFixed(4)} shifts=${e.cls.shifts.length}`);
    for (const s of e.cls.shifts.slice(0, 6)) {
      console.log(`  shift ${s.value.toFixed(4)} @${Math.round(s.time)}ms`);
      for (const src of s.sources.slice(0, 3)) {
        console.log(`     ${src.node} ${JSON.stringify(src.prev)} -> ${JSON.stringify(src.cur)}`);
      }
    }
    for (const [state, a] of Object.entries(e.states)) {
      const bad = a.doc.overflowPx > 0 || a.overflow.length > 0 || a.smallTargets.length > 0 || a.smallFonts.length > 0;
      if (bad) findings++;
      console.log(`  [${state}] docOverflow=${a.doc.overflowPx}px contained=${a.overflow.length} inScrollRegion=${a.inScrollRegion.length} targets<44=${a.smallTargets.length} inputs<16px=${a.smallFonts.length}`);
      for (const o of a.overflow.slice(0, 5)) console.log(`     overflow: ${o.sel} right=${o.right}`);
      for (const t of a.smallTargets.slice(0, 10)) console.log(`     target: ${t.sel} ${t.w}x${t.h} "${t.text}"`);
      for (const f of a.smallFonts.slice(0, 10)) console.log(`     font: ${f.sel} ${f.fontSize}px ${f.type}`);
      for (const oc of a.occlusion) if (oc.covered) console.log(`     OCCLUDED: ${oc.sel} under ${oc.topAtCentre}`);
    }
    console.log(`  tapClosedModal=${e.tapClosedModal} tapClosedFloorModal=${e.tapClosedFloorModal} escClosedBackup=${e.escClosedBackup} outsideTapClosedBackup=${e.outsideTapClosedBackup}`);
  }
  console.log(`\nstates with findings: ${findings}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
