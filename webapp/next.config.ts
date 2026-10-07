import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    // CORS transport for the client-side rate staleness check. OEB publishes
    // HTML only — no JSON (406), no RSS (404), and no Access-Control-Allow-
    // Origin header — so the browser cannot fetch the page cross-origin. This
    // fixed-destination, stateless rewrite proxies it same-origin; ALL check
    // logic (parse/compare/banner) still runs client-side in
    // src/hooks/useRateStaleness.ts. No server state, no backend code.
    return [
      {
        source: '/oeb-rates-page',
        destination: 'https://www.oeb.ca/consumer-information-and-protection/electricity-rates',
      },
    ];
  },
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
