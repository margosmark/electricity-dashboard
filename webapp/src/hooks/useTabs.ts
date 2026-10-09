/**
 * Wave R — which tab is on screen, and where that answer comes from.
 *
 * The address bar is the source of truth, because that is what a shared link
 * and the browser's back button both speak:
 *
 *   1. `#tab=` in the URL  — "send me exactly this section", and the entries
 *      back/forward walk through (every tab change pushes a hash entry).
 *   2. localStorage        — "where was I last time?" (a plain reload keeps
 *      the tab you were on; the URL stays clean until you change tabs).
 *   3. `overview`          — a first visit opens on the decision.
 *
 * Modelled on `useSelectedPlan` — a tiny external store read through
 * `useSyncExternalStore`, not component state plus an effect: the store has
 * no state to cascade, the server snapshot is the default tab (so hydration
 * matches the rendered HTML and React corrects it immediately after), and a
 * back-button `hashchange` is just another store notification.
 *
 * `select` writes storage AND the hash synchronously before notifying, so a
 * click switches tabs in the same frame — the hashchange the browser then
 * fires reads back the same value and is a no-op.
 */

'use client';

import { useCallback, useSyncExternalStore } from 'react';
import {
  DEFAULT_TAB,
  TAB_STORAGE_KEY,
  tabFromHash,
  tabFromStorage,
  tabHash,
  type TabId,
} from '@/lib/tabs';

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** URL first (a deep link beats a remembered tab), then storage, then us. */
function readTab(): TabId {
  const fromUrl = tabFromHash(window.location.hash);
  if (fromUrl) return fromUrl;
  try {
    return tabFromStorage(window.localStorage.getItem(TAB_STORAGE_KEY));
  } catch {
    // Storage blocked (private mode / quota): behave like a first-time user.
    return DEFAULT_TAB;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Back/forward between hash entries, and a hand-edited URL.
  const onHashChange = () => emit();
  window.addEventListener('hashchange', onHashChange);

  // Make the address bar tell the truth about the tab on screen, once, with
  // no history entry of its own — otherwise a visit with no hash would leave
  // back() with nothing to go back TO, and `#tab=bogus` would keep lying.
  const resolved = readTab();
  if (window.location.hash !== tabHash(resolved)) {
    window.history.replaceState(window.history.state, '', tabHash(resolved));
  }

  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', onHashChange);
  };
}

function getSnapshot(): TabId {
  // Read fresh every time rather than caching: nothing can change between
  // React's two reads inside one render pass, and a cache would need a reset
  // API that every caller (and every test) has to remember to call.
  return readTab();
}

function getServerSnapshot(): TabId {
  return DEFAULT_TAB;
}

export type UseTabs = {
  tab: TabId;
  /** Select a tab: storage + address bar now, history entry last. */
  select: (tab: TabId) => void;
};

export function useTabs(): UseTabs {
  const tab = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const select = useCallback((next: TabId) => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // Persistence is a convenience; the tab still switches.
    }
    // Only push when the hash actually changes — clicking the tab you are
    // already on must never grow the history stack.
    if (window.location.hash !== tabHash(next)) {
      window.location.hash = tabHash(next);
    }
    emit();
  }, []);

  return { tab, select };
}
