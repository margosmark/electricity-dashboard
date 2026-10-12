/**
 * POST /greenbutton/disconnect — drop this browser's session AND the stored
 * authorisation.
 *
 * This is the local half of revocation: it wipes the token file (so no
 * refresh token survives on .110) and expires the cookie. The utility-side
 * half — revoking in Oakville's own UI — is detected on the next use: the
 * refresh grant comes back `invalid_grant`, the shim clears state and answers
 * `grant_revoked`, and the UI offers "reconnect".
 */

import {
  cookieSecure,
  getConfig,
  getTokenStore,
  isSameOrigin,
  jsonError,
  jsonResponse,
  sessionMatches,
  SESSION_COOKIE,
} from "@/lib/greenbutton/http";
import { clearSyncMeta } from "@/lib/greenbutton/session";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return jsonError(403, "cross_origin_blocked");

  const cfg = getConfig();
  const store = getTokenStore(cfg.tokenFile);
  const tokens = cfg.configured ? await store.load() : null;
  if (!tokens) return jsonResponse({ ok: true, wasConnected: false });
  if (!sessionMatches(request, tokens)) return jsonError(401, "session_required");

  await store.clear();
  clearSyncMeta();

  const res = jsonResponse({ ok: true, wasConnected: true });
  // Same attributes the cookie was minted with. Browsers key deletion on
  // name/path/domain, so a partial match happens to work — but writing a
  // non-Secure `gb_session` on the https deployment, even empty, is not a
  // trade worth making for the convenience.
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
