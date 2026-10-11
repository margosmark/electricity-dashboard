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
 * Runs in CI inside the smoke job's `npx playwright test` step.
 * Locally: SMOKE_BASE_URL=http://localhost:3111 npx playwright test theme-contrast
 */

import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const FIXTURE = path.resolve(__dirname, '../fixtures/green-button-alliance-sample.xml');
const TABS = ['overview', 'usage', 'plans', 'money'] as const;

type Finding = {
  ratio: number;
  need: number;
  px: number;
  color: string;
  bg: string;
  cls: string;
  text: string;
};

/** Load a real dashboard — an empty app has no charts, chips or verdicts. */
async function loadFixture(page: Page, theme: 'light' | 'dark') {
  await page.context().addInitScript((t) => localStorage.setItem('theme', t), theme);
  await page.goto('/');
  await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(FIXTURE);
  await expect(page.getByTestId('totals-strip')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Charts draw on their own frames; sample too early and half the DOM is
  // still a skeleton whose colours are not the ones under test.
  await page.waitForTimeout(1500);
}

/**
 * Runs IN the page. Returns every visible text node whose effective
 * foreground/background pairing is under its AA floor.
 */
function contrastWalk() {
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

  const out: Finding[] = [];
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
    const bg = bgOf(el);
    const px = Math.round(parseFloat(cs.fontSize));
    const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    const need = large ? 3 : 4.5;
    const cr = ratio(over(fg, bg), bg);
    if (cr < need) {
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
      });
    }
  }
  return out.sort((a, b) => a.ratio - b.ratio);
}

/** Walk every tab: a budget that only checks the default tab is not a budget. */
async function walkAllTabs(page: Page): Promise<Finding[]> {
  const all: Finding[] = [];
  for (const tab of TABS) {
    const btn = page.getByTestId(`tab-${tab}`);
    if ((await btn.count()) === 0) continue;
    await btn.click();
    await page.waitForTimeout(1000);
    const rows = await page.evaluate(contrastWalk);
    all.push(...rows.map((r) => ({ ...r, cls: `[${tab}] ${r.cls}` })));
  }
  return all;
}

const fmt = (rows: Finding[]) =>
  rows.map((r) => `${r.ratio}:1 (need ${r.need}) ${r.px}px ${r.color} on ${r.bg} "${r.text}" — ${r.cls}`).join('\n');

test.describe('dark mode contrast walk (spec §2 #10)', () => {
  test('DARK: every painted text pairing clears AA on all four tabs', async ({ page }) => {
    test.setTimeout(120_000);
    await loadFixture(page, 'dark');
    const rows = await walkAllTabs(page);
    expect(rows, `dark mode painted ${rows.length} pairing(s) under AA:\n${fmt(rows)}`).toEqual([]);
  });

  test('LIGHT: the only pairings under AA are the pre-existing ink-4 ones', async ({ page }) => {
    test.setTimeout(120_000);
    await loadFixture(page, 'light');
    const rows = await walkAllTabs(page);

    // `--ink-4` is slate-400 in LIGHT: 2.56:1 on the card at 8–10px, across
    // 56 micro-label sites. Dark mode did not create it and this card does
    // not fix it (spec §2 #4 scopes it out and recommends its own card) —
    // but it IS pinned here, so the defect can only ever be this one, and a
    // new light-mode pairing has to clear AA instead of hiding behind it.
    const allowed = rows.filter(
      (r) => r.color === 'rgb(148, 163, 184)' && (r.bg === 'rgb(255, 255, 255)' || r.bg === 'rgb(248, 250, 252)'),
    );
    const unexpected = rows.filter((r) => !allowed.includes(r));
    expect(unexpected, `LIGHT mode painted ${unexpected.length} NEW pairing(s) under AA:\n${fmt(unexpected)}`).toEqual([]);
    // The allowed set is capped by TOKEN, not by count: it is exactly the
    // --ink-4 micro-label defect the filter above names, and the worst of it
    // is pinned at the number the spec measured (2.45:1 on the page) so it
    // can neither quietly widen nor quietly get "fixed" downwards in dark.
    expect(
      Math.min(...allowed.map((r) => r.ratio)),
      'the ink-4 defect must not get WORSE than the 2.45:1 the spec measured',
    ).toBeGreaterThanOrEqual(2.4);
  });
});
