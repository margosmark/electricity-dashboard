/**
 * Dark mode — the theme subscription (spec: card t_d5d0a86b, comment 119).
 *
 * Deliberately shaped like `i18n/index.ts`: a module singleton plus a React
 * subscription, NOT a context. The reason is the same one i18n gives — a
 * context provider would have to wrap the tree, but the palette is applied
 * by ONE attribute on <html>, so there is nothing to thread through props.
 * A singleton keeps `ThemeToggle` a leaf component with no prop drilling and
 * lets the FOUC script in layout.tsx own the pre-hydration decision.
 *
 * Three rules that make it safe (all enforced by DarkMode.test.tsx):
 *
 *   1. The FIRST client render must match the server's HTML. The server
 *      renders `<html lang="en">` with no data-theme, so `getResolvedTheme`'s
 *      initial answer is `'light'` and the stored value is applied in an
 *      effect after mount — exactly how `restoreStoredLocale` avoids a
 *      hydration mismatch for French. By then the FOUC script has already
 *      painted the correct theme, so the effect is a no-op in the common
 *      case and a repair only when storage changed under us.
 *   2. `theme` is NOT app data. `storage.test.ts:244-260` already pins that
 *      a `theme` key survives `resetStoredData()` and is not listed by
 *      `listOurStoredKeys()`. Resetting your readings must not reset your
 *      theme, so this file never asks storage.ts to own the key.
 *   3. `System` is a LIVE preference, not a snapshot: it subscribes to
 *      `matchMedia('(prefers-color-scheme: dark)')` change events so a phone
 *      flipping to dark at sunset repaints. Pinned modes unsubscribe.
 */

'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEMES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** Spec §3.1: System is the default — respect the OS out of the box. */
export const DEFAULT_THEME: ThemeMode = 'system';

/**
 * The persistence key. Named `theme` because `storage.test.ts` already
 * anticipates exactly this key (see rule 2 above) — renaming it would break
 * a test that was written before this feature existed.
 */
export const THEME_STORAGE_KEY = 'theme';

/** What is actually painted. Never `'system'` — that resolves to one of these. */
export type ResolvedTheme = 'light' | 'dark';

const subscribers = new Set<() => void>();

let currentMode: ThemeMode = DEFAULT_THEME;
/** The server's answer until `restoreStoredTheme` runs post-mount. */
let snapshot: ResolvedTheme = 'light';
/** The media query `System` follows; created lazily, SSR never touches it. */
let mediaQuery: MediaQueryList | null = null;

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/**
 * The media query `System` resolves against.
 *
 * Memoised because `change` listeners must be added to ONE object — creating
 * a fresh query per render would leak a listener on every toggle.
 */
function systemQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!mediaQuery) mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  return mediaQuery;
}

/** Paint the resolved theme on <html>. The ONLY writer of these attributes. */
function apply(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // Android's status bar / PWA chrome follow <meta name="theme-color">.
  // The manifest pins #facc15 (theme-neutral accent); dark gets the navy
  // page so the chrome matches the app instead of glowing yellow.
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = resolved === 'dark' ? '#020617' : '#facc15';
}

/** `system` is not a colour — resolve it against the media query. */
function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemQuery()?.matches ? 'dark' : 'light';
}

function notify(): void {
  for (const cb of subscribers) cb();
}

/** Current mode (`light` | `dark` | `system`). SSR-safe: never touches window. */
export function getTheme(): ThemeMode {
  return currentMode;
}

/** What is painted right now. The `useSyncExternalStore` snapshot. */
export function getResolvedTheme(): ResolvedTheme {
  return snapshot;
}

/** Subscribe to theme changes — the primitive under `useTheme`. */
export function subscribeTheme(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/**
 * The `System` listener, attached only while `currentMode === 'system'`.
 * Pinned modes detach it: a manual choice must survive the OS flipping.
 */
function syncMediaSubscription(): void {
  const query = systemQuery();
  if (!query) return;
  if (currentMode === 'system') {
    if (!query.onchange) query.onchange = handleSystemChange;
  } else if (query.onchange) {
    query.onchange = null;
  }
}

function handleSystemChange(): void {
  if (currentMode !== 'system') return;
  snapshot = resolve('system');
  apply(snapshot);
  notify();
}

/**
 * Switch theme. Persists the MODE (never the resolved value — storing
 * `'dark'` when the user chose System would silently pin it) and repaints.
 *
 * A storage failure is non-fatal: the session stays themed even if the
 * preference cannot be remembered, same contract as `setLocale`.
 */
export function setTheme(next: ThemeMode): void {
  if (!isThemeMode(next) || next === currentMode) return;
  currentMode = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private mode / quota — the in-memory mode is still authoritative.
  }
  snapshot = resolve(next);
  apply(snapshot);
  syncMediaSubscription();
  notify();
}

/**
 * One-shot restore, called from a component AFTER mount (never during the
 * first render — that would hydrate a dark attribute against light SSR HTML,
 * per rule 1). The FOUC script has normally already done this work; here we
 * simply converge on the same answer and take over the media subscription.
 */
export function restoreStoredTheme(): void {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(raw)) currentMode = raw;
  } catch {
    // No storage access: stay on the default (System).
  }
  snapshot = resolve(currentMode);
  apply(snapshot);
  syncMediaSubscription();
}

/** Drop the media listener — used on unmount so a test run leaks nothing. */
export function teardownTheme(): void {
  const query = systemQuery();
  if (query?.onchange) query.onchange = null;
}

/* --------------------------------------------------------------------------
 * React binding
 * -------------------------------------------------------------------------- */

export type ThemeBag = {
  theme: ThemeMode;
  resolved: ResolvedTheme;
  setTheme: (next: ThemeMode) => void;
};

/**
 * Subscribe the component to the theme. `setTheme` is referentially stable,
 * so it is safe in any dependency array.
 */
export function useTheme(): ThemeBag {
  const mode = useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME);
  const resolved = useSyncExternalStore(
    subscribeTheme,
    getResolvedTheme,
    () => 'light' as ResolvedTheme,
  );
  const change = useCallback((next: ThemeMode) => setTheme(next), []);
  return { theme: mode, resolved, setTheme: change };
}

/** Applies the stored theme to <html> once, after hydration. */
export function useThemeBootstrap(): void {
  useEffect(() => {
    restoreStoredTheme();
    return teardownTheme;
  }, []);
}
