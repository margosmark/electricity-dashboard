import { test, expect, type Locator, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * Visual contract for the mobile tab strip.
 *
 * This is intentionally a separate spec from tabnav-fit.spec.ts: the fit
 * matrix owns DOM/geometry assertions, while this matrix owns the pixels a
 * user sees. Keeping the baselines here also makes a visual regression easy
 * to review without changing the interaction contract.
 *
 * Each cell captures three states:
 *   - active: the initial Overview pill is visibly selected;
 *   - focus: keyboard navigation selects Analytics and leaves its focus ring;
 *   - sticky: the selected strip is pinned to the viewport top after scroll.
 *
 * The screenshot is scoped to the nav so dashboard values, dates and charts
 * cannot make an otherwise unrelated visual diff noisy.
 */

const WIDTHS = [360, 390, 412] as const;
const LOCALES = ['en-CA', 'fr-CA'] as const;
const THEMES = ['light', 'dark'] as const;

type Theme = (typeof THEMES)[number];

async function selectLocale(page: Page, locale: (typeof LOCALES)[number]): Promise<void> {
  // The app stores its short locale tag, not the BCP47 label used in test
  // titles. Using the latter would silently render English in the fr cells.
  await page.addInitScript((value) => {
    window.localStorage.setItem('oeo_locale', value.startsWith('fr') ? 'fr' : 'en');
  }, locale);
}

async function selectTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
}

async function disableMotion(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `,
  });
}

async function expectNavAtTop(nav: Locator): Promise<void> {
  await expect
    .poll(async () => nav.evaluate((element) => Math.round(element.getBoundingClientRect().top)), {
      message: 'sticky tab navigation reaches the viewport top',
    })
    .toBe(0);
}

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test.describe(`tab strip visuals @ ${width} / ${locale} / ${theme}`, () => {
        test.use({
          viewport: { width, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 1,
        });

        test(`active, keyboard focus and sticky states`, async ({ page }) => {
          test.setTimeout(180_000);
          await selectLocale(page, locale);
          await selectTheme(page, theme);
          await page.route('https://archive-api.open-meteo.com/**', (route) => route.abort());
          await seedMarkShaped(page);
          await disableMotion(page);

          const nav = page.getByTestId('tab-nav');
          const overview = page.getByTestId('tab-overview');
          const analytics = page.getByTestId('tab-analytics');
          await expect(nav).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(overview).toHaveAttribute('aria-selected', 'true');

          const screenshotOptions = {
            animations: 'disabled' as const,
            caret: 'hide' as const,
            scale: 'css' as const,
            maxDiffPixelRatio: 0.002,
          };

          await expect(nav).toHaveScreenshot(
            `tabnav-${width}-${locale}-${theme}-active.png`,
            screenshotOptions,
          );

          // A real keyboard event is important here: it makes :focus-visible
          // deterministic and exercises the same roving-tabindex path users
          // take, rather than merely forcing a DOM focus state.
          await overview.focus();
          await page.keyboard.press('ArrowRight');
          await expect(analytics).toBeFocused();
          await expect(analytics).toHaveAttribute('aria-selected', 'true');
          await expect(nav).toHaveScreenshot(
            `tabnav-${width}-${locale}-${theme}-focus.png`,
            screenshotOptions,
          );

          // Return to a mouse-selected state before the sticky capture so the
          // sticky baseline isolates position from the focus-ring state.
          await overview.click();
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await expectNavAtTop(nav);
          await expect(overview).toHaveAttribute('aria-selected', 'true');
          await expect(nav).toHaveScreenshot(
            `tabnav-${width}-${locale}-${theme}-sticky.png`,
            screenshotOptions,
          );
        });
      });
    }
  }
}