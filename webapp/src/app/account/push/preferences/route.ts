/**
 * GET/PUT /account/push/preferences — the anti-spam policy, per user.
 *
 * The card's requirement is "NOT spammy: per-user notification preferences
 * UI (what to notify about + frequency cap)". This is where that becomes
 * enforceable rather than aspirational: the same numbers are read by
 * `lib/account/push.ts#decide`, which every send goes through — so what the
 * panel promises and what the server does cannot drift apart.
 */

import { getPushPrefs, listSubscriptions, setPushPrefs, TOPIC_MIN_INTERVAL_MS, isNotifyTopic, NOTIFY_TOPICS, type PushPrefs } from "@/lib/account/db";
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

export async function GET(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) return auth;

  const db = getDb(cfg);
  return accountJson({
    prefs: getPushPrefs(db, auth.account.id),
    subscriptionCount: listSubscriptions(db, auth.account.id).length,
    pushConfigured: Boolean(cfg.vapid),
    vapidPublicKey: cfg.vapid?.publicKey ?? null,
    // The policy itself, so the settings UI can explain each row instead of
    // hard-coding a number the server might not share.
    topics: NOTIFY_TOPICS.map((topic) => ({
      topic,
      minIntervalMs: TOPIC_MIN_INTERVAL_MS[topic],
    })),
  });
}

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function PUT(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) return auth;

  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const incoming = (body.value ?? {}) as Record<string, unknown>;

  const current = getPushPrefs(getDb(cfg), auth.account.id);
  const next: PushPrefs = { ...current, topics: [...current.topics] };

  if (incoming.topics !== undefined) {
    if (!Array.isArray(incoming.topics)) return accountError(400, "invalid_prefs", "topics must be an array.");
    // Whitelist: a hostile body can only name topics this build knows.
    next.topics = incoming.topics.filter(isNotifyTopic);
  }
  if (incoming.dailyCap !== undefined) {
    const v = clampInt(incoming.dailyCap, 0, 20);
    if (v === null) return accountError(400, "invalid_prefs", "dailyCap must be a number.");
    next.dailyCap = v;
  }
  if (incoming.quietStart !== undefined) {
    const v = clampInt(incoming.quietStart, 0, 1439);
    if (v === null) return accountError(400, "invalid_prefs", "quietStart must be minutes from midnight.");
    next.quietStart = v;
  }
  if (incoming.quietEnd !== undefined) {
    const v = clampInt(incoming.quietEnd, 0, 1439);
    if (v === null) return accountError(400, "invalid_prefs", "quietEnd must be minutes from midnight.");
    next.quietEnd = v;
  }
  if (incoming.tzOffset !== undefined) {
    const v = clampInt(incoming.tzOffset, -840, 840);
    if (v === null) return accountError(400, "invalid_prefs", "tzOffset must be minutes east of UTC.");
    next.tzOffset = v;
  }

  setPushPrefs(getDb(cfg), auth.account.id, next);
  return accountJson({ ok: true, prefs: next });
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
export { wrongMethod as POST, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
