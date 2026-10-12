/**
 * Mobile-defect acceptance harness (t_c58f1459 / spec t_fcbba376) — D2, D3, D4
 * measured in a real browser at every viewport the evidence covers.
 *
 * The same checks exist as a Playwright spec (`webapp/tests/e2e/
 * mobile-defects.spec.ts`, run with `SMOKE_BASE_URL=… npx playwright test
 * mobile-defects`); this harness is the evidence-channel sibling the repo's
 * `evidence/*-verify.cjs` files follow — no test runner, plain chrome, writes
 * `mobile-defects-verification.json` next to itself and exits non-zero on the
 * first failed expectation, so it can be re-run by QA or by hand:
 *
 *   node evidence/mobile-defects-verify.cjs [baseURL]   # server must be up
 *
 * D1 (the full-bleed black rule under the pills) is not asserted here: it has
 * not shipped — its colour is @designerbot's call (border-accent vs
 * border-b-2 border-edge-muted) and nothing lands before that verdict.
 *
 * Viewports:
 *   390×844   the iPhone-class width the spec was written against;
 *   427×952   Mark's actual device (screenshot 1280×2856, six anchors at
 *             exactly DPR 3.0) — the width compensation is what makes the
 *             same code pass both;
 *   1280×900  desktop: the "nothing changed" bar.
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join(__dirname, '../webapp/node_modules/playwright-core'));

const OUT_DIR = __dirname;
const BASE_URL = process.argv[2] || 'http://localhost:3210';
const CHROME =
  process.env.PW_CHROMIUM_PATH ||
  process.env.CHROME_PATH ||
  '/usr/bin/google-chrome';

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, kind: 'mobile' },
  { name: '427x952', width: 427, height: 952, kind: 'mobile' },
  { name: '1280x900', width: 1280, height: 900, kind: 'desktop' },
];

const results = { baseURL: BASE_URL, generatedAt: new Date().toISOString(), viewports: {}, failures: [] };

function check(viewport, name, ok, detail) {
  const list = (results.viewports[viewport].checks ||= []);
  list.push({ name, ok, detail });
  if (!ok) results.failures.push(`${viewport}: ${name} — ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${viewport} ${name}  ${detail}`);
}

/** 24 Mark-shaped bills + readings carried into the current month. */
function seedBills() {
  const round2 = (n) => Math.round(n * 100) / 100;
  const ymd = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  const meas = (v) => ({ scaled: round2(v), value: round2(v), powerOfTenMultiplier: 0, uom: 72 });
  const item = (note, amount, measurement) => ({
    note,
    amount,
    rawAmount: amount === null ? null : Math.round(amount * 10000),
    itemKind: null,
    unitCost: null,
    measurement: measurement || null,
  });
  const now = new Date();
  const bills = [];
  for (let i = 0; i < 24; i++) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - (23 - i), 1));
    const y = end.getUTCFullYear();
    const m = end.getUTCMonth();
    const start = Date.UTC(y, m, 1) / 1000;
    const duration = 28 * 86400;
    const summer = m >= 4 && m <= 9;
    const kwh = round2((summer ? 1250 : 880) + 120 * Math.sin(i * 1.7));
    const rate = round2(8.5 + 2.2 * Math.sin(i * 0.9) + (summer ? 1.1 : 0));
    const commodity = round2((kwh * rate) / 100);
    const delivery = round2(36 + 0.0252 * kwh);
    const regulatory = round2(45.15);
    const total = round2(commodity + delivery + regulatory);
    const tax = round2(total * 0.13);
    bills.push({
      source: 'UsageSummary',
      start,
      duration,
      startDate: ymd(start),
      endDate: ymd(start + duration),
      days: 28,
      billLastPeriod: duration,
      billToDate: 0,
      costAdditionalLastPeriod: 0,
      currency: 124,
      consumption: meas(kwh),
      items: [
        item('Total Electricity Charges', total, null),
        item('Electricity Commodity', commodity, null),
        item('Delivery', delivery, null),
        item('Regulatory Charges', regulatory, null),
        item('HST', tax, null),
        item('Off Peak Usage', null, meas(round2(kwh * 0.55))),
        item('Mid Peak Usage', null, meas(round2(kwh * 0.2))),
        item('On Peak Usage', null, meas(round2(kwh * 0.25))),
      ],
    });
  }
  localStorage.setItem('usage_summaries', JSON.stringify(bills));
  const payload = JSON.parse(localStorage.getItem('energy_data_v2') || 'null');
  if (payload && Array.isArray(payload.points) && payload.points.length > 0) {
    let ts = payload.points[payload.points.length - 1].timestamp;
    const target = Math.floor(Date.now() / 1000);
    let guard = 0;
    while (ts < target && guard++ < 500) {
      ts += 6 * 3600;
      payload.points.push({ timestamp: ts, usage_kwh: 0.28 + 0.18 * Math.sin(ts / 9000) });
    }
    localStorage.setItem('energy_data_v2', JSON.stringify(payload));
  }
  return { bills: bills.length, points: payload && payload.points ? payload.points.length : 0 };
}

async function measure(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="efficiency-chart"]');
    const texts = [...svg.querySelectorAll('text')].map((t) => {
      const r = t.getBoundingClientRect();
      return { text: t.textContent, x: r.left, y: r.top, w: r.width, h: r.height, fontSize: getComputedStyle(t).fontSize };
    });
    const overlaps = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i];
        const b = texts[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0 && oy > 0) overlaps.push(`${a.text} x ${b.text}`);
      }
    }
    const bands = [...svg.querySelectorAll('[data-testid="efficiency-season-band"]')].map((rect) => {
      const rb = rect.getBoundingClientRect();
      const label = (rect.closest('g') || document).querySelector('text');
      const lb = label ? label.getBoundingClientRect() : null;
      return {
        season: rect.getAttribute('data-season'),
        units: Number(rect.getAttribute('width')),
        cssWidth: Math.round(rb.width * 10) / 10,
        label: label ? label.textContent : null,
        escapes: lb
          ? lb.left < rb.left - 1 || lb.right > rb.right + 1 || lb.top < rb.top - 1 || lb.bottom > rb.bottom + 1
          : false,
      };
    });

    // D2
    const active = document.querySelector('[role="tab"][data-active="true"]');
    const pills = [...active.parentElement.querySelectorAll('[role="tab"]')];
    const next = pills[pills.indexOf(active) + 1];
    const cs = getComputedStyle(active);
    const m = /rgb\(37,\s*99,\s*235\)\s+(-?[\d.]+)px/.exec(cs.boxShadow);
    const offset = m ? Math.abs(parseFloat(m[1])) : 0;
    const ar = active.getBoundingClientRect();
    const nr = next.getBoundingClientRect();

    // D4
    window.scrollTo(0, document.documentElement.scrollHeight);
    const card = document.querySelector('[data-testid="bill-projection"]');
    const cr = card.getBoundingClientRect();

    const svgBox = svg.getBoundingClientRect();
    return {
      d2: {
        shadow: cs.boxShadow,
        shadowOffsetPx: offset,
        pillGapPx: Math.round((nr.left - ar.right) * 10) / 10,
        shadowClearancePx: Math.round((nr.left - (ar.right + offset)) * 10) / 10,
        focusVisible: active.matches(':focus-visible'),
      },
      d3: {
        svgWidthPx: Math.round(svgBox.width * 10) / 10,
        labelCount: texts.length,
        minLabelHeightPx: Math.round(Math.min(...texts.map((t) => t.h)) * 10) / 10,
        fontSizes: [...new Set(texts.map((t) => t.fontSize))],
        overlaps,
        bands: bands.map((b) => ({
          season: b.season,
          widthUnits: Math.round(b.units * 10) / 10,
          widthCssPx: b.cssWidth,
          label: b.label,
          escapesBand: b.escapes,
        })),
        labelledBands: bands.filter((b) => b.label).length,
        escapingLabels: bands.filter((b) => b.escapes).length,
        labels: texts.map((t) => ({ text: t.text, fontSize: t.fontSize, heightPx: Math.round(t.h * 10) / 10 })),
      },
      d4: {
        state: card.getAttribute('data-state'),
        bodyPadBottom: getComputedStyle(document.body).paddingBottom,
        cardBottom: Math.round(cr.bottom * 10) / 10,
        viewportHeight: window.innerHeight,
        clearancePx: Math.round((window.innerHeight - cr.bottom) * 10) / 10,
        fullyVisible: cr.bottom <= window.innerHeight && cr.top >= 0,
        atMaxScroll: Math.round(window.scrollY) === Math.round(document.documentElement.scrollHeight - window.innerHeight),
      },
      page: {
        verticalScrollReservePx: document.documentElement.scrollHeight - window.innerHeight,
        horizontalOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      },
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  for (const vp of VIEWPORTS) {
    results.viewports[vp.name] = { kind: vp.kind, checks: [] };
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.kind === 'mobile' ? 3 : 1,
      isMobile: vp.kind === 'mobile',
      hasTouch: vp.kind === 'mobile',
      locale: 'en-CA',
      timezoneId: 'America/Toronto',
    });
    const page = await ctx.newPage();
    await page.goto(BASE_URL + '/', { waitUntil: 'networkidle', timeout: 90_000 });
    await page.getByTestId('try-example-data').click();
    await page.getByTestId('totals-strip').waitFor({ timeout: 60_000 });
    const seeded = await page.evaluate(seedBills);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('efficiency-chart').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);

    const m = await measure(page);
    results.viewports[vp.name].seed = seeded;
    results.viewports[vp.name].measurements = m;
    await page.screenshot({ path: path.join(OUT_DIR, `mobile-defects-${vp.name}.png`) });

    const expectedFs = Math.max(10, Math.round((9 * 720) / Math.max(1, m.d3.svgWidthPx)));
    if (vp.kind === 'mobile') {
      check(vp.name, 'D2 gap between pills', m.d2.pillGapPx >= 8, `${m.d2.pillGapPx}px (gap-2)`);
      check(vp.name, 'D2 clearance past the blue shadow', m.d2.shadowClearancePx >= 4, `${m.d2.shadowClearancePx}px`);
      check(vp.name, 'D2 shadow is still the blue hard offset', /37, 99, 235/.test(m.d2.shadow) && m.d2.shadowOffsetPx === 3, m.d2.shadow);
      check(vp.name, 'D2 sliver was never the focus ring', m.d2.focusVisible === false, `:focus-visible=${m.d2.focusVisible}`);
      check(vp.name, 'D3 every label >= 8 CSS px', m.d3.minLabelHeightPx >= 8, `min ${m.d3.minLabelHeightPx}px`);
      check(vp.name, 'D3 labels compensated for this width', m.d3.fontSizes.length === 1 && parseFloat(m.d3.fontSizes[0]) === expectedFs, `svg ${m.d3.svgWidthPx}px -> ${m.d3.fontSizes.join('/')}`);
      check(vp.name, 'D3 no two label boxes intersect', m.d3.overlaps.length === 0, m.d3.overlaps.join('; ') || 'none');
      check(vp.name, 'D3 season labels stay inside their band', m.d3.escapingLabels === 0, `${m.d3.labelledBands} labelled, ${m.d3.escapingLabels} escaping`);
      check(vp.name, 'D3 the fixture still has labelled bands', m.d3.labelledBands > 0, `${m.d3.labelledBands}/${m.d3.bands.length}`);
      check(vp.name, 'D4 body floor is 40px', m.d4.bodyPadBottom === '40px', m.d4.bodyPadBottom);
      check(vp.name, 'D4 projection card renders', m.d4.state === 'ready', `state=${m.d4.state}`);
      check(vp.name, 'D4 card clears the 36px gesture bar', m.d4.clearancePx >= 36, `${m.d4.clearancePx}px below the card (spec: >=33px)`);
      check(vp.name, 'D4 card fully visible at max scroll', m.d4.fullyVisible && m.d4.atMaxScroll, `bottom ${m.d4.cardBottom} / ${m.d4.viewportHeight}px`);
      check(vp.name, 'no horizontal overflow', m.page.horizontalOverflowPx === 0, `${m.page.horizontalOverflowPx}px`);
    } else {
      check(vp.name, 'desktop label size is the pre-D3 literal 10', m.d3.fontSizes.length === 1 && parseFloat(m.d3.fontSizes[0]) === 10, m.d3.fontSizes.join('/'));
      check(vp.name, 'desktop: chart measures >= 648px', m.d3.svgWidthPx >= 648, `${m.d3.svgWidthPx}px`);
      check(vp.name, 'desktop: no label overlaps', m.d3.overlaps.length === 0, m.d3.overlaps.join('; ') || 'none');
      check(vp.name, 'desktop: no season label escapes its band', m.d3.escapingLabels === 0, `${m.d3.labelledBands}/${m.d3.bands.length} labelled`);
      check(vp.name, 'desktop: labels still legible', m.d3.minLabelHeightPx >= 8, `min ${m.d3.minLabelHeightPx}px`);
    }
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'mobile-defects-verification.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`\n${results.failures.length === 0 ? 'ALL CHECKS PASS' : 'FAILURES'}: ${results.failures.length}`);
  for (const f of results.failures) console.log('  ' + f);
  process.exit(results.failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
