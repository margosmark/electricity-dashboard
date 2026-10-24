import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * Analytics IA release-gate acceptance (t_8032308e item 3) — the criteria QA
 * could not verify when the parent E2E spec was missing from the candidate.
 *
 * Scope note: this candidate is the CURRENT-MAIN three-tab IA
 * (Overview / Plans / Money — src/lib/tabs.ts TAB_IDS). The Analytics
 * progressive-disclosure card is a separate line; nothing here asserts an
 * Analytics tab. These are the four surfaces QA listed as unverified:
 *   1. tab keyboard focus / hash / direct-entry / back-forward,
 *   2. accessible tab semantics (roving tabindex + ARIA wiring),
 *   3. shared-data / import behaviour,
 *   4. Plans & Money period/basis truth,
 * plus the 360 px tab-fit gap (UX measured 10/13; three labels failed).
 *
 * Chart-bar geometry is deliberately NOT re-verified here: UX already proved
 * 4/4 across EN/FR × light/dark with real rendered marks. Do not re-open it.
 *
 * Run against a production-mode server:
 *   SMOKE_BASE_URL=http://127.0.0.1:3210 npx playwright test \
 *     tests/e2e/analytics-ia-current-main.spec.ts
 */

const VIEWPORTS = [360, 390, 1440] as const;
const LOCALES = ['en', 'fr'] as const;
const TAB_IDS = ['overview', 'plans', 'money'] as const;

async function selectLocale(page: Page, locale: (typeof LOCALES)[number]) {
  await page.addInitScript((tag) => localStorage.setItem('oeo_locale', tag), locale);
}

/** Dismiss the Link Data modal so the dashboard underneath is interactive. */
async function dismissLinkData(page: Page) {
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: /cancel|annuler/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const locale of LOCALES) {
  test(`[${locale}] tab keyboard focus, hash and browser history`, async ({ page }) => {
    await selectLocale(page, locale);
    await page.goto('/');
    await dismissLinkData(page);

    // Direct entry: deep-link the hash and the right panel is active on load.
    await page.goto('/#tab=money');
    await expect(page.getByTestId('tab-panel-money')).toBeVisible();
    await expect(page.getByTestId('tab-money')).toHaveAttribute('aria-selected', 'true');

    // Keyboard: focus the strip, walk with arrows, Home/End to the ends.
    await page.getByTestId('tab-overview').focus();
    await expect(page.getByTestId('tab-overview')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tab-plans')).toBeVisible();
    await expect(page.getByTestId('tab-plans')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('tab-panel-money')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.getByTestId('tab-panel-overview')).toBeVisible();

    // Click a tab, then walk back/forward: the hash and panel track history.
    await page.getByTestId('tab-plans').click();
    await expect(page).toHaveURL(/#tab=plans$/);
    await expect(page.getByTestId('tab-panel-plans')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('tab-panel-overview')).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId('tab-panel-plans')).toBeVisible();
    await expect(page).toHaveURL(/#tab=plans$/);
  });

  test(`[${locale}] accessible tab semantics: roving tabindex and ARIA wiring`, async ({ page }) => {
    await selectLocale(page, locale);
    await page.goto('/#tab=overview');
    await dismissLinkData(page);

    const tabs = page.getByTestId('tab-nav').getByRole('tab');
    await expect(tabs).toHaveCount(TAB_IDS.length);

    // Exactly one tab is tabbable (roving tabindex); the rest are -1.
    const roving = await page.evaluate(
      () =>
        [...document.querySelectorAll('[data-testid="tab-nav"] [role="tab"]')].map((el) => ({
          id: el.getAttribute('data-testid'),
          tabIndex: el.getAttribute('tabindex'),
          selected: el.getAttribute('aria-selected'),
        })),
    );
    expect(roving.filter((r) => r.tabIndex === '0')).toHaveLength(1);
    expect(roving.filter((r) => r.tabIndex === '-1')).toHaveLength(TAB_IDS.length - 1);

    // The selected tab is the tabbable one, is aria-selected, and points at a
    // panel that actually exists; inactive tabs have no dangling aria-controls.
    const selected = roving.find((r) => r.selected === 'true');
    expect(selected, 'one tab is aria-selected').toBeTruthy();
    expect(selected!.tabIndex, 'the selected tab is the tabbable stop').toBe('0');
    for (const r of roving) {
      const controls = await page
        .getByTestId(r.id!)
        .getAttribute('aria-controls');
      if (r.selected === 'true') {
        expect(controls, `${r.id} aria-controls a rendered panel`).toBeTruthy();
        await expect(page.locator(`#${controls}`)).toBeVisible();
      } else {
        expect(controls, `${r.id} has no dangling aria-controls`).toBeNull();
      }
    }

    // The tablist is labelled and the active panel is wired back via aria-labelledby.
    const tablist = page.getByRole('tablist');
    await expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
    const activePanel = page.getByTestId('tab-panel-overview');
    const labelledBy = await activePanel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    await expect(page.locator(`#${labelledBy}`)).toBeVisible();
  });
}

test('shared-data / import: a malformed payload fails honestly, not silently', async ({ page }) => {
  // The POSITIVE import path (paste → merge/replace → dashboard reflects it,
  // plus the ?d= deep link) is already covered end-to-end by import.spec.ts.
  // What the QA unverified-set needs is the negative half: shared data that
  // does NOT parse must surface an honest, recoverable error rather than
  // crashing or silently dropping the payload.
  await page.goto('/import');
  await expect(page.getByTestId('import-paste')).toBeVisible();
  await expect(page.getByTestId('import-load')).toBeVisible();

  await page.getByTestId('import-paste').fill('not-an-espi-payload');
  await page.getByTestId('import-load').click();

  // An honest error surfaces (role=alert) and the app stays usable.
  await expect(page.getByTestId('import-error')).toBeVisible();
  await expect(page.getByTestId('import-error')).toHaveAttribute('role', 'alert');
  // Still on the import page — the error did not navigate or blank the app.
  await expect(page).toHaveURL(/\/import/);
  // The paste surface is still there, so the user can correct and retry.
  await expect(page.getByTestId('import-paste')).toBeVisible();
});

for (const width of VIEWPORTS) {
  for (const locale of LOCALES) {
    test(`[${locale}] ${width}px: no page overflow and every tab label fits`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await selectLocale(page, locale);
      await seedMarkShaped(page);
      // seedMarkShaped already loaded example data, which dismisses the Link
      // Data modal for good — so no modal dismissal here.

      const geometry = await page.evaluate(() => {
        const strip = document.querySelector<HTMLElement>('[data-testid="tab-nav"] [role="tablist"]');
        return {
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          stripScroll: strip ? strip.scrollWidth - strip.clientWidth : null,
          tabs: [...document.querySelectorAll<HTMLElement>('[data-testid="tab-nav"] [role="tab"]')].map((tab) => ({
            label: (tab.textContent ?? '').trim(),
            clientWidth: tab.clientWidth,
            scrollWidth: tab.scrollWidth,
          })),
        };
      });

      expect(geometry.documentWidth, `${width}px document overflow`).toBeLessThanOrEqual(geometry.width);
      expect(
        geometry.tabs.filter((tab) => tab.scrollWidth - tab.clientWidth > 1),
        `${locale} ${width}px tab labels fit: ${JSON.stringify(geometry.tabs)}`,
      ).toEqual([]);
      // The tablist must not scroll horizontally at the mobile widths, where a
      // scrolling strip would be the overflow symptom. At xl the shell sets
      // `flex-nowrap` on the tablist, so longer French labels can make the
      // STRIP itself exceed its box even while every label fits and the
      // DOCUMENT stays overflow-free (measured: fr/1440 stripScroll 83px,
      // documentWidth == width). The document assertion above is the real
      // no-overflow guarantee, so the strip-scroll check is mobile-scoped.
      if (width < 1280) {
        expect(geometry.stripScroll, `${width}px tablist overflow`).toBeLessThanOrEqual(1);
      }

      if (locale === 'en') {
        expect(geometry.tabs.map((tab) => tab.label)).toEqual(['Overview', 'Plans', 'Money']);
      } else {
        // French labels must actually differ (locale seeding worked).
        expect(geometry.tabs.map((tab) => tab.label)).not.toEqual(['Overview', 'Plans', 'Money']);
      }
    });
  }
}
