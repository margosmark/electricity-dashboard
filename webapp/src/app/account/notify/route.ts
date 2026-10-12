/**
 * POST /account/notify — a browser asks the server to notify THAT user.
 *
 * This is the client-origin half of the trigger table (WAVE-N-DESIGN.md §7).
 * Under E2EE the server cannot compute "your best plan changed" or "this day
 * was an anomaly" — those need `energy_data`, which it cannot read — so the
 * browser computes them and posts PRE-RENDERED TEXT here. The server's job is
 * then only to decide whether it may be sent, and that decision is the same
 * one every other trigger gets (`lib/account/push.ts#decide`), because the
 * caps are enforced here rather than trusted from the client.
 *
 * TWO BOUNDS THIS ROUTE MUST NOT LEAVE, both learned from round 1 of the
 * security review:
 *
 *  1. **The target is the caller.** `fanOut` takes an explicit
 *     `NotifyTarget`; passing `{ scope: "account", accountId }` from the
 *     session means a hostile client can reach exactly one account — its
 *     own. Leaving it out used to mean "every account", which turned a
 *     signed-in session into a broadcast primitive: usage-derived text to
 *     other people's phones, arbitrary title/body under this app's name, and
 *     the victim's daily cap burned by someone else's send (H1).
 *  2. **The topic is client-origin.** `plan_change` and `anomaly` are the
 *     two things a browser can legitimately observe. Claiming `oeb_rates` or
 *     `data_available` would be announcing public state this client cannot
 *     see, and would squat the dedup window those server-side triggers read
 *     back out of `notify_log`.
 *
 * The body carries no readings and no blob: a title, a sentence, a topic.
 * A hostile client can therefore spam ITSELF at most `dailyCap` times a day —
 * which is the whole point of the cap. What the server does see of that
 * sentence is written up in SECURITY.md §5 ("what a notification may carry").
 */

import { CLIENT_NOTIFY_TOPICS, isClientNotifyTopic, topicList, type NotifyTopic } from "@/lib/account/db";
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
import { fanOut } from "@/lib/account/push";

export const dynamic = "force-dynamic";

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) return auth;

  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as { topic?: unknown; title?: unknown; body?: unknown; url?: unknown };

  if (!isClientNotifyTopic(value.topic)) {
    return accountError(400, "invalid_topic", `topic must be one of: ${topicList(CLIENT_NOTIFY_TOPICS)}.`);
  }
  const title = cleanText(value.title, 200);
  if (!title) return accountError(400, "invalid_payload", "title is required.");
  const text = cleanText(value.body, 500) ?? title;

  const result = await fanOut(
    cfg,
    getDb(cfg),
    {
      topic: value.topic as NotifyTopic,
      title,
      body: text,
      url: "/",
    },
    { scope: "account", accountId: auth.account.id },
  );

  // 200 either way: a suppressed notification is a correct outcome, not a
  // client error. The reason is in `notify_log`, and the count here lets a
  // test assert the cap without reading the database.
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
