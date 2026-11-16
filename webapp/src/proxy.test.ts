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

    // Same-origin script execution is the threat this controls — but note
    // WHICH surface that sentence is about: this is the policy for this
    // app's own pages. `/oeb-rates-page` (third-party HTML, a navigable
    // document) is answered with a different, stricter policy — see the
    // "sandbox" test below and src/lib/oebRouteCsp.ts. `object-src`/
    // `base-uri`/`frame-ancestors` are the directives that cannot be worked
    // around with markup on either surface.
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

  it("ships upgrade-insecure-requests ONLY for an inventoried https origin", () => {
    const cspFor = (url: string) =>
      proxy(new NextRequest(url)).headers.get("Content-Security-Policy");

    // The inventory (OPERATIONS.md §Public URL — the one origin whose TLS is
    // handed over).
    expect(cspFor("https://electricity.markarslan.ca/")).toContain(
      "upgrade-insecure-requests",
    );

    // Everything else gets the policy WITHOUT the directive: the LAN surface
    // this shipped broken, localhost, and a bare no-request call.
    for (const url of [
      "http://dashboard.example.internal:3939/",
      "http://localhost:3939/",
      "http://127.0.0.1:3939/",
    ]) {
      expect(cspFor(url), url).not.toContain("upgrade-insecure-requests");
    }
    expect(proxy().headers.get("Content-Security-Policy")).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("REGRESSION: decides by host, never by the request URL's scheme (the :3939 outage)", () => {
    // 7ee0375 read the scheme off `request.url`. Behind edge-router nginx that
    // is ALWAYS https — it sets X-Forwarded-Proto for the whole deployment and
    // cannot distinguish a request forwarded from the public TLS edge from a
    // direct plaintext LAN hit — so a plaintext visitor received
    // `upgrade-insecure-requests`, the browser rewrote all 15 subresources to
    // https://dashboard.example.internal:3939/ (nothing listens there), and the app rendered
    // ZERO interactive elements with hydration never running. An
    // uninventoried host must therefore stay upgrade-free EVEN when the URL
    // says https, which is exactly the shape the outage arrived in.
    const httpsShapedLanHit = new NextRequest("https://dashboard.example.internal:3939/");
    expect(proxy(httpsShapedLanHit).headers.get("Content-Security-Policy")).not.toContain(
      "upgrade-insecure-requests",
    );

    // ...and the inventoried origin keeps it even when the URL says http,
    // because the Host is the signal we trust.
    const inventoried = new NextRequest("http://electricity.markarslan.ca/");
    expect(proxy(inventoried).headers.get("Content-Security-Policy")).toContain(
      "upgrade-insecure-requests",
    );
  });

  it("answers /oeb-rates-page with the SANDBOX policy — the F2 fix (t_9ae84620)", () => {
    // F2 (t_0d85b1f8): this path serves www.oeb.ca's HTML as a navigable
    // document on our origin, and the app-wide policy's `script-src
    // 'unsafe-inline'` let OEB's 4 inline <script> blocks run here with this
    // origin's localStorage in reach (browser-proven before the fix:
    // window.a2a_config / dataLayer / $buoop all became objects).
    //
    // This is the layer that MATTERS: measured with curl against a production
    // build (2026-11-09), Next applies these proxy headers AFTER the route
    // handler's, so the route's own `content-security-policy` never reaches
    // the browser — whatever this function returns for the path is the wire.
    const csp = (url: string) => proxy(new NextRequest(url)).headers.get("Content-Security-Policy");

    const oeb = csp("http://localhost:3000/oeb-rates-page");
    expect(oeb).toBe("sandbox; default-src 'none'");
    // Nothing in a sandboxed policy can permit inline script — the directive
    // that opened F2 must be absent entirely, not merely overridden.
    expect(oeb).not.toContain("unsafe-inline");

    // The sandbox must not leak onto the app's own pages, and a near-miss
    // path must not inherit it either (exact-path match, not prefix).
    for (const url of [
      "http://localhost:3000/",
      "http://localhost:3000/import",
      "http://localhost:3000/api/rates",
      "http://localhost:3000/oeb-rates-page-clone",
    ]) {
      expect(csp(url), url).toContain("default-src 'self'");
      expect(csp(url), url).not.toContain("sandbox");
    }

    // A query string is not a different path — pathname strips it, so the
    // policy cannot be dodged by `?` … (and it is the shape /import's
    // probe-style links take).
    expect(csp("http://localhost:3000/oeb-rates-page?probe=1")).toBe("sandbox; default-src 'none'");
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
    // The path whose CSP branch lives in `proxy()` — if the matcher ever stops
    // covering it, that branch never runs and only the route's own header
    // stands between OEB's inline scripts and this origin.
    expect(re.test("/oeb-rates-page")).toBe(true);
    expect(re.test("/_next/static/chunks/x.js")).toBe(false);
    expect(re.test("/_next/static/media/font.woff2")).toBe(false);
    expect(re.test("/sw.js")).toBe(false);
    expect(re.test("/manifest.webmanifest")).toBe(false);
  });
});
