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
