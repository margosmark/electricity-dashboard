import type { NextConfig } from "next";

// NOTE: the former `rewrites()` — the `/oeb-rates-page` pass-through to
// www.oeb.ca — is now a route handler at src/app/oeb-rates-page/route.ts.
// A rewrite forwards the upstream response HEADERS as-is, and OEB's own
// (~5 KB, two Drupal CSP headers among them) overflowed nginx's first-read
// proxy buffer: `upstream sent too big header` → 502 (production,
// 2026-10-17). The route handler streams the upstream body and reissues
// only the headers this origin asserts, so the transport's header size is
// no longer an oeb.ca function.

const nextConfig: NextConfig = {
  output: 'standalone',

  async headers() {
    // Baseline transport headers, on EVERY response (`/:path*` matches the
    // root and every segment count, so nothing — sw.js, the manifest, the
    // /greenbutton routes — is left out).
    //
    // HSTS is what stops an active MITM from holding a first-time visitor on
    // the plaintext path — and this is the page that reads localStorage meter
    // data, so a poisoned HTML/JS response on that path is a data exfil. The
    // edge already 302s http→https, but a redirect is a request, not a
    // guarantee; only a header on the TLS response is. The frame guard
    // matters because the connect flow is click-driven (frame the page, bait
    // the Authorise click).
    //
    // They live here, not in nginx: this travels with the build instead of
    // depending on a proxy config we do not control.
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
    ];

    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // The service worker script must never be served stale — that's how users
        // get trapped on an old app shell after a deploy.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
