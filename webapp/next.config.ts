import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
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
