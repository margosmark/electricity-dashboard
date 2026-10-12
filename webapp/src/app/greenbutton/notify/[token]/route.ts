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
 * An unknown token gets a plain 404 so we never confirm the scheme, and the
 * comparison is constant-time so the token can't be walked one byte at a time.
 *
 * The body is read through a capped reader, never `request.text()`: nginx
 * admits 64 MB (`ops/edge/default.conf.template`) while we only ever inspect
 * the first 64 KB of it, so buffering the whole thing would hand an
 * unauthenticated caller a 64 MB allocation per request (finding L1).
 */

import { notifyAccountServer } from "@/lib/greenbutton/accountNotify";
import { getNotifyToken } from "@/lib/greenbutton/config";
import { getConfig, secretEquals } from "@/lib/greenbutton/http";
import { markDataAvailable } from "@/lib/greenbutton/session";

const MAX_BODY_BYTES = 64 * 1024;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/**
 * Pull at most `max` bytes off the request body, then cancel the rest.
 *
 * Returns the decoded text plus how many bytes were actually read. Anything
 * past the cap is never pulled into memory — the caller has no use for it and
 * an attacker has every use for us holding it.
 */
export async function readBodyCapped(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<{ text: string; bytesRead: number }> {
  const body = request.body;
  if (!body) return { text: "", bytesRead: 0 };

  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = body.getReader();
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      // Never overshoot: a chunk may be larger than what is left.
      const room = maxBytes - total;
      const take = value.byteLength > room ? value.subarray(0, room) : value;
      parts.push(take);
      total += take.byteLength;
    }
    // Stop the rest of the stream — cancelling beats draining it to EOF.
    await reader.cancel().catch(() => undefined);
  } catch {
    // A truncated or erroring body is still a valid notification: we only
    // ever wanted "something changed", not the payload itself.
  }
  return { text: Buffer.concat(parts).toString("utf8"), bytesRead: total };
}

/** Drop a body we are never going to use (bad token / not configured). */
async function discardBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    /* nothing to cancel */
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const cfg = getConfig();

  // Not configured yet: a mid-onboarding notification must not bounce (the
  // custodian would retry and email an operator), there is just nothing to do.
  if (!cfg.configured) {
    await discardBody(request);
    return new Response(null, { status: 200 });
  }
  if (!secretEquals(token, getNotifyToken())) {
    await discardBody(request);
    return new Response("Not Found", { status: 404 });
  }

  const { text, bytesRead } = await readBodyCapped(request);
  const resources = new Set(text.match(URL_PATTERN) ?? []).size;

  markDataAvailable();
  // Byte count and resource count only. BatchList bodies carry resource URIs,
  // never readings — but a count is all we need, so a count is all we keep.
  // `bytesRead` is what actually came off the wire before the cap, so the log
  // can never claim — and never hold — more than MAX_BODY_BYTES.
  console.log(`[greenbutton] notification: resources=${resources} bytes=${bytesRead}`);

  // Wave N: hand the "something changed" fact to the account server so
  // subscribers get a push while the tab is closed. Deliberately `void` and
  // deliberately AFTER the decision to answer 200 — a fan-out that is down,
  // unconfigured or slow must never make Oakville's webhook bounce (they
  // would retry a notification we have already recorded).
  void notifyAccountServer({ resources, bytes: bytesRead }).catch(() => false);

  return new Response(null, { status: 200 });
}
