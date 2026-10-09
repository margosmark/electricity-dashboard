/**
 * Toolbar geometry verification — the Wave R follow-up (t_7f224ead).
 *
 * The complaint this script exists to settle: at >=1024px the dashboard's
 * toolbar card wrapped into two rows and left a ~640x175px void in the
 * bottom-left of the card (the right cluster's `lg:ml-auto` right-aligned
 * row 2, so everything between the left edge and the right cluster was
 * dead white).
 *
 * What it measures, in a real browser, at every width the gates name:
 *
 *   1. the toolbar card exists and holds the global actions;
 *   2. the LARGEST AXIS-ALIGNED EMPTY RECTANGLE inside the card's content
 *      box (sampled at 4px over every descendant box) is small — this is
 *      the dead band, measured instead of eyeballed;
 *   3. each visual row of top-level clusters spans most of the card's
 *      content width (no right-aligned orphan row);
 *   4. no horizontal page overflow, and no internal horizontal scrolling of
 *      the toolbar, at any width including 390.
 *
 * Run:  NODE_PATH=$PWD/webapp/node_modules node evidence/toolbar-verify.cjs
 * Env:  TOOLBAR_BASE_URL (default http://127.0.0.1:3100/), TOOLBAR_CHROMIUM,
 *       TOOLBAR_XML, TOOLBAR_SUFFIX ('-local' writes a separate json)
 *
 * Writes evidence/toolbar-verification[-suffix].json + toolbar-*.png
 */

process.env.TZ = 'America/Toronto';

const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.TOOLBAR_BASE_URL || 'http://127.0.0.1:3100/';
const CHROMIUM = process.env.TOOLBAR_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.TOOLBAR_SUFFIX || '';
const FIXTURE =
  process.env.TOOLBAR_XML ||
  path.resolve(__dirname, '../webapp/tests/fixtures/green-button-alliance-sample.xml');
const OUT = __dirname;

/**
 * Default: the widths the acceptance names — 1440, the 1024-1366 band, and
 * the 390 phone. TOOLBAR_WIDTHS overrides the list for an ad-hoc sweep.
 */
const WIDTHS = (process.env.TOOLBAR_WIDTHS || '1440,1366,1024,390').split(',').map((w) => {
  const width = Number(w);
  return { width, height: width < 640 ? 844 : 900, band: width < 640 ? 'mobile' : 'desktop' };
});

/**
 * Budgets. The bug measured ~640x175 = 112,000 px² of nothing inside the
 * card; a healthy toolbar leaves only the small notches around buttons.
 */
const MAX_VOID_AREA = { desktop: 45_000, mobile: 20_000 };
/** Every top-level row must span at least this share of the card's width. */
const MIN_ROW_FILL = 0.72;
/** Share of the card's content box that must be painted control, not white. */
const MIN_COVERAGE = { desktop: 0.55, mobile: 0.45 };

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail === undefined ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const r1 = (n) => Math.round(n * 10) / 10;

async function launch() {
  return chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

/** Fresh profile → upload the alliance fixture → totals strip on screen. */
async function openLoaded(browser, viewport) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"][accept=".xml"]').setInputFiles(FIXTURE);
  const loaded = await page.getByTestId('totals-strip').waitFor({ timeout: 60_000 }).then(() => true, () => false);
  if (!loaded) throw new Error('upload never produced a totals strip');
  return { ctx, page };
}

/**
 * In-page geometry: content box of the toolbar, every top-level cluster,
 * per-row grouping, and the largest empty rectangle inside the content box.
 * Empty = not covered by ANY descendant element box (sampled at STEP px).
 */
async function measureToolbar(page) {
  return page.evaluate(() => {
    const STEP = 4;
    const toolbar = document.querySelector('[data-testid="plan-switcher"]')?.closest('.no-print');
    if (!toolbar) return { error: 'toolbar not found' };

    const cardRect = toolbar.getBoundingClientRect();
    const cs = getComputedStyle(toolbar);
    const padL = parseFloat(cs.paddingLeft);
    const padR = parseFloat(cs.paddingRight);
    const padT = parseFloat(cs.paddingTop);
    const padB = parseFloat(cs.paddingBottom);
    const inner = {
      x: cardRect.left + padL,
      y: cardRect.top + padT,
      w: cardRect.width - padL - padR,
      h: cardRect.height - padT - padB,
    };

    /* --- top-level clusters, grouped into visual rows by y overlap ----- */
    const kids = [...toolbar.children]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el, i) => {
        const r = el.getBoundingClientRect();
        return { i, x: r.left, y: r.top, w: r.width, h: r.height, text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 48) };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);

    const rows = [];
    for (const k of kids) {
      const row = rows.find((r) => k.y < r.y + r.h - 1 && k.y + k.h > r.y + 1);
      if (row) {
        row.kids.push(k);
        row.y = Math.min(row.y, k.y);
        row.h = Math.max(row.h, k.y + k.h - row.y);
        row.x = Math.min(row.x, k.x);
        row.w = Math.max(row.x + row.w, k.x + k.w) - row.x;
      } else {
        rows.push({ y: k.y, h: k.h, x: k.x, w: k.w, kids: [k] });
      }
    }
    rows.sort((a, b) => a.y - b.y);
    for (const row of rows) {
      const xs = row.kids.map((k) => k.x).sort((a, b) => a - b);
      row.x = Math.min(...xs);
      row.right = Math.max(...row.kids.map((k) => k.x + k.w));
      row.w = row.right - row.x;
    }

    /* --- occupancy grid over the content box --------------------------
     * "Covered" means PAINTED, not merely boxed: a transparent flex wrapper
     * (a w-full row) is white card showing through exactly as the card is,
     * so counting it would let a right-aligned orphan row pass as full.
     * An element covers where it draws — a background, a border, replaced
     * content, or its own text. */
    const REPLACED = new Set(['SVG', 'IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED']);
    const paints = (el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      const bg = s.backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return true;
      if (s.backgroundImage && s.backgroundImage !== 'none') return true;
      const bw =
        parseFloat(s.borderTopWidth) + parseFloat(s.borderRightWidth) +
        parseFloat(s.borderBottomWidth) + parseFloat(s.borderLeftWidth);
      if (bw > 0 && s.borderTopStyle !== 'none') return true;
      if (REPLACED.has(el.tagName)) return true;
      return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    };

    const cols = Math.max(1, Math.ceil(inner.w / STEP));
    const rowsN = Math.max(1, Math.ceil(inner.h / STEP));
    const grid = new Uint8Array(cols * rowsN);
    const rects = [...toolbar.querySelectorAll('*')].filter(paints).map((el) => el.getBoundingClientRect());
    let painted = 0;

    for (const r of rects) {
      const x0 = Math.max(0, Math.floor((r.left - inner.x) / STEP));
      const x1 = Math.min(cols - 1, Math.ceil((r.right - inner.x) / STEP));
      const y0 = Math.max(0, Math.floor((r.top - inner.y) / STEP));
      const y1 = Math.min(rowsN - 1, Math.ceil((r.bottom - inner.y) / STEP));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * cols + x] = 1;
    }
    for (let i = 0; i < grid.length; i++) painted += grid[i];
    const coverage = painted / grid.length;

    /* largest rectangle of zeros (classic histogram sweep) */
    const heights = new Int32Array(cols);
    let best = { area: 0, w: 0, h: 0, x: 0, y: 0 };
    for (let y = 0; y < rowsN; y++) {
      for (let x = 0; x < cols; x++) heights[x] = grid[y * cols + x] ? 0 : heights[x] + 1;
      const stack = [];
      for (let x = 0; x <= cols; x++) {
        const h = x === cols ? 0 : heights[x];
        let start = x;
        while (stack.length && stack[stack.length - 1].h >= h) {
          const pop = stack.pop();
          const area = pop.h * (x - pop.start);
          if (area > best.area) best = { area, w: (x - pop.start) * STEP, h: pop.h * STEP, x: inner.x + pop.start * STEP, y: inner.y + (y - pop.h + 1) * STEP };
          start = pop.start;
        }
        stack.push({ h, start });
      }
    }

    const pageOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;

    return {
      card: { x: cardRect.left, y: cardRect.top, w: cardRect.width, h: cardRect.height },
      inner: { x: inner.x, y: inner.y, w: inner.w, h: inner.h },
      rows: rows.map((r) => ({
        y: Math.round(r.y),
        h: Math.round(r.h),
        x: Math.round(r.x),
        w: Math.round(r.w),
        fill: r.w / inner.w,
        kids: r.kids.map((k) => ({ t: k.text, x: Math.round(k.x), w: Math.round(k.w) })),
      })),
      void: { area: best.area * STEP * STEP, w: best.w, h: best.h, x: Math.round(best.x), y: Math.round(best.y) },
      coverage,
      toolbarScroll: toolbar.scrollWidth - toolbar.clientWidth,
      pageOverflow,
    };
  });
}

async function run(browser, { width, height, band }) {
  const label = `${width}px`;
  const { ctx, page } = await openLoaded(browser, { width, height });
  try {
    const m = await measureToolbar(page);
    if (m.error) {
      check(`${label}: toolbar present`, false, m.error);
      return;
    }
    check(`${label}: toolbar present`, true, `${Math.round(m.card.w)}x${Math.round(m.card.h)} at y=${Math.round(m.card.y)}`);

    check(
      `${label}: largest dead band ≤ ${MAX_VOID_AREA[band]}px²`,
      m.void.area <= MAX_VOID_AREA[band],
      `${m.void.w}x${m.void.h} = ${Math.round(m.void.area)}px² at (${m.void.x},${m.void.y})`,
    );

    const fills = m.rows.map((r) => r.fill);
    check(
      `${label}: every toolbar row fills ≥${Math.round(MIN_ROW_FILL * 100)}% of the card`,
      fills.every((f) => f >= MIN_ROW_FILL),
      m.rows.map((r, i) => `row${i + 1} ${Math.round(r.w)}/${Math.round(m.inner.w)} (${Math.round(fills[i] * 100)}%)`).join(' · '),
    );

    check(
      `${label}: ≥${Math.round(MIN_COVERAGE[band] * 100)}% of the card's face is painted controls`,
      m.coverage >= MIN_COVERAGE[band],
      `${Math.round(m.coverage * 100)}%`,
    );

    check(
      `${label}: no horizontal page overflow`,
      m.pageOverflow <= 1,
      `${m.pageOverflow}px`,
    );
    check(
      `${label}: the toolbar itself does not scroll sideways`,
      m.toolbarScroll <= 1,
      `${m.toolbarScroll}px`,
    );

    const shot = path.join(OUT, `toolbar-${width}.png`);
    await page.locator('[data-testid="plan-switcher"]').locator('xpath=ancestor::*[contains(@class,"no-print")][1]').screenshot({ path: shot });
    console.log(`      rows: ${m.rows.map((r) => `${Math.round(r.w)}x${r.h}@${r.y}`).join(' | ')} · card ${Math.round(m.card.w)}x${Math.round(m.card.h)} · painted ${Math.round(m.coverage * 100)}%`);

    return m;
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture not found: ${FIXTURE}`);
    process.exit(2);
  }
  console.log(`base ${BASE} · fixture ${path.basename(FIXTURE)}`);

  const browser = await launch();
  const layouts = {};
  try {
    for (const w of WIDTHS) layouts[w.width] = (await run(browser, w)) || null;
  } finally {
    await browser.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const summary = {
    wave: 'toolbar',
    base: BASE,
    fixture: path.basename(FIXTURE),
    at: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
    layouts,
  };
  const file = path.join(OUT, `toolbar-verification${SUFFIX}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${checks.length} checks passed → evidence/${path.basename(file)}`);
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
