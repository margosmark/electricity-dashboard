/**
 * Shared HTTP plumbing for the `/greenbutton/*` route handlers.
 *
 * Two gates live here and every handler goes through them:
 *
 *  - same-origin: a cross-site page must never be able to poke the shim.
 *  - session: every data-bearing response requires the HttpOnly `gb_session`
 *    cookie minted by the OAuth callback. Without it the shim — which holds a
 *    live utility access token — would be an unauthenticated meter-data API
 *    behind a public hostname.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getConfig, getProcessIdentity } from "./config";
import { getTokenStore, type TokenSet } from "./tokens";

export const SESSION_COOKIE = "gb_session";
export const STATE_COOKIE = "gb_state";

/**
 * Session cookie lifetime: 90 days, and never more.
 *
 * This used to be a decade — a leaked `gb_session` then granted
 * `/greenbutton/usage` for ten years, while the secret behind it was also
 * sitting in `tokens.json`. 90 days bounds the damage to a stolen cookie,
 * and the value is re-issued on every authenticated data response so a
 * session that is actually in use slides forward instead of being cut off
 * mid-year (see `renewSessionCookie`).
 */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 90;

/** The origin the utility sent us to — also the origin the app is served from. */
export function appOrigin(): string {
  try {
    return new URL(getConfig().redirectUri).origin;
  } catch {
    return "http://localhost:3939";
  }
}

/** Cookies must be Secure on an https deployment but not on local dev. */
export function cookieSecure(): boolean {
  return appOrigin().startsWith("https://");
}

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

/** Constant-time comparison that tolerates length mismatches. */
export function secretEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The session cookie's value if (and only if) this request presents the one
 * currently on file — constant-time, so a timing probe cannot walk a guess
 * toward the stored secret. Returns null otherwise; callers that only need
 * a yes/no want `sessionMatches`.
 */
export function validSession(request: Request, tokens: TokenSet | null): string | null {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!tokens?.sessionToken || !secretEquals(cookie, tokens.sessionToken)) return null;
  return cookie;
}

export function sessionMatches(request: Request, tokens: TokenSet | null): boolean {
  return validSession(request, tokens) !== null;
}

/**
 * `Set-Cookie` that slides an already-authenticated session forward by the
 * full 90 days. Emitted by data-bearing responses, so expiry tracks *use*:
 * a session nobody touches ages out, one that is in weekly use never
 * expires on the user mid-year — and the ceiling on any single cookie
 * remains SESSION_MAX_AGE.
 *
 * Built by hand because these route handlers answer with a plain
 * `Response` (one of them a stream), not a NextResponse.
 *
 * `secure` defaults to what the configured origin implies; it is a parameter
 * so both branches are testable without mutating the shared env.
 */
export function sessionSetCookie(value: string, secure: boolean = cookieSecure()): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Reject cross-site requests. Same-origin GETs and top-level navigations
 * carry no Origin header at all, so an absent header is fine — what must not
 * pass is an Origin we don't own.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;
  const allowed = new Set([appOrigin(), new URL(request.url).origin]);
  return allowed.has(origin.replace(/\/+$/, ""));
}

export function jsonError(status: number, error: string, detail?: string): NextResponse {
  const body: Record<string, string> = { error };
  if (detail) body.detail = detail.slice(0, 500);
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function jsonResponse(body: unknown): NextResponse {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store",
      // Who produced this body — read from this process's own config inside
      // the handler, not from the route that was requested. The two containers
      // run the same code, so this value only differs because their env does;
      // that is what makes it a check instead of a restatement of the URL.
      "x-gb-process": getProcessIdentity(),
    },
  });
}

/** Redirect back into the app with a machine-readable result flag. */
export function redirectToApp(query: string): NextResponse {
  return NextResponse.redirect(new URL(`/?${query}`, appOrigin()).toString(), 302);
}

export { getConfig, getTokenStore };
