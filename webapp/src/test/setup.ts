import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { TAB_STORAGE_KEY } from '@/lib/tabs';

/**
 * Wave R: WHICH tab is open is part of the URL (`#tab=usage`), because a deep
 * link and the browser back button are both supposed to choose it. jsdom's
 * window, though, persists for the whole test FILE — so one test clicking a
 * tab would silently pick the starting tab of every later test in that file,
 * and "renders the totals strip on Overview" would start failing for a reason
 * that has nothing to do with the strip.
 *
 * Clear the hash after every test so each one opens on the default tab unless
 * it sets one up itself.
 */
afterEach(() => {
  // Several suites are `@vitest-environment node` (headers, proxy, OAuth):
  // there is no URL and no tab to reset there.
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  try {
    // Same reasoning for the remembered tab: a later test in this file that
    // never clicks a tab should still open on the default one.
    window.localStorage.removeItem(TAB_STORAGE_KEY);
  } catch {
    /* storage blocked — there is nothing to forget */
  }
});
