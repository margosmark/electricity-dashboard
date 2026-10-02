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
    // The service worker script must never be served stale — that's how users
    // get trapped on an old app shell after a deploy.
    return [
      {
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
