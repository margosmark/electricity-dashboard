/**
 * Wave N + the Alerts merge — THE account feature probe for the page.
 *
 * Two components need the same boolean — "does this deployment run the
 * account feature?" — for two different reasons:
 *
 *   - `AccountControls` uses it to decide whether any account chrome exists
 *     at all (a feature-off deployment must render nothing);
 *   - `NotificationToggle` (the Alerts drawer) ORs it into the bell gate
 *     (`gbConnected || accountFeatureEnabled`), because a manual-upload
 *     browser can already have a live anomaly push channel and hiding the
 *     bell would leave that channel reachable only inside the account
 *     drawer — the split this card exists to kill.
 *
 * The naive version of that gate is a second `useAccount()`, which is
 * forbidden: a second instance means a second state machine, a second key
 * derivation, a second auto-push interval and a second `GET
 * /account/session`. So the probe lives HERE, at module level, and every
 * consumer in one page load shares a single in-flight request:
 *
 *   `useAccount` seeds itself from `acquireSession()` (it needs the whole
 *   `SessionInfo`), and both components read the answer through
 *   `useAccountFeature()`. Three consumers, one request.
 *
 * The reference count is what makes the cache honest: it is dropped when the
 * LAST consumer unmounts, so the next mount probes again instead of reading
 * an answer from a previous page — which is also what keeps tests that
 * re-render with a different mocked server from seeing each other's reply.
 */

"use client";

import { useEffect, useState } from "react";
import { fetchSession, type SessionInfo } from "@/lib/account/client";

export type AccountFeature = {
  /** The probe has answered — either way. */
  probed: boolean;
  /** This process was given `ACCT_ENABLED` (the feature exists here). */
  enabled: boolean;
};

/** "Not yet asked" — deliberately `enabled: false` so nothing renders early. */
const UNPROBED: AccountFeature = { probed: false, enabled: false };

let inflight: Promise<SessionInfo | null> | null = null;
let consumers = 0;

/**
 * Join the shared probe. The caller keeps the handle for as long as it is
 * mounted and must pair it with exactly one `releaseSession()` (every caller
 * below does it in an effect cleanup).
 */
export function acquireSession(): Promise<SessionInfo | null> {
  consumers += 1;
  if (!inflight) {
    // A 404 (this is the app container), a 502 (account container down) and
    // an unreachable server all mean the same thing to the UI: no account
    // system here. Never an unhandled rejection — a missing feature is a
    // normal answer, not an error the dashboard should surface.
    inflight = fetchSession().catch(() => null);
  }
  return inflight;
}

export function releaseSession(): void {
  consumers = Math.max(0, consumers - 1);
  if (consumers === 0) inflight = null;
}

/** Test hook — drop the shared probe so the next consumer asks again. */
export function resetAccountFeature(): void {
  consumers = 0;
  inflight = null;
}

/**
 * The feature flag, as React state. Never prompts, never writes, never
 * derives anything: it is a read of one shared HTTP probe.
 */
export function useAccountFeature(): AccountFeature {
  const [feature, setFeature] = useState<AccountFeature>(UNPROBED);

  useEffect(() => {
    let live = true;
    const session = acquireSession();
    void session.then((info) => {
      if (!live) return;
      setFeature({ probed: true, enabled: info !== null && info.enabled });
    });
    return () => {
      live = false;
      releaseSession();
    };
  }, []);

  return feature;
}
