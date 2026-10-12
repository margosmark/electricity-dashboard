/**
 * GET /greenbutton/callback — the custodian sends the user back here.
 *
 * Verifies the CSRF state against both the in-memory value (single-use, 10
 * minute TTL) and the cookie, exchanges the code, mints the browser session
 * cookie, and returns to the dashboard. Failure is never silent: every path
 * lands on `/?gb=error:<code>` so the UI can explain what happened.
 *
 * Token handling: the code exchange is the ONLY place a refresh token first
 * appears, and it goes straight into the token store (file, 0600, outside the
 * container). It is never rendered into the page, never put in a cookie, and
 * never logged.
 */

import { randomBytes } from "node:crypto";
import { exchangeCode, expiryFrom, OAuthError, resolveResourceUri } from "@/lib/greenbutton/oauth";
import { consumeState } from "@/lib/greenbutton/session";
import type { TokenSet } from "@/lib/greenbutton/tokens";
import {
  cookieSecure,
  getConfig,
  getTokenStore,
  readCookie,
  redirectToApp,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  STATE_COOKIE,
} from "@/lib/greenbutton/http";

export async function GET(request: Request): Promise<Response> {
  const cfg = getConfig();
  if (!cfg.configured) return redirectToApp("gb=error:not_configured");

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  // State must be present in the store (single-use) AND match the cookie the
  // browser was handed at /start — either alone is not enough. Consumption
  // comes first on purpose: a cross-site attempt burns its own state and can
  // never satisfy the cookie comparison below. What the state was carrying
  // (the PKCE verifier, if the flow started with PKCE) rides along.
  const cookieState = readCookie(request, STATE_COOKIE);
  const pending = state ? consumeState(state) : null;
  const stateOk = Boolean(pending) && state === cookieState;

  if (!stateOk) return redirectToApp("gb=error:state_mismatch");
  if (oauthError) {
    // `access_denied` is the user pressing Cancel — not a failure to report
    // as an error state, but still worth surfacing verbatim.
    return redirectToApp(`gb=error:denied&gb_detail=${encodeURIComponent(oauthError)}`);
  }
  if (!code) return redirectToApp("gb=error:no_code");
  // PKCE is on for this attempt but no verifier came back with the state —
  // the flow was started by a different (older) build or the config flipped
  // underneath it. Fail closed rather than exchanging an unbound code.
  if (cfg.pkce && !pending?.codeVerifier) return redirectToApp("gb=error:pkce_verifier_missing");

  try {
    const res = await exchangeCode(cfg, code, cfg.redirectUri, pending?.codeVerifier);
    const store = getTokenStore(cfg.tokenFile);
    const previous = await store.load();

    // Someone completing a flow from a browser that does not hold the current
    // session is replacing an existing authorisation. Expected only when
    // re-bootstrapping (cleared cookies / new machine); never a silent event.
    if (previous?.accessToken && previous.sessionToken) {
      const heldSession = readCookie(request, SESSION_COOKIE) === previous.sessionToken;
      if (!heldSession) {
        console.warn(
          "[greenbutton] token set replaced by a browser without a session — " +
            "expected only on a deliberate re-authorisation",
        );
      }
    }

    // A fresh secret on EVERY successful authorisation. Reusing
    // `previous.sessionToken` meant one value lived in the cookie and in
    // tokens.json for as long as the grant lasted; minting here means a
    // value captured once (log, extension, shoulder-surf) is dead the next
    // time anyone completes the flow, and the stored secret never matches
    // what an old cookie holds.
    const sessionToken = randomBytes(24).toString("hex");
    const tokens: TokenSet = {
      accessToken: res.access_token,
      obtainedAt: Date.now(),
      expiresAt: expiryFrom(res),
      scope: res.scope ?? cfg.scope,
      // Keep the resource pointers we already had: a refresh (or a re-auth
      // that answered without them) must not lose the batch URI.
      subscriptionUri:
        resolveResourceUri(res.resourceURI, cfg.tokenUrl) ??
        previous?.subscriptionUri ??
        undefined,
      authorizationUri:
        resolveResourceUri(res.authorizationURI, cfg.tokenUrl) ??
        previous?.authorizationUri ??
        undefined,
      sessionToken,
    };
    if (res.refresh_token) tokens.refreshToken = res.refresh_token;
    else if (previous?.refreshToken) tokens.refreshToken = previous.refreshToken;
    await store.save(tokens);

    console.log(
      `[greenbutton] authorised: scope=${tokens.scope ?? "(none)"} ` +
        `refresh=${tokens.refreshToken ? "yes" : "no"} ` +
        `batch=${tokens.subscriptionUri ? "yes" : "unknown"} ` +
        `persistence=${store.persistence()}`,
    );

    const out = redirectToApp("gb=connected");
    out.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    out.cookies.set(STATE_COOKIE, "", {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return out;
  } catch (e) {
    if (e instanceof OAuthError) {
      if (e.kind === "client_auth") {
        return redirectToApp("gb=error:client_auth&gb_detail=token endpoint rejected our client credentials");
      }
      if (e.kind === "grant_revoked") {
        return redirectToApp("gb=error:grant_revoked");
      }
      return redirectToApp(`gb=error:token_exchange&gb_detail=${encodeURIComponent(e.message)}`);
    }
    return redirectToApp(
      `gb=error:token_exchange&gb_detail=${encodeURIComponent(e instanceof Error ? e.message : "unknown")}`,
    );
  }
}
