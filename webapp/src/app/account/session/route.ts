/**
 * GET /account/session — "is there an account system here, and am I in it?"
 *
 * The one endpoint the browser probes before it draws anything about
 * accounts. Two jobs:
 *
 *  - it is the feature flag for the UI: the app container (no `ACCT_*` env)
 *    answers 404, so a deployment without an account server shows no account
 *    controls at all and the public site behaves exactly as it did before.
 *  - it carries everything a reload needs to resume an existing session:
 *    the KDF salt (to re-derive the blob key), the revision (to detect a
 *    stale local copy), and the push configuration.
 *
 * `Cache-Control: no-store` because the body says who you are.
 */

import { getBlob, getPushPrefs, openDb } from "@/lib/account/db";
import {
  accountJson,
  applySessionCookie,
  isAuth,
  isConfig,
  requireEnabled,
  requireSession,
} from "@/lib/account/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;

  // The ONE route that rotates: it is also the only one that writes the new
  // value back to `Set-Cookie` (bottom of this handler, `SessionGateOptions`).
  const auth = requireSession(request, cfg, { rotate: true });
  if (!isAuth(auth)) {
    // Signed out is a 200, not a 401: "the feature exists, you are not in
    // it" is a different answer from "the feature does not exist", and the
    // UI needs the first one to draw a login form.
    return accountJson({
      enabled: true,
      authed: false,
      pushConfigured: Boolean(cfg.vapid),
      vapidPublicKey: cfg.vapid?.publicKey ?? null,
      maxAccounts: cfg.maxAccounts,
    });
  }

  const { account, currentToken, rotatedToken, extended } = auth;
  const db = openDb(cfg.dbPath);
  const blob = getBlob(db, account.id);

  const res = accountJson({
    enabled: true,
    authed: true,
    email: account.email,
    // The per-user KDF salt: public by design (a salt is not a secret) and
    // useless without the password it is mixed with.
    kdfSalt: account.kdf_salt,
    hasRecoveryCode: Boolean(account.recovery_hash),
    hasBlob: Boolean(blob),
    rev: blob?.rev ?? 0,
    updatedAt: blob ? new Date(blob.updated_at).toISOString() : null,
    pushConfigured: Boolean(cfg.vapid),
    vapidPublicKey: cfg.vapid?.publicKey ?? null,
    prefs: getPushPrefs(db, account.id),
    maxAccounts: cfg.maxAccounts,
  });

  if (rotatedToken || extended) {
    applySessionCookie(res, rotatedToken ?? currentToken, Math.floor(cfg.sessionTtlMs / 1000));
  }
  return res;
}
