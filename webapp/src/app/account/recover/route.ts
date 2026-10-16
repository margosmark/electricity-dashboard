/**
 * POST /account/recover.
 *
 * In verified mode this only requests a mailbox link and always returns the
 * same 202 shape for an unknown, existing, or suppressed address. The password
 * is accepted only by POST /account/recover/verify after that link is proven.
 * The legacy recovery-code path is retained only for the local compatibility
 * fixture (ACCT_EMAIL_VERIFICATION=false).
 */

import {
  deleteBlob,
  deleteEmailToken,
  deleteEmailTokensForEmail,
  deleteSessionsForAccount,
  findAccountByEmail,
  getBlob,
  insertEmailToken,
  insertSession,
  isSuppressed,
  setPasswordHash as writePasswordHash,
  setRecoveryHash,
} from "@/lib/account/db";
import { EMAIL_TOKEN_TTL_MS, type AccountConfig } from "@/lib/account/config";
import { accountError, accountJson, applySessionCookie, getDb, isConfig, rateLimitError, readJsonSmall, rejectCrossOrigin, requireEnabled } from "@/lib/account/http";
import { DUMMY_PASSWORD_HASH, hashPassword, hashRecoveryCode, newEmailToken, newRecoveryCode, newSessionToken, normalizeEmail, validatePassword, verifyRecoveryCode } from "@/lib/account/auth";
import { checkAttempts, recoverAttempts, refundIdentity, spendAttempts } from "@/lib/account/ratelimit";
import { recoveryEmail, enqueueAccountEmail, drainOutbox } from "@/lib/account/email";

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

  if (!cfg.emailVerification) return legacyRecover(request, cfg, email.value, value);
  if (value.recoveryCode !== undefined || value.newPassword !== undefined) return accountError(400, "verification_required", "Open the recovery link before choosing a new password.");
  if (!cfg.smtp) return accountError(503, "email_unavailable");

  const attempts = recoverAttempts(email.value, request);
  const verdict = checkAttempts(attempts);
  if (!verdict.allowed) return rateLimitError(verdict.retryAfterSeconds);
  const db = getDb(cfg);
  deleteEmailTokensForEmail(db, email.value, "recovery");
  const account = findAccountByEmail(db, email.value);
  if (!account || !account.email_verified_at || isSuppressed(db, email.value)) {
    spendAttempts(attempts);
    return accountJson({ ok: true, recoveryRequested: true }, { status: 202 });
  }
  const token = newEmailToken();
  insertEmailToken(db, { tokenHash: token.hash, purpose: "recovery", accountId: account.id, email: account.email, expiresAt: Date.now() + EMAIL_TOKEN_TTL_MS });
  const message = recoveryEmail(cfg, account.email, token.token);
  if (!enqueueAccountEmail(db, token.hash, message)) {
    deleteEmailToken(db, token.hash);
    spendAttempts(attempts);
    return accountError(503, "email_unavailable");
  }
  refundIdentity(attempts);
  void drainOutbox(cfg, db);
  return accountJson({ ok: true, recoveryRequested: true }, { status: 202 });
}

async function legacyRecover(
  request: Request,
  cfg: AccountConfig,
  emailValue: string,
  value: { recoveryCode?: unknown; newPassword?: unknown },
): Promise<Response> {
  const password = validatePassword(value.newPassword);
  if (!password.ok) return accountError(400, "invalid_password", password.error);
  const attempts = recoverAttempts(emailValue, request);
  const verdict = checkAttempts(attempts);
  if (!verdict.allowed) return rateLimitError(verdict.retryAfterSeconds);
  const db = getDb(cfg);
  const account = findAccountByEmail(db, emailValue);
  const codeOk = account?.recovery_hash
    ? await verifyRecoveryCode(account.recovery_hash, value.recoveryCode)
    : await verifyRecoveryCode(DUMMY_PASSWORD_HASH, value.recoveryCode);
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
  const res = accountJson({ ok: true, email: account.email, kdfSalt: account.kdf_salt, hadBlob, blobDropped: hadBlob, blobDroppedReason: hadBlob ? "Your stored copy was encrypted with the old password, so it could not be kept. Sync again from a device that still has your data." : null, recoveryCode, rev: 0, hasBlob: false });
  applySessionCookie(res, session.token, Math.floor(cfg.sessionTtlMs / 1000));
  return res;
}

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
