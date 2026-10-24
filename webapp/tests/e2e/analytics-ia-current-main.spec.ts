import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * Analytics IA release-gate acceptance (t_8032308e item 3) — the criteria QA
 * could not verify when the parent E2E spec was absent from the candidate
 * (QA CHANGES 2026-10-24: "keyboard/hash/history, accessible tab semantics,
 * shared-data/import, and Plans/Money period-basis criteria remain
 * unverified… the parent E2E task's acceptance spec is not present").
 *
 * Rides WITH the candidate: this file is committed on the retest candidate
 * (492d1aeb + the /oeb-rates-page degradation fix), so QA reviews the exact
 * tree its evidence came from.
 *
 * Covers, in EN and FR:
 *   1. fresh Overview after Link Data dismissal (CTA present, no chart marks)
 *      and CTA → Analytics with hash + browser back/forward,
 *   2. tab keyboard focus / hash / direct-entry / history,
 *   3. accessible tab semantics (roving tabindex + ARIA wiring),
 *   4. shared-data / import failure honesty,
 *   5. the tab-fit / strip-fit / hit-test matrix at 360/390 (mobile) AND
 *      1024/1279/1440/1920 (desktop md+). QA-1 (t_9991d1f2): the previous
 *      version of this spec scoped the STRIP-fit check to `< 1280` and never
 *      checked that a tab's box is actually PAINTED inside the strip, so the
 *      4-tab strip clipping Money to 18/98px at 1440 (clicks falling through
 *      to the date input) walked straight through a green suite. The desktop
 *      cells now assert strip scroll 0, every tab fully inside the strip's
 *      own box, every tab centre hit-testable, and End/Home leaving the
 *      selected tab fully visible.
 *
 * Deliberately NOT re-verified: chart-bar geometry across EN/FR × light/dark
 * — UX already proved 4/4 with real rendered marks (PM ruling 2026-10-24).
 * Plans/Money period-basis truth is held by the Vitest Wave-P/Wave-T units
 * and quiet-meter-regression.spec.ts, which this candidate also runs.
 *
 * Run against a production-mode server:
 *   SMOKE_BASE_URL=http://127.0.0.1:3210 npx playwright test \
 *     tests/e2e/analytics-ia-current-main.spec.ts
 */

const VIEWPORTS = [360, 390, 1024, 1279, 1440, 1920] as const;
const LOCALES = ['en', 'fr'] as const;
const TAB_IDS = ['overview', 'analytics', 'plans', 'money'] as const;

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
  test(`[${locale}] fresh Overview: CTA no charts, CTA navigates with history`, async ({ page }) => {
    await selectLocale(page, locale);
    await page.goto('/');
    await dismissLinkData(page);

    // The first screen is calm: the Analytics entry point is present and no
    // chart marks render on the empty Overview.
    await expect(page.getByTestId('tab-panel-overview')).toBeVisible();
    await expect(page.getByTestId('overview-analytics-cta')).toBeVisible();
    await expect(page.getByTestId('rate-chart-svg')).toHaveCount(0);
    await expect(page.getByTestId('rate-chart-bar')).toHaveCount(0);

    // CTA → Analytics, hash follows, back/forward walk the tabs.
    await page.getByTestId('overview-analytics-cta').click();
    await expect(page.getByTestId('tab-panel-analytics')).toBeVisible();
    await expect(page).toHaveURL(/#tab=analytics$/);
    await page.goBack();
    await expect(page.getByTestId('tab-panel-overview')).toBeVisible();
    await expect(page).not.toHaveURL(/#tab=analytics$/);
    await page.goForward();
    await expect(page.getByTestId('tab-panel-analytics')).toBeVisible();
    await expect(page).toHaveURL(/#tab=analytics$/);
  });

  test(`[${locale}] tab keyboard focus, hash and browser history`, async ({ page }) => {
    await selectLocale(page, locale);
    await page.goto('/');
    await dismissLinkData(page);

    // Direct entry: deep-link the hash and the right panel is active on load.
    await page.goto('/#tab=money');
    await expect(page.getByTestId('tab-panel-money')).toBeVisible();
    await expect(page.getByTestId('tab-money')).toHaveAttribute('aria-selected', 'true');

    // Keyboard: focus the strip, walk with arrows (Overview → Analytics →
    // Plans), Home/End to the ends.
    await page.getByTestId('tab-overview').focus();
    await expect(page.getByTestId('tab-overview')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tab-panel-analytics')).toBeVisible();
    await expect(page.getByTestId('tab-analytics')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tab-panel-plans')).toBeVisible();
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
      const controls = await page.getByTestId(r.id!).getAttribute('aria-controls');
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
  // plus the ?d= deep link) is covered end-to-end by import.spec.ts, which
  // this candidate also runs. What QA's unverified set needs is the negative
  // half: shared data that does NOT parse must surface an honest,
  // recoverable error rather than crashing or silently dropping the payload.
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
        const stripRect = strip?.getBoundingClientRect() ?? null;
        const px = (n: number) => Math.round(n * 100) / 100;
        return {
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          stripScroll: strip ? strip.scrollWidth - strip.clientWidth : null,
          stripBox: stripRect ? { left: stripRect.left, right: stripRect.right } : null,
          tabs: [...document.querySelectorAll<HTMLElement>('[data-testid="tab-nav"] [role="tab"]')].map((tab) => {
            const r = tab.getBoundingClientRect();
            // How much of the tab's box lies INSIDE the strip's own box —
            // the QA-1 metric: a tab laid out past the strip is not painted
            // and not hit-testable, however small its label overflows.
            const visible = stripRect
              ? Math.max(0, Math.min(r.right, stripRect.right) - Math.max(r.left, stripRect.left))
              : null;
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
              label: (tab.textContent ?? '').trim(),
              clientWidth: tab.clientWidth,
              scrollWidth: tab.scrollWidth,
              width: px(r.width),
              visible: visible === null ? null : px(visible),
              // The hit may be the button's icon/span child; the tab owns it
              // iff the hit element's closest [role=tab] IS this button.
              hitIsTab: hit === tab || (hit instanceof Element && hit.closest('[role="tab"]') === tab),
            };
          }),
        };
      });

      expect(geometry.documentWidth, `${width}px document overflow`).toBeLessThanOrEqual(geometry.width);
      expect(
        geometry.tabs.filter((tab) => tab.scrollWidth - tab.clientWidth > 1),
        `${locale} ${width}px tab labels fit: ${JSON.stringify(geometry.tabs)}`,
      ).toEqual([]);
      // The tablist must not scroll horizontally AT ANY WIDTH. The previous
      // version exempted ≥1280 ("xl sets flex-nowrap… the document assertion
      // is the real guarantee") — that exemption is exactly the hole QA-1 hid
      // in. The acceptance is exact zero, not a tolerance: strip overflow is
      // a concrete clipped-tab / reachability defect, not a sub-pixel label
      // centering residue.
      expect(geometry.stripScroll, `${width}px tablist overflow`).toBe(0);
      // QA-1 acceptance 1+2: every tab fully inside the strip's own box and
      // hit-testable at its centre (a click aimed at a tab must never fall
      // through to the date input behind it).
      for (const tab of geometry.tabs) {
        expect(
          tab.visible,
          `${locale} ${width}px: "${tab.label}" fully inside the strip box (box ${JSON.stringify(geometry.stripBox)}) — ${JSON.stringify(geometry.tabs)}`,
        ).not.toBeNull();
        expect(
          Math.abs((tab.visible ?? 0) - tab.width),
          `${locale} ${width}px: "${tab.label}" paints ${tab.visible}px of its ${tab.width}px box inside the strip`,
        ).toBeLessThanOrEqual(1);
        expect(
          tab.hitIsTab,
          `${locale} ${width}px: elementFromPoint at "${tab.label}"'s centre must return that tab`,
        ).toBe(true);
      }
      // QA-1 acceptance 3: End/Home still move selection, and the tab they
      // select is fully inside the visible box afterwards — no scrollLeft
      // needed (the pre-fix defect changed the PANEL on End while Money
      // stayed 82% outside the box).
      for (const key of ['End', 'Home'] as const) {
        await page.getByTestId('tab-overview').focus();
        await page.keyboard.press(key);
        const after = await page.evaluate(() => {
          const strip = document.querySelector<HTMLElement>('[data-testid="tab-nav"] [role="tablist"]')!;
          const selected = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
          const s = strip.getBoundingClientRect();
          const r = selected.getBoundingClientRect();
          return {
            label: (selected.textContent ?? '').trim(),
            stripScroll: strip.scrollWidth - strip.clientWidth,
            outside: Math.max(0, Math.max(r.left - s.right, s.left - r.right)),
          };
        });
        expect(after.outside, `${locale} ${width}px: after ${key}, "${after.label}" is fully inside the strip box`).toBeLessThanOrEqual(1);
        expect(after.stripScroll, `${locale} ${width}px: strip still does not scroll after ${key}`).toBeLessThanOrEqual(1);
      }

      if (locale === 'en') {
        expect(geometry.tabs.map((tab) => tab.label)).toEqual([
          'Overview',
          'Analytics',
          'Plans',
          'Money',
        ]);
      } else {
        // French labels must actually differ (locale seeding worked).
        expect(geometry.tabs.map((tab) => tab.label)).not.toEqual([
          'Overview',
          'Analytics',
          'Plans',
          'Money',
        ]);
      }
    });
  }
}
