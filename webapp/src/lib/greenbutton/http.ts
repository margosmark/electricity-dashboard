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
import { getConfig } from "./config";
import { getTokenStore, type TokenSet } from "./tokens";

export const SESSION_COOKIE = "gb_session";
export const STATE_COOKIE = "gb_state";

/** Session cookie lifetime: the authorisation is years-long, so is this. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365 * 10;

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
function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sessionMatches(request: Request, tokens: TokenSet | null): boolean {
  if (!tokens?.sessionToken) return false;
  return secretEquals(readCookie(request, SESSION_COOKIE), tokens.sessionToken);
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
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Redirect back into the app with a machine-readable result flag. */
export function redirectToApp(query: string): NextResponse {
  return NextResponse.redirect(new URL(`/?${query}`, appOrigin()).toString(), 302);
}

export { getConfig, getTokenStore };
