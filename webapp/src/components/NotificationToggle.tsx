/**
 * Wave M + Wave N — the ONE Alerts drawer.
 *
 * This bell is the single alert surface: it owns the on-device channel (page
 * context, `new Notification()`), it now hosts the push channel that Wave N
 * moved out of the account drawer, and it prints the third channel (the
 * dashboard banner) as a state line so all three answer the same question —
 * *how will I hear about a plan or rate change?* — in one place.
 *
 * Why one drawer: two panels explained one browser prompt with two
 * vocabularies, and neither could answer alone (the account drawer had no
 * idea a banner existed; this one claimed there was no account). Two channels
 * stay separate rows because they are genuinely different machines: on-device
 * is instant and uncapped but dies with the tab, push survives the tab inside
 * a daily cap and quiet hours.
 *
 * Hard rules that survive the merge:
 *   - NOTHING prompts from an effect. `Notification.requestPermission()` is
 *     reached only from this component's click handlers (and push's), through
 *     the one implementation in `lib/notifications.ts`.
 *   - Identifiers do not move: `NotificationToggle`, `notification-*`
 *     testids and `lib/notifications.ts` are exactly as Wave M left them, so
 *     `background-refresh.spec.ts` keeps passing. Only strings changed.
 *   - The bell shows for `connected || accountFeatureEnabled`: a
 *     manual-upload browser can already have a live anomaly push channel, and
 *     hiding the bell would leave it reachable only inside the account
 *     drawer. A feature-off deployment renders no new chrome at all.
 *   - "notification" is the BROWSER's word (its API, its permission). Our
 *     words are Alerts / on-device alert / push / banner.
 */

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import {
  disableNotifications,
  enableNotifications,
  notificationAvailability,
  notificationPermission,
  type NotificationAvailability,
} from "@/lib/notifications";
import type { BackgroundSyncState } from "@/lib/periodicSync";
import { useAccountFeature } from "@/hooks/useAccountFeature";
import type { AccountApi } from "@/hooks/useAccount";
import { NotificationSettings } from "@/components/NotificationSettings";

const TOGGLE_CLASS =
  "min-h-11 min-w-11 inline-flex items-center justify-center " +
  "p-3 md:p-4 bg-white text-black border-4 border-black rounded-xl md:rounded-2xl " +
  "shadow-[4px_4px_0px_0px_rgba(220,38,38,1)] hover:translate-y-1 active:translate-y-0 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all";

/**
 * What the switch says about the ON-DEVICE channel.
 *
 * Wave M shipped "closed-tab alerts" here, which was false: `showNotification`
 * builds a page-context `new Notification()` (`notifications.ts`) and the
 * service worker raises exactly one thing, its `push` handler. The closed tab
 * is push's reach, not this channel's — so the copy now says what this
 * machine actually does.
 */
const AVAILABILITY_COPY: Record<NotificationAvailability, string> = {
  on: "On — a system notification appears while this app is open.",
  off: "Off — turn on to get a system notification while this app is open.",
  blocked: "Blocked in browser settings — the dashboard banner still works.",
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

/** Prepended to the on-device state while there is no live source to raise. */
const NO_LIVE_SYNC =
  "No live sync yet, so there is nothing to raise until you authorise Oakville Hydro.";

/**
 * The bottom line, first match wins. Replaces the old unconditional "There is
 * no account…", which is false the moment someone signs in.
 */
function honestyLine(signedOut: boolean, pushOn: boolean): string {
  if (signedOut) {
    return "Nothing here can reach you when the app is closed — no account is signed in, so there is no push. This app never sends email or SMS.";
  }
  return pushOn
    ? "Push is on — it works when the app is closed and stops at your daily cap and quiet hours. This app never sends email or SMS."
    : "Push is off, so nothing reaches you when the app is closed. This app never sends email or SMS.";
}

type Props = {
  /** `gb_status.connected` — is there a live sync source to raise from? */
  connected: boolean;
  /** Reported by `useEnergyData` after it tries to register the SW loop. */
  backgroundSync: BackgroundSyncState;
  /** The single account state machine (`Dashboard` owns it). */
  account: AccountApi;
  /** Row 2 of the push table: open the account drawer. No new modal. */
  onSignIn?: () => void;
};

export function NotificationToggle({
  connected,
  backgroundSync,
  account,
  onSignIn,
}: Props) {
  // The bell gate's other half: one shared probe, never a second `useAccount`.
  const feature = useAccountFeature();

  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<NotificationAvailability>(() =>
    notificationAvailability(),
  );
  // The browser's raw permission (not our opt-in flag): the push state table
  // has to distinguish "blocked, only the browser can undo it" from "off".
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    () => notificationPermission(),
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
    // and this is one of its two callers: a click handler, never an effect.
    const next = await enableNotifications();
    setAvailability(next);
    setPermission(notificationPermission());
    setStatus(
      next === "on"
        ? "On — a system notification appears while the app is open."
        : next === "blocked"
          ? "The browser did not grant permission — the dashboard banner still works."
          : "This browser cannot raise notifications.",
    );
  };

  // Bell visibility: an authorised browser always gets it (live sync is a
  // real event source); otherwise only a deployment that actually runs the
  // account feature does. Nothing is rendered before the probe answers, so a
  // feature-off deployment stays a no-op.
  if (!connected && !(feature.probed && feature.enabled)) return null;

  const busy = availability === "blocked" || availability === "unsupported";
  const acct = account.status;
  const signedOut = !acct.probed || !acct.enabled || !acct.authed;

  return (
    <div ref={rootRef} className="md:relative">
      <button
        type="button"
        data-testid="notification-toggle"
        title="Alerts"
        aria-label="Alerts"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          // Re-read the browser's permission every time the drawer OPENS — a
          // grant or block made in the browser's own UI is reflected without
          // a reload. Done here rather than in an effect so opening the drawer
          // costs exactly one render instead of two.
          if (next) {
            setAvailability(notificationAvailability());
            setPermission(notificationPermission());
          }
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
          aria-label="Alerts"
          className="absolute left-0 right-0 md:right-auto top-[calc(100%+8px)] z-[250] w-auto md:w-[360px] max-w-[calc(100vw-2rem)] bg-white border-4 border-black rounded-xl md:rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-4 md:p-5 text-black font-black uppercase"
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="text-xs md:text-sm">Alerts</div>
            <button
              type="button"
              aria-label="Close alerts"
              onClick={() => setOpen(false)}
              className="min-h-11 min-w-11 inline-flex items-center justify-center p-1 hover:bg-slate-100 active:bg-slate-200 rounded"
            >
              <X size={16} strokeWidth={4} />
            </button>
          </div>

          <p className="text-[9px] md:text-[10px] leading-relaxed text-slate-600 font-black mb-3 normal-case">
            One event, three places to see it. Turning one on never turns another off.
          </p>

          {/* ---------------- channel 3: the dashboard banner ------------- */}
          <div className="text-[10px] font-black uppercase">In the dashboard</div>
          <div
            data-testid="alerts-banner"
            className="mt-1 text-[9px] md:text-[10px] text-slate-600 normal-case font-bold leading-relaxed"
          >
            On — plan and rate changes show a banner until you dismiss it.
            {!connected && (
              <>
                {" "}
                On, but nothing to show yet — live sync with Oakville Hydro is what creates these.
              </>
            )}
          </div>

          {/* ---------------- channel 1: on-device ------------------------ */}
          <div className="mt-3 pt-3 border-t-2 border-black text-[10px] font-black uppercase">
            While the app is open — on-device alerts
          </div>
          <p className="mt-1 text-[9px] md:text-[10px] leading-relaxed text-slate-600 normal-case font-bold">
            A system notification raised by this app while it is open: instant, uncapped, gone when
            you close the tab.
          </p>

          <button
            type="button"
            data-testid="notification-switch"
            data-availability={availability}
            onClick={() => void handleToggle()}
            disabled={busy}
            aria-pressed={availability === "on"}
            className={`mt-2 min-h-11 w-full px-4 py-3 rounded-lg border-4 border-black text-[11px] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-50 ${
              availability === "on" ? "bg-emerald-400" : "bg-yellow-400"
            }`}
          >
            {availability === "on"
              ? "Turn off on-device alerts"
              : busy
                ? "On-device alerts unavailable"
                : "Turn on on-device alerts"}
          </button>

          {!connected && (
            <div className="mt-2 text-[9px] md:text-[10px] text-amber-700 normal-case font-bold leading-relaxed">
              {NO_LIVE_SYNC}
            </div>
          )}

          <div
            data-testid="notification-availability"
            className="mt-2 text-[9px] md:text-[10px] text-slate-600 normal-case font-bold leading-relaxed"
          >
            {AVAILABILITY_COPY[availability]}
          </div>

          {/* The precondition for the channel above, not a separate setting. */}
          <div
            data-testid="notification-background-sync"
            data-state={backgroundSync}
            className="mt-2 text-[9px] md:text-[10px] text-slate-600 normal-case font-bold leading-relaxed"
          >
            {SYNC_COPY[backgroundSync]}
          </div>

          {/* ---------------- channel 2: push ----------------------------- */}
          <NotificationSettings account={account} onSignIn={onSignIn} permission={permission} />

          {/* The tradeoff, stated where the user decides — not buried in a doc. */}
          <p className="mt-3 text-[9px] leading-relaxed text-slate-500 font-black normal-case">
            {honestyLine(signedOut, acct.subscriptionCount > 0)}
          </p>

          {status && (
            <div
              data-testid="notification-status"
              className="mt-2 text-[9px] md:text-[10px] text-emerald-700 normal-case font-bold"
            >
              {status}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationToggle;
