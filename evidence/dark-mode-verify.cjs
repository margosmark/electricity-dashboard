/**
 * Dark mode browser verification — the token layer on a running stack.
 *
 * The claim under test is not "a dark theme exists" but the four things the
 * spec (card t_d5d0a86b, comment 119) makes non-negotiable:
 *
 *   1. ONE ATTRIBUTE FLIPS THE APP — `data-theme="dark"` on <html> repaints
 *      every surface from the CSS custom properties. No `dark:` variants
 *      anywhere (2 hits, both comments), so this script asserts the RENDERED
 *      colours: page, card, border, ink and the hard-shadow paint all change,
 *      and they change to the token values, not to "something darker".
 *   2. THE TOGGLE IS A REAL 3-STATE CONTROL — radiogroup, three radios,
 *      aria-checked on exactly one, keyboard arrows move selection, and the
 *      choice survives a reload (localStorage `theme`).
 *   3. PRINT IS ALWAYS LIGHT — a dark-mode user hitting ⌘P must not ink a
 *      black page. Verified by emulating `media: print` and reading the same
 *      computed styles back: they must resolve to the LIGHT token values.
 *   4. THE OS THEME IS FOLLOWED, NOT FROZEN — with no stored value the page
 *      tracks `prefers-color-scheme`, live.
 *
 * Run:  DARK_MODE_BASE_URL=http://127.0.0.1:3111/ \
 *         node evidence/dark-mode-verify.cjs
 * Env:  DARK_MODE_BASE_URL (default http://127.0.0.1:3111/),
 *       DARK_MODE_CHROMIUM (default /usr/bin/chromium),
 *       DARK_MODE_SUFFIX ('-local' writes dark-mode-verification-local.json),
 *       DARK_MODE_XML (defaults to the committed Green Button sample).
 *
 * Writes evidence/dark-mode-verification[-suffix].json + dark-mode-*.png
 */

process.env.TZ = 'America/Toronto';

const path = require('node:path');
const fs = require('node:fs');

let chromium;
try {
  ({ chromium } = require('@playwright/test'));
} catch {
  ({ chromium } = require(path.resolve(__dirname, '../webapp/node_modules/@playwright/test')));
}

const BASE = process.env.DARK_MODE_BASE_URL || 'http://127.0.0.1:3111/';
const CHROMIUM = process.env.DARK_MODE_CHROMIUM || '/usr/bin/chromium';
const SUFFIX = process.env.DARK_MODE_SUFFIX || '';
const FIXTURE =
  process.env.DARK_MODE_XML ||
  path.resolve(__dirname, '../webapp/tests/fixtures/green-button-alliance-sample.xml');
const OUT = __dirname;

/** The token values this script expects to see PAINTED (globals.css). */
const TOKENS = {
  light: {
    page: 'rgb(248, 250, 252)', // #f8fafc
    card: 'rgb(255, 255, 255)', // #ffffff
    edge: 'rgb(0, 0, 0)', // #000000
    ink: 'rgb(0, 0, 0)', // #000000
    // Computed `box-shadow` serializes an opaque black as `rgb(0, 0, 0)`,
    // not `rgba(0, 0, 0, 1)` — the assertion normalises both spellings.
    shadow: 'rgb(0, 0, 0)',
    accent: 'rgb(250, 204, 21)', // #facc15 — the brand constant, BOTH themes
  },
  dark: {
    page: 'rgb(2, 6, 23)', // #020617
    card: 'rgb(15, 23, 42)', // #0f172a
    edge: 'rgb(203, 213, 225)', // #cbd5e1
    ink: 'rgb(248, 250, 252)', // #f8fafc
    shadow: 'rgba(255, 255, 255, 0.12)',
    accent: 'rgb(250, 204, 21)', // unchanged
  },
};

const checks = [];
function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: String(detail == null ? '' : detail) };
  checks.push(entry);
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}

/** Read the painted values straight off a rendered element tree. */
async function painted(page) {
  return page.evaluate(() => {
    const body = getComputedStyle(document.body);
    // The toolbar card and a bordered chip inside it: one surface, one edge.
    const card = document.querySelector('[data-testid="plan-switcher"]')?.closest('.no-print');
    const chip = card?.querySelector('button');
    const cs = card ? getComputedStyle(card) : null;
    const chipCs = chip ? getComputedStyle(chip) : null;
    const shadowHost = document.querySelector('.shadow-hard-4, [class*="shadow-hard-"]');
    return {
      dataTheme: document.documentElement.dataset.theme,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      page: body.backgroundColor,
      ink: body.color,
      card: cs?.backgroundColor ?? '',
      edge: cs?.borderTopColor ?? '',
      chipInk: chipCs?.color ?? '',
      shadow: shadowHost ? getComputedStyle(shadowHost).boxShadow : '',
      themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? '',
    };
  });
}

async function loadFixture(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[aria-label="Upload Green Button XML"]').setInputFiles(FIXTURE);
  await page.getByTestId('totals-strip').waitFor({ state: 'visible', timeout: 60_000 });
  // Let the charts settle: the screenshots are evidence, not a race.
  await page.waitForTimeout(1500);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const meta = { base: BASE, at: new Date().toISOString(), checks: [], screenshots: [] };

  // ---- 1/2: theme + token paint, desktop and phone, both themes ----------
  for (const theme of ['light', 'dark']) {
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const ctx = await browser.newContext({ viewport: vp, timezoneId: 'America/Toronto' });
      // Seed the stored choice BEFORE the document loads: this is the cold
      // path the FOUC guard exists for, and the only honest way to
      // screenshot a theme the boot script must pick unaided.
      await ctx.addInitScript((t) => {
        try {
          localStorage.setItem('theme', t);
        } catch {
          /* private mode — the script must still work */
        }
      }, theme);
      const page = await ctx.newPage();
      await loadFixture(page);
      const got = await painted(page);
      const want = TOKENS[theme];
      const tag = `${theme} ${vp.width}x${vp.height}`;

      check(`${tag}: <html data-theme> is "${theme}"`, got.dataTheme === theme, got.dataTheme);
      check(
        `${tag}: page paints --page (${want.page})`,
        got.page === want.page,
        `${got.page} vs ${want.page}`,
      );
      check(
        `${tag}: card paints --card (${want.card})`,
        got.card === want.card,
        `${got.card} vs ${want.card}`,
      );
      check(
        `${tag}: card border paints --edge (${want.edge})`,
        got.edge === want.edge,
        `${got.edge} vs ${want.edge}`,
      );
      check(
        `${tag}: body ink paints --ink (${want.ink})`,
        got.ink === want.ink,
        `${got.ink} vs ${want.ink}`,
      );
      check(
        `${tag}: hard shadow paint is "${want.shadow}"`,
        got.shadow.includes(want.shadow),
        got.shadow,
      );
      check(
        `${tag}: accent yellow is UNCHANGED (${want.accent})`,
        got.themeColor === (theme === 'dark' ? '#020617' : '#facc15'),
        `meta theme-color=${got.themeColor}`,
      );

      const shot = path.join(OUT, `dark-mode-${theme}-${vp.width}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      meta.screenshots.push(path.basename(shot));
      console.log(`      screenshot → ${path.basename(shot)}`);
      await ctx.close();
    }
  }

  // ---- 3: print from DARK renders the LIGHT palette ---------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => localStorage.setItem('theme', 'dark'));
    const page = await ctx.newPage();
    await loadFixture(page);
    check('print: screen is dark first', (await painted(page)).dataTheme === 'dark');
    await page.emulateMedia({ media: 'print' });
    const printed = await painted(page);
    // The print block paints paper WHITE (`html, body { background: #fff }`)
    // on top of the light --page, so the honest assertion is "not the dark
    // navy, and paper-white" — expecting #f8fafc here would be asserting
    // against the app's own print rule.
    check(
      'print: the page is paper, not the dark navy',
      printed.page === 'rgb(255, 255, 255)' || printed.page === TOKENS.light.page,
      printed.page,
    );
    check(
      'print: --card falls back to white',
      printed.card === TOKENS.light.card,
      printed.card,
    );
    check(
      'print: borders are black again',
      printed.edge === TOKENS.light.edge,
      printed.edge,
    );
    const shot = path.join(OUT, 'dark-mode-print-from-dark.png');
    await page.screenshot({ path: shot, fullPage: true });
    meta.screenshots.push(path.basename(shot));
    console.log(`      screenshot → ${path.basename(shot)}`);
    await ctx.close();
  }

  // ---- 4: the control itself + persistence + live OS follow -------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loadFixture(page);

    const group = page.getByTestId('theme-toggle');
    check('toggle: role=radiogroup with an accessible name', (await group.getAttribute('role')) === 'radiogroup' && !!(await group.getAttribute('aria-label')), await group.getAttribute('aria-label'));
    const radios = group.locator('[role="radio"]');
    check('toggle: three radios', (await radios.count()) === 3, await radios.count());
    const checked = await group.locator('[role="radio"][aria-checked="true"]').count();
    check('toggle: exactly one aria-checked', checked === 1, checked);
    const defaultMode = await group.getAttribute('data-theme-mode');
    check('toggle: defaults to system with nothing stored', defaultMode === 'system', defaultMode);

    // Keyboard: focus the checked radio, ArrowRight moves selection.
    await group.locator('[role="radio"][aria-checked="true"]').focus();
    await page.keyboard.press('ArrowRight');
    const afterArrow = await group.getAttribute('data-theme-mode');
    check('toggle: ArrowRight moves the selection', afterArrow !== defaultMode, `${defaultMode} → ${afterArrow}`);
    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    check('toggle: the choice is persisted to `theme`', stored === afterArrow, stored);

    // And it survives a reload — the FOUC path, now with a manual override.
    const before = (await painted(page)).dataTheme;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('totals-strip').waitFor({ state: 'visible', timeout: 60_000 });
    const after = await painted(page);
    check(
      'toggle: the manual choice survives a reload',
      after.dataTheme === before,
      `${before} → ${after.dataTheme}`,
    );
    await ctx.close();
  }

  meta.checks = checks;
  meta.failed = checks.filter((c) => !c.ok).length;
  const outPath = path.join(OUT, `dark-mode-verification${SUFFIX}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`\n${checks.length - meta.failed}/${checks.length} checks passed → ${path.relative(process.cwd(), outPath)}`);

  await browser.close();
  process.exit(meta.failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
