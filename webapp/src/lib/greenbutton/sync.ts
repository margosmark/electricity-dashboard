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
 * Classification rule that matters for the years-long refresh token: only an
 * EXPLICIT rejection of a freshly-minted credential (invalid_grant from the
 * token endpoint, or 401/403 after a forced refresh) destroys the token set.
 * Everything ambiguous — network errors, 5xx, cross-origin redirects that
 * strip the Authorization header on the way — is `upstream` and keeps the
 * grant on disk. A custodian hiccup must never look like a revocation.
 *
 * Zero data at rest: this module hands the caller a stream and a byte count.
 * It never materialises the feed, never parses it, and never writes anything
 * but the token set.
 */

import { getConfig } from "./config";
import { OAuthError, expiryFrom, refresh, resolveResourceUri } from "./oauth";
import { getTokenStore, type TokenSet } from "./tokens";
import { fetchResource, isCrossOriginRedirect, type ResourceResult } from "./espi";
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
  const loaded = await store.load();
  if (!loaded) return fail("not_connected");
  let tokens = loaded;

  // A revoked grant must leave NOTHING on disk: a token file that keeps
  // failing is a token file an operator will forget about.
  const failOAuth = async (e: unknown): Promise<FeedResult> => {
    if (e instanceof OAuthError && e.kind === "grant_revoked") await store.clear();
    return oauthFailure(e);
  };

  // A usable access token comes FIRST: pointer resolution is an
  // authenticated request too, and resolving with a stale token misreads an
  // ordinary expiry as a revoked grant. Every later save writes the token
  // set returned here, so saves compose instead of clobbering each other.
  try {
    tokens = await ensureAccessToken(tokens, false);
  } catch (e) {
    return failOAuth(e);
  }

  let pointer: PointerResult;
  try {
    pointer = await resolveSubscriptionUri(tokens);
  } catch (e) {
    // The forced refresh inside pointer resolution said invalid_grant.
    return failOAuth(e);
  }
  if (pointer.kind === "transient") return fail("upstream", pointer.detail);
  if (pointer.kind === "missing") {
    await store.clear();
    return fail("grant_revoked", "token set carried no ESPI resource pointer");
  }
  if (pointer.kind === "revoked") {
    await store.clear();
    return fail("grant_revoked", pointer.detail);
  }
  tokens = pointer.tokens;
  const uri = pointer.uri;

  // Attempt 1, then exactly one forced refresh + retry: a 401 can mean "token
  // expired a second ago" or "grant is gone", and only the retry tells them
  // apart. Wiping a good token set on the first 401 would strand the user.
  let result = await requestFeed(tokens, uri, req);
  if (result.kind === "error" && (result.status === 401 || result.status === 403)) {
    if (result.redirectedCrossOrigin) {
      // The redirect dropped our Authorization header, so this 401 proves
      // nothing about the grant — refreshing would not change the outcome.
      return fail("upstream", stripDetail(result));
    }
    try {
      tokens = await ensureAccessToken(tokens, true);
    } catch (e) {
      return failOAuth(e);
    }
    result = await requestFeed(tokens, uri, req);
    if (result.kind === "error" && (result.status === 401 || result.status === 403)) {
      if (result.redirectedCrossOrigin) return fail("upstream", stripDetail(result));
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
  if (result.kind === "accepted") {
    // 202: the custodian is still assembling the batch. Their response
    // body is THEIR text — it never becomes `detail` (the toolbar would
    // quote a third-party sentence at the reader). The catalog sentence
    // for `data_pending` says what is happening, in the reader's locale.
    return fail("data_pending");
  }

  return {
    ok: true,
    kind: "stream",
    contentType: result.contentType,
    body: result.body,
    url: result.url,
  };
}

function stripDetail(result: Extract<ResourceResult, { kind: "error" }>): string {
  return `resource server redirected to another origin and the redirect dropped the Authorization header (${result.status})`;
}

async function requestFeed(
  tokens: TokenSet,
  subscriptionUri: string,
  req: FeedRequest,
): Promise<ResourceResult> {
  return fetchResource({
    accessToken: tokens.accessToken,
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
 * A usable token set, refreshing when within a minute of expiry (or when
 * forced). A rotated refresh token is persisted BEFORE the set is returned,
 * so every caller threads the current credentials onward — a retry that used
 * a pre-rotation snapshot would burn a one-time token and read invalid_grant
 * as a revocation.
 */
async function ensureAccessToken(tokens: TokenSet, force: boolean): Promise<TokenSet> {
  const cfg = getConfig();
  const fresh = !force && (tokens.expiresAt === undefined || tokens.expiresAt > Date.now());
  if (fresh) return tokens;
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
  return next;
}

type PointerResult =
  | { kind: "uri"; uri: string; tokens: TokenSet }
  | { kind: "missing" }
  | { kind: "revoked"; detail: string }
  | { kind: "transient"; detail: string };

/**
 * The token response's `resourceURI` is the batch; if a custodian omitted
 * it, the ESPI Authorization resource advertises it as `<resourceURI>`.
 * Reading that one small resource is the spec-defined way to find the batch —
 * far better than guessing URLs.
 *
 * Failure classification mirrors the feed request: one forced refresh + retry
 * separates "expired a second ago" from "grant is gone", and anything that is
 * not an explicit rejection (network error, 5xx, cross-origin redirect that
 * stripped our credentials) is `transient` — reported upstream with the token
 * set kept intact. A cached pointer is trusted only when it is an absolute
 * http(s) URL: an older build persisted raw relative URIs, which would throw
 * in `buildResourceUrl` forever after, so a bad one is discarded and
 * re-resolved from the Authorization resource.
 */
async function resolveSubscriptionUri(tokens: TokenSet): Promise<PointerResult> {
  const cfg = getConfig();
  if (tokens.subscriptionUri && isHttpUrl(tokens.subscriptionUri)) {
    return { kind: "uri", uri: tokens.subscriptionUri, tokens };
  }
  if (!tokens.authorizationUri) return { kind: "missing" };

  let current = tokens;
  let outcome: PointerAttempt = { kind: "missing" };
  for (let attempt = 0; attempt < 2; attempt++) {
    outcome = await fetchAuthorizationResource(current);
    if (outcome.kind !== "unauthorized") break;
    // 401 here can be an access token the utility expired server-side before
    // our clock says so — refresh once and ask again. A second 401 with the
    // fresh token is a revocation.
    current = await ensureAccessToken(current, true);
  }

  if (outcome.kind !== "uri") {
    if (outcome.kind === "unauthorized") {
      return { kind: "revoked", detail: "authorization resource rejected a fresh access token" };
    }
    return outcome;
  }

  // Relative references resolve against the Authorization resource's own
  // URL (RFC 3986); non-http schemes are unusable, not revocable.
  const uri = resolveResourceUri(outcome.raw, current.authorizationUri!);
  if (!uri) return { kind: "missing" };

  const next: TokenSet = { ...current, subscriptionUri: uri };
  await getTokenStore(cfg.tokenFile).save(next);
  return { kind: "uri", uri, tokens: next };
}

type PointerAttempt =
  | { kind: "uri"; raw: string }
  | { kind: "unauthorized" }
  | { kind: "missing" }
  | { kind: "transient"; detail: string };

async function fetchAuthorizationResource(tokens: TokenSet): Promise<PointerAttempt> {
  const authorizationUri = tokens.authorizationUri!;
  let res: Response;
  try {
    res = await fetch(authorizationUri, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/atom+xml, application/xml",
      },
      cache: "no-store",
    });
  } catch (e) {
    // The exception's own words go to the LOG as an object; `detail` keeps
    // the phase only, because this value can reach a reader through
    // `/greenbutton/usage`'s error body (greenbutton/recovery.test.ts).
    console.warn("[greenbutton] authorization resource unreachable", e);
    return {
      kind: "transient",
      detail: "authorization resource unreachable",
    };
  }
  if (res.status === 401 || res.status === 403) {
    // A cross-origin follow arrives WITHOUT our Authorization header (fetch
    // strips it by design), so a 401 after such a hop says nothing about
    // the grant — treating it as revocation would destroy a valid one.
    if (isCrossOriginRedirect(authorizationUri, res)) {
      return {
        kind: "transient",
        detail: `authorization resource redirected to another origin and the redirect dropped the Authorization header (${res.status})`,
      };
    }
    return { kind: "unauthorized" };
  }
  if (!res.ok) return { kind: "transient", detail: `authorization resource ${res.status}` };
  const xml = await res.text();
  const match = xml.match(/<(?:\w+:)?resourceURI>\s*([^<]+?)\s*<\/(?:\w+:)?resourceURI>/);
  const raw = match?.[1]?.trim();
  if (!raw) return { kind: "missing" };
  return { kind: "uri", raw };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * An OAuth-layer failure, classified by `OAuthError.kind`.
 *
 * NO `detail` on any arm. An `OAuthError.message` is log prose (a status,
 * the custodian's error code, our own description) and a non-OAuth
 * exception is raw — a token-store fs error can carry a filesystem path —
 * so both go to the LOG as objects here, and the reader gets
 * `describeGbError(code).detail`, the catalog sentence for the code this
 * returns (in their locale, not in ours).
 */
function oauthFailure(e: unknown): FeedResult {
  console.warn("[greenbutton] oauth failure", e);
  if (e instanceof OAuthError) {
    if (e.kind === "grant_revoked") return fail("grant_revoked");
    if (e.kind === "client_auth") return fail("client_auth");
    return fail("upstream");
  }
  return fail("upstream");
}

/**
 * A failure the browser classifies by `error` alone.
 *
 * `detail` is an OPERATOR breadcrumb — phase + status, logged by the usage
 * route and never sent to the browser, whose reader gets
 * `describeGbError(error).detail` (catalog, their locale). It must
 * therefore never carry an exception message or a third-party response
 * body; pinned by greenbutton/recovery.test.ts.
 */
function fail(error: FeedErrorCode, detail?: string): FeedResult {
  return { ok: false, error, status: FEED_STATUS[error], detail };
}
