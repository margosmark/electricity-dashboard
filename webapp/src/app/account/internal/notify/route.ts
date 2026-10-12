/**
 * POST /account/internal/notify — fan-out for server-origin triggers.
 *
 * Called by the Green Button shim when Oakville Hydro says new data exists
 * (`greenbutton/notify/[token]`), over the docker network, on a path the
 * edge router DENIES (`location /account/internal { deny all; }` in
 * `ops/edge/default.conf.template`). Two locks, deliberately:
 *
 *   - the path never reaches this process from the internet;
 *   - even if it did, the caller must present `X-Account-Internal`, compared
 *     constant-time against `ACCT_INTERNAL_TOKEN`.
 *
 * Why the shim may call this at all, under E2EE: it holds scalars only —
 * `lastSyncAt`, `lastSyncBytes`, `dataAvailableSince`. It can say "something
 * changed at 09:11" without ever holding a reading, and that is exactly the
 * `data_available` trigger.
 *
 * Broadcast by nature: the notification says "your utility posted new data",
 * which is true for every account on this server — so this is one of the two
 * callers allowed to pass `{ scope: "all" }` to `fanOut`. It may only do that
 * for a SERVER-origin topic: accepting `anomaly`/`plan_change` here would
 * mean this endpoint originating usage-derived text nobody's browser asked
 * for (`db.ts#SERVER_NOTIFY_TOPICS`).
 */

import { SERVER_NOTIFY_TOPICS, isServerNotifyTopic, topicList, type NotifyTopic } from "@/lib/account/db";
import {
  accountError,
  accountJson,
  getDb,
  internalTokenMatches,
  isConfig,
  readJsonSmall,
  requireEnabled,
} from "@/lib/account/http";
import { fanOut } from "@/lib/account/push";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;

  // Constant-time even on the miss: no timing difference between "no token
  // configured" and "wrong token".
  if (!internalTokenMatches(request, cfg)) return accountError(404, "not_found");

  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as { topic?: unknown; title?: unknown; body?: unknown; url?: unknown };

  if (!isServerNotifyTopic(value.topic)) {
    return accountError(400, "invalid_topic", `topic must be one of: ${topicList(SERVER_NOTIFY_TOPICS)}.`);
  }
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim().slice(0, 200) : null;
  if (!title) return accountError(400, "invalid_payload", "title is required");

  const result = await fanOut(
    cfg,
    getDb(cfg),
    {
      topic: value.topic as NotifyTopic,
      title,
      body: typeof value.body === "string" ? value.body.slice(0, 500) : title,
      url: typeof value.url === "string" && value.url.startsWith("/") ? value.url : "/",
    },
    { scope: "all" },
  );

  return accountJson({ ok: true, sent: result.sent, suppressed: result.suppressed });
}

/*
 * Wrong-method stubs — see `wrongMethod()` in `lib/account/http.ts`.
 *
 * Next routes by path and answers the verbs this route does not export
 * (and its auto-OPTIONS) before any handler runs, so without these a
 * disabled deployment would answer 405/204 and admit that an account API
 * exists here (SECURITY.md 5.1). With them: 404 while the feature is off,
 * an honest 405 — naming the method — once it is on.
 */
export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
