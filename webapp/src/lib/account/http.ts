/**
 * Wave N — HTTP plumbing shared by every `/account/*` route handler.
 *
 * Three gates live here and each handler goes through them:
 *
 *  1. `requireEnabled()`  — 404 unless THIS process was told to be the
 *     account server (`ACCT_ENABLED=true`). The public app container sets no
 *     `ACCT_*` at all, so it answers 404 to every account route: no password
 *     verifier, no session token and no VAPID key can be exercised from the
 *     container that serves the public site.
 *  2. `isSameOrigin()`    — a cross-site page must never be able to poke the
 *     account API (CSRF: the session rides a cookie).
 *  3. `requireSession()`  — the HttpOnly `acct_session` cookie, 90-day
 *     sliding with token rotation, byte-for-byte the same contract as Wave
 *     K's `gb_session`.
 *
 * Body reading is always bounded (`readJsonCapped`): nginx admits 64 MB for
 * the XML import path, so an unbounded `request.json()` would hand an
 * unauthenticated caller a 64 MB allocation per request — the exact finding
 * that produced the capped reader in `greenbutton/notify/[token]`.
 */

import { NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { getAccountConfig, SESSION_COOKIE, MAX_SYNC_BYTES, assertAccountDataDir, type AccountConfig } from "./config";
import {
  openDb,
  findSession,
  findAccountById,
  touchSession,
  pruneSessions,
  type AccountRow,
} from "./db";
import { hashToken, newSessionToken, secretEquals } from "./auth";
import { ensureAccountServices } from "./services";

export const ACCOUNT_DISABLED_STATUS = 404;

/* --------------------------------------------------------------------------
 * JSON helpers — `Cache-Control: no-store` on everything account-shaped:
 * a response that says whether you are logged in must never sit in a cache.
 * ------------------------------------------------------------------------ */

export function accountJson(body: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

export function accountError(status: number, error: string, detail?: string): NextResponse {
  const body: Record<string, string> = { error };
  if (detail) body.detail = detail.slice(0, 500);
  return accountJson(body, { status });
}

/**
 * 429 with a machine-readable `Retry-After`.
 *
 * The number appears three times on purpose: as the header (what HTTP
 * clients read), as `retryAfterSeconds` (what our `fetch` wrapper can pass
 * on without parsing headers), and inside `detail` (what a human reads).
 * `ratelimit.ts#peek` never answers below 1 second.
 */
export function rateLimitError(retryAfterSeconds: number): NextResponse {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const res = accountJson(
    {
      error: "rate_limited",
      detail: `Too many attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      retryAfterSeconds: seconds,
    },
    { status: 429 },
  );
  res.headers.set("retry-after", String(seconds));
  return res;
}

/**
 * Gate 1. Returns the config when this process is the account server,
 * otherwise a 404 Response the caller returns as-is.
 *
 * The 404 is deliberately indistinguishable from "route does not exist": an
 * app-container response must not confirm that an account feature exists
 * somewhere else behind the router.
 */
export function requireEnabled(): AccountConfig | NextResponse {
  const cfg = getAccountConfig();
  if (!cfg.enabled) return accountError(404, "not_found");
  assertAccountDataDir(cfg);
  ensureAccountServices();
  return cfg;
}

/**
 * Gate 1 for the verbs a route does not export.
 *
 * The routes exist in the bundle in BOTH processes — same image — so Next
 * routes by path FIRST and answers a method the route has no handler for
 * itself: `405 Method Not Allowed`, plus an auto-`OPTIONS` `204` carrying
 * `Allow`. Both answers come from the router, before any handler (and so
 * before `requireEnabled()`) can run, so on a deployment with the feature
 * off they would admit that an account API exists on this origin — which
 * is exactly what SECURITY.md 5.1 ("indistinguishable from no such route")
 * forbids. "Invisible, not broken" has to hold for every method, not just
 * the one the handler implements.
 *
 * So every `/account/*` route re-exports one of these shared stubs for the
 * verbs it does not implement: ordinary account routes use `wrongMethod`,
 * while registration/recovery/mailbox routes use `wrongEmailMethod` so the
 * independent mailbox flag is carried to every verb. `HEAD` needs no export
 * of its own: Next serves it from the route's `GET`, stub or real, which is
 * why `GET` must be stubbed wherever it is missing.
 *
 * `request` is read only so the enabled-path answer can name the method;
 * Next calls every export as `(request, context)`.
 */
export function wrongMethod(request: Request): NextResponse {
  if (!getAccountConfig().enabled) return accountError(404, "not_found");
  return accountError(405, "method_not_allowed", `${request.method} is not supported on this route.`);
}

/** Method stub for routes that only exist when mailbox verification is on. */
export function wrongEmailMethod(request: Request): NextResponse {
  const cfg = getAccountConfig();
  if (!cfg.enabled || !cfg.emailVerificationEnabled) return accountError(404, "not_found");
  return accountError(405, "method_not_allowed", `${request.method} is not supported on this route.`);
}

/** The database handle for an enabled process. */
export function getDb(cfg: AccountConfig): DatabaseSync {
  return openDb(cfg.dbPath);
}

/* --------------------------------------------------------------------------
 * Cookies
 * ------------------------------------------------------------------------ */

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** HttpOnly/Secure/SameSite=Lax — identical contract to `gb_session`. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = getAccountConfig().publicOrigin.startsWith("https://");
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Attach the session cookie to a response.
 *
 * `headers.append` rather than `.set`: a response may need BOTH the rotated
 * value and nothing else — `.set` would silently drop a cookie the handler
 * already added.
 */
export function applySessionCookie(res: NextResponse, token: string, maxAgeSeconds: number): NextResponse {
  res.headers.append("set-cookie", sessionCookie(token, maxAgeSeconds));
  return res;
}

/** Detach the session cookie (logout). */
export function clearSessionCookie(res: NextResponse): NextResponse {
  res.headers.append("set-cookie", sessionCookie("", 0));
  return res;
}

/* --------------------------------------------------------------------------
 * Gate 2 — same-origin
 *
 * Same-origin GETs and top-level navigations carry no Origin header at all,
 * so an absent header is fine; what must not pass is an Origin we don't own.
 * ------------------------------------------------------------------------ */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;
  const cfg = getAccountConfig();
  const allowed = new Set([cfg.publicOrigin, new URL(request.url).origin]);
  return allowed.has(origin.replace(/\/+$/, ""));
}

/** Gate 2 as a response: returns null when the request may proceed. */
export function rejectCrossOrigin(request: Request): NextResponse | null {
  return isSameOrigin(request) ? null : accountError(403, "cross_origin_blocked");
}

/* --------------------------------------------------------------------------
 * Gate 3 — session
 * ------------------------------------------------------------------------ */

export type Authenticated = {
  account: AccountRow;
  /** The token this request authenticated with (for a Max-Age refresh). */
  currentToken: string;
  /**
   * Hash of the session row that is live NOW — after rotation, if any.
   * Logout deletes by this, not by the cookie it was handed, so a rotation
   * that happened on the same request cannot leave an orphaned row.
   */
  sessionHash: string;
  /** Set when the token was rotated this request — the caller sets the cookie. */
  rotatedToken: string | null;
  /** True when this request slid the expiry (cookie max-age should refresh). */
  extended: boolean;
};

/**
 * Rotation is OPT-IN per route, and the default must stay `false`.
 *
 * Rotating mints a new token, deletes the old row and hands the new value
 * back for the caller to put in a `Set-Cookie`. A route that forgets to do
 * that hands the browser a cookie whose row no longer exists: the next
 * request 401s as "session expired" and an orphaned, live session row sits
 * in the database that nobody holds a token for. That is exactly the defect
 * security review round 1 found (L1), so the safe failure is now the default:
 * only `GET /account/session` — the one route that both rotates and applies
 * the cookie — passes `{ rotate: true }`.
 *
 * Everything else still slides the row's expiry (`touchSession`), so a busy
 * session never expires server-side; it simply keeps the same token until
 * the next session probe refreshes it.
 */
export type SessionGateOptions = { rotate?: boolean };

/* --------------------------------------------------------------------------
 * Union guards — the two "gate returned a response" shapes, so route handlers
 * read as `if (!isOk(auth)) return auth;` instead of duck-typing NextResponse.
 * ------------------------------------------------------------------------ */

export function isConfig(value: AccountConfig | NextResponse): value is AccountConfig {
  return (value as AccountConfig).enabled !== undefined;
}

export function isAuth(value: Authenticated | NextResponse): value is Authenticated {
  return (value as Authenticated).account !== undefined;
}

/**
 * Resolve the session cookie to an account.
 *
 * Rotation (opt-in, `options.rotate`): a session untouched for more than a
 * day is re-minted, so the value in the browser is never the value it held
 * last month. Rotation happens on a request that was already authenticated
 * with the old value, so it cannot be used to enumerate sessions — and only
 * a route that writes the resulting `Set-Cookie` may ask for it.
 */
export function requireSession(
  request: Request,
  cfg: AccountConfig,
  options: SessionGateOptions = {},
): Authenticated | NextResponse {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return accountError(401, "session_required");

  const db = getDb(cfg);
  const row = findSession(db, hashToken(token));
  if (!row) return accountError(401, "session_required");

  const account = findAccountById(db, row.account_id);
  if (!account) {
    // Orphaned session (account deleted): drop it rather than 401-looping.
    return accountError(401, "session_required");
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let rotatedToken: string | null = null;
  // Rotation only where the caller asked for it AND can apply it — see
  // `SessionGateOptions`.
  const stale = options.rotate === true && now - row.last_seen_at > dayMs;

  let sessionHash = row.token_hash;
  if (stale) {
    const next = newSessionToken();
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    touchSessionFor(db, next.hash, row.account_id, cfg.sessionTtlMs);
    rotatedToken = next.token;
    sessionHash = next.hash;
  } else {
    touchSession(db, row.token_hash, cfg.sessionTtlMs);
  }

  return { account, currentToken: token, sessionHash, rotatedToken, extended: stale };
}

/** Insert-after-rotate helper (kept here so db.ts stays storage-only). */
function touchSessionFor(db: DatabaseSync, tokenHash: string, accountId: number, ttlMs: number): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(tokenHash, accountId, now, now + ttlMs, now);
}

/** Session housekeeping, cheap enough to run opportunistically on a login. */
export function pruneExpiredSessions(cfg: AccountConfig): void {
  pruneSessions(getDb(cfg));
}

/* --------------------------------------------------------------------------
 * Bounded body reads
 * ------------------------------------------------------------------------ */

export type CappedRead = { ok: true; value: unknown } | { ok: false; error: string; status: number };

/**
 * Read at most `maxBytes` of JSON off a request body, then cancel the rest.
 *
 * Returns a parse error naming the problem rather than swallowing it: an
 * account API that answers "bad request" to everything is untestable.
 */
export async function readJsonCapped(request: Request, maxBytes = MAX_SYNC_BYTES): Promise<CappedRead> {
  const body = request.body;
  if (!body) return { ok: false, error: "Request body is empty.", status: 400 };

  const parts: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    const reader = body.getReader();
    while (total <= maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        parts.push(value.subarray(0, Math.max(room, 0)));
        total = maxBytes;
        overflow = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      parts.push(value);
      total += value.byteLength;
    }
  } catch {
    return { ok: false, error: "The request body could not be read.", status: 400 };
  }

  if (overflow) {
    return {
      ok: false,
      error: `That upload is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`,
      status: 413,
    };
  }

  const text = Buffer.concat(parts).toString("utf8");
  if (text.trim() === "") return { ok: false, error: "Request body is empty.", status: 400 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    // This string is rendered by the browser — it becomes AccountApiError
    // detail and then say()/notify() copy — so JSON.parse's own message
    // must never be echoed. The LOG gets only shape, not text: on node the
    // unexpected-token message embeds an excerpt of the input, so logging
    // `e` would print a fragment of a password-bearing body (gate t_a0a48336
    // item 1; pinned by serverRawException.test.ts).
    console.warn("[account] request body is not valid JSON", {
      bytes: text.length,
      name: e instanceof Error ? e.name : typeof e,
    });
    return {
      ok: false,
      error: "Request body is not valid JSON.",
      status: 400,
    };
  }
}

/** Read a small JSON body (credentials, prefs) under a 64 KB cap. */
export function readJsonSmall(request: Request): Promise<CappedRead> {
  return readJsonCapped(request, 64 * 1024);
}

/** Bounded raw text read for signed webhook bodies; never buffers untrusted input. */
export async function readTextCapped(request: Request, maxBytes = 64 * 1024): Promise<{ ok: true; value: string } | { ok: false; status: number }> {
  const body = request.body;
  if (!body) return { ok: false, status: 400 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return { ok: false, status: 400 };
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

/** Pull a string field out of a parsed body without trusting its type. */
export function stringField(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/** Constant-time token check for the internal (edge-denied) fan-out route. */
export function internalTokenMatches(request: Request, cfg: AccountConfig): boolean {
  if (!cfg.internalToken) return false;
  return secretEquals(request.headers.get("x-account-internal"), cfg.internalToken);
}
