/**
 * Wave N — Web Push: caps first, delivery second.
 *
 * The card's requirement is "NOT spammy", and every rule that makes that
 * true lives HERE rather than in whichever component happens to fire a
 * notification. Server-enforced means a buggy (or hostile) client cannot
 * talk its way past the cap, and it means the four triggers — two of them
 * computed in the browser under E2EE — obey one policy:
 *
 *   1. topic disabled            → suppressed (`topic_off`)
 *   2. identical text recently   → suppressed (`duplicate`)
 *   3. per-topic minimum interval → suppressed (`capped_interval`)
 *   4. quiet hours (user's tz)   → suppressed (`quiet_hours`)
 *   5. global daily cap          → suppressed (`capped_daily`)
 *
 * Every decision — sends AND suppressions — is written to `notify_log`, so
 * "why didn't I get one?" is a query instead of a guess. Suppressions are
 * logged too but never consume the interval or the daily cap: a notification
 * suppressed at 23:30 must still be sendable the next morning.
 */

import type { DatabaseSync } from "node:sqlite";
import type { AccountConfig } from "./config";
import {
  DEFAULT_PUSH_PREFS,
  TOPIC_MIN_INTERVAL_MS,
  getPushPrefs,
  lastSentAt,
  lastSentTitle,
  listSubscriptions,
  logNotify,
  sentCountSince,
  recordSubscriptionFailure,
  recordSubscriptionOk,
  deleteSubscriptionByEndpoint,
  type NotifyTopic,
  type PushPrefs,
} from "./db";

/** A push payload: pre-rendered text only. Never readings, never a blob. */
export type NotifyPayload = {
  topic: NotifyTopic;
  title: string;
  body: string;
  /** Where `notificationclick` should land. Same-origin, always `/`. */
  url: string;
};

export type SendDecision = { send: true } | { send: false; outcome: "topic_off" | "duplicate" | "capped_interval" | "quiet_hours" | "capped_daily" };

/** Minutes from local midnight for an instant, given a UTC offset in minutes. */
export function localMinutesOfDay(nowMs: number, tzOffsetMinutes: number): number {
  const shifted = new Date(nowMs + tzOffsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Start of the user's current local day, as a UTC instant. */
export function localDayStart(nowMs: number, tzOffsetMinutes: number): number {
  const shifted = nowMs + tzOffsetMinutes * 60_000;
  return shifted - (shifted % (24 * 60 * 60 * 1000)) - tzOffsetMinutes * 60_000;
}

/**
 * Quiet hours, as a window that may wrap midnight (22:00–07:00 does).
 * Equal bounds mean "no quiet hours", not "always quiet".
 */
export function inQuietHours(nowMs: number, prefs: PushPrefs): boolean {
  if (prefs.quietStart === prefs.quietEnd) return false;
  const m = localMinutesOfDay(nowMs, prefs.tzOffset);
  return prefs.quietStart < prefs.quietEnd
    ? m >= prefs.quietStart && m < prefs.quietEnd
    : m >= prefs.quietStart || m < prefs.quietEnd;
}

/**
 * Apply the five rules in order and return the verdict.
 *
 * Order matters: a topic the user turned off must be reported as `topic_off`
 * (their choice) rather than as a cap (ours), and a duplicate must be
 * distinguishable from a rate limit when someone reads the log.
 */
export function decide(
  db: DatabaseSync,
  accountId: number,
  topic: NotifyTopic,
  title: string,
  prefs: PushPrefs,
  now: number,
): SendDecision {
  if (!prefs.topics.includes(topic)) return { send: false, outcome: "topic_off" };

  const minInterval = TOPIC_MIN_INTERVAL_MS[topic];
  const lastAt = lastSentAt(db, accountId, topic);
  if (lastAt !== null) {
    if (now - lastAt < minInterval) {
      // The plan flapping between two values must not flap at the user:
      // identical text inside the window is a duplicate even if the topic's
      // interval has since elapsed (relevant when intervals shrink later).
      if (lastSentTitle(db, accountId, topic) === title) return { send: false, outcome: "duplicate" };
      return { send: false, outcome: "capped_interval" };
    }
    if (lastSentTitle(db, accountId, topic) === title) return { send: false, outcome: "duplicate" };
  }

  if (inQuietHours(now, prefs)) return { send: false, outcome: "quiet_hours" };

  const sentToday = sentCountSince(db, accountId, localDayStart(now, prefs.tzOffset));
  if (sentToday >= prefs.dailyCap) return { send: false, outcome: "capped_daily" };

  return { send: true };
}

/**
 * WHO gets a notification. Required, and it is a union rather than an
 * optional argument on purpose.
 *
 * Round 1 of the security review found `POST /account/notify` calling
 * `fanOut(cfg, db, payload)` with the target simply *missing* — which, under
 * an optional parameter, silently meant "every account on this server": one
 * signed-in session could push its own usage-derived text to everyone else's
 * phone and burn their daily cap doing it. Making the caller state the target
 * turns that omission into a type error instead of a broadcast.
 *
 * `{ scope: "all" }` is still real — the two SERVER-origin triggers (new OEB
 * rates, new CMD data) are true for every account by nature, and only the
 * internal, edge-denied, token-checked route and the rate watcher may use it.
 */
export type NotifyTarget = { scope: "account"; accountId: number } | { scope: "all" };

/**
 * Fan one notification out to the accounts a `NotifyTarget` names.
 *
 * Returns how many subscriptions were actually delivered to. A suppressed
 * notification returns 0 with the outcome logged; a failure to reach a push
 * service is logged per subscription, not per account, because that is what
 * the operator needs to see.
 */
export async function fanOut(
  cfg: AccountConfig,
  db: DatabaseSync,
  payload: NotifyPayload,
  target: NotifyTarget,
): Promise<{ sent: number; suppressed: string | null }> {
  const targets =
    target.scope === "all"
      ? (db.prepare("SELECT id FROM accounts").all() as unknown as { id: number }[])
      : [{ id: target.accountId }];

  let sent = 0;
  let suppressed: string | null = null;

  for (const target of targets) {
    const prefs = getPushPrefs(db, target.id);
    const now = Date.now();
    const verdict = decide(db, target.id, payload.topic, payload.title, prefs, now);

    if (!verdict.send) {
      logNotify(db, {
        accountId: target.id,
        topic: payload.topic,
        title: payload.title,
        outcome: verdict.outcome,
      });
      suppressed = suppressed ?? verdict.outcome;
      continue;
    }

    const subs = listSubscriptions(db, target.id);
    if (subs.length === 0) {
      logNotify(db, {
        accountId: target.id,
        topic: payload.topic,
        title: payload.title,
        outcome: "no_subscriptions",
      });
      suppressed = suppressed ?? "no_subscriptions";
      continue;
    }

    const results = await Promise.all(subs.map((sub) => sendToSubscription(cfg, db, sub, payload)));
    const delivered = results.filter((r) => r === "sent").length;
    if (delivered > 0) {
      sent += delivered;
      logNotify(db, {
        accountId: target.id,
        topic: payload.topic,
        title: payload.title,
        outcome: "sent",
        detail: `${delivered}/${subs.length}`,
      });
    } else {
      logNotify(db, {
        accountId: target.id,
        topic: payload.topic,
        title: payload.title,
        outcome: "send_failed",
        detail: results.join(","),
      });
      suppressed = suppressed ?? "send_failed";
    }
  }

  return { sent, suppressed };
}

type SubResult = "sent" | "gone" | "failed" | "unconfigured";

async function sendToSubscription(
  cfg: AccountConfig,
  db: DatabaseSync,
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: NotifyPayload,
): Promise<SubResult> {
  if (!cfg.vapid) return "unconfigured";

  const { sendNotification } = await import("web-push");
  try {
    await sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: cfg.vapid.subject,
          publicKey: cfg.vapid.publicKey,
          privateKey: cfg.vapid.privateKey,
        },
        TTL: 60 * 60 * 12,
      },
    );
    recordSubscriptionOk(db, sub.endpoint);
    return "sent";
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    // 404/410: the browser already unsubscribed. Drop it rather than
    // hammering a dead endpoint forever (the card's "dead subs on 410").
    if (status === 404 || status === 410) {
      deleteSubscriptionByEndpoint(db, sub.endpoint);
      return "gone";
    }
    const failures = recordSubscriptionFailure(db, sub.endpoint);
    if (failures >= 5) {
      // Persistent failure across five attempts: stop retrying. The
      // subscription can come back with a fresh subscribe().
      deleteSubscriptionByEndpoint(db, sub.endpoint);
    }
    return "failed";
  }
}

/** Defaults for a brand-new account (documented in the prefs UI). */
export const DEFAULT_PREFS = DEFAULT_PUSH_PREFS;
