/**
 * Dark mode — the a11y contrast budget, measured on the PAINTED page
 * (spec §2 #10).
 *
 * `src/lib/darkMode.test.ts` walks the TOKEN layer: it proves every declared
 * pairing clears its floor. It cannot prove the app actually uses the tokens
 * — one unconverted `text-ink` on a fixed slab, one inherited colour, one
 * chart label and the budget is spent while every token test stays green.
 * That is exactly how twelve sites shipped on the first dark build
 * (OverviewPanel's emerald/red/yellow chips: near-white `--ink` on slabs
 * that do not flip, 1.4–2.8:1).
 *
 * So this gate reads COMPUTED styles off the real production build, walks
 * every visible text node's effective background (alpha-composited up the
 * ancestor chain) and applies WCAG 2.1 to what the user actually sees.
 *
 * Two browser details that make the measurement honest:
 *
 *   1. Tailwind v4 serialises its palette as `lab(...)`/`oklch(...)`, not
 *      `rgb(...)`. A regex that only understands rgb() silently fails to
 *      read a chip's own background and walks UP to the card behind it —
 *      which reports black-on-yellow (13.7:1) as black-on-card (1.18:1).
 *      Every colour is therefore normalised through a 1x1 canvas, which
 *      returns the sRGB pixel that is really on screen.
 *   2. The background is the first painted ancestor, composited through
 *      translucent layers (the dark validation panel is 35% red over the
 *      card). Measuring the raw alpha as if it were opaque under-reports
 *      the ratio by ~2:1.
 *
 * THE SEED IS PART OF THE GATE (t_fbf590fa). This walk used to upload the
 * small Green Button sample, which never opens `projection.ready` — so
 * BillProjectionBanner, a data-gated card, simply was not in the DOM while the
 * walk declared "0 failures in dark" over a page the defect lived on. It now
 * loads the Mark-shaped dashboard (mark-seed.ts): 24 bills + readings into the
 * current month. The seed is ASSERTED below, so a future edit that stops
 * rendering a gated card fails here instead of quietly shrinking the budget.
 *
 * Runs in CI inside the smoke job's `npx playwright test` step.
 * Locally: SMOKE_BASE_URL=http://localhost:3111 npx playwright test theme-contrast
 */

import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { seedMarkShaped, seedMarkShapedWithTemps } from './mark-seed';

const TABS = ['overview', 'usage', 'plans', 'money'] as const;

type Finding = {
  ratio: number;
  need: number;
  px: number;
  color: string;
  bg: string;
  cls: string;
  text: string;
  /** The PANEL the node is painted in — see `panelOf` in the walk below. */
  panel: string;
};

/**
 * One theme's measurement.
 *
 * `findings` is the debt; `measured` is the COVERAGE — how many text nodes the
 * walk actually read in each panel. A budget that only counts failures cannot
 * tell "every panel is clean" from "the panel was not on the page", which is
 * the gate hole this suite has closed twice already (t_fbf590fa: a data-gated
 * card absent from the DOM, the walk reporting 0 failures over the very page
 * the defect lived on). Both numbers are therefore returned, and coverage is
 * asserted alongside the budget.
 */
type WalkResult = {
  findings: Finding[];
  measured: Record<string, number>;
};

/** Load the Mark-shaped dashboard in the given theme. */
async function loadFixture(page: Page, theme: 'light' | 'dark') {
  await page.context().addInitScript((t) => localStorage.setItem('theme', t), theme);
  await seedMarkShaped(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // THE SEED CHECK. `data-state="ready"` is the assertion that matters: the
  // testid exists in the gated branch too, so waiting for the element alone
  // would let this walk go back to measuring a page without the banner on it.
  await expect(page.getByTestId('bill-projection')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
}

/**
 * Runs IN the page. Returns every visible text node whose effective
 * foreground/background pairing is under its AA floor.
 */
function contrastWalk(panelRoots: string[]) {
  const lum = ([r, g, b]: number[]) => {
    const f = (c: number) => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  /** Any CSS colour string → the sRGB pixel Chrome paints for it. */
  const toRgb = (color: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const parse = (s: string | null): [number, number, number, number] | null => {
    if (!s || s === 'transparent') return null;
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?/.exec(s);
    if (!m) return toRgb(s);
    const a =
      m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  };
  const over = (
    fg: [number, number, number, number],
    bg: [number, number, number, number],
  ): [number, number, number, number] => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  /** First painted ancestor, composited through any translucent layers. */
  const bgOf = (el: Element | null): [number, number, number, number] => {
    let n: Element | null = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) {
        if (c[3] >= 1) return c;
        return over(c, bgOf(n.parentElement));
      }
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
  };

  /**
   * WHICH PANEL a node belongs to — the axis the budget is applied on.
   *
   * A single global "0 failures" number hides WHERE the failure is, and this
   * suite's whole defect class (a themed ink on a slab that does not flip with
   * the theme) is always a defect of ONE panel.
   *
   * PANEL_ROOTS is the DECLARED list of card/panel testids, passed into the
   * page from here so the in-page walk and the assertion below cannot drift
   * apart. Two rules of evidence shaped that list:
   *
   *   - "nearest testid ancestor" is not a panel: this page carries 372
   *     distinct testids, most of them per-row (`money-row`, `bill-line-*`,
   *     `shift-block-*`), and a budget with 372 entries is a list of rows.
   *   - "occurs exactly once in the document" does not separate cards from
   *     rows either — `switch-row-2025-10-01`, `hindsight-period-2026-01-01`
   *     and the `*-pick-*` testids are date-stamped, so every row is unique.
   *
   * So the panels are declared, and the attribution is: nearest declared root,
   * else the enclosing tab panel, else `chrome`. A node that belongs to no
   * declared panel is still measured — it lands in its tab's bucket, which is
   * a real budget — and `PANEL_COVERAGE` below asserts every declared panel is
   * actually present in BOTH themes, so a renamed/removed panel fails the gate
   * instead of silently shrinking it. A NEW card is simply unattributed to
   * itself until someone adds it here, which is the one manual step a budget
   * is allowed to have.
   */
  const rootSet = new Set(panelRoots);
  const panelOf = (el: Element): string => {
    let n: Element | null = el;
    let tabRoot: string | null = null;
    while (n && n !== document.documentElement) {
      const id = n.getAttribute('data-testid');
      if (id) {
        if (rootSet.has(id)) return id;
        if (!tabRoot && id.startsWith('tab-panel-')) tabRoot = id;
      }
      n = n.parentElement;
    }
    return tabRoot ?? 'chrome';
  };

  const out: Finding[] = [];
  /** Text nodes MEASURED per panel — the coverage half of the budget. */
  const measured: Record<string, number> = {};
  const seen = new Set<string>();
  for (const el of document.querySelectorAll('body *')) {
    if (!el.firstChild || el.firstChild.nodeType !== Node.TEXT_NODE) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.3) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (el.closest('.sr-only')) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const panel = panelOf(el);
    measured[panel] = (measured[panel] ?? 0) + 1;
    const bg = bgOf(el);
    const px = Math.round(parseFloat(cs.fontSize));
    const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    const need = large ? 3 : 4.5;
    const cr = ratio(over(fg, bg), bg);
    if (cr < need) {
      // Deduped by (colours, text) as before — the panel is ATTRIBUTION, not
      // part of the key, so one defect repeated down a table is still one
      // finding and the counts in the messages stay comparable run to run.
      const key = `${cs.color}|${bg.slice(0, 3).join(',')}|${text.slice(0, 24)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ratio: +cr.toFixed(2),
        need,
        px,
        color: cs.color,
        bg: `rgb(${bg
          .slice(0, 3)
          .map(Math.round)
          .join(', ')})`,
        cls: (el.className || '').toString().slice(0, 80),
        text: text.slice(0, 70),
        panel,
      });
    }
  }
  return { findings: out.sort((a, b) => a.ratio - b.ratio), measured };
}

/** Walk every tab: a budget that only checks the default tab is not a budget. */
async function walkAllTabs(page: Page): Promise<WalkResult> {
  const findings: Finding[] = [];
  const measured: Record<string, number> = {};
  for (const tab of TABS) {
    const btn = page.getByTestId(`tab-${tab}`);
    if ((await btn.count()) === 0) continue;
    await btn.click();
    await page.waitForTimeout(1000);
    const walk = (await page.evaluate(contrastWalk, PANEL_ROOTS)) as WalkResult;
    findings.push(...walk.findings.map((r) => ({ ...r, cls: `[${tab}] ${r.cls}` })));
    for (const [panel, count] of Object.entries(walk.measured)) {
      measured[panel] = (measured[panel] ?? 0) + count;
    }
  }
  return { findings, measured };
}

/** The debt grouped by the panel that owes it. */
const byPanel = (rows: Finding[]): Record<string, Finding[]> => {
  const map: Record<string, Finding[]> = {};
  for (const r of rows) (map[r.panel] ??= []).push(r);
  return map;
};

const fmt = (rows: Finding[]) =>
  rows.map((r) => `${r.ratio}:1 (need ${r.need}) ${r.px}px ${r.color} on ${r.bg} "${r.text}" — ${r.cls}`).join('\n');

/**
 * The ledger is keyed by (panel, colours) — see `ledgerKeyOf` below. The old
 * pair-only key is gone on purpose: it let the same colours pass anywhere on
 * the page once they had been pinned in one card.
 */

/**
 * THE PINNED DEBT LEDGER (t_fbf590fa).
 *
 * Seeding the walk with the Mark-shaped dashboard — the fix for the gate hole
 * where a data-gated card was never in the DOM — immediately exposed this: 52
 * painted pairings under AA in dark and 10 in light, on the fixed light-soft
 * slabs (`bg-yellow-400`'s #fdc700, the amber-200 note strip, emerald-50,
 * blue-50, yellow-50) that do NOT flip with the theme while their ink does.
 *
 * Those are NOT this card's defects: the card is the thermometer ramp plus
 * three named pairings, and every one of the 62 is a slab that predates it
 * (the same page measured them before this diff). Fixing them changes LIGHT
 * too (the light leg of the ledger is `--ink-3` at 3.0–4.4:1 on the same
 * slabs), so it needs its own colour call and Mark's sign-off — filed as a
 * follow-up card, assigned to @designer, rather than half-fixed here.
 *
 * They are therefore PINNED, by (foreground, background) pair and not by
 * count, so that:
 *   - the hole stays closed (the walk renders the whole Mark-shaped app),
 *   - a NEW pairing on top of them still fails this gate, and
 *   - the debt is enumerated in the repo instead of living in a comment.
 * The ledger may only SHRINK: when a pair is fixed, delete its row. A row that
 * stops matching is not an error (the seed's numbers move month to month), so
 * the check is one-sided on purpose.
 *
 * THE DARK LEDGER IS NOW EMPTY (t_3e571ddb). @designer's colour call on
 * t_3ccf52af answered all 13 dark pairs at once, and this diff applied it:
 *   - the fixed accent slab (`bg-yellow-400`) and the verdict chips
 *     (`bg-emerald-400` / `bg-red-400`) pin their own ink (`text-accent-ink`,
 *     #000 both themes) instead of inheriting a themed one;
 *   - the pastel slabs moved onto tokens with a dark de-escalation
 *     (`--warn-strip`, `--good-soft`, `--good-soft-2`, `--info-soft`), their
 *     LIGHT values byte-identical to the literals they replaced;
 *   - the year-over-year hues became `--data-year-1..4`, where only year-1
 *     lifts in dark (3.45 → 4.85:1).
 * The DARK walk below therefore asserts ZERO painted pairings under AA — no
 * ledger, no carve-out. LIGHT is not there yet: its seven pairs are the light
 * leg of the same call (L1–L4), which changes LIGHT rendering and is gated on
 * Mark's sign-off, so LIGHT_PINNED_DEBT still stands (and still may only
 * shrink).
 */
/**
 * The ledger below keeps t_fbf590fa's rows, and adds the PANEL each one was
 * measured in. The reasoning above (why they are pinned, why they may only
 * shrink, why fixing them moves LIGHT) is unchanged.
 */
const LIGHT_PINNED_DEBT = [
  // The LIGHT leg of the same colour call. Five pairs left: L1 (--ink-3/--ink-4
  // darkened) and L3 (legend text to --ink-2) release them, and both change
  // LIGHT rendering, so they wait on Mark's sign-off.
  // (The seventh row — `--ink-3` on the fixed `#fdc700` accent slab at
  // 3.02:1 — was released by family A/L2 in Phase 1: every ink step on that
  // slab is now text-accent-ink, #000 in both themes, 13.35:1.)
  { panel: 'ev-scenario', color: 'rgb(100, 116, 139)', bg: 'rgb(208, 250, 229)' }, // --ink-3 on emerald-100
  { panel: 'bill-accrual', color: 'rgb(100, 116, 139)', bg: 'rgb(239, 246, 255)' }, // --ink-3 on blue-50
  { panel: 'totals-strip', color: 'rgb(100, 116, 139)', bg: 'rgb(241, 245, 249)' }, // --ink-3 on slate-100
  { panel: 'actual-bill', color: 'rgb(148, 163, 184)', bg: 'rgb(236, 253, 245)' }, // --ink-4 on emerald-50
  { panel: 'money-deltas', color: 'rgb(148, 163, 184)', bg: 'rgb(254, 252, 232)' }, // --ink-4 on yellow-50
  { panel: 'trend-panel', color: 'rgb(249, 115, 22)', bg: 'rgb(255, 255, 255)' }, // recharts legend orange-500
];

/**
 * The ledger key is (panels, colours) — NOT just the colours.
 *
 * That is the one thing this file adds to t_fbf590fa's ledger, and it can only
 * tighten the gate: the same foreground on the same background, showing up in
 * a panel where it was never measured, is a new pairing and fails. It also
 * means the failure message says which card owes the debt, instead of "some
 * ink is under AA somewhere".
 */
const ledgerKeyOf = (r: { panel: string; color: string; bg: string }) =>
  `${r.panel}|${r.color}|${r.bg}`;

const pinnedKeys = (ledger: { panel: string; color: string; bg: string }[]) =>
  new Set(ledger.map(ledgerKeyOf));

/** One log line per pinned pair that is still on the page — the debt, visible. */
const logPinned = (rows: Finding[], keys: Set<string>) => {
  const hit = rows.filter((r) => keys.has(ledgerKeyOf(r)));
  if (hit.length) {
    const worst = hit.reduce((a, b) => (a.ratio < b.ratio ? a : b));
    console.log(
      `pinned pre-existing debt: ${hit.length} pairing(s) under AA across ${new Set(hit.map(ledgerKeyOf)).size} (panel,fg,bg) triple(s); worst ${worst.ratio}:1 (${worst.color} on ${worst.bg} in ${worst.panel})`,
    );
  }
};

/* ==========================================================================
 * THE PER-PANEL BUDGET (both themes)
 * ==========================================================================
 *
 * The walk above used to answer one global question — "is anything under AA
 * anywhere?" — and that shape is why this suite kept re-finding the same class
 * of defect (t_fbf590fa, t_3e571ddb). Two things were missing, and both are
 * asserted from here on:
 *
 *   1. COVERAGE. A clean budget over a page whose cards are not in the DOM is
 *      not a clean budget; it is an UNMEASURED page (the seed hole). `measured`
 *      counts the text nodes actually read per panel, and PANEL_COVERAGE names
 *      the panels that MUST appear in both passes. A seed change or a rename
 *      that drops a panel fails here, by name, instead of quietly shrinking
 *      the budget it was supposed to be measuring.
 *
 *   2. ATTRIBUTION. "0 failures" does not say WHERE, and this defect class is
 *      always a defect of one panel. Every finding carries its panel, so a
 *      failure names the card that owes it — and the light ledger below is a
 *      budget per panel rather than one flat list of colours.
 *
 * Neither change relaxes anything: DARK still asserts zero under AA in every
 * panel, and LIGHT still allows only the enumerated pins.
 */

/**
 * The DECLARED panels: the card testids the walk attributes ink to, and the
 * list PANEL_COVERAGE asserts were actually measured. Hand-kept on purpose —
 * a budget is a declared allowance per surface — and kept honest by the
 * coverage assertion: a panel that stops rendering (or gets renamed) fails the
 * gate by name, so the list cannot quietly rot into a smaller budget.
 *
 * These are the boards the dark-mode defects lived on: the overview strip and
 * its gated banner, the thermometer, the efficiency/trend charts, the plans
 * timeline and switch record, the whole money tab, and the EV/shift cards.
 */
const PANEL_ROOTS = [
  // overview
  'totals-strip',
  'bill-projection',
  'best-choice-banner',
  'temp-band-card',
  'efficiency-card',
  'efficiency-strip',
  'trend-panel',
  'active-plan-chip',
  'chart-area',
  'example-data-banner',
  'rate-assumptions-banner',
  // plans
  'plan-switcher',
  'plan-timeline',
  'switch-track-record',
  'shift-optimizer',
  'shift-verification',
  // money
  'money-section',
  'actual-bill',
  'true-bill',
  'true-bill-vs-actual',
  'money-stacked',
  'money-deltas',
  'money-hour-histogram',
  'money-waterfall',
  'bill-accrual',
  'bill-estimate',
  'open-period',
  'hindsight-panel',
  // usage
  'ev-scenario',
];

/**
 * Every bucket that must be measured in BOTH themes.
 *
 * The walk can also emit five FALLBACK buckets — `chrome` (the toolbar/tab
 * strip, which holds the theme control) and the four `tab-panel-*` bodies —
 * for text that belongs to no declared card. The tab bodies are deliberately
 * NOT required: a tab whose text is entirely inside declared cards legitimately
 * has an empty bucket (measured: overview and money do). `chrome` IS required:
 * a walk that stops seeing it has stopped seeing the page.
 */
const PANEL_COVERAGE = ['chrome', ...PANEL_ROOTS];

/** Panels the walk must have found but did not — the coverage failure. */
const missingPanels = (measured: Record<string, number>) =>
  PANEL_COVERAGE.filter((p) => (measured[p] ?? 0) === 0);

/** One line per theme: the budget as measured, and where it stands. */
const logBudget = (theme: string, walk: WalkResult) => {
  const panels = Object.keys(walk.measured).length;
  const nodes = Object.values(walk.measured).reduce((a, b) => a + b, 0);
  const over = Object.entries(byPanel(walk.findings))
    .map(([panel, rows]) => `${panel}: ${rows.length}`)
    .join(', ');
  console.log(
    `panel budget [${theme}]: ${panels} panels / ${nodes} text nodes measured; ` +
      `${walk.findings.length} pairing(s) under AA${over ? ` — ${over}` : ''}`,
  );
};

/** Findings printed panel by panel — a failure has to name the card. */
const fmtByPanel = (rows: Finding[]) =>
  Object.entries(byPanel(rows))
    .map(([panel, rs]) => `${panel}:\n${fmt(rs)}`)
    .join('\n');

/**
 * The evidence dump — the same numbers the assertions use, on disk.
 *
 * Gated on an env var because only the local gate (`scripts/e2e-theme-
 * regression.sh`) wants the file: a container/CI run has no tracked workspace
 * to write into, and rewriting a tracked file on every run is noise.
 */
const EVIDENCE_JSON = process.env.THEME_EVIDENCE_JSON;

function writeEvidence(theme: string, walk: WalkResult) {
  if (!EVIDENCE_JSON) return;
  // READ-MODIFY-WRITE on purpose: Playwright restarts the worker after a
  // failing test, so the two themes can be measured in two processes and an
  // in-memory accumulator would silently drop the first one's numbers. The
  // file is deleted by the runner before the suite starts.
  let doc: {
    note?: string;
    panels?: string[];
    themes?: Record<string, { measured: Record<string, number>; findings: Finding[] }>;
  } = {};
  try {
    doc = JSON.parse(fs.readFileSync(EVIDENCE_JSON, 'utf8'));
  } catch {
    doc = {};
  }
  doc.note =
    'Per-panel dark-mode contrast budget, measured on the painted page (theme-contrast.spec.ts).';
  doc.panels = PANEL_COVERAGE;
  doc.themes = { ...(doc.themes ?? {}), [theme]: { measured: walk.measured, findings: walk.findings } };
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(doc, null, 2) + '\n');
}

test.describe('dark mode contrast walk (spec §2 #10)', () => {
  test('DARK: nothing paints under AA in ANY panel — no pinned debt left', async ({ page }) => {
    test.setTimeout(180_000);
    await loadFixture(page, 'dark');
    const walk = await walkAllTabs(page);
    logBudget('dark', walk);
    writeEvidence('dark', walk);

    expect(
      missingPanels(walk.measured),
      `the dark walk did not measure every panel — a clean budget over an unrendered panel is not a clean budget. Text nodes per panel: ${JSON.stringify(walk.measured)}`,
    ).toEqual([]);

    const over = Object.entries(byPanel(walk.findings)).map(
      ([panel, rs]) => `${panel} (${rs.length} pairing(s)):\n${fmt(rs)}`,
    );
    expect(
      over,
      `DARK painted ${walk.findings.length} pairing(s) under AA across ${over.length} panel(s) — the ledger is empty (t_3e571ddb released all 13 rows):\n${over.join('\n')}`,
    ).toEqual([]);
  });

  test('LIGHT: the only pairings under AA are the pinned ones (ink-4 + slab debt)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loadFixture(page, 'light');
    const walk = await walkAllTabs(page);
    logBudget('light', walk);
    writeEvidence('light', walk);

    expect(
      missingPanels(walk.measured),
      `the light walk did not measure every panel — text nodes per panel: ${JSON.stringify(walk.measured)}`,
    ).toEqual([]);

    const rows = walk.findings;

    // `--ink-4` is slate-400 in LIGHT: 2.56:1 on the card at 8–10px, across
    // 56 micro-label sites. Dark mode did not create it and this card does
    // not fix it (spec §2 #4 scopes it out and recommends its own card) —
    // but it IS pinned here, so the defect can only ever be this one, and a
    // new light-mode pairing has to clear AA instead of hiding behind it.
    //
    // This one allowance is deliberately PANEL-AGNOSTIC, unlike the ledger:
    // it is a defect of a TOKEN (`--ink-4` on a card or the page), measured in
    // a dozen different panels, and pinning it per panel would mean carrying
    // ~17 rows of the same token. It is capped by the ratio floor below, which
    // is what stops it from quietly getting worse.
    const ink4 = rows.filter(
      (r) => r.color === 'rgb(148, 163, 184)' && (r.bg === 'rgb(255, 255, 255)' || r.bg === 'rgb(248, 250, 252)'),
    );
    const keys = pinnedKeys(LIGHT_PINNED_DEBT);
    logPinned(rows, keys);

    const unexpected = rows.filter((r) => !ink4.includes(r) && !keys.has(ledgerKeyOf(r)));
    expect(
      unexpected,
      `LIGHT mode painted ${unexpected.length} NEW (panel, fg, bg) pairing(s) under AA — the ledger is per panel, so "the same colours somewhere else" is a new pairing:\n${fmtByPanel(unexpected)}`,
    ).toEqual([]);
    // The ink-4 set is capped by TOKEN, not by count: the worst of it is
    // pinned at the number the spec measured (2.45:1 on the page) so it can
    // neither quietly widen nor quietly get "fixed" downwards in dark.
    expect(
      Math.min(...ink4.map((r) => r.ratio)),
      'the ink-4 defect must not get WORSE than the 2.45:1 the spec measured',
    ).toBeGreaterThanOrEqual(2.4);

    // The budget, panel by panel — in the run log, so the debt is a set of
    // named allowances and not one aggregate number.
    const perPanel = Object.entries(byPanel(rows))
      .map(([panel, rs]) => {
        const pinned = rs.filter((r) => ink4.includes(r) || keys.has(ledgerKeyOf(r))).length;
        return `${panel}: ${rs.length} under AA (${pinned} pinned)`;
      })
      .join('\n  ');
    console.log(`LIGHT budget by panel:\n  ${perPanel}`);
  });
});

/**
 * The pairings THIS card fixes, asserted on the page it actually renders on.
 * They are data-gated, which is why they were invisible before: the seed is
 * what puts BillProjectionBanner in the DOM (loadFixture asserts
 * `data-state="ready"`, so a seed change cannot silently hollow this out).
 */
test.describe('BillProjectionBanner dark-mode pairings (t_fbf590fa addendum 1)', () => {
  test('DARK: the two mini-card boxes and the flood caption clear AA', async ({ page }) => {
    test.setTimeout(180_000);
    await loadFixture(page, 'dark');
    const m = await page.evaluate(() => {
      const lum = ([r, g, b]: number[]) => {
        const f = (c: number) => {
          c /= 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const toRgb = (color: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]] as [number, number, number];
      };
      const parse = (s: string | null): [number, number, number] | null => {
        if (!s || s === 'transparent') return null;
        const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?/.exec(s);
        if (!m) return toRgb(s);
        // A fully transparent background is NOT a surface: skipping this is
        // how a probe reports black-on-black for text on an emerald flood.
        const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return a === 0 ? null : [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
      };
      const bgOf = (el: Element | null): [number, number, number] => {
        let n: Element | null = el;
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c) return c;
          n = n.parentElement;
        }
        return [255, 255, 255];
      };
      const ratioOf = (el: Element) => {
        const fg = parse(getComputedStyle(el).color)!;
        const bg = bgOf(el);
        const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return {
          text: (el.textContent || '').trim().slice(0, 30),
          fg: `rgb(${fg.join(', ')})`,
          bg: `rgb(${bg.join(', ')})`,
          ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2),
        };
      };
      const banner = document.querySelector('[data-testid="bill-projection"]')!;
      const boxes = [...banner.querySelectorAll('.bg-card')].map(ratioOf);
      const caption = ratioOf(banner.querySelector('p')!);
      return { boxes, caption };
    });

    expect(m.boxes.length, 'both mini-cards render').toBe(2);
    for (const b of [...m.boxes, m.caption]) {
      expect(b.ratio, `"${b.text}" ${b.fg} on ${b.bg} = ${b.ratio}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // The defect these replaced: --accent-ink (#000) inherited onto --card.
    expect(m.boxes[0].fg, 'the cards use --ink, not the slab ink').not.toBe('rgb(0, 0, 0)');
  });
});

/**
 * The thermometer ramp (TempBandCard's 7 bar fills) is GRAPHICS, not text, so
 * the text walk above cannot see it — an unreadable bar is not a text node.
 *
 * It is also the one colour budget in the app whose meaning IS the colour: the
 * bars are the temperature axis, so "just pick two readable colours" (the
 * obvious fix) would flatten the cold→hot ramp and delete the reading. The
 * probe therefore measures the PAINTED fill of each bar against the surface it
 * is painted on, and the LIGHT test pins the seven rendered pixels to the
 * literals the component used to hardcode — the dark fix must cost light
 * exactly nothing.
 */
function rampProbe() {
  const lum = ([r, g, b]: number[]) => {
    const f = (c: number) => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const toRgb = (color: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const parse = (s: string | null): [number, number, number, number] | null => {
    if (!s || s === 'transparent' || s === 'none') return null;
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?/.exec(s);
    if (!m) return toRgb(s);
    const a =
      m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  };
  const over = (fg: number[], bg: number[]): [number, number, number, number] => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
  const bgOf = (el: Element | null): [number, number, number, number] => {
    let n: Element | null = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) return c[3] >= 1 ? c : over(c, bgOf(n.parentElement));
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
  };
  const rgb = (c: number[]) => `rgb(${c.slice(0, 3).map(Math.round).join(', ')})`;

  return [...document.querySelectorAll('[data-testid="temp-band-bar"]')].map((el) => {
    const fill = parse(getComputedStyle(el).fill);
    const bg = bgOf(el);
    if (!fill) return { band: el.getAttribute('data-band'), rgb: 'none', bg: rgb(bg), ratio: 0, hours: 0, h: 0 };
    const [hi, lo] = [lum(over(fill, bg)), lum(bg)].sort((x, y) => y - x);
    const r = el.getBoundingClientRect();
    return {
      band: el.getAttribute('data-band'),
      rgb: rgb(fill),
      bg: rgb(bg),
      ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2),
      hours: Number(el.getAttribute('data-hours')),
      h: +r.height.toFixed(1),
    };
  });
}

test.describe('thermometer ramp (TempBandCard, t_fbf590fa)', () => {
  test('DARK: every bar fill clears 3:1 on the card — and 4.5:1 for its in-bar label', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loadFixture(page, 'dark');
    const seeded = await seedMarkShapedWithTemps(page);
    expect(seeded.bands.length, `the seeded year must fill every band (got ${seeded.bands})`).toBe(7);

    const bars = await page.evaluate(rampProbe);
    expect(bars.length, 'seven bars render').toBe(7);
    const live = bars.filter((b) => b.hours > 0);
    expect(
      live.length,
      `every band needs hours for the ramp to be measured at all — got ${bars
        .map((b) => `${b.band}:${b.hours}`)
        .join(' ')}`,
    ).toBe(7);

    const fmt = (b: (typeof bars)[number]) =>
      `${b.band} ${b.rgb} on ${b.bg} = ${b.ratio}:1 (${b.hours}h)`;
    const under = live.filter((b) => b.ratio < 4.5);
    expect(
      under,
      `${under.length}/7 dark bar fills under the floor the ¢/kWh label needs:\n${under
        .map(fmt)
        .join('\n')}\n--- all seven ---\n${live.map(fmt).join('\n')}`,
    ).toEqual([]);
    // 3:1 is the graphics floor; the label is why this asserts 4.5:1.
    for (const b of live) expect(b.ratio, fmt(b)).toBeGreaterThanOrEqual(4.5);
  });

  test('LIGHT: the rendered fills are the seven literals the ramp replaced', async ({ page }) => {
    test.setTimeout(180_000);
    await loadFixture(page, 'light');
    await seedMarkShapedWithTemps(page);

    const bars = await page.evaluate(rampProbe);
    expect(bars.length, 'seven bars render').toBe(7);
    expect(
      bars.map((b) => b.rgb),
      'the light ramp is byte-identical to the hardcoded list (zero light regression)',
    ).toEqual([
      'rgb(29, 78, 216)', // #1d4ed8 blue-700
      'rgb(37, 99, 235)', // #2563eb blue-600
      'rgb(59, 130, 246)', // #3b82f6 blue-500
      'rgb(245, 158, 11)', // #f59e0b amber-500
      'rgb(249, 115, 22)', // #f97316 orange-500
      'rgb(239, 68, 68)', // #ef4444 red-500
      'rgb(185, 28, 28)', // #b91c1c red-700
    ]);
  });
});
