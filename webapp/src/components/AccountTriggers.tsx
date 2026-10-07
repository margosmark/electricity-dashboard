/**
 * Wave N — client-origin notification triggers (the bottom half of the
 * trigger table in WAVE-N-DESIGN.md §7).
 *
 * Under E2EE the server cannot compute either of these: it has ciphertext.
 * So the browser decides and posts PRE-RENDERED TEXT to `POST
 * /account/notify`, and the server applies the same caps it applies to its
 * own triggers (`lib/account/push.ts#decide`). A buggy client cannot talk
 * its way past the daily cap, which is the only reason this split is safe.
 *
 * Two properties this component must keep:
 *
 *  - **It fires once per detected event, not once per render.** The
 *    dashboard re-renders constantly; without a marker, a user would get one
 *    notification per chart interaction. The marker is per browser session
 *    and per event key, so a genuine new anomaly still notifies.
 *  - **Failure is silent.** Not signed in, server down, VAPID missing — none
 *    of those may surface as an error in a dashboard that is working fine.
 *
 * `detectAnomalies()` already exists in `lib/energy.ts` and runs where the
 * data is; this is the component that gives its output a way to reach a
 * closed tab. The third client-side trigger, `plan_change`, is deliberately
 * NOT here: it belongs to Wave M's plan detector
 * (`hooks/useRefreshNotices.ts`) and lives in `AccountPlanTrigger` next
 * door, which posts the same shape to the same endpoint and is capped by the
 * same server-side rules.
 *
 * WHAT LEAVES THIS DEVICE (stated because the card demanded it, SECURITY.md
 * §5): the payload is pre-rendered text — a title ("Unusual usage on Oct 3")
 * and one sentence that may include the day's total and the ratio. The
 * server relays it, enforces the caps on it, and stores topic + title +
 * outcome in `notify_log`; it never receives the readings, the series, or
 * anything it could total them into. The alternative — stripping the figures
 * so nothing derived from usage crosses at all — would leave a notification
 * that says something is wrong without saying what, and a date is already
 * usage-derived. We chose the honest boundary over the silent one.
 */

"use client";

import { useEffect, useRef } from "react";
import type { Anomaly } from "@/lib/energy";
import { notify } from "@/lib/account/client";

/** Session-scoped marker: "we already asked the server about this event". */
const SENT_MARKER = "account_anomaly_notified";

type Props = {
  /** Output of `detectAnomalies(processedData, filteredData)`. */
  anomalies: Anomaly[];
  /** Only days at least this much worse than usual are worth a push. */
  thresholdRatio?: number;
};

export function AccountTriggers({ anomalies, thresholdRatio = 1.5 }: Props) {
  const sentFor = useRef<string | null>(null);

  // Newest spike first: one notification per session-load, about the day the
  // user would actually look at.
  const worst = anomalies
    .filter((a) => a.expected > 0 && a.usage / a.expected >= thresholdRatio)
    .sort((a, b) => b.usage - a.usage)[0];

  const key = worst ? `${worst.date.toISOString().slice(0, 10)}:${Math.round(worst.usage)}` : "";

  useEffect(() => {
    if (!key) return;
    if (sentFor.current === key) return;

    let marker: string | null = null;
    try {
      marker = sessionStorage.getItem(SENT_MARKER);
    } catch {
      marker = null;
    }
    if (marker === key) {
      sentFor.current = key;
      return;
    }

    sentFor.current = key;
    const date = worst!.date;
    const title = `Unusual usage on ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    const body = `${Math.round(worst!.usage)} kWh that day — about ${(worst!.usage / worst!.expected).toFixed(1)}x the usual for a ${date.toLocaleDateString(undefined, { weekday: "long" })}.`;

    void notify({ topic: "anomaly", title, body })
      .then(() => {
        try {
          sessionStorage.setItem(SENT_MARKER, key);
        } catch {
          /* private mode: we may ask again next load — the server caps it */
        }
      })
      .catch(() => {
        // Not signed in / account server absent: expected, not an error.
        sentFor.current = null;
      });
    // `worst` is derived from `anomalies`; keying on the derived value keeps
    // the effect from re-running on unrelated dashboard renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}

export default AccountTriggers;
