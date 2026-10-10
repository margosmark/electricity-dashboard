/**
 * Toolbar geometry — ONE definition of "the dead band", shared by the CI
 * regression gate (tests/e2e/toolbar-layout.spec.ts) and the evidence probe
 * that settled t_7f224ead (evidence/toolbar-verify.cjs). If the two measured
 * different pixels or held different budgets, the gate would prove nothing.
 *
 * `measureToolbarGeometry` runs IN THE PAGE: Playwright serializes the
 * function's own source, so its body may not reference anything outside
 * itself (no budgets, no helpers, no imports inlined from here).
 *
 * What it measures inside the toolbar card (the `.no-print` card that holds
 * the plan switcher):
 *
 *   1. the LARGEST axis-aligned empty rectangle inside the card's content
 *      box, sampled at 4px over every descendant box. Empty means "nothing
 *      PAINTS it": a transparent `w-full` flex wrapper is white card showing
 *      through exactly as the card is, so counting boxes instead of paint
 *      would let a right-aligned orphan row pass as a full row;
 *   2. every top-level cluster grouped into visual rows by y-overlap, each
 *      row's span as a share of the content width — a right-aligned orphan
 *      row (the original bug) shows up here as a row far below the fill
 *      budget even when its own gap is narrow;
 *   3. painted coverage of the card's face, page-level horizontal overflow
 *      and the toolbar's own sideways scroll.
 */
'use strict';

/**
 * Budgets. The bug this gate exists for measured ~640x175 = 112,640px² of
 * nothing inside the card at 1440 (55,440px² at 1024); a healthy toolbar
 * leaves only the small notches around buttons — ~20,000px² (the row gutter).
 */
const TOOLBAR_BUDGETS = {
  /** Largest allowed painted-empty rectangle inside the card's content box. */
  maxVoidArea: { desktop: 45_000, mobile: 20_000 },
  /** Every top-level row must span at least this share of the card's width. */
  minRowFill: 0.72,
  /** Share of the card's content box that must be painted control, not white. */
  minCoverage: { desktop: 0.55, mobile: 0.45 },
  maxPageOverflowPx: 1,
  maxToolbarOverflowPx: 1,
};

/** Below this viewport width the phone budgets apply. */
const MOBILE_BELOW = 640;

/** Which budget set a viewport width falls into. */
function bandFor(width) {
  return width < MOBILE_BELOW ? 'mobile' : 'desktop';
}

/**
 * The vw/vh sweep the CI gate runs.
 *
 * Every Tailwind breakpoint is probed at BOTH sides (±1px) — the dead band
 * was a breakpoint-shaped bug: two clusters that fit at 1920 could not fit in
 * the 1224px card at 1440, so `lg:` (1024) is the width that decides whether
 * row 2 wraps. Widths alone would miss a layout that only breaks on a short
 * viewport, so each interesting band also gets a short (700/768px) height
 * and the phone gets its own.
 */
const VIEWPORT_SWEEP = [
  { width: 390, height: 844 }, // phone
  { width: 639, height: 900 }, // just below sm
  { width: 640, height: 900 }, // sm
  { width: 767, height: 900 }, // just below md
  { width: 768, height: 900 }, // md
  { width: 939, height: 900 }, // just below the scope switch's own ~940 wrap
  { width: 940, height: 900 },
  { width: 1023, height: 900 }, // just below lg — one row still fits
  { width: 1024, height: 700 }, // lg, short laptop: the band the bug lived in
  { width: 1100, height: 900 },
  { width: 1279, height: 900 }, // just below xl
  { width: 1280, height: 700 }, // xl, short laptop
  { width: 1366, height: 768 }, // the common laptop
  { width: 1440, height: 900 }, // the width the void was measured at
  { width: 1920, height: 1080 }, // wide desktop: two clusters fit again
];

/**
 * In-page geometry of the toolbar card. Runs in the page (see header).
 * Returns `{ error }` if the card is not on screen at all.
 */
function measureToolbarGeometry() {
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
}

const r0 = (n) => Math.round(n * 10) / 10;

/**
 * Turn one measurement into the gate's checks. Names and details are shared
 * verbatim with the evidence probe so both report the same sentences.
 *
 * @param {string} label   viewport label, e.g. `1440px` or `1024x700`
 * @param {object} m       result of measureToolbarGeometry()
 * @param {'desktop'|'mobile'} band  budget set for this width
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
function toolbarChecks(label, m, band) {
  if (m.error) return [{ name: `${label}: toolbar present`, ok: false, detail: String(m.error) }];

  const voidBudget = TOOLBAR_BUDGETS.maxVoidArea[band];
  const coverageBudget = TOOLBAR_BUDGETS.minCoverage[band];
  const fills = m.rows.map((r) => r.fill);

  return [
    {
      name: `${label}: toolbar present`,
      ok: true,
      detail: `${Math.round(m.card.w)}x${Math.round(m.card.h)} at y=${Math.round(m.card.y)}`,
    },
    {
      name: `${label}: largest dead band ≤ ${voidBudget}px²`,
      ok: m.void.area <= voidBudget,
      detail: `${m.void.w}x${m.void.h} = ${Math.round(m.void.area)}px² at (${m.void.x},${m.void.y})`,
    },
    {
      name: `${label}: every toolbar row fills ≥${Math.round(TOOLBAR_BUDGETS.minRowFill * 100)}% of the card`,
      ok: fills.every((f) => f >= TOOLBAR_BUDGETS.minRowFill),
      detail: m.rows.map((r, i) => `row${i + 1} ${Math.round(r.w)}/${Math.round(m.inner.w)} (${Math.round(fills[i] * 100)}%)`).join(' · '),
    },
    {
      name: `${label}: ≥${Math.round(coverageBudget * 100)}% of the card's face is painted controls`,
      ok: m.coverage >= coverageBudget,
      detail: `${Math.round(m.coverage * 100)}%`,
    },
    {
      name: `${label}: no horizontal page overflow`,
      ok: m.pageOverflow <= TOOLBAR_BUDGETS.maxPageOverflowPx,
      detail: `${m.pageOverflow}px`,
    },
    {
      name: `${label}: the toolbar itself does not scroll sideways`,
      ok: m.toolbarScroll <= TOOLBAR_BUDGETS.maxToolbarOverflowPx,
      detail: `${m.toolbarScroll}px`,
    },
  ];
}

/** One-line moving number for a log or an evidence file. */
function layoutSummary(m) {
  if (m.error) return m.error;
  return (
    `rows ${m.rows.map((r) => `${Math.round(r.w)}x${r.h}@${r.y}`).join(' | ')} · ` +
    `card ${Math.round(m.card.w)}x${Math.round(m.card.h)} · ` +
    `void ${r0(m.void.area)}px² · painted ${Math.round(m.coverage * 100)}%`
  );
}

module.exports = {
  TOOLBAR_BUDGETS,
  MOBILE_BELOW,
  VIEWPORT_SWEEP,
  bandFor,
  measureToolbarGeometry,
  toolbarChecks,
  layoutSummary,
};
