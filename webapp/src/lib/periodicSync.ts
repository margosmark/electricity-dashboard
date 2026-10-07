/**
 * Wave M — PWA Periodic Background Sync, registered only for a browser that
 * has actually authorised live sync.
 *
 * THE HONEST PART, because the API's name oversells it:
 *
 *   - Chromium only, and inside Chrome only for a web app that has been
 *     **installed to the device and launched as a distinct application**.
 *     Chrome's own docs: "Periodic background sync is not available in the
 *     context of a regular tab in Chrome." MDN marks it as not Baseline —
 *     Safari and Firefox do not implement it at all.
 *   - `minInterval` is a floor, not a schedule. Chrome decides the real
 *     cadence from the site's engagement score, the device's power and
 *     connectivity, and how often the person uses the app; an hourly request
 *     may be honoured daily, or not at all. So this registration is a bonus
 *     path — the loop that actually keeps data fresh everywhere is the
 *     focus / visibilitychange fallback in `useEnergyData`.
 *   - `register()` can reject with `NotAllowedError` (the permission is not
 *     granted — no prompt is shown, it is simply unavailable) or
 *     `InvalidStateError` (no active service worker). Both are normal, and
 *     both resolve to "use the fallback" rather than an error the user sees.
 *
 * What it can and cannot do while the app is closed: the service worker has
 * no `localStorage`, so it cannot merge readings or re-price three plans. Its
 * handler fetches the feed and stages it in Cache Storage (see public/sw.js);
 * the merge and the banner happen the next time a window is open. That is a
 * platform limitation, not a design preference.
 */

import { GB_PERIODIC_TAG } from './backgroundRefresh';

/**
 * Floor we ASK the browser for. One hour is the card's intended cadence; the
 * browser may give us far less. Chrome's own documentation uses a one-day
 * example, and the real interval is engagement-driven either way.
 */
export const PERIODIC_SYNC_MIN_MS = 60 * 60 * 1000;

export type BackgroundSyncState =
  /** `periodicSync.register()` resolved — the SW can now be woken closed. */
  | 'registered'
  /** No PeriodicSyncManager (Safari/Firefox/regular Chrome tab). */
  | 'unsupported'
  /** The manager exists but the permission was refused. */
  | 'denied'
  /** Not tried: this browser has no Green Button authorisation. */
  | 'unconfigured'
  /** Not tried yet. */
  | 'unknown';

type PeriodicSyncRegistrationLike = {
  register: (tag: string, options: { minInterval: number }) => Promise<void>;
  unregister: (tag: string) => Promise<boolean>;
  getTags: () => Promise<string[]>;
};

function periodicSyncOf(registration: unknown): PeriodicSyncRegistrationLike | null {
  const candidate = (registration as { periodicSync?: PeriodicSyncRegistrationLike })?.periodicSync;
  return candidate && typeof candidate.register === 'function' ? candidate : null;
}

/**
 * Try to let the browser wake the service worker on its own schedule.
 * Resolves to a state the settings drawer can print verbatim; it never throws
 * and never prompts (there is no permission prompt for this API).
 */
export async function registerGreenButtonPeriodicSync(): Promise<BackgroundSyncState> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  // `next dev` and the vitest/jsdom environment register no worker, and
  // `navigator.serviceWorker.ready` would never settle — same policy the
  // service-worker registration itself uses.
  if (process.env.NODE_ENV !== 'production') return 'unsupported';

  try {
    const registration = await navigator.serviceWorker.ready;
    const periodicSync = periodicSyncOf(registration);
    if (!periodicSync) return 'unsupported';
    await periodicSync.register(GB_PERIODIC_TAG, { minInterval: PERIODIC_SYNC_MIN_MS });
    return 'registered';
  } catch (e) {
    return e instanceof DOMException && e.name === 'NotAllowedError' ? 'denied' : 'unsupported';
  }
}

/**
 * Drop the loop when the authorisation is dropped. A background job that
 * outlives the grant it depends on is exactly the kind of thing that keeps
 * hitting a utility with a revoked token.
 */
export async function unregisterGreenButtonPeriodicSync(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (process.env.NODE_ENV !== 'production') return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const periodicSync = periodicSyncOf(registration);
    if (periodicSync) await periodicSync.unregister(GB_PERIODIC_TAG);
  } catch {
    /* nothing registered, or the browser refused: the grant is gone either way */
  }
}
