/**
 * OAuth2 client for the Green Button CMD custodian (RFC 6749 + ESPI extras).
 *
 * Three operations, nothing else: build the authorization URL, exchange the
 * code, refresh the access token. Failures are classified so the caller can
 * tell WHOSE credential the token endpoint rejected — that distinction is the
 * difference between "reconnect in the UI" and "the client secret is wrong":
 *
 *   client_auth  — our client_id/secret failed (HTTP 401 invalid_client).
 *                  Nothing the user can fix; do NOT wipe their tokens.
 *   grant_revoked— the user's grant is gone (invalid_grant / access_denied).
 *                  Wipe tokens, show "reconnect".
 *   transient    — upstream/5xx/malformed. Retry, keep tokens.
 */

import { createHash, randomBytes } from "node:crypto";
import type { GreenButtonConfig, TokenAuthStyle } from "./config";

/** RFC 6749 §5.1 plus the ESPI resource pointers Green Button adds. */
export type TokenResponse = {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  resourceURI?: string;
  authorizationURI?: string;
};

export type OAuthErrorKind = "client_auth" | "grant_revoked" | "transient";

/**
 * Classified OAuth failure.
 *
 * `message` is a stable phrase written for the LOG — a status, the
 * custodian's error code when there is one, or our own description of the
 * failure. It is not copy: `sync.ts` never puts it on a `FeedResult
 * detail`, so the reader's sentence for each kind comes from the catalog
 * (`describeGbError` on the client).
 */
export class OAuthError extends Error {
  readonly kind: OAuthErrorKind;
  readonly status?: number;

  constructor(kind: OAuthErrorKind, message: string, status?: number) {
    super(message);
    this.name = "OAuthError";
    this.kind = kind;
    this.status = status;
  }
}

/** Clock skew: refresh a minute early rather than mid-request. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * RFC 7636 §4.1 — a `code_verifier` is 43-128 characters of unreserved
 * charset. 48 random bytes base64url-encoded is 64 characters drawn from
 * `A-Za-z0-9-_`, i.e. comfortably inside both bounds, and unguessable.
 */
export function newCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/**
 * RFC 7636 §4.2 — `BASE64URL(SHA256(ASCII(code_verifier)))`. Only the
 * challenge ever goes to the custodian, so a code intercepted on the
 * callback URL is worthless without the verifier parked on this side.
 */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function buildAuthorizeUrl(
  cfg: GreenButtonConfig,
  state: string,
  redirectUri: string,
  scope: string,
  codeChallenge?: string,
): string {
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export async function exchangeCode(
  cfg: GreenButtonConfig,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  };
  if (codeVerifier) params.code_verifier = codeVerifier;
  return postToken(cfg, params);
}

/**
 * RFC 6749 §6: an omitted `scope` means "same as originally granted", which
 * is what we want by default — some custodians reject an explicit scope even
 * when it equals the granted one.
 */
export async function refresh(
  cfg: GreenButtonConfig,
  refreshToken: string,
  scope?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  if (scope) params.scope = scope;
  return postToken(cfg, params);
}

/**
 * ESPI resource pointers come back absolute from most custodians, but the
 * spec allows a relative one — and `fetch()` refuses a relative URL outright.
 * Resolve against the token endpoint's origin, which is where the batch
 * logically lives.
 */
export function resolveResourceUri(uri: string | undefined | null, tokenUrl: string): string | undefined {
  if (!uri) return undefined;
  try {
    const resolved = new URL(uri, tokenUrl);
    // Only http(s) may become a fetch target — a custodian that answers with
    // `javascript:` or some other scheme gets nothing, not an exception.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

/** Expiry as epoch ms, with skew applied. Undefined when the custodian omits it. */
export function expiryFrom(res: TokenResponse, now = Date.now()): number | undefined {
  if (typeof res.expires_in !== "number" || !Number.isFinite(res.expires_in)) return undefined;
  return now + res.expires_in * 1000 - EXPIRY_SKEW_MS;
}

async function postToken(
  cfg: GreenButtonConfig,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const primary: TokenAuthStyle = cfg.tokenAuthStyle === "auto" ? "basic" : cfg.tokenAuthStyle;
  const first = await attemptToken(cfg, params, primary);
  if (first.ok) return first.value;

  // `auto` mode only: the custodian rejected client_secret_basic, so try the
  // form-body variant (some London-Hydro-platform deployments want it). The
  // retry only fires on invalid_client, so a rejected grant is never re-sent.
  const retryStyle =
    first.retryStyle ??
    (cfg.tokenAuthStyle === "auto" && primary === "basic" && first.error.kind === "client_auth"
      ? "body"
      : undefined);
  if (!retryStyle) throw first.error;

  const second = await attemptToken(cfg, params, retryStyle);
  if (second.ok) return second.value;
  throw second.error;
}

type Attempt =
  | { ok: true; value: TokenResponse }
  | { ok: false; error: OAuthError; retryStyle?: TokenAuthStyle };

async function attemptToken(
  cfg: GreenButtonConfig,
  params: Record<string, string>,
  style: TokenAuthStyle,
): Promise<Attempt> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { Accept: "application/json" };

  if (style === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", cfg.clientId);
    body.set("client_secret", cfg.clientSecret);
  }

  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    });
  } catch (e) {
    // The network error's own words (host, port, the cause chain) go to
    // the LOG as an object. `OAuthError.message` itself never becomes
    // copy: `sync.ts` attaches no detail to an OAuth failure, so every
    // reader-facing sentence for these codes is catalog copy
    // (greenbutton/recovery.test.ts pins that).
    console.warn("[greenbutton] token endpoint unreachable", e);
    throw new OAuthError("transient", "token endpoint unreachable");
  }

  const text = await res.text();
  if (!res.ok) {
    const err = classifyTokenError(res.status, text);
    // Log status + the custodian's error code ONLY. The body can echo
    // request parameters, so it never reaches the log verbatim.
    console.warn(`[greenbutton] token endpoint ${res.status} (${err.kind}) error=${err.code ?? "-"}`);
    const retryStyle =
      cfg.tokenAuthStyle === "auto" && style === "basic" && err.kind === "client_auth"
        ? "body"
        : undefined;
    return { ok: false, error: err, retryStyle };
  }

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthError("transient", "token endpoint returned a non-JSON body", res.status);
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    return {
      ok: false,
      error: new OAuthError("transient", "token response had no access_token", res.status),
    };
  }
  return { ok: true, value: parsed };
}

export type ClassifiedError = OAuthError & { code?: string };

function classifyTokenError(status: number, body: string): ClassifiedError {
  const code = errorCode(body);
  const kind: OAuthErrorKind =
    code === "invalid_client" || (!code && status === 401)
      ? "client_auth"
      : code === "invalid_grant" || code === "access_denied" || (!code && (status === 400 || status === 403))
        ? "grant_revoked"
        : // invalid_request / unsupported_grant_type / invalid_scope and any
          // 5xx are OUR problem or a transient upstream one: keep the tokens.
          "transient";
  const err = new OAuthError(kind, `token endpoint ${status}${code ? ` ${code}` : ""}`, status) as ClassifiedError;
  err.code = code;
  return err;
}

/** The custodian's `error` field when the body is a JSON error document. */
function errorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
