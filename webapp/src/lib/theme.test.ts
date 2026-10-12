/**
 * Dark mode — the theme STORE (`src/lib/theme.ts`), the one writer of
 * `data-theme`.
 *
 * The token layer is already gated (`darkMode.test.ts` proves every declared
 * pairing clears its floor, both themes) and the FOUC guard is gated in a
 * browser (`tests/e2e/theme.spec.ts`). What sat between them was UNGATED: the
 * two things every other gate assumed had already happened.
 *
 *   1. THE FLIP. `setTheme` is the only code that writes `html[data-theme]`,
 *      `style.colorScheme` and `<meta name="theme-color">`. If it stops, the
 *      token tests stay green (the tokens are still correct) and the FOUC
 *      tests stay green (the boot script still writes its own attribute) while
 *      the app quietly stops switching. That is exactly the regression the
 *      dark-mode suite keeps re-finding (`t_fbf590fa`), so it is pinned here.
 *
 *   2. WHAT IS PERSISTED. The MODE (`'system'`), never the RESOLVED value
 *      (`'dark'`). Storing the resolution looks identical on the machine that
 *      made the choice and silently pins a phone to yesterday's answer when
 *      the OS flips at sunset — a defect no browser assertion on one machine
 *      can see.
 *
 * Run: cd webapp && npx vitest run src/lib/theme.test.ts
 *
 * Each case takes a FRESH module instance (`vi.resetModules` + dynamic
 * import): the store is a module singleton on purpose (i18n is shaped the same
 * way), so module state would otherwise leak between cases exactly as a real
 * page's session does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Handler = ((ev: MediaQueryListEvent) => void) | null;

/**
 * A controllable `matchMedia('(prefers-color-scheme: dark)')`.
 *
 * jsdom ships no `prefers-color-scheme` (its `matchMedia` answers `false` for
 * every media feature), so "the OS flipped at sunset" has to be simulated:
 * the store reads `.matches` and assigns `.onchange`, and that is the whole
 * surface this fake has to honour.
 */
function fakeMatchMedia(initialDark: boolean) {
  const query = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null as Handler,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  window.matchMedia = ((media: string) => {
    expect(media).toBe('(prefers-color-scheme: dark)');
    return query as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;

  return {
    query,
    /** The OS (or the phone) changes its mind while the page is open. */
    flip(dark: boolean) {
      query.matches = dark;
      const handler = query.onchange as Handler;
      if (handler) handler({ matches: dark } as MediaQueryListEvent);
    },
  };
}

const metaThemeColor = () =>
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null;

/** A fresh store over a clean document, with the OS on `dark` by default. */
async function freshStore(osDark = false) {
  vi.resetModules();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
  document.querySelector('meta[name="theme-color"]')?.remove();
  const media = fakeMatchMedia(osDark);
  const theme = await import('@/lib/theme');
  return { theme, media };
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

describe('theme store — what the flip actually writes', () => {
  it('paints nothing before the boot path runs (SSR HTML has no data-theme)', async () => {
    const { theme } = await freshStore();

    // The server renders `<html lang="en">` with no attribute; the first
    // client snapshot must agree with it or hydration mismatches.
    expect(theme.getTheme(), 'System is the default').toBe('system');
    expect(theme.getResolvedTheme(), "the server's answer is light").toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('setTheme("dark") writes the attribute, colorScheme, the storage MODE and the chrome colour', async () => {
    const { theme } = await freshStore(false);

    theme.setTheme('dark');

    expect(document.documentElement.dataset.theme).toBe('dark');
    // iOS/Android chrome and form controls follow `color-scheme`, not the
    // attribute — a flip that sets only one of the two paints half a theme.
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');
    // Android's status bar follows <meta theme-color>; the store creates it if
    // the document has none (layout.tsx is not the only possible entry point).
    expect(metaThemeColor()).toBe('#020617');
  });

  it('setTheme("light") flips the same four things back', async () => {
    const { theme } = await freshStore(true);

    theme.setTheme('light');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(window.localStorage.getItem('theme')).toBe('light');
    expect(metaThemeColor()).toBe('#facc15');
  });

  it('System persists the MODE, never the resolved value', async () => {
    const { theme } = await freshStore(true); // the OS prefers dark

    theme.setTheme('light');
    theme.setTheme('system');

    // The painted answer is dark (the OS says so) while the stored one stays
    // `system` — storing `dark` here would pin the app to tonight's OS answer
    // forever, including on the phone that flips at sunset.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('system');
    expect(theme.getTheme()).toBe('system');
  });

  it('System follows the OS live; a pinned mode ignores it', async () => {
    const { theme, media } = await freshStore(false);

    // Set an explicit mode first: `setTheme` is a no-op when the mode is
    // already current (default System), so switching TO System is what
    // attaches the media listener.
    theme.setTheme('light');
    theme.setTheme('system');
    let notified = 0;
    const unsubscribe = theme.subscribeTheme(() => {
      notified += 1;
    });

    media.flip(true);
    expect(document.documentElement.dataset.theme, 'System tracks the OS live').toBe('dark');
    expect(notified, 'subscribers are told so React repaints').toBe(1);

    theme.setTheme('light');
    media.flip(false);
    media.flip(true);
    expect(
      document.documentElement.dataset.theme,
      'a manual choice detaches the media listener — the OS cannot take it back',
    ).toBe('light');

    unsubscribe();
  });
});

describe('theme store — restore and refuse', () => {
  it('restoreStoredTheme converges on the stored mode after mount', async () => {
    const { theme } = await freshStore(false); // the OS prefers light
    window.localStorage.setItem('theme', 'dark');

    theme.restoreStoredTheme();

    expect(theme.getTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme, 'an explicit choice beats the OS').toBe('dark');
  });

  it('an unusable stored value falls back to the default instead of throwing', async () => {
    const { theme } = await freshStore(true);

    for (const junk of ['banana', '', 'DARK', '{"mode":"dark"}']) {
      window.localStorage.setItem('theme', junk);
      theme.restoreStoredTheme();

      expect(theme.getTheme(), `"${junk}" is not a mode`).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('dark'); // the OS decides
    }
  });

  it('an invalid mode passed to setTheme is a no-op', async () => {
    const { theme } = await freshStore(false);

    theme.setTheme('sepia' as never);

    expect(theme.getTheme()).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(window.localStorage.getItem('theme'), 'nothing persisted').toBeNull();
  });

  it('a storage failure still repaints (private mode is not a broken theme)', async () => {
    const { theme } = await freshStore(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    expect(() => theme.setTheme('dark')).not.toThrow();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBeNull();
  });
});
