/**
 * POST /greenbutton/notify/[token] — the registered `notification_uri`.
 *
 * The custodian POSTs an ESPI BatchList here when new data exists. We record
 * ONLY "something changed at <time>" in memory and answer 200: no parsing, no
 * storage, no fan-out. The browser picks the marker up from
 * `/greenbutton/status` on its next visit and refreshes then — the same
 * poll-don't-react posture open-green-button takes.
 *
 * The unguessable path token (derived from the client secret, or
 * `GB_NOTIFY_TOKEN`) stops a stranger from scribling on our in-memory flag.
 * An unknown token gets a plain 404 so we never confirm the scheme.
 */

import { getNotifyToken } from "@/lib/greenbutton/config";
import { getConfig } from "@/lib/greenbutton/http";
import { markDataAvailable } from "@/lib/greenbutton/session";

const MAX_BODY_BYTES = 64 * 1024;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const cfg = getConfig();

  // Not configured yet: a mid-onboarding notification must not bounce (the
  // custodian would retry and email an operator), there is just nothing to do.
  if (!cfg.configured) return new Response(null, { status: 200 });
  if (token !== getNotifyToken()) return new Response("Not Found", { status: 404 });

  let body = "";
  try {
    body = await request.text();
  } catch {
    body = "";
  }
  const truncated = body.slice(0, MAX_BODY_BYTES);
  const resources = new Set(truncated.match(URL_PATTERN) ?? []).size;

  markDataAvailable();
  // Byte count and resource count only. BatchList bodies carry resource URIs,
  // never readings — but a count is all we need, so a count is all we keep.
  console.log(`[greenbutton] notification: resources=${resources} bytes=${body.length}`);

  return new Response(null, { status: 200 });
}
