/**
 * POST /account/login — exchange e-mail + password for a session cookie.
 *
 * Three properties worth stating out loud:
 *
 *  1. Enumeration cost is equal: an address that does not exist still pays
 *     one argon2id verification against a dummy hash, so "user not found"
 *     cannot be told apart from "wrong password" by a stopwatch.
 *  2. The response carries `kdfSalt` — the browser needs it to re-derive the
 *     blob key, and it is only ever handed out to someone who just proved
 *     the password that mixes with it. (It is a salt, not a secret; gating
 *     it anyway keeps the trust boundary easy to explain.)
 *  3. Nothing about the account is written to `localStorage`. The session is
 *     an HttpOnly cookie the page cannot read, which is exactly the property
 *     the existing "no token material in browser storage" assertion needs.
 */

import { findAccountByEmail, getBlob, insertSession, openDb, pruneSessions } from "@/lib/account/db";
import {
  accountError,
  accountJson,
  applySessionCookie,
  getDb,
  isConfig,
  readJsonSmall,
  rejectCrossOrigin,
  requireEnabled,
} from "@/lib/account/http";
import {
  newSessionToken,
  normalizeEmail,
  timingEqualize,
  validatePassword,
  verifyPassword,
} from "@/lib/account/auth";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;

  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);

  const email = normalizeEmail((body.value as { email?: unknown } | null)?.email);
  if (!email.ok) return accountError(400, "invalid_email", email.error);
  const password = validatePassword((body.value as { password?: unknown } | null)?.password);
  if (!password.ok) return accountError(400, "invalid_password", password.error);

  const db = getDb(cfg);
  const account = findAccountByEmail(db, email.value);
  const ok = account
    ? await verifyPassword(account.password_hash, password.value)
    : await timingEqualize(password.value);

  if (!account || !ok) {
    // One message for both failure modes — see property (1) above.
    return accountError(401, "invalid_credentials", "That e-mail address and password do not match.");
  }

  pruneSessions(db);
  const session = newSessionToken();
  insertSession(db, session.hash, account.id, cfg.sessionTtlMs);
  const blob = getBlob(openDb(cfg.dbPath), account.id);

  const res = accountJson({
    ok: true,
    email: account.email,
    kdfSalt: account.kdf_salt,
    hasRecoveryCode: Boolean(account.recovery_hash),
    hasBlob: Boolean(blob),
    rev: blob?.rev ?? 0,
    updatedAt: blob ? new Date(blob.updated_at).toISOString() : null,
  });
  applySessionCookie(res, session.token, Math.floor(cfg.sessionTtlMs / 1000));
  return res;
}
