/**
 * POST/DELETE /account/push/subscribe — a browser's Web Push subscription.
 *
 * A subscription is an endpoint + two keys the browser generated; it is not
 * a credential for anything else, and it is per-account rather than
 * per-device (a phone that re-subscribes replaces its own endpoint, because
 * the endpoint string is what identifies it).
 *
 * `POST` requires the VAPID keys to exist: answering 201 to a subscription
 * we can never deliver to would be a lie the user only discovers weeks
 * later, when a notification does not arrive.
 */

import { deleteSubscription, listSubscriptions, upsertSubscription } from "@/lib/account/db";
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

  upsertSubscription(getDb(cfg), auth.account.id, {
    endpoint: value.endpoint,
    p256dh: value.keys!.p256dh as string,
    auth: value.keys!.auth as string,
  });

  return accountJson(
    { ok: true, subscriptions: listSubscriptions(getDb(cfg), auth.account.id).length },
    { status: 201 },
  );
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
