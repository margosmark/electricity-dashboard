import { test, expect, type Page } from '@playwright/test';
import { seedMarkShaped } from './mark-seed';

/**
 * The tab strip's FIT / STICKY / OVERFLOW acceptance — the machine-assertable
 * half of ux's 2026-10-15 walk (360, 390, 780×360, both themes, en+fr).
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
 * through the sticky transition.
 */

const WIDTHS = [360, 390] as const;
const LOCALES = ['en-CA', 'fr-CA'] as const;

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
    test.describe(`tab strip @ ${width} / ${locale}`, () => {
      test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

      test(`fit, sticky and overflow`, async ({ page }) => {
        test.setTimeout(180_000);
        const consoleSeen = collectConsole(page);
        await selectLocale(page, locale);
        await seedMarkShaped(page);
        await expect(page.getByTestId('tab-nav')).toBeVisible();

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

/** The landscape phone width from the walk — overflow only, no pills clip check. */
test.describe('tab strip @ 780×360 landscape', () => {
  test.use({ viewport: { width: 780, height: 360 }, isMobile: true, hasTouch: true });

  test('no horizontal overflow, sticky holds', async ({ page }) => {
    const consoleSeen = collectConsole(page);
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

