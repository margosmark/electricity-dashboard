/**
 * The pipe-through orchestrator: turn "give me the feed" into a live ESPI
 * response, doing whatever token maintenance that requires on the way.
 *
 * Failure modes are enumerated here (rather than scattered across handlers)
 * so the browser gets one stable vocabulary:
 *
 *   not_configured — no client credentials yet (Oakville hasn't issued them)
 *   not_connected  — never authorised on this machine
 *   grant_revoked  — the utility says the authorisation is gone → reconnect
 *   client_auth    — our client secret is wrong → operator problem, NOT reauth
 *   data_pending   — 202 Accepted, the custodian is assembling the batch
 *   upstream       — 5xx / unreachable / malformed → retry later
 *
 * Zero data at rest: this module hands the caller a stream and a byte count.
 * It never materialises the feed, never parses it, and never writes anything
 * but the token set.
 */

import { getConfig } from "./config";
import { OAuthError, expiryFrom, refresh } from "./oauth";
import { getTokenStore, type TokenSet } from "./tokens";
import { fetchResource, type ResourceResult } from "./espi";
import { markSync } from "./session";

export type FeedErrorCode =
  | "not_configured"
  | "not_connected"
  | "grant_revoked"
  | "client_auth"
  | "data_pending"
  | "upstream";

export type FeedRequest = {
  resourcePath?: string | null;
  publishedMin?: number;
  publishedMax?: number;
};

export type FeedResult =
  | { ok: true; kind: "stream"; contentType: string; body: ReadableStream<Uint8Array>; url: string }
  | { ok: false; error: FeedErrorCode; status: number; detail?: string };

/** HTTP status the browser should see for each failure. */
export const FEED_STATUS: Record<FeedErrorCode, number> = {
  not_configured: 503,
  not_connected: 401,
  grant_revoked: 401,
  client_auth: 502,
  data_pending: 409,
  upstream: 502,
};

export async function readFeed(req: FeedRequest = {}): Promise<FeedResult> {
  const cfg = getConfig();
  if (!cfg.configured) return fail("not_configured", cfg.unconfiguredReason);

  const store = getTokenStore(cfg.tokenFile);
  const tokens = await store.load();
  if (!tokens) return fail("not_connected");

  const uri = await resolveSubscriptionUri(tokens);
  if (!uri) {
    await store.clear();
    return fail("grant_revoked", "token set carried no ESPI resource pointer");
  }

  // A revoked grant must leave NOTHING on disk: a token file that keeps
  // failing is a token file an operator will forget about.
  const failOAuth = async (e: unknown): Promise<FeedResult> => {
    if (e instanceof OAuthError && e.kind === "grant_revoked") await store.clear();
    return oauthFailure(e);
  };

  let accessToken: string;
  try {
    accessToken = await ensureAccessToken(tokens, false);
  } catch (e) {
    return failOAuth(e);
  }

  // Attempt 1, then exactly one forced refresh + retry: a 401 can mean "token
  // expired a second ago" or "grant is gone", and only the retry tells them
  // apart. Wiping a good token set on the first 401 would strand the user.
  let result = await requestFeed(accessToken, uri, req);
  if (result.kind === "error" && (result.status === 401 || result.status === 403)) {
    try {
      accessToken = await ensureAccessToken(tokens, true);
    } catch (e) {
      return failOAuth(e);
    }
    result = await requestFeed(accessToken, uri, req);
    if (result.kind === "error" && (result.status === 401 || result.status === 403)) {
      await store.clear();
      return fail("grant_revoked", `resource server answered ${result.status} after a fresh token`);
    }
  }

  if (result.kind === "error") {
    if (result.status === 0) return fail("upstream", result.detail);
    if (result.status >= 500) return fail("upstream", `resource server ${result.status}`);
    if (result.status === 403 || result.status === 401) return fail("grant_revoked");
    return fail("upstream", `resource server ${result.status}`);
  }
  if (result.kind === "accepted") return fail("data_pending", result.detail);

  return {
    ok: true,
    kind: "stream",
    contentType: result.contentType,
    body: result.body,
    url: result.url,
  };
}

async function requestFeed(
  accessToken: string,
  subscriptionUri: string,
  req: FeedRequest,
): Promise<ResourceResult> {
  return fetchResource({
    accessToken,
    subscriptionUri,
    resourcePath: req.resourcePath ?? null,
    publishedMin: req.publishedMin,
    publishedMax: req.publishedMax,
    onComplete: (bytes) => {
      markSync(bytes);
      // Status, size, and URL only — never the payload.
      console.log(`[greenbutton] feed piped: ${bytes} bytes`);
    },
  });
}

/**
 * A usable access token, refreshing when within a minute of expiry (or when
 * forced). A rotated refresh token is persisted before we return, so a
 * subsequent 401 can't strand us holding a one-time token we already burned.
 */
async function ensureAccessToken(tokens: TokenSet, force: boolean): Promise<string> {
  const cfg = getConfig();
  const fresh = !force && (tokens.expiresAt === undefined || tokens.expiresAt > Date.now());
  if (fresh) return tokens.accessToken;
  if (!tokens.refreshToken) {
    throw new OAuthError("grant_revoked", "access token expired and no refresh token is held");
  }

  // RFC 6749 §6: omit scope → "same as originally granted".
  const res = await refresh(cfg, tokens.refreshToken, undefined);
  const store = getTokenStore(cfg.tokenFile);
  const next: TokenSet = {
    ...tokens,
    accessToken: res.access_token,
    obtainedAt: Date.now(),
  };
  if (res.refresh_token && res.refresh_token !== tokens.refreshToken) {
    next.refreshToken = res.refresh_token;
  }
  if (res.scope) next.scope = res.scope;
  next.expiresAt = expiryFrom(res);
  await store.save(next);
  return next.accessToken;
}

/**
 * The token response's `resourceURI` is the batch; if a custodian omitted
 * it, the ESPI Authorization resource advertises it as `<resourceURI>`.
 * Reading that one small resource is the spec-defined way to find the batch —
 * far better than guessing URLs.
 */
async function resolveSubscriptionUri(tokens: TokenSet): Promise<string | null> {
  if (tokens.subscriptionUri) return tokens.subscriptionUri;
  if (!tokens.authorizationUri) return null;

  const cfg = getConfig();
  try {
    const res = await fetch(tokens.authorizationUri, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/atom+xml, application/xml",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const match = xml.match(/<(?:\w+:)?resourceURI>\s*([^<]+?)\s*<\/(?:\w+:)?resourceURI>/);
    const uri = match?.[1]?.trim();
    if (!uri) return null;
    const store = getTokenStore(cfg.tokenFile);
    await store.save({ ...tokens, subscriptionUri: uri });
    return uri;
  } catch {
    return null;
  }
}

function oauthFailure(e: unknown): FeedResult {
  if (e instanceof OAuthError) {
    if (e.kind === "grant_revoked") return fail("grant_revoked", e.message);
    if (e.kind === "client_auth") return fail("client_auth", e.message);
    return fail("upstream", e.message);
  }
  return fail("upstream", e instanceof Error ? e.message : String(e));
}

function fail(error: FeedErrorCode, detail?: string): FeedResult {
  return { ok: false, error, status: FEED_STATUS[error], detail };
}
