/**
 * POST /account/recover — forgot the password, no SMTP, and an honest answer.
 *
 * THE TRUTH THIS ENDPOINT HAS TO TELL (design §11, confirmed in the PM
 * ruling): there is no e-mail to send a reset link through, so a recovery
 * CODE issued when the server copy was created is the only way back in.
 *
 * What recovery restores: the ACCOUNT (a new password verifier).
 * What it cannot restore: the DATA. The blob is encrypted with a key derived
 * from the OLD password and the server holds no key at all — that is the
 * entire promise of client-side E2EE, and pretending otherwise here would be
 * the moment it stopped being true. So the unreadable ciphertext is DELETED
 * rather than left as something that looks like a backup, `blobDropped`
 * says so, and the client tells the user to sync again from whichever device
 * still holds the local copy (which the UI calls the real one for exactly
 * this reason).
 *
 * A fresh recovery code is returned on success, so the account never ends up
 * with a code that has already been spent.
 */

import {
  deleteBlob,
  deleteSessionsForAccount,
  findAccountByEmail,
  getBlob,
  insertSession,
  setRecoveryHash,
  setPasswordHash as writePasswordHash,
} from "@/lib/account/db";
import {
  accountError,
  accountJson,
  applySessionCookie,
  getDb,
  isConfig,
  rateLimitError,
  readJsonSmall,
  rejectCrossOrigin,
  requireEnabled,
} from "@/lib/account/http";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashRecoveryCode,
  newRecoveryCode,
  newSessionToken,
  normalizeEmail,
  validatePassword,
  verifyRecoveryCode,
} from "@/lib/account/auth";
import { checkAttempts, recoverAttempts, refundIdentity, spendAttempts } from "@/lib/account/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;

  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as { email?: unknown; recoveryCode?: unknown; newPassword?: unknown };

  const email = normalizeEmail(value.email);
  if (!email.ok) return accountError(400, "invalid_email", email.error);
  const password = validatePassword(value.newPassword);
  if (!password.ok) return accountError(400, "invalid_password", password.error);

  // Same brake as login, tighter: this is an argon2 loop against a 100-bit
  // code — unguessable, but free to run if it is never slowed down.
  const attempts = recoverAttempts(email.value, request);
  const verdict = checkAttempts(attempts);
  if (!verdict.allowed) return rateLimitError(verdict.retryAfterSeconds);

  const db = getDb(cfg);
  const account = findAccountByEmail(db, email.value);
  const codeOk = account?.recovery_hash
    ? await verifyRecoveryCode(account.recovery_hash, value.recoveryCode)
    : // Unknown account still pays one argon2 verification: "no such
      // account" and "wrong code" must be indistinguishable.
      await verifyRecoveryCode(DUMMY_PASSWORD_HASH, value.recoveryCode);

  if (!account || !codeOk) {
    spendAttempts(attempts);
    return accountError(401, "invalid_recovery", "That e-mail address and recovery code do not match.");
  }
  refundIdentity(attempts);

  const hadBlob = Boolean(getBlob(db, account.id));
  await writePasswordHash(db, account.id, await hashPassword(password.value));
  if (hadBlob) deleteBlob(db, account.id);
  deleteSessionsForAccount(db, account.id);

  const recoveryCode = newRecoveryCode();
  setRecoveryHash(db, account.id, await hashRecoveryCode(recoveryCode));

  const session = newSessionToken();
  insertSession(db, session.hash, account.id, cfg.sessionTtlMs);

  const res = accountJson({
    ok: true,
    email: account.email,
    kdfSalt: account.kdf_salt,
    hadBlob,
    // The UI must say this out loud — see the module header.
    blobDropped: hadBlob,
    blobDroppedReason: hadBlob
      ? "Your stored copy was encrypted with the old password, so it could not be kept. Sync again from a device that still has your data."
      : null,
    recoveryCode,
    rev: 0,
    hasBlob: false,
  });
  applySessionCookie(res, session.token, Math.floor(cfg.sessionTtlMs / 1000));
  return res;
}
