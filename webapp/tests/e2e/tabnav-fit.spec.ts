import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * The tab strip's FIT / STICKY / OVERFLOW acceptance — the machine-assertable
 * half of ux's 2026-10-15 walk (360, 390, 780×360, both themes, en+fr).
 * The portrait cells also click every tab and verify the selected panel, so
 * this is an EN/FR × light/dark mobile interaction matrix rather than only a
 * geometry sweep.
 *
 * What each criterion is guarding:
 *
 *   FIT     the strip has ~9px of slack at 360 (4×76 + 32px padding of 345),
 *           so a longer translation clips INSIDE a pill and reads as a
 *           rendering bug rather than a deliberate ellipsis. The nav-level
 *           metric (`scrollWidth === clientWidth`) passes even when a tab
 *           clips — both are asserted, because only the per-tab one fails.
 *   STICKY  at max scroll the strip sits at `top: 0` and the ACTIVE pill is
 *           inside it (a sticky rule that parks the selected pill out of view
 *           is worse than no sticky rule).
 *   OVERFLOW no page-level horizontal scroll at any of the three widths.
 *   TOKEN   the rule's colour resolves from `--edge` per theme and the
 *           surface stays opaque — the regression 8868a43 replaced
 *           (`border-edge-muted`) and the value the branch's D1 test pins.
 *   CONSOLE zero messages across the above.
 *
 * Not covered here, deliberately (needs the docker smoke path / a real
 * device): safe-area insets, 200% text zoom, reduced-motion + focus-visible
 * through the sticky transition, and keyboard focus behavior (owned by the
 * later focus/motion lane).
 */

const WIDTHS = [360, 390] as const;
const LOCALES = ['en-CA', 'fr-CA'] as const;
const THEMES = ['light', 'dark'] as const;

/**
 * The cells that fail today — ux's 2026-10-15 walk measured `CONSOMMATION`
 * at scrollWidth 88 in a clientWidth 72 box at 360/fr; this sweep finds the
 * same clip at 390/fr too (`Consommation: 92 > 80`, 12px), which the walk's
 * table listed as clean — see the report's note on that disagreement. Both
 * are declared EXPECTED failures so the suite stays green while the P2 is
 * open: when the label can shrink (or the pill can widen) this condition
 * stops matching, the test passes, and Playwright fails it as "expected to
 * fail but passed" — the signal to delete the line.
 *
 * English never clips: at 360 `Overview` measures 73 vs 72, a sub-pixel
 * centreing residue vision-checked clean on the painted page.
 */
const KNOWN_CLIP = (width: number, locale: string): boolean =>
  locale.startsWith('fr') && (width === 360 || width === 390);

async function selectLocale(page: Page, locale: string): Promise<void> {
  // `oeo_locale` holds the app's own tag ('en' | 'fr'), NOT the BCP47 name
  // the test titles use — seeding 'fr-CA' is silently ignored and the strip
  // renders English, which fits (and makes the whole cell vacuous).
  const tag = locale.startsWith('fr') ? 'fr' : 'en';
  await page.addInitScript((value) => window.localStorage.setItem('oeo_locale', value), tag);
}

async function selectTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
}

/** Console messages + ≥400 responses seen since this collector was attached. */
function collectConsole(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (msg) => {
    // "Failed to load resource" carries no URL; the response listener below
    // records the same failure WITH its URL, so keeping both would count one
    // problem twice and name neither.
    if (!msg.text().startsWith('Failed to load resource')) {
      seen.push(`${msg.type()}: ${msg.text()}`);
    }
  });
  // An assertion that names the resource is a defect report; one that says
  // "404 ()" is a puzzle.
  page.on('response', (res) => {
    if (res.status() >= 400) seen.push(`http ${res.status()}: ${res.url()}`);
  });
  return seen;
}

/** Weather is optional UI data; block the live CDN so the nav matrix is stable. */
async function blockOptionalWeather(page: Page): Promise<void> {
  await page.route('https://archive-api.open-meteo.com/**', (route) => route.abort());
}

/**
 * The account-gate probe: `/account/*` answers 404 by DESIGN while the
 * account feature is off (`2c8ca8d` — "wrong-method probes on /account/*
 * answer 404 when the feature is off"), and the client asks anyway, so every
 * walk logs it. Excluded from "no console messages" HERE so the criterion
 * means "nothing unexpected" — removing the probe client-side is what would
 * make the literal 0-message criterion true, and that is a product call.
 */
const EXPECTED_GATE_404 = /^http 404: .*\/account\/(session|notify)$/;

interface StripMetrics {
  navScrollWidth: number;
  navClientWidth: number;
  navTop: number;
  navRect: { top: number; bottom: number; left: number; right: number };
  activeRect: { top: number; bottom: number; left: number; right: number } | null;
  tabs: { text: string; scrollWidth: number; clientWidth: number }[];
  docScrollWidth: number;
  innerWidth: number;
}

async function measureStrip(page: Page): Promise<StripMetrics> {
  return page.getByTestId('tab-nav').evaluate((nav) => {
    const rectOf = (r: DOMRect) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    const active = nav.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?? nav.querySelector<HTMLElement>('[role="tab"][data-active="true"]');
    return {
      navScrollWidth: nav.scrollWidth,
      navClientWidth: nav.clientWidth,
      navTop: nav.getBoundingClientRect().top,
      navRect: rectOf(nav.getBoundingClientRect()),
      activeRect: active ? rectOf(active.getBoundingClientRect()) : null,
      tabs: [...nav.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
        text: (tab.textContent ?? '').trim(),
        scrollWidth: tab.scrollWidth,
        clientWidth: tab.clientWidth,
      })),
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test.describe(`tab strip @ ${width} / ${locale} / ${theme}`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

        test(`fit, sticky, overflow and tab interaction`, async ({ page }) => {
          test.setTimeout(180_000);
          const consoleSeen = collectConsole(page);
          await blockOptionalWeather(page);
          await selectLocale(page, locale);
          await selectTheme(page, theme);
          await seedMarkShaped(page);
          await expect(page.getByTestId('tab-nav')).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

          // --- INTERACTION: every mobile tab selects its labelled panel. --
          const tabs = page.getByTestId('tab-nav').getByRole('tab');
          await expect(tabs, 'the four canonical tabs render').toHaveCount(4);
          for (let index = 0; index < 4; index++) {
            const tab = tabs.nth(index);
            await tab.click();
            await expect(tab, `tab ${index} becomes selected`).toHaveAttribute('aria-selected', 'true');
            const controls = await tab.getAttribute('aria-controls');
            expect(controls, `tab ${index} points at its rendered panel`).toBeTruthy();
            if (!controls) throw new Error(`tab ${index} has no aria-controls target`);
            await expect(page.locator(`#${controls}`), `panel for tab ${index} is visible`).toBeVisible();
            await expect(
              page.getByTestId('tab-nav').locator('[role="tab"][aria-selected="true"]'),
            ).toHaveCount(1);
          }

          // --- FIT: the strip as a whole, then each pill. ------------------
          const fit = await measureStrip(page);
          expect(fit.navScrollWidth, 'strip scrolls as a whole').toBe(fit.navClientWidth);

          // Only an overflow past 1px counts as a clip: at 360/en `Overview`
          // measures scrollWidth 73 vs clientWidth 72 — a sub-pixel centreing
          // residue that vision-checked clean on the painted page (2026-10-15),
          // while fr `CONSOMMATION` measures 16px over and is visibly cut.
          const clipped = fit.tabs.filter((t) => t.scrollWidth - t.clientWidth > 1);
          const worst = fit.tabs.reduce((n, t) => Math.max(n, t.scrollWidth - t.clientWidth), 0);
          // The cell that fails today is the only one allowed to fail.
          test.fail(
            KNOWN_CLIP(width, locale),
            `P2: fr label clips its pill at ${width} (walk: 88 in 72 @360; this sweep: 92 in 80 @390)`,
          );
          expect(
            clipped.map((t) => `${t.text}: ${t.scrollWidth} > ${t.clientWidth}`),
            `no pill clips its label (worst overflow ${worst}px; strip reads: ${fit.tabs
              .map((t) => t.text)
              .join(' | ')})`,
          ).toEqual([]);

          // A locale that silently fails to apply makes this test vacuous — it
          // would measure the English pills, which fit. Assert French landed.
          if (locale.startsWith('fr')) {
            expect(
              fit.tabs.map((t) => t.text).join('|'),
              'fr-CA must actually reach the strip before its fit means anything',
            ).not.toBe('Overview|Usage|Plans|Money');
          }

          // --- OVERFLOW: no page-level horizontal scroll. ------------------
          expect(fit.docScrollWidth, `document must not scroll sideways at ${width}`).toBeLessThanOrEqual(
            fit.innerWidth,
          );

          // --- STICKY: at max scroll the strip parks at 0, active inside. --
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          const stuck = await measureStrip(page);
          expect(stuck.navTop, 'strip pinned to the viewport top').toBe(0);
          expect(stuck.activeRect, 'the selected pill exists').not.toBeNull();
          expect(stuck.activeRect!.top, 'active pill top inside the strip').toBeGreaterThanOrEqual(
            stuck.navRect.top - 0.5,
          );
          expect(stuck.activeRect!.bottom, 'active pill bottom inside the strip').toBeLessThanOrEqual(
            stuck.navRect.bottom + 0.5,
          );

          expect(
            consoleSeen.filter((s) => !EXPECTED_GATE_404.test(s)),
            'no console messages across the walk',
          ).toEqual([]);
        });
      });
    }
  }
}

/** The landscape phone width from the walk — overflow only, no pills clip check. */
test.describe('tab strip @ 780×360 landscape', () => {
  test.use({ viewport: { width: 780, height: 360 }, isMobile: true, hasTouch: true });

  test('no horizontal overflow, sticky holds', async ({ page }) => {
    const consoleSeen = collectConsole(page);
    await blockOptionalWeather(page);
    await seedMarkShaped(page);
    await expect(page.getByTestId('tab-nav')).toBeVisible();

    const m = await measureStrip(page);
    expect(m.docScrollWidth, 'document must not scroll sideways').toBeLessThanOrEqual(m.innerWidth);
    expect(m.navScrollWidth, 'strip fits').toBe(m.navClientWidth);
    expect(
      m.tabs.filter((t) => t.scrollWidth > t.clientWidth).map((t) => t.text),
      'no pill clips its label',
    ).toEqual([]);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const stuck = await measureStrip(page);
    expect(stuck.navTop, 'strip pinned to the viewport top').toBe(0);

    expect(
      consoleSeen.filter((s) => !EXPECTED_GATE_404.test(s)),
      'no console messages across the walk',
    ).toEqual([]);
  });
});

/**
 * Combined accessibility/resilience contract: keyboard selection and visible
 * focus under reduced motion, plus zoom/breakpoint/safe-area guards. Safe-area
 * values are zero in headless Chromium, so pin the viewport-fit declaration
 * and the app's documented 40px bottom clearance floor rather than claiming
 * hardware inset simulation.
 */
for (const locale of LOCALES) {
  for (const theme of THEMES) {
    test.describe(`tab strip accessibility @ ${locale} / ${theme}`, () => {
      test.use({
        viewport: { width: 320, height: 720 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
        reducedMotion: 'reduce',
      });

      test('keyboard, reduced motion, 200% text scale, breakpoint and safe-area', async ({ page }) => {
        await blockOptionalWeather(page);
        await selectLocale(page, locale);
        await selectTheme(page, theme);
        await seedMarkShaped(page);
        const nav = page.getByTestId('tab-nav');
        await expect(nav).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const tabs = nav.getByRole('tab');
        await expect(tabs).toHaveCount(4);
        await tabs.nth(0).focus();
        await page.keyboard.press('ArrowRight');
        await expect(tabs.nth(1)).toBeFocused();
        await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('End');
        await expect(tabs.nth(3)).toBeFocused();
        await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('ArrowLeft');
        await expect(tabs.nth(2)).toBeFocused();
        await page.keyboard.press('Home');
        await expect(tabs.nth(0)).toBeFocused();
        const focusStyle = await tabs.nth(0).evaluate((tab) => ({
          outlineStyle: getComputedStyle(tab).outlineStyle,
          outlineWidth: getComputedStyle(tab).outlineWidth,
          transitionProperty: getComputedStyle(tab).transitionProperty,
        }));
        expect(focusStyle.outlineStyle, 'keyboard focus remains visible').not.toBe('none');
        expect(parseFloat(focusStyle.outlineWidth), 'focus indicator has visible width').toBeGreaterThanOrEqual(2);
        expect(focusStyle.transitionProperty, 'reduced motion disables tab transitions').toBe('none');

        // Simulate 200% text scaling without relying on a browser-specific zoom
        // shortcut; verify the tab strip remains viewport-bounded and retains
        // usable touch targets.
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        const mobile = await nav.evaluate((element) => ({
          navRect: element.getBoundingClientRect().toJSON(),
          viewportWidth: document.documentElement.clientWidth,
          tablist: element.querySelector<HTMLElement>('[role="tablist"]')?.getBoundingClientRect().toJSON(),
          targets: [...element.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
            width: tab.getBoundingClientRect().width,
            height: tab.getBoundingClientRect().height,
          })),
          bodyBottomPadding: getComputedStyle(document.body).paddingBottom,
          viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
        }));
        expect(mobile.navRect.right, 'tab strip stays within the mobile viewport')
          .toBeLessThanOrEqual(mobile.viewportWidth);
        expect(mobile.tablist?.right, 'tablist stays within the mobile viewport')
          .toBeLessThanOrEqual(mobile.viewportWidth);
        expect(mobile.targets.every((target) => target.width >= 44 && target.height >= 44),
          'all tab targets stay at least 44×44 CSS px').toBe(true);
        expect(mobile.viewport, 'installed app opts into device safe areas').toContain('viewport-fit=cover');
        expect(parseFloat(mobile.bodyBottomPadding), 'content clears the home-indicator floor')
          .toBeGreaterThanOrEqual(40);

        // Exercise the md breakpoint on the same locale/theme state.
        await page.setViewportSize({ width: 768, height: 720 });
        const desktop = await nav.evaluate((element) => ({
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          gap: getComputedStyle(element.querySelector('[role="tablist"]')!).columnGap,
        }));
        expect(desktop.documentWidth, 'no page-level horizontal overflow at tablet breakpoint')
          .toBeLessThanOrEqual(desktop.width);
        expect(desktop.gap, 'md breakpoint applies desktop tab spacing at the 200% text scale').toBe('24px');
      });
    });
  }
}

/**
 * The rule's token, both themes — the value the branch's D1 test pins
 * (`border-b-2 border-edge`, opaque surface, no blur). Asserting 2px is
 * deliberate: `origin/main` still ships `border-b-4 border-edge` with
 * `backdrop-blur-sm` and `bg-inset/95`, so this test is also the
 * discriminator that says WHICH build it ran against.
 */
test.describe('tab strip rule token', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const theme of ['light', 'dark'] as const) {
    test(`resolves --edge in ${theme}`, async ({ page }) => {
      const consoleSeen = collectConsole(page);
      await blockOptionalWeather(page);
      await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
      await seedMarkShaped(page);
      await expect(page.getByTestId('tab-nav')).toBeVisible();

      const rule = await page.getByTestId('tab-nav').evaluate((nav) => {
        const style = getComputedStyle(nav);
        return {
          borderWidth: style.borderBottomWidth,
          borderColor: style.borderBottomColor,
          background: style.backgroundColor,
          backdrop: style.backdropFilter,
        };
      });

      expect(rule.borderWidth, 'the rule the branch ships').toBe('2px');
      expect(rule.borderColor, 'resolves from --edge, not --edge-muted').toBe(
        theme === 'light' ? 'rgb(0, 0, 0)' : 'rgb(203, 213, 225)',
      );
      expect(rule.background, 'the strip surface stays opaque').not.toBe('rgba(0, 0, 0, 0)');
      expect(rule.backdrop, 'no blur on the branch build').toBe('none');

      expect(
        consoleSeen.filter((s) => !EXPECTED_GATE_404.test(s)),
        'no console messages',
      ).toEqual([]);
    });
  }
});

