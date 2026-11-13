/**
 * Dark mode — the TOGGLE and the PERSISTENCE it feeds, pinned in a browser.
 *
 * `theme.spec.ts` (the FOUC guard) seeds `localStorage` by hand and then reads
 * the attribute. That proves the BOOT SCRIPT resolves a stored value before
 * first paint — and nothing else. Between it and `theme-contrast.spec.ts`
 * (which only looks at colours) sat the one path every user actually takes and
 * no gate covered:
 *
 *   the control → the store → `html[data-theme]` → localStorage → next visit
 *
 * That path was verified ONCE, by hand, in `evidence/dark-mode-verify.cjs` —
 * a script nothing runs automatically. This file is the gate version, and it
 * exists because ungated dark-mode behaviour is the defect class that keeps
 * coming back on this board (`t_fbf590fa`, `t_3e571ddb`).
 *
 * Three claims, and why each needs a browser:
 *
 *   1. DATA-ATTRIBUTE FLIP. The painted attribute must change because a real
 *      click/keyboard event reached the real store — not because a test set
 *      the attribute. jsdom (`src/components/ThemeToggle.test.tsx`) proves the
 *      wiring; only a browser proves the attribute repaints the document.
 *
 *   2. PERSISTENCE IS THE *MODE*. `system` must be stored as `system`. Storing
 *      the resolved colour looks identical on the machine that chose it and
 *      pins every other device to one answer.
 *
 *   3. NO FLASH ON THE WAY BACK IN. A reload must paint the stored theme
 *      before the first frame, sampled from inside the document — an assertion
 *      made after load cannot tell a pre-paint write from a late one.
 *
 * The `System` cases use live `emulateMedia` flips: the store must follow the
 * OS while System is selected and must NOT follow it once a mode is pinned.
 *
 * Run: webapp/scripts/e2e-theme-regression.sh   (boots the app, runs all three
 * theme specs), or by hand against a running server:
 *   SMOKE_BASE_URL=http://localhost:3111 npx playwright test theme-toggle
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3111';

const html = (page: Page) => page.locator('html');
const group = (page: Page) => page.getByTestId('theme-toggle');
const option = (page: Page, mode: string) => page.locator(`[data-theme-option="${mode}"]`);
const storedMode = (page: Page) => page.evaluate(() => window.localStorage.getItem('theme'));
const chromeColour = (page: Page) =>
  page.locator('meta[name="theme-color"]').getAttribute('content');

/**
 * Sample `data-theme` from the instant the element exists, on a zero-delay
 * rAF loop. The first non-null value is necessarily PRE-PAINT: the loop starts
 * during parsing and paint cannot happen until the parser yields.
 *
 * Register with `page.addInitScript` BEFORE navigating (or reloading) — it is
 * re-installed on every navigation, so a reload is sampled too.
 */
async function sampleFirstPaint(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __themeSeen: string[] };
    w.__themeSeen = [];
    const tick = () => {
      const el = document.documentElement;
      const value = el ? el.getAttribute('data-theme') : null;
      if (value && w.__themeSeen[w.__themeSeen.length - 1] !== value) w.__themeSeen.push(value);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

const firstSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __themeSeen: string[] }).__themeSeen);

/**
 * Load the app and wait for HYDRATION, not merely for a response: the toggle
 * is server-rendered, so clicking it before React attaches is a click into
 * nothing (and the resulting flake reads like a dark-mode defect).
 *
 * Two repo-standing signals are used, both of which a human hits on a cold
 * visit:
 *   - "Drop XML Here" is client-only UI (`csp.spec.ts`, `journey.spec.ts` wait
 *     on it for the same reason) — its appearance IS hydration;
 *   - on an empty install that text lives inside the empty-state upload MODAL
 *     (role=dialog, aria-modal, z-[300], fixed inset-0), which covers the
 *     toolbar. Mouse clicks on the theme options are swallowed by it while the
 *     keyboard still reaches them — a focus+arrow test passes and every click
 *     test hangs. It closes on Escape (Dashboard's top-layer handler), so
 *     dismissing it is part of the cold-start flow, not a test workaround.
 */
async function dismissUploadModal(page: Page) {
  const modal = page.getByTestId('upload-modal');
  if ((await modal.count()) === 0) return;
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0, { timeout: 15_000 });
}

/** Wait for the interactive app, then clear the modal off the toolbar. */
async function settle(page: Page) {
  await expect(page.getByText('Drop XML Here')).toBeVisible({ timeout: 30_000 });
  await dismissUploadModal(page);
}

async function gotoHydrated(page: Page) {
  await page.goto(BASE);
  await settle(page);
}

/** A reload is a fresh visit: it hydrates and re-opens the modal too. */
async function reloadSettled(page: Page) {
  await page.reload();
  await settle(page);
}

test.describe('dark mode — the toggle flips the painted attribute', () => {
  test('cold start with nothing stored: System is selected and the OS decides', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await sampleFirstPaint(page);
    await gotoHydrated(page);

    expect((await firstSeen(page))[0], 'the OS answer is painted before first paint').toBe('dark');
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(group(page)).toHaveAttribute('data-theme-mode', 'system');
    await expect(option(page, 'system')).toHaveAttribute('aria-checked', 'true');
    // Following the OS is not a choice: nothing is written until the user
    // makes one (a stored 'dark' here would freeze tonight's OS answer).
    expect(await storedMode(page), 'a cold start stores nothing').toBeNull();
    expect(await chromeColour(page), 'the browser chrome follows the resolution').toBe('#020617');
  });

  test('Dark: a click flips the attribute, the store and the browser chrome', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' }); // so the click is the cause
    await gotoHydrated(page);
    await expect(html(page)).toHaveAttribute('data-theme', 'light');

    await option(page, 'dark').click();

    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(group(page)).toHaveAttribute('data-theme-mode', 'dark');
    await expect(option(page, 'dark')).toHaveAttribute('aria-checked', 'true');
    await expect(option(page, 'light')).toHaveAttribute('aria-checked', 'false');
    await expect(option(page, 'system')).toHaveAttribute('aria-checked', 'false');
    expect(await storedMode(page)).toBe('dark');
    expect(await chromeColour(page), 'Android status bar follows <meta theme-color>').toBe(
      '#020617',
    );

    // Roving tabindex: the group stays ONE tab stop, on the selection.
    const stops = await page.locator('[data-theme-option][tabindex="0"]').count();
    expect(stops, 'exactly one option is tab-reachable').toBe(1);
    await expect(option(page, 'dark')).toHaveAttribute('tabindex', '0');
  });

  test('Light: and back again', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoHydrated(page);
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');

    await option(page, 'light').click();

    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    expect(await storedMode(page)).toBe('light');
    expect(await chromeColour(page)).toBe('#facc15');
  });

  test('a pinned mode ignores the OS; System follows it live — no reload either way', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoHydrated(page);

    await option(page, 'light').click();
    await expect(html(page)).toHaveAttribute('data-theme', 'light');

    // The OS changes its mind underneath a PINNED choice. Nothing may move:
    // a manual choice that the OS can overwrite is not a preference.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(500);
    await expect(html(page)).toHaveAttribute('data-theme', 'light');

    // The positive control for the negative assertion above: the SAME flip
    // must move the page while System is selected, or "nothing moved" would
    // pass on a page that had stopped listening altogether.
    await option(page, 'system').click();
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html(page), 'System tracks the OS live').toHaveAttribute('data-theme', 'dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html(page)).toHaveAttribute('data-theme', 'light');

    // And the pin still wins after all that: the listener is detached again.
    await option(page, 'dark').click();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    expect(await storedMode(page)).toBe('dark');
  });

  test('the keyboard moves the selection and repaints with it', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoHydrated(page);

    // The group is one tab stop; land on it the way a keyboard user does.
    await option(page, 'system').focus();
    await page.keyboard.press('ArrowRight'); // System → Light (wraps)
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    expect(await storedMode(page)).toBe('light');
    await expect(option(page, 'light')).toBeFocused();

    await page.keyboard.press('End');
    await expect(option(page, 'system')).toHaveAttribute('aria-checked', 'true');
    await expect(html(page)).toHaveAttribute('data-theme', 'light'); // System, OS = light

    await page.keyboard.press('Home');
    await expect(option(page, 'light')).toHaveAttribute('aria-checked', 'true');
    await expect(html(page)).toHaveAttribute('data-theme', 'light');

    await page.keyboard.press('ArrowRight');
    await expect(option(page, 'dark')).toHaveAttribute('aria-checked', 'true');
    await expect(html(page), 'the attribute follows the keyboard, not just the mouse').toHaveAttribute(
      'data-theme',
      'dark',
    );
  });
});

test.describe('dark mode — persistence, and no flash on the way back in', () => {
  test('a choice made through the control is painted before first paint on the next visit', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await sampleFirstPaint(page);
    await gotoHydrated(page);

    await option(page, 'dark').click();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');

    await reloadSettled(page);

    const seen = await firstSeen(page);
    expect(seen.length, 'the boot script wrote the attribute before paint').toBeGreaterThan(0);
    expect(seen[0], 'the FIRST write is the one the user sees — no white flash').toBe('dark');
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(group(page)).toHaveAttribute('data-theme-mode', 'dark');
    expect(await storedMode(page)).toBe('dark');
  });

  test('an explicit Light beats an OS that prefers dark — on the way in, too', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await sampleFirstPaint(page);
    await gotoHydrated(page);

    await option(page, 'light').click();
    await reloadSettled(page);

    expect((await firstSeen(page))[0], 'the stored override outranks the OS before paint').toBe(
      'light',
    );
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await expect(option(page, 'light')).toHaveAttribute('aria-checked', 'true');
  });

  test('System is stored as the MODE: the next visit still follows the OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await sampleFirstPaint(page);
    await gotoHydrated(page);

    await option(page, 'light').click();
    // The default mode IS System, and `setTheme` is a no-op when the mode is
    // already current — so a user has to leave System and come back for the
    // choice to be written at all. (That is the behaviour the unit pin
    // 'System persists the MODE' also encodes.)
    await option(page, 'system').click();
    expect(await storedMode(page), 'the MODE is stored, never the resolution').toBe('system');

    // Same storage, opposite OS answers: both must be honoured, which is only
    // possible if `system` — not tonight's colour — is what was written.
    await page.emulateMedia({ colorScheme: 'dark' });
    await reloadSettled(page);
    expect((await firstSeen(page))[0]).toBe('dark');
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(group(page)).toHaveAttribute('data-theme-mode', 'system');

    await page.emulateMedia({ colorScheme: 'light' });
    await reloadSettled(page);
    expect((await firstSeen(page))[0]).toBe('light');
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    expect(await storedMode(page)).toBe('system');
  });
});
