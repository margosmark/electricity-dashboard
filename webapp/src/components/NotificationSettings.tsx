/**
 * The "When the app is closed — push" section of the Alerts drawer.
 *
 * Moved here from `AccountControls.tsx` (where it lived as the account
 * drawer's "Notifications" block) so that the two surfaces that used to
 * explain one browser prompt with two vocabularies are one surface with one
 * vocabulary: **Alerts** / on-device alert / push / banner. The account
 * drawer keeps sign-in, backup and sync and gains no pointer line — one
 * entry point is the point.
 *
 * Every control still writes through `account.savePrefs` /
 * `account.enableNotifications`, so the panel can only ever show values the
 * server accepted. `savePrefs` and `useAccount` themselves are untouched.
 *
 * THE HONESTY CONTRACT — the push state table, first true row only:
 *
 *   1. feature off ............ section not rendered at all
 *   2. signed out ............. "Push needs an account" + Sign in (opens the
 *                               account drawer — a drawer, never a new modal)
 *   3. no VAPID keys .......... inert + disabled button
 *   4. browser blocked it ..... disabled button (only the browser can undo it)
 *   5. subscribed ............. "Push on" + topics / cap / quiet disclosure
 *   6. otherwise .............. "Turn on push"
 *
 * A state we cannot truthfully claim is not rendered: nothing here says
 * "email" or "SMS", because this product has neither.
 */

"use client";

import { useState } from "react";
import type { AccountApi } from "@/hooks/useAccount";
import { MIN_INTERVAL_TEXT, TOPIC_LABELS, topicHasProducer } from "@/lib/account/topics";

const BUTTON_CLASS =
  "min-h-11 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-4 border-black text-[11px] " +
  "shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40";

const INPUT_CLASS =
  "w-full min-h-11 px-3 py-2 rounded-lg border-4 border-black bg-white text-black text-[12px] font-bold normal-case " +
  "focus:outline-none focus:ring-4 focus:ring-purple-300";

/** Row 4 — the browser's own permission, which only the browser can undo. */
const BLOCKED_COPY =
  "The browser blocked notifications for this site — allow them for this site in your browser settings.";
const UNSUPPORTED_COPY = "This browser exposes no notification API here, so push cannot be delivered.";

type Props = {
  /** The single shared account state machine (`Dashboard` owns it). */
  account: AccountApi;
  /** Row 2: "Sign in to use push" opens the account drawer — no new modal. */
  onSignIn?: () => void;
  /**
   * The browser's raw permission, re-read by the drawer every time it opens
   * so a grant or block made in the browser's own UI shows up without a
   * reload. One reader (`NotificationToggle`) so this section never prompts.
   */
  permission: NotificationPermission | "unsupported";
};

type PushRow = "hidden" | "signin" | "no-vapid" | "blocked" | "subscribed" | "ready";

export function NotificationSettings({ account, onSignIn, permission }: Props) {
  const { status } = account;
  const prefs = status.prefs;
  const [cap, setCap] = useState(prefs?.dailyCap ?? 3);
  const [quiet, setQuiet] = useState(
    prefs ? `${minutesToTime(prefs.quietStart)}-${minutesToTime(prefs.quietEnd)}` : "22:00-07:00",
  );
  const [expanded, setExpanded] = useState(false);

  // Re-seed the local form fields when the SERVER's copy of the preferences
  // changes (first load, or after a save round-trip). Done during render with
  // a previous-value guard rather than in an effect — the fields are a draft
  // of `prefs`, and a render-phase adjustment is how React says "the source
  // of truth moved" without an extra committed pass.
  const [seenPrefs, setSeenPrefs] = useState(prefs);
  if (prefs !== seenPrefs) {
    setSeenPrefs(prefs);
    if (prefs) {
      setCap(prefs.dailyCap);
      setQuiet(`${minutesToTime(prefs.quietStart)}-${minutesToTime(prefs.quietEnd)}`);
    }
  }

  // Row 1 — before the probe answers, and forever on a feature-off
  // deployment, this section does not exist. A feature-off deploy must stay
  // a byte-level no-op: no account chrome anywhere on the page.
  if (!status.probed || !status.enabled) return null;

  const row: PushRow = !status.authed
    ? "signin"
    : !status.pushConfigured
      ? "no-vapid"
      : permission === "denied" || permission === "unsupported"
        ? "blocked"
        : status.subscriptionCount > 0
          ? "subscribed"
          : "ready";

  const subscribed = row === "subscribed";

  const toggleTopic = (topic: string) => {
    if (!prefs) return;
    const topics = prefs.topics.includes(topic)
      ? prefs.topics.filter((t) => t !== topic)
      : [...prefs.topics, topic];
    void account.savePrefs({ ...prefs, topics });
  };

  const commitLimits = () => {
    if (!prefs) return;
    const [start, end] = quiet.split("-");
    void account.savePrefs({
      ...prefs,
      dailyCap: Math.max(0, Math.min(20, Math.round(cap))),
      quietStart: timeToMinutes(start),
      quietEnd: timeToMinutes(end),
    });
  };

  return (
    <div
      className="mt-3 pt-3 border-t-2 border-black"
      data-testid="alerts-push"
      data-push-state={row}
    >
      <div className="text-[10px] font-black uppercase">When the app is closed — push</div>
      <p className="mt-1 text-[9px] md:text-[10px] leading-relaxed text-slate-600 normal-case font-bold">
        Push from this app&apos;s server: works with the app closed, inside your daily cap and quiet
        hours.
      </p>

      {row === "signin" && (
        <>
          <div className="mt-2 text-[9px] md:text-[10px] text-slate-600 normal-case font-bold">
            Push needs an account on this server.
          </div>
          <button
            type="button"
            data-testid="alerts-push-signin"
            onClick={onSignIn}
            className={BUTTON_CLASS + " bg-purple-300 w-full mt-2"}
          >
            Sign in to use push
          </button>
        </>
      )}

      {row === "no-vapid" && (
        <>
          <div className="mt-2 text-[9px] md:text-[10px] text-slate-600 normal-case font-bold">
            This server has no VAPID keys yet, so push cannot be delivered.
          </div>
          <button
            type="button"
            data-testid="alerts-push-enable"
            disabled
            className={BUTTON_CLASS + " bg-emerald-300 w-full mt-2"}
          >
            Turn on push
          </button>
        </>
      )}

      {row === "blocked" && (
        <>
          <div className="mt-2 text-[9px] md:text-[10px] text-slate-600 normal-case font-bold">
            {permission === "unsupported" ? UNSUPPORTED_COPY : BLOCKED_COPY}
          </div>
          <button
            type="button"
            data-testid="alerts-push-enable"
            disabled
            className={BUTTON_CLASS + " bg-emerald-300 w-full mt-2"}
          >
            Turn on push
          </button>
        </>
      )}

      {row === "ready" && (
        <button
          type="button"
          data-testid="alerts-push-enable"
          onClick={() => void account.enableNotifications()}
          className={BUTTON_CLASS + " bg-emerald-300 w-full mt-2"}
        >
          Turn on push
        </button>
      )}

      {subscribed && (
        <>
          {prefs && (
            <>
              <button
                type="button"
                data-testid="alerts-push-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="mt-2 min-h-11 w-full flex items-center justify-between px-3 py-2 rounded-lg border-4 border-black bg-emerald-300 text-[10px]"
              >
                <span className="font-black uppercase">Push on</span>
                <span aria-hidden>{expanded ? "−" : "+"}</span>
              </button>

              {expanded && (
            <div className="mt-3 flex flex-col gap-3">
              <fieldset>
                <legend className="text-[9px] font-black uppercase mb-1">Tell me about</legend>
                {Object.keys(TOPIC_LABELS).map((topic) => {
                  const waiting = !topicHasProducer(topic);
                  return (
                    <label
                      key={topic}
                      className={
                        "flex items-start gap-2 text-[9px] normal-case py-1 " +
                        (waiting ? "cursor-not-allowed opacity-70" : "cursor-pointer")
                      }
                    >
                      <input
                        type="checkbox"
                        data-testid={`alerts-topic-${topic}`}
                        // A row with no emitter is pinned ON and off: off
                        // would silently change a saved preference, on and
                        // clickable would let the user "enable" something
                        // that can never fire.
                        checked={waiting || prefs.topics.includes(topic)}
                        disabled={waiting}
                        onChange={() => toggleTopic(topic)}
                        className="mt-0.5 h-4 w-4 accent-purple-600"
                      />
                      <span>
                        {TOPIC_LABELS[topic]}
                        <span className="block text-slate-500">
                          {waiting
                            ? `${MIN_INTERVAL_TEXT[topic]} · not connected yet`
                            : MIN_INTERVAL_TEXT[topic]}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-[9px]">
                  <span className="block font-black uppercase mb-1">Per day (max)</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    data-testid="alerts-daily-cap"
                    value={cap}
                    onChange={(e) => setCap(Number(e.target.value))}
                    onBlur={commitLimits}
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="text-[9px]">
                  <span className="block font-black uppercase mb-1">Quiet</span>
                  <input
                    type="text"
                    data-testid="alerts-quiet-hours"
                    value={quiet}
                    onChange={(e) => setQuiet(e.target.value)}
                    onBlur={commitLimits}
                    className={INPUT_CLASS}
                    pattern="\d{1,2}:\d{2}-\d{1,2}:\d{2}"
                    title="HH:MM-HH:MM"
                  />
                </label>
              </div>
              </div>
              )}
            </>
          )}

          <button
            type="button"
            data-testid="alerts-push-disable"
            onClick={() => void account.disableNotifications()}
            className={BUTTON_CLASS + " bg-white w-full mt-3"}
          >
            Turn off push
          </button>
        </>
      )}

      {/*
        The state machine reports its failures through ONE message slot, which
        the account drawer renders. This section used to be inside that drawer;
        left alone it would now swallow every push error (a failed subscribe, a
        failed save) in silence, so the same message is repeated here.
      */}
      {account.message && (
        <div
          data-testid="alerts-message"
          role={account.message.tone === "error" ? "alert" : "status"}
          className={
            "mt-2 text-[9px] md:text-[10px] break-words normal-case font-bold " +
            (account.message.tone === "error" ? "text-red-600" : "text-emerald-700")
          }
        >
          {account.message.text}
        </div>
      )}
    </div>
  );
}

function minutesToTime(minutes: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string | undefined): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return 0;
  const hours = Math.min(23, Number(match[1]));
  const mins = Math.min(59, Number(match[2]));
  return hours * 60 + mins;
}

export default NotificationSettings;
