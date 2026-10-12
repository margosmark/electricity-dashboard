// @vitest-environment node
/**
 * The proxy that labels every response with `x-gb-process`.
 *
 * It exists because the router's own header is derived from which location
 * matched, so it reported `shim` even while the app container was serving the
 * request (security finding H1, 2026-10-07). These two tests pin the property
 * that makes the replacement falsifiable: the value comes from this process's
 * config, and the matcher covers the routes that need to prove it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import proxy, { config } from "@/proxy";
import { resetConfigCache } from "@/lib/greenbutton/config";

afterEach(() => {
  delete process.env.GB_TOKEN_FILE;
  resetConfigCache();
});

describe("x-gb-process proxy", () => {
  it("labels the response from this process's config", () => {
    delete process.env.GB_TOKEN_FILE;
    resetConfigCache();
    expect(proxy().headers.get("x-gb-process")).toBe("app");

    process.env.GB_TOKEN_FILE = "/var/lib/greenbutton/tokens.json";
    resetConfigCache();
    expect(proxy().headers.get("x-gb-process")).toBe("shim");
  });

  it("ships a Content-Security-Policy that blocks external script injection", () => {
    const csp = proxy().headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();

    // The OEB page is proxied onto OUR origin, so same-origin script execution
    // is the threat this controls. `object-src`/`base-uri`/`frame-ancestors`
    // are the ones that cannot be worked around with markup.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");

    // Only the Open-Meteo archive API is reachable; there is no `*` anywhere,
    // which is what would let an injected page exfiltrate the readings.
    expect(csp).toContain("connect-src 'self' https://archive-api.open-meteo.com");
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
    expect(csp).not.toMatch(/default-src[^;]*\*/);

    // NOTE: `script-src` carries 'unsafe-inline', which is weaker than the
    // nonce-based policy Next documents. It is deliberate and load-bearing:
    // `/`, `/import` and the 404 are prerendered (○ Static), so a per-request
    // nonce cannot exist — measured against a real `next start`, the flight
    // payload rendered `nonce="$undefined"` and a nonce policy blocked it,
    // breaking hydration entirely. See the comment on buildCsp.
    expect(csp).toContain("script-src 'self'");
  });

  it("omits upgrade-insecure-requests off https so local http dev still works", () => {
    // No request (as the x-gb-process test calls it) means "not a known
    // origin" — treated as secure, the production shape.
    expect(proxy().headers.get("Content-Security-Policy")).toContain("upgrade-insecure-requests");

    const httpReq = new NextRequest("http://localhost:3939/");
    expect(proxy(httpReq).headers.get("Content-Security-Policy")).not.toContain(
      "upgrade-insecure-requests",
    );

    const httpsReq = new NextRequest("https://electricity.markarslan.ca/");
    expect(proxy(httpsReq).headers.get("Content-Security-Policy")).toContain(
      "upgrade-insecure-requests",
    );
  });

  it("ships the cheap companion headers", () => {
    const res = proxy();
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("matches the pages and routes, not the immutable assets", () => {
    // Next compiles a matcher source into an anchored path RegExp — verified
    // against a real `next start`: /, /api/rates and /greenbutton/status come
    // back with x-gb-process, /_next/static/…, /sw.js and
    // /manifest.webmanifest come back without it.
    const [pattern] = config.matcher;
    const re = new RegExp(`^(?:${pattern})$`);
    expect(re.test("/")).toBe(true);
    expect(re.test("/greenbutton/status")).toBe(true);
    expect(re.test("/api/rates")).toBe(true);
    expect(re.test("/_next/static/chunks/x.js")).toBe(false);
    expect(re.test("/_next/static/media/font.woff2")).toBe(false);
    expect(re.test("/sw.js")).toBe(false);
    expect(re.test("/manifest.webmanifest")).toBe(false);
  });
});
