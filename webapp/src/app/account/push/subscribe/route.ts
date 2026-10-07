/**
 * POST/DELETE /account/push/subscribe — a browser's Web Push subscription.
 *
 * A subscription is an endpoint + two keys the browser generated; it is not
 * a credential for anything else, and it is per-account rather than
 * per-device (a phone that re-subscribes replaces its own endpoint, because
 * the endpoint string is what identifies it). An endpoint is NOT a secret,
 * so ownership is checked before it is written: presenting an endpoint that
 * already belongs to another account is a 409, never a re-pointing (L2 in
 * the round-1 review).
 *
 * `POST` requires the VAPID keys to exist: answering 201 to a subscription
 * we can never deliver to would be a lie the user only discovers weeks
 * later, when a notification does not arrive.
 */

import { deleteSubscription, findSubscriptionOwner, listSubscriptions, upsertSubscription } from "@/lib/account/db";
import {
  accountError,
  accountJson,
  getDb,
  isAuth,
  isConfig,
  readJsonSmall,
  rejectCrossOrigin,
  requireEnabled,
  requireSession,
} from "@/lib/account/http";

export const dynamic = "force-dynamic";

type SubscribeBody = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

/** Push endpoints are always `https:` (or `webpush:` on some test harnesses). */
function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "webpush:";
  } catch {
    return false;
  }
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) return auth;

  if (!cfg.vapid) {
    return accountError(503, "push_unconfigured", "This server has no VAPID keys — notifications are not enabled.");
  }

  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as SubscribeBody;

  if (!validEndpoint(value.endpoint)) return accountError(400, "invalid_subscription", "endpoint is not a valid push URL.");
  if (!validKey(value.keys?.p256dh) || !validKey(value.keys?.auth)) {
    return accountError(400, "invalid_subscription", "keys.p256dh and keys.auth are required.");
  }

  const db = getDb(cfg);
  // An endpoint identifies a DEVICE, not a person, and it is not a secret —
  // so a session that presents somebody else's endpoint gets an explicit
  // refusal instead of quietly stealing (or un-stealing) their subscription.
  // The SQL in `upsertSubscription` enforces the same rule; this is the
  // version a human can read.
  const owner = findSubscriptionOwner(db, value.endpoint);
  if (owner !== null && owner !== auth.account.id) {
    return accountError(
      409,
      "endpoint_taken",
      "That push endpoint is already registered to another account on this server. Sign out there (or unsubscribe) first.",
    );
  }

  upsertSubscription(db, auth.account.id, {
    endpoint: value.endpoint,
    p256dh: value.keys!.p256dh as string,
    auth: value.keys!.auth as string,
  });

  return accountJson({ ok: true, subscriptions: listSubscriptions(db, auth.account.id).length }, { status: 201 });
}

export async function DELETE(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) return auth;

  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const endpoint = (body.value as { endpoint?: unknown } | null)?.endpoint;
  if (!validEndpoint(endpoint)) return accountError(400, "invalid_subscription", "endpoint is not a valid push URL.");

  deleteSubscription(getDb(cfg), auth.account.id, endpoint);
  return accountJson({ ok: true, subscriptions: listSubscriptions(getDb(cfg), auth.account.id).length });
}
