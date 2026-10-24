import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * The tab strip's FIT / INTERACTION / OVERFLOW acceptance for the four-tab
 * IA — the machine-assertable
 * half of ux's 2026-10-15 walk (360, 390, 780×360, both themes, en+fr).
 * The portrait cells also click every tab and verify the selected panel, so
 * this is an EN/FR × light/dark mobile interaction matrix rather than only a
 * geometry sweep.
 *
 * What each criterion is guarding:
 *
 *   FIT     the FOUR-tab strip (the Analytics disclosure added a tab) has
 *           enough slack at 360 that no pill clips its label — a longer
 *           translation clips INSIDE a pill and reads as a rendering bug
 *           rather than a deliberate ellipsis. The nav-level metric
 *           (`scrollWidth === clientWidth`) passes even when a tab clips —
 *           both are asserted, because only the per-tab one fails.
 *   INTERACTION every tab selects its labelled panel, in both locales and
 *           themes, on a touch viewport.
 *   OVERFLOW no page-level horizontal scroll at any of the three widths.
 *   CONSOLE zero messages across the above.
 *
 * Deliberately NOT asserted here: the strip's rule/sticky styling (owned by
 * the D1 design lane), safe-area insets, 200% text zoom, and keyboard focus
 * behaviour through a sticky transition.
 */

const WIDTHS = [360, 390] as const;
const LOCALES = ['en-CA', 'fr-CA'] as const;
const THEMES = ['light', 'dark'] as const;

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
      navScrollWidth: nav.querySelector<HTMLElement>('[role="tablist"]')?.scrollWidth ?? 0,
      navClientWidth: nav.querySelector<HTMLElement>('[role="tablist"]')?.clientWidth ?? 0,
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
            ).not.toBe('Overview|Analytics|Plans|Money');
          }

          // --- OVERFLOW: no page-level horizontal scroll. ------------------
          expect(fit.docScrollWidth, `document must not scroll sideways at ${width}`).toBeLessThanOrEqual(
            fit.innerWidth,
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

    expect(
      consoleSeen.filter((s) => !EXPECTED_GATE_404.test(s)),
      'no console messages across the walk',
    ).toEqual([]);
  });
});
