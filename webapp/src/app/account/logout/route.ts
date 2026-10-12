/**
 * POST /account/logout — end THIS session, keep the server copy.
 *
 * Logout is deliberately not a data operation: the card says "logout wipes
 * local data but not server copy", and the local half is the browser's own
 * business (it must first prove the local copy is not ahead of the server —
 * see `lib/account/sync.ts`). What this handler owns is the credential: the
 * session row is deleted server-side, so a cookie left in some other tab
 * stops working even if it is never cleared.
 *
 * Idempotent on purpose — a logout button that errors on the second click is
 * a support ticket, and "you are signed out" is true either way.
 */

import { deleteSession, openDb } from "@/lib/account/db";
import {
  accountJson,
  clearSessionCookie,
  isAuth,
  isConfig,
  rejectCrossOrigin,
  requireEnabled,
  requireSession,
} from "@/lib/account/http";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;

  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) {
    const res = accountJson({ ok: true, wasAuthenticated: false });
    return clearSessionCookie(res);
  }

  // `sessionHash` is the live row (post-rotation) — see the field's comment.
  deleteSession(openDb(cfg.dbPath), auth.sessionHash);

  const res = accountJson({ ok: true, wasAuthenticated: true, email: auth.account.email });
  return clearSessionCookie(res);
}

/*
 * Wrong-method stubs — see `wrongMethod()` in `lib/account/http.ts`.
 *
 * Next routes by path and answers the verbs this route does not export
 * (and its auto-OPTIONS) before any handler runs, so without these a
 * disabled deployment would answer 405/204 and admit that an account API
 * exists here (SECURITY.md 5.1). With them: 404 while the feature is off,
 * an honest 405 — naming the method — once it is on.
 */
export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
