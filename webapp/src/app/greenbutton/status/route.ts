/**
 * GET /greenbutton/status — what the shim can tell the UI without leaking
 * anything: is it configured, is THIS browser connected, when did the last
 * pipe-through happen.
 *
 * `connected` is deliberately session-scoped: another device that has never
 * run the connect flow sees `false` even though the server holds a token set,
 * because it has no cookie that unlocks the data.
 *
 * The notification URI is deliberately ABSENT: its path token is the only
 * gate on `POST /greenbutton/notify/[token]`, and this endpoint answers with
 * no cookie, session or Origin at all — publishing it would hand the gate to
 * every visitor (finding M1).
 */

import {
  getConfig,
  getTokenStore,
  jsonResponse,
  sessionMatches,
} from "@/lib/greenbutton/http";
import { getSyncMeta } from "@/lib/greenbutton/session";

export async function GET(request: Request): Promise<Response> {
  const cfg = getConfig();
  const store = getTokenStore(cfg.tokenFile);
  const tokens = cfg.configured ? await store.load() : null;
  const connected = Boolean(tokens && sessionMatches(request, tokens));
  const meta = getSyncMeta();

  return jsonResponse({
    configured: cfg.configured,
    unconfiguredReason: cfg.configured ? null : cfg.unconfiguredReason,
    connected,
    // Where the refresh token lives (never the value itself) — surfaced so an
    // operator can confirm the mount took without reading the file.
    tokenPersistence: tokens ? store.persistence() : null,
    tokenExpiresAt:
      tokens?.expiresAt !== undefined ? new Date(tokens.expiresAt).toISOString() : null,
    lastSyncAt: meta.lastSyncAt ? new Date(meta.lastSyncAt).toISOString() : null,
    lastSyncBytes: meta.lastSyncBytes ?? null,
    dataAvailableSince: meta.dataAvailableSince
      ? new Date(meta.dataAvailableSince).toISOString()
      : null,
    redirectUri: cfg.redirectUri,
  });
}
