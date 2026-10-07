/**
 * Wave M — the OPTIONAL on-device notification channel.
 *
 * Hard rules encoded here, because they are the ones a later refactor would
 * most easily break:
 *
 *  1. NOTHING calls `Notification.requestPermission()` on its own. The only
 *     path that can prompt is `enableNotifications()`, which only runs from
 *     the settings drawer's toggle — a direct user gesture. Page load, a
 *     background refresh and a plan change are all explicitly silent.
 *  2. Absence is normal. Safari/Firefox without the API, a denied
 *     permission, a private window, or a plain http:// origin all resolve to
 *     "unsupported / unavailable" and the feature degrades to the in-app
 *     banner — which is the primary surface anyway (the card puts the
 *     notification behind an "optional").
 *  3. Turning the toggle off is OUR state, not the browser's: browsers give
 *     web pages no way to revoke a granted permission, so we stop sending
 *     and say so in the drawer instead of pretending to un-grant.
 *
 * The tradeoff, stated in the drawer and here: with no account server there
 * is no email and no SMS. This is an on-device alert about data that never
 * left this browser. That is the whole channel.
 */

import { NOTIFICATIONS_ENABLED_KEY } from './backgroundRefresh';

export type NotificationAvailability =
  | 'unsupported' // no Notification API (or not a secure context)
  | 'blocked' // the user denied it — only the browser can undo that
  | 'off' // granted (or grantable) but the user has not turned it on here
  | 'on'; // granted AND switched on in the settings drawer

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the toggle simply does not survive a reload */
  }
}

/** Is the Notification API usable at all here? (never prompts) */
export function notificationSupport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof Notification === 'undefined') return false;
  // An http:// origin has no Notification constructor in practice, and
  // `window.isSecureContext` is the honest test for that case.
  return window.isSecureContext !== false;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationSupport()) return 'unsupported';
  return Notification.permission;
}

/** The user's explicit opt-in inside this app (independent of the browser). */
export function notificationsEnabled(): boolean {
  return storageGet(NOTIFICATIONS_ENABLED_KEY) === '1';
}

/**
 * What the settings drawer should say and whether its switch is on.
 * Pure read — never prompts, never writes.
 */
export function notificationAvailability(): NotificationAvailability {
  if (!notificationSupport()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  return notificationsEnabled() ? 'on' : 'off';
}

/**
 * Switch the app's opt-in on. ONLY ever called from the toggle's onClick:
 * `requestPermission()` may show the browser's prompt, so calling it from an
 * effect would make the card's "no prompt on first load" impossible.
 */
export async function enableNotifications(): Promise<NotificationAvailability> {
  if (!notificationSupport()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';

  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return 'blocked';
    }
  }
  if (permission !== 'granted') return 'blocked';

  storageSet(NOTIFICATIONS_ENABLED_KEY, '1');
  return 'on';
}

/** Turn our opt-in off. The browser permission stays — we simply go quiet. */
export function disableNotifications(): void {
  try {
    window.localStorage.removeItem(NOTIFICATIONS_ENABLED_KEY);
  } catch {
    /* storage blocked: next read still defaults to off */
  }
}

/**
 * Fire one alert. Silently does nothing unless the user has BOTH granted the
 * browser permission and switched the drawer on — so a refresh can never
 * resurrect an alert the user turned off.
 *
 * Failures are swallowed on purpose: an installed iOS PWA, a locked profile
 * or a browser that requires the service worker to raise notifications all
 * throw here, and in every one of those cases the in-app banner is still on
 * screen. Losing an optional notification must never break a refresh.
 */
export function showNotification(payload: { title: string; body: string; tag: string }): boolean {
  if (notificationAvailability() !== 'on') return false;
  try {
    new Notification(payload.title, { body: payload.body, tag: payload.tag });
    return true;
  } catch {
    return false;
  }
}
