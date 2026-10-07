/**
 * Wave M — the settings drawer that owns the ONE thing allowed to ask the
 * browser for notification permission.
 *
 * Nothing else in the app may call `Notification.requestPermission()`: not
 * page load, not a background refresh, not a plan change. The prompt can only
 * come out of this button's `onClick`, which is a direct user gesture — the
 * card's "no prompt on first load, explicit toggle in a settings drawer".
 *
 * The drawer is also where the honest limits are printed, because hiding them
 * would be the dishonest option:
 *   - with no account server there is no email and no SMS; this is an
 *     on-device alert about readings that never left this browser;
 *   - browsers give a page no way to revoke a granted permission, so
 *     switching this off stops US sending, it does not un-grant the browser;
 *   - the background loop itself is throttled by the browser: Periodic
 *     Background Sync is Chromium-only, installed-PWA-only, and its cadence
 *     follows the site's engagement score rather than our `minInterval`.
 *
 * Rendered only for an authorised (gb_session) browser — a manual-upload-only
 * user sees no new chrome at all.
 */

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import {
  disableNotifications,
  enableNotifications,
  notificationAvailability,
  type NotificationAvailability,
} from "@/lib/notifications";
import type { BackgroundSyncState } from "@/lib/periodicSync";

const TOGGLE_CLASS =
  "min-h-11 min-w-11 inline-flex items-center justify-center " +
  "p-3 md:p-4 bg-white text-black border-4 border-black rounded-xl md:rounded-2xl " +
  "shadow-[4px_4px_0px_0px_rgba(220,38,38,1)] hover:translate-y-1 active:translate-y-0 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all";

const AVAILABILITY_COPY: Record<NotificationAvailability, string> = {
  on: "On — alerts can appear while the tab is closed.",
  off: "Off — turn on to get an alert when the tab is closed.",
  blocked: "Blocked — allow notifications for this site in your browser settings.",
  unsupported: "Not available — this browser exposes no notification API here.",
};

const SYNC_COPY: Record<BackgroundSyncState, string> = {
  registered:
    "Periodic background sync registered — the browser will refresh on its own schedule while the app is installed.",
  unsupported:
    "Periodic background sync: not in this browser (Chromium-only, installed app only). Refreshing on tab focus instead.",
  denied:
    "Periodic background sync refused by the browser. Refreshing on tab focus instead.",
  unconfigured:
    "No background loop — this browser has not authorised live sync with Oakville Hydro.",
  unknown: "Checking background refresh…",
};

type Props = {
  /** `gb_status.connected` — the drawer is only for an authorised browser. */
  connected: boolean;
  /** Reported by `useEnergyData` after it tries to register the SW loop. */
  backgroundSync: BackgroundSyncState;
};

export function NotificationToggle({ connected, backgroundSync }: Props) {
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<NotificationAvailability>(() =>
    notificationAvailability(),
  );
  const [status, setStatus] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  });

  // Same overlay contract as every other drawer: Escape closes it, and a tap
  // outside dismisses it (a phone has no Escape key).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openRef.current && !e.defaultPrevented) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const handleToggle = async () => {
    setStatus(null);
    if (availability === "on") {
      disableNotifications();
      setAvailability("off");
      setStatus("Turned off. The browser permission stays granted — this app just goes quiet.");
      return;
    }
    if (availability === "blocked" || availability === "unsupported") return;
    // The prompt itself lives in lib/notifications.ts#requestBrowserPermission
    // (shared with Wave N's account panel) and this is one of its two callers:
    // a click handler, never an effect.
    const next = await enableNotifications();
    setAvailability(next);
    setStatus(
      next === "on"
        ? "On. You will get an alert here when the best plan or the rates change."
        : next === "blocked"
          ? "The browser did not grant permission — the in-app banner still works."
          : "This browser cannot raise notifications.",
    );
  };

  if (!connected) return null;

  const busy = availability === "blocked" || availability === "unsupported";

  return (
    <div ref={rootRef} className="md:relative">
      <button
        type="button"
        data-testid="notification-toggle"
        title="Alert settings"
        aria-label="Alert settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          // Re-read the browser's permission every time the drawer OPENS — a
          // grant or block made in the browser's own UI is reflected without
          // a reload. Done here rather than in an effect so opening the drawer
          // costs exactly one render instead of two.
          if (next) setAvailability(notificationAvailability());
          setOpen(next);
        }}
        className={TOGGLE_CLASS}
      >
        <Bell size={18} strokeWidth={4} />
      </button>

      {open && (
        <div
          data-testid="notification-drawer"
          role="dialog"
          aria-label="Alert settings"
          className="absolute left-0 right-0 md:right-auto top-[calc(100%+8px)] z-[250] w-auto md:w-[360px] max-w-[calc(100vw-2rem)] bg-white border-4 border-black rounded-xl md:rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-5 text-black font-black uppercase"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="text-xs md:text-sm">Alerts</div>
            <button
              type="button"
              aria-label="Close alert settings"
              onClick={() => setOpen(false)}
              className="min-h-11 min-w-11 inline-flex items-center justify-center p-1 hover:bg-slate-100 active:bg-slate-200 rounded"
            >
              <X size={16} strokeWidth={4} />
            </button>
          </div>

          <p className="text-[9px] md:text-[10px] leading-relaxed text-slate-600 font-black mb-3 normal-case">
            Live sync watches two things after every refresh: the best of your three plans, and
            whether new Ontario rates are in effect. When either changes you get the banner at the
            top of the dashboard.
          </p>

          <button
            type="button"
            data-testid="notification-switch"
            data-availability={availability}
            onClick={() => void handleToggle()}
            disabled={busy}
            aria-pressed={availability === "on"}
            className={`min-h-11 w-full px-4 py-3 rounded-lg border-4 border-black text-[11px] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-50 ${
              availability === "on" ? "bg-emerald-400" : "bg-yellow-400"
            }`}
          >
            {availability === "on"
              ? "Turn off closed-tab alerts"
              : availability === "blocked" || availability === "unsupported"
                ? "Closed-tab alerts unavailable"
                : "Turn on closed-tab alerts"}
          </button>

          <div
            data-testid="notification-availability"
            className="mt-2 text-[9px] md:text-[10px] text-slate-600 normal-case font-bold leading-relaxed"
          >
            {AVAILABILITY_COPY[availability]}
          </div>

          <div
            data-testid="notification-background-sync"
            data-state={backgroundSync}
            className="mt-3 pt-3 border-t-2 border-black text-[9px] md:text-[10px] text-slate-600 normal-case font-bold leading-relaxed"
          >
            {SYNC_COPY[backgroundSync]}
          </div>

          {/* The tradeoff, stated where the user decides — not buried in a doc. */}
          <p className="mt-3 text-[9px] leading-relaxed text-slate-500 font-black normal-case">
            There is no account, so nothing here can email or text you: alerts are on-device only,
            and stop entirely if this browser clears its site data.
          </p>

          {status && (
            <div data-testid="notification-status" className="mt-2 text-[9px] md:text-[10px] text-emerald-700 normal-case font-bold">
              {status}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationToggle;
