import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * The desktop tab strip's HOVER affordance (t_656e635d).
 *
 * The defect this pins: `TabNav.tsx` hands inactive tabs `hover:text-ink`, and
 * `.hover\:text-ink:hover{color:var(--ink)}` IS in the built CSS — but
 * `globals.css` pins EVERY tab with `color: var(--ink-2) !important`, and an
 * important declaration always beats a non-important one. Hovering an
 * inactive tab therefore painted ZERO change (verified live at 5fe79cf:
 * hovered Analytics computed colour == Plans, both `rgb(84,92,106)`, and the
 * CSSOM matched-rules list carried no hover colour rule at all). The fix adds
 * `nav[data-testid="tab-nav"] [role="tab"]:hover:not([aria-selected="true"])`
 * with `color: var(--ink) !important`.
 *
 * What is asserted here is the CASCADE RESULT, not the source text: the
 * hovered inactive tab must compute a different colour from its rest state,
 * and must land on the SAME colour as the selected tab — both resolve
 * `var(--ink)` through one pipeline, so the comparison is exact without
 * normalising Tailwind v4's `lab()`/`oklch()` serialisation, which is what
 * makes a literal `rgb()` expectation the flaky half of such a test.
 *
 * Cells: 1280 / 1440 × light / dark — desktop only, because `:hover` is not a
 * real affordance on a coarse pointer. The colour is locale-independent, so
 * EN alone carries the signal (FR is the same rule with different labels).
 *
 * Local run (targets an already-running server, per playwright.config.ts):
 *   SMOKE_BASE_URL=http://127.0.0.1:3210 npx playwright test tab-hover
 */

const WIDTHS = [1280, 1440] as const;
const THEMES = ['light', 'dark'] as const;

/** Park the pointer well clear of the strip so `:hover` is genuinely off. */
async function pointerAway(page: Page): Promise<void> {
  // (2, 2) is the page's top-left corner: outside the sticky nav's tab row at
  // every cell width, and Playwright's default mouse position before any move.
  await page.mouse.move(2, 2);
}

async function selectTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
}

/** Weather is optional UI data; block the live CDN so the walk is stable. */
async function blockOptionalWeather(page: Page): Promise<void> {
  await page.route('https://archive-api.open-meteo.com/**', (route) => route.abort());
}

const colourOf = (locator: ReturnType<Page['getByTestId']>) =>
  locator.evaluate((el) => getComputedStyle(el).color);

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test.describe(`tab hover @ ${width} / ${theme}`, () => {
      test.use({ viewport: { width, height: 900 } });

      test("an inactive tab's computed colour changes on hover", async ({ page }) => {
        test.setTimeout(180_000);
        await blockOptionalWeather(page);
        await selectTheme(page, theme);
        await seedMarkShaped(page);

        const strip = page.getByTestId('tab-nav');
        await expect(strip).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const selected = strip.locator('[role="tab"][aria-selected="true"]');
        const inactive = strip.locator('[role="tab"][aria-selected="false"]').first();
        await expect(selected, 'exactly one selected tab renders').toHaveCount(1);
        await expect(inactive, 'the strip has an inactive tab to hover').toHaveCount(1);

        // --- REST: pointer away, and the two states must already differ, or
        // the hover measurement below would be measuring nothing. -----------
        await pointerAway(page);
        const restColour = await colourOf(inactive);
        const selectedColour = await colourOf(selected);
        expect(
          restColour,
          'baseline has signal: an inactive tab does not already sit on the selected ink',
        ).not.toBe(selectedColour);

        // --- HOVER: the affordance paints, on the button AND its label. ----
        await inactive.hover();
        await expect(
          inactive,
          `hovering an inactive tab lifts it to the selected ink (rest ${restColour} -> hover, selected ${selectedColour})`,
        ).toHaveCSS('color', selectedColour);
        await expect(
          inactive.locator('span'),
          'the label the user reads changes with the button',
        ).toHaveCSS('color', selectedColour);

        // --- UNHOVER: it is a hover state, not a sticky class or a selection
        // side-effect, so moving the pointer away must restore rest. -------
        await pointerAway(page);
        await expect(inactive, 'leaving the tab restores its rest colour').toHaveCSS(
          'color',
          restColour,
        );

        // --- The selected tab keeps its own ink under the pointer: the fix
        // must not turn hover into a second selection marker. ---------------
        await selected.hover();
        await expect(selected, 'hovering the selected tab changes nothing').toHaveCSS(
          'color',
          selectedColour,
        );
      });
    });
  }
}
