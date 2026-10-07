/**
 * GET /greenbutton/usage — the pipe-through.
 *
 * Refreshes the access token if needed, GETs the custodian's ESPI batch, and
 * streams the Atom/XML body straight into the response. The shim does not
 * parse it, does not buffer it, and does not write it anywhere: the browser
 * runs it through `parseGreenButtonUsagePoints` and stores the readings in
 * localStorage, exactly as if the user had uploaded the file by hand.
 *
 * Query parameters (all optional, all validated):
 *   resourcePath   — relative ESPI suffix (never a URL: see espi.ts)
 *   publishedMin   — epoch seconds, ESPI published-min
 *   publishedMax   — epoch seconds, clamped to now server-side
 */

import { isSafeResourcePath } from "@/lib/greenbutton/espi";
import {
  getConfig,
  getTokenStore,
  isSameOrigin,
  jsonError,
  sessionSetCookie,
  validSession,
} from "@/lib/greenbutton/http";
import { clearDataAvailable } from "@/lib/greenbutton/session";
import { readFeed } from "@/lib/greenbutton/sync";

export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "cross_origin_blocked");

  const cfg = getConfig();
  if (!cfg.configured) return jsonError(503, "not_configured", cfg.unconfiguredReason);

  const store = getTokenStore(cfg.tokenFile);
  const tokens = await store.load();
  if (!tokens) return jsonError(401, "not_connected");
  const session = validSession(request, tokens);
  if (!session) return jsonError(401, "session_required");

  const url = new URL(request.url);
  const resourcePath = url.searchParams.get("resourcePath");
  if (!isSafeResourcePath(resourcePath)) {
    return jsonError(400, "invalid_resource_path");
  }
  const publishedMin = intParam(url.searchParams.get("publishedMin"));
  const publishedMax = intParam(url.searchParams.get("publishedMax"));
  if (publishedMin === "invalid" || publishedMax === "invalid") {
    return jsonError(400, "invalid_date_filter");
  }

  const feed = await readFeed({ resourcePath, publishedMin, publishedMax });
  if (!feed.ok) {
    return jsonError(feed.status, feed.error, feed.detail);
  }

  // The client is about to ingest this payload, so the custodian's
  // "data changed" marker has served its purpose.
  clearDataAvailable();

  return new Response(feed.body, {
    status: 200,
    headers: {
      "Content-Type": feed.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-GreenButton-Pipe": "stream",
      // This request proved the cookie still matches the one on file, so
      // hand it back for another full SESSION_MAX_AGE — that is what makes
      // the expiry slide on use rather than run out from a fixed mint date.
      "Set-Cookie": sessionSetCookie(session),
    },
  });
}

function intParam(raw: string | null): number | undefined | "invalid" {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return Math.floor(n);
}
