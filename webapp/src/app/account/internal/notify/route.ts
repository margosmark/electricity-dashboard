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
 * which is true for every account on this server.
 */

import { isNotifyTopic, type NotifyTopic } from "@/lib/account/db";
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

  if (!isNotifyTopic(value.topic)) return accountError(400, "invalid_topic", "unknown topic");
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim().slice(0, 200) : null;
  if (!title) return accountError(400, "invalid_payload", "title is required");

  const result = await fanOut(cfg, getDb(cfg), {
    topic: value.topic as NotifyTopic,
    title,
    body: typeof value.body === "string" ? value.body.slice(0, 500) : title,
    url: typeof value.url === "string" && value.url.startsWith("/") ? value.url : "/",
  });

  return accountJson({ ok: true, sent: result.sent, suppressed: result.suppressed });
}
