/**
 * Wave N — the third client-origin trigger: `plan_change` (the "Best plan
 * changed" row of WAVE-N-DESIGN.md §7).
 *
 * Wave M's detector (`hooks/useRefreshNotices.ts` → `buildRefreshNotices`)
 * already works this notice out, renders the in-app banner and — only if the
 * user opted in — raises an on-device `Notification`. Every one of those dies
 * with the tab. This component hands the SAME notice to `POST /account/notify`
 * so it can reach a closed tab and the phone on the account, with the server
 * applying the caps (`lib/account/push.ts#decide`) rather than trusting us.
 *
 * Three rules, in the order they bite:
 *
 *  1. **Once per notice, not once per render.** `notices` is re-derived on
 *     every background refresh, so the guard is an id set — the discipline
 *     `useRefreshNotices` uses for the on-device alert — persisted under
 *     `ACCOUNT_PLAN_POSTED_KEY` and written ONLY once the server accepts the
 *     post. A failed post therefore retries instead of losing the message.
 *  2. **Only when the account probe says so.** `GET /account/session` must
 *     answer `enabled && authed`, or this browser makes NO request against
 *     `/account/notify` at all — the silent no-op `AccountTriggers` gets out
 *     of the server's 401, asked for up front instead of after the fact.
 *  3. **`rate-change` never posts here.** New OEB rates are a SERVER-origin
 *     topic: `lib/account/services.ts` fingerprints `/api/rates` and fans
 *     `oeb_rates` out itself, and `POST /account/notify` would answer 400
 *     `invalid_topic` for it (`CLIENT_NOTIFY_TOPICS` in `lib/account/db.ts`).
 *     Wave M's rate banner still renders — only the push is the server's.
 *
 * WHAT LEAVES THIS DEVICE (SECURITY.md §5): `notificationPayload(notice)` —
 * the pre-rendered title and one sentence the on-device notification shows
 * ("Best plan changed to TOU — your readings now put TOU ~$12.50/mo ahead of
 * ULO…"). No readings, no series, no blob; the server stores topic + title +
 * outcome in `notify_log` and never the body.
 *
 * Failure is silent by construction: a rejected probe or post is caught, the
 * id is un-marked and the next derivation tries again. An account server that
 * is down, absent or signed-out must never surface in a dashboard that is
 * working fine — the data-loss floor of WAVE-N-DESIGN.md §8, restated for a
 * channel nobody is waiting on.
 */

"use client";

import { useEffect, useRef } from "react";
import {
  notificationPayload,
  type PlanChangeNotice,
  type RefreshNotice,
} from "@/lib/backgroundRefresh";
import { fetchSession, notify } from "@/lib/account/client";

/**
 * Ids of plan notices this browser has already had accepted by the server.
 *
 * Persistent (localStorage) unlike `account_anomaly_notified` (session): a
 * plan notice SURVIVES reloads — the banner sits there until it is dismissed
 * — so a session marker would re-ask on every page load. The server's own
 * 1/day interval and duplicate check would catch that, but a client that asks
 * once is the cheaper and more honest boundary.
 */
export const ACCOUNT_PLAN_POSTED_KEY = "account_plan_posted";

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: we may ask again next load — the server caps it */
  }
}

type Props = {
  /** Wave M's derivation, straight out of `useRefreshNotices`. */
  notices: RefreshNotice[];
};

/**
 * Probe, then post. `false` means "the account system said no" (not enabled,
 * or no session) — a distinct outcome from "the call failed", because the
 * first one is a decision and the second one deserves a retry.
 */
async function pushPlanChange(notice: PlanChangeNotice): Promise<boolean> {
  const session = await fetchSession();
  if (!session.enabled || !session.authed) return false;
  const payload = notificationPayload(notice);
  await notify({ topic: "plan_change", title: payload.title, body: payload.body });
  return true;
}

export function AccountPlanTrigger({ notices }: Props) {
  // Ids already asked about, seeded from disk so a reload does not re-ask
  // about a banner that is still on screen — the same shape as
  // `useRefreshNotices`' `notifiedRef`.
  const postedRef = useRef<Set<string> | null>(null);
  if (postedRef.current === null) {
    const seed = readKey(ACCOUNT_PLAN_POSTED_KEY);
    postedRef.current = new Set(seed ? seed.split(",").filter(Boolean) : []);
  }

  // `buildRefreshNotices` emits at most ONE plan-change notice, so there is a
  // single candidate rather than a list to walk.
  const notice =
    notices.find((n): n is PlanChangeNotice => n.kind === "plan-change") ?? null;
  const key = notice?.id ?? "";

  useEffect(() => {
    if (!key || !notice) return;
    const posted = postedRef.current;
    if (!posted || posted.has(key)) return;

    // Marked BEFORE the round trip so a re-render mid-flight cannot post the
    // same notice twice; un-marked again on anything that was not accepted.
    posted.add(key);

    void pushPlanChange(notice)
      .then((accepted) => {
        if (accepted) writeKey(ACCOUNT_PLAN_POSTED_KEY, [...posted].join(","));
        else posted.delete(key);
      })
      .catch(() => {
        // Not reachable, expired session, 500 — indistinguishable from here
        // and equally not an error the dashboard should show.
        posted.delete(key);
      });
    // `notice` is re-created by every re-derivation; `key` is what makes the
    // effect meaningful. Both are needed for the exhaustive-deps check.
  }, [key, notice]);

  return null;
}

export default AccountPlanTrigger;
