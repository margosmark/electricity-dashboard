import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  /* config options here */
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
};

export default nextConfig;
