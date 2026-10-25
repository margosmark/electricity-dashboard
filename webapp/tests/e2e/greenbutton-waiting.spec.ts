import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import en from '../../src/i18n/en.json';
import fr from '../../src/i18n/fr.json';

/**
 * The credential-waiting state + day-one connection journey (t_10f231ed).
 *
 * Wave K's connect flow is built but CANNOT complete: the utility has not
 * issued this deployment its credentials, which is where production sits
 * today. So the state a real visitor meets on day one is `unconfigured`,
 * and this spec gates what the brief promises about it:
 *
 *   1. REACHABLE — against a real, unconfigured server (the status endpoint
 *      is read first and must answer `configured:false`; the card is never
 *      faked by a stub), from a cold visit with empty storage, where the
 *      Link Data dialog auto-opens.
 *   2. EXPLAINED — headline/pending/works-today copy that matches the
 *      catalog for the locale on screen, no dead control, no error surface,
 *      and no configuration jargon (the technical reason lives server-side).
 *   3. JOURNEY — the three steps, in order, each matching the catalog.
 *   4. MEASURED — every text node in the card clears WCAG AA against the
 *      background it is really painted on, in BOTH themes. The walk is
 *      scoped to the card and counts what it measured, because a budget
 *      that only counts failures cannot tell "clean" from "not on the page".
 *   5. PICTURED — with GB_WAITING_SHOT_DIR set, an element shot of the card
 *      plus a full-dialog shot per locale×theme (the card's deliverable).
 *
 * Screenshots are opt-in through the env var so a normal gate run never
 * writes files into the repo.
 *
 * Runs against any origin the app is client-only, e.g.:
 *   SMOKE_BASE_URL=http://127.0.0.1:3210 GB_WAITING_SHOT_DIR=/tmp/shots \
 *     npx playwright test greenbutton-waiting
 */

const EN = en as Record<string, string>;
const FR = fr as Record<string, string>;

/** Where the deliverable screenshots land. Empty = assertions only. */
const SHOT_DIR = process.env.GB_WAITING_SHOT_DIR || '';

const COMBOS = [
  { locale: 'en', theme: 'light' },
  { locale: 'en', theme: 'dark' },
  { locale: 'fr', theme: 'light' },
  { locale: 'fr', theme: 'dark' },
] as const;

type Locale = (typeof COMBOS)[number]['locale'];
type Theme = (typeof COMBOS)[number]['theme'];

const WAITING_KEYS = [
  'gb.waiting.headline',
  'gb.waiting.pending',
  'gb.waiting.worksToday',
  'gb.journey.title',
] as const;

const STEPS = [
  { n: 1, keys: ['gb.journey.need.label', 'gb.journey.need.body'] },
  { n: 2, keys: ['gb.journey.do.label', 'gb.journey.do.body'] },
  { n: 3, keys: ['gb.journey.after.label', 'gb.journey.after.body'] },
] as const;

const catalog = (l: Locale) => (l === 'en' ? EN : FR);

/**
 * Cold visit: empty storage, stored locale + stored theme, so the boot
 * script and the i18n restore both take the SAME path a returning user does.
 */
async function boot(page: Page, locale: Locale, theme: Theme) {
  await page.addInitScript(
    ([l, th]) => {
      window.localStorage.setItem('oeo_locale', l);
      window.localStorage.setItem('theme', th);
    },
    [locale, theme],
  );
  await page.goto('/');
  // Fresh browser, no readings: the Link Data dialog opens itself.
  await expect(page.getByTestId('upload-modal')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('gb-unconfigured')).toBeVisible();
}

type Finding = {
  ratio: number;
  need: number;
  px: number;
  color: string;
  bg: string;
  text: string;
};

/**
 * WCAG 2.1 contrast over the card as PAINTED — copied from the discipline of
 * `theme-contrast.spec.ts`: Tailwind v4 serialises colours as lab()/oklch(),
 * so every colour goes through a 1x1 canvas and the background is the first
 * painted ancestor, alpha-composited up the chain. Scoped to one selector,
 * and it returns how many nodes it measured alongside the failures.
 */
async function contrastIn(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { findings: [{ ratio: 0, need: 0, px: 0, color: '', bg: '', text: `no ${sel}` }], measured: 0 };

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

    const findings: Array<Finding> = [];
    let measured = 0;
    for (const el of root.querySelectorAll('*')) {
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
      measured += 1;
      const bg = bgOf(el);
      const px = Math.round(parseFloat(cs.fontSize));
      const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      const need = large ? 3 : 4.5;
      const cr = ratio(over(fg, bg), bg);
      if (cr < need) {
        findings.push({
          ratio: +cr.toFixed(2),
          need,
          px,
          color: cs.color,
          bg: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`,
          text: text.slice(0, 70),
        });
      }
    }
    return { findings, measured };
  }, selector);
}

test.describe('Green Button credential-waiting state (day-one journey)', () => {
  for (const { locale, theme } of COMBOS) {
    test(`${locale}/${theme}: the waiting state is reachable, explained and measured`, async ({
      page,
    }) => {
      // 1. the state must be REAL: an unconfigured server, not a stub.
      const status = await (await page.request.get('/greenbutton/status')).json();
      expect(
        status.configured,
        'this gate only means something against a server the utility has NOT issued ' +
          'credentials for — if configured:true, the waiting state is not what this build shows',
      ).toBe(false);

      await boot(page, locale, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (locale === 'fr') await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

      const card = page.getByTestId('gb-unconfigured');
      const C = catalog(locale);

      // 2. it reads as a state, not as a failure.
      await expect(card).toHaveAttribute('data-gb-state', 'unconfigured');
      await expect(card.getByTestId('gb-waiting-headline')).toHaveText(C['gb.waiting.headline']);
      await expect(card.getByTestId('gb-waiting-pending')).toHaveText(C['gb.waiting.pending']);
      await expect(card.getByTestId('gb-waiting-works')).toHaveText(C['gb.waiting.worksToday']);
      await expect(card.getByTestId('gb-journey')).toContainText(C['gb.journey.title']);

      // no dead control, no error surface inside the card
      await expect(card.getByTestId('gb-connect')).toHaveCount(0);
      await expect(card.getByTestId('gb-sync')).toHaveCount(0);
      await expect(card.getByRole('alert')).toHaveCount(0);

      // configuration jargon never reaches a homeowner (the technical reason
      // is `unconfiguredReason`, which names GB_CLIENT_ID/GB_CLIENT_SECRET)
      const painted = (await card.innerText()).replace(/\s+/g, ' ');
      expect(painted).not.toMatch(/credential|client_id|client_secret|oauth|\btoken\b|shim|GB_/i);
      expect(painted).toContain('Oakville Hydro');

      // 3. the three journey steps, in order, matching the catalog
      for (const step of STEPS) {
        const li = card.getByTestId(`gb-journey-step-${step.n}`);
        await expect(li).toBeVisible();
        for (const key of step.keys) {
          await expect(li).toContainText(C[key]);
        }
      }
      const steps = await card.locator('ol li').all();
      expect(steps.length, 'the journey is three steps').toBe(3);

      // 4. contrast on the painted card, with the coverage half reported
      const { findings, measured } = await contrastIn(page, '[data-testid="gb-unconfigured"]');
      expect(
        measured,
        'the walk measured nothing — a 0-failure budget over an invisible card is not evidence',
      ).toBeGreaterThanOrEqual(12);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);

      // 5. the deliverable pictures
      if (SHOT_DIR) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await card.screenshot({ path: path.join(SHOT_DIR, `waiting-${locale}-${theme}.png`) });
        await page.screenshot({ path: path.join(SHOT_DIR, `dialog-${locale}-${theme}.png`) });
      }
    });
  }

  test('the French card carries no English and quotes the French button', async ({ page }) => {
    const status = await (await page.request.get('/greenbutton/status')).json();
    expect(status.configured).toBe(false);

    await boot(page, 'fr', 'light');
    const card = page.getByTestId('gb-unconfigured');
    // `textContent`, not `innerText`: the labels are painted `uppercase`, and
    // innerText reports the TRANSFORMED text, which would make every catalog
    // comparison fail on presentation instead of on translation.
    const raw = ((await card.textContent()) || '').replace(/\s+/g, ' ');
    const painted = ((await card.innerText()) || '').replace(/\s+/g, ' ');

    for (const key of [...WAITING_KEYS, ...STEPS.flatMap((s) => s.keys)]) {
      expect(raw, `fr value missing for ${key}`).toContain(FR[key]);
      expect(FR[key], `${key} is identical in both catalogs`).not.toBe(EN[key]);
      expect(painted.toLowerCase(), `English leaked through ${key}`).not.toContain(
        EN[key].toLowerCase(),
      );
    }
    expect(raw).toContain(FR['gb.authorise']);
  });

  // The classic surface renders its OWN copy of this component
  // (`components/classic/GreenButtonSync.tsx`) inside /classic's upload
  // dialog. Same catalog keys, second implementation: reachable there too,
  // or the change is only half shipped.
  for (const locale of ['en', 'fr'] as const) {
    test(`/classic carries the same waiting state (${locale})`, async ({ page }) => {
      const status = await (await page.request.get('/greenbutton/status')).json();
      expect(status.configured).toBe(false);

      await page.addInitScript((l) => window.localStorage.setItem('oeo_locale', l), locale);
      await page.goto('/classic');
      await expect(page.getByTestId('gb-unconfigured')).toBeVisible({ timeout: 15_000 });

      const C = catalog(locale);
      const card = page.getByTestId('gb-unconfigured');
      await expect(card.getByTestId('gb-waiting-headline')).toHaveText(C['gb.waiting.headline']);
      await expect(card.getByTestId('gb-waiting-works')).toHaveText(C['gb.waiting.worksToday']);
      for (const step of STEPS) {
        const li = card.getByTestId(`gb-journey-step-${step.n}`);
        await expect(li).toBeVisible();
        for (const key of step.keys) await expect(li).toContainText(C[key]);
      }
      await expect(card.getByTestId('gb-connect')).toHaveCount(0);
      await expect(card.getByRole('alert')).toHaveCount(0);

      const { findings, measured } = await contrastIn(page, '[data-testid="gb-unconfigured"]');
      expect(measured, 'the classic walk measured nothing').toBeGreaterThanOrEqual(12);
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);

      if (SHOT_DIR) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await card.screenshot({ path: path.join(SHOT_DIR, `waiting-classic-${locale}.png`) });
      }
    });
  }
});
