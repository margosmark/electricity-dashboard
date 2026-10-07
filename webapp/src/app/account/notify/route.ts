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
 * The body carries no readings and no blob: a title, a sentence, a topic.
 * A hostile client can therefore spam itself at most `dailyCap` times a day —
 * which is the whole point of the cap.
 */

import { isNotifyTopic, type NotifyTopic } from "@/lib/account/db";
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

  if (!isNotifyTopic(value.topic)) {
    return accountError(400, "invalid_topic", `topic must be one of: plan_change, oeb_rates, data_available, anomaly.`);
  }
  const title = cleanText(value.title, 200);
  if (!title) return accountError(400, "invalid_payload", "title is required.");
  const text = cleanText(value.body, 500) ?? title;

  const result = await fanOut(cfg, getDb(cfg), {
    topic: value.topic as NotifyTopic,
    title,
    body: text,
    url: "/",
  });

  // 200 either way: a suppressed notification is a correct outcome, not a
  // client error. The reason is in `notify_log`, and the count here lets a
  // test assert the cap without reading the database.
  return accountJson({ ok: true, sent: result.sent, suppressed: result.suppressed });
}
