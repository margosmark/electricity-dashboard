// @vitest-environment node
/**
 * Pins the transport/session claims SECURITY.md §4 makes, so a regression
 * fails CI instead of waiting for a reviewer with a curl prompt:
 *
 *  1. the four baseline security headers are on every response, with the
 *     exact values the doc quotes (HSTS in particular — dropping it silently
 *     reopens SSL-strip on the page that reads localStorage);
 *  2. the service worker's no-cache headers survived the change;
 *  3. `gb_session` can never be minted for longer than 90 days, and the
 *     Set-Cookie it is built from is HttpOnly + SameSite=Lax (+ Secure on
 *     https).
 *
 * That these headers actually reach a browser is asserted end to end in
 * webapp/scripts/e2e-greenbutton-topology.sh (real container, real router).
 */

import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";
import { SESSION_COOKIE, SESSION_MAX_AGE, sessionSetCookie } from "@/lib/greenbutton/http";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

const EXPECTED: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

async function headerRules(): Promise<HeaderRule[]> {
  const fn = nextConfig.headers;
  if (typeof fn !== "function") throw new Error("webapp/next.config.ts must define headers()");
  return (await fn()) as HeaderRule[];
}

function headersOf(rules: HeaderRule[], source: string): Map<string, string> {
  const rule = rules.find((r) => r.source === source);
  if (!rule) throw new Error(`no header rule for source "${source}"`);
  return new Map(rule.headers.map((h) => [h.key, h.value]));
}

describe("baseline security headers", () => {
  it("carries all four on /:path*, with the values SECURITY.md quotes", async () => {
    const headers = headersOf(await headerRules(), "/:path*");
    for (const [key, value] of Object.entries(EXPECTED)) {
      expect(headers.get(key), `missing or changed: ${key}`).toBe(value);
    }
  });

  it("matches the root as well as every subpath", async () => {
    // `:path*` is zero-or-more segments in the Next.js path matcher, so "/"
    // (no segments) is covered too. Pin the syntax: switching to `:path+`
    // would silently drop the landing page — the one response a first-time
    // visitor over http ever sees.
    const rules = await headerRules();
    expect(rules.map((r) => r.source)).toContain("/:path*");
    expect(rules.map((r) => r.source)).not.toContain("/:path+");
  });

  it("still serves sw.js and the manifest no-cache", async () => {
    const rules = await headerRules();
    expect(headersOf(rules, "/sw.js").get("Cache-Control")).toBe(
      "no-cache, no-store, must-revalidate",
    );
    expect(headersOf(rules, "/sw.js").get("Service-Worker-Allowed")).toBe("/");
    expect(headersOf(rules, "/manifest.webmanifest").get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });
});

describe("gb_session lifetime", () => {
  it("is capped at 90 days — never a decade again", () => {
    expect(SESSION_MAX_AGE).toBeLessThanOrEqual(60 * 60 * 24 * 90);
    expect(SESSION_MAX_AGE).toBe(60 * 60 * 24 * 90);
  });

  it("is rebuilt from an HttpOnly, SameSite=Lax cookie with that exact Max-Age", () => {
    const cookie = sessionSetCookie("a".repeat(48), true);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    // No path scoping to a route an attacker could reach without the gate.
    expect(cookie).not.toContain("Path=/greenbutton");
  });

  it("omits Secure only where the origin really is plain http (local dev)", () => {
    expect(sessionSetCookie("v", false)).not.toContain("Secure");
    expect(sessionSetCookie("v", true)).toContain("Secure");
  });
});
