/**
 * POST /account/register.
 *
 * Public mode is a two-step flow: this endpoint accepts an e-mail address only,
 * sends a mailbox-proof link, and creates no account, password verifier or
 * session. The password is submitted only to POST /account/verify after the
 * link has been opened. A false ACCT_EMAIL_VERIFICATION mode remains solely as
 * a local compatibility fixture for the pre-SMTP account tests.
 */

import { randomBytes } from "node:crypto";
import { findAccountByEmail, insertAccount, insertEmailToken, deleteEmailToken, deleteEmailTokensForEmail, isSuppressed, insertSession } from "@/lib/account/db";
import { type AccountConfig, EMAIL_TOKEN_TTL_MS } from "@/lib/account/config";
import {
  accountError, accountJson, isConfig, rateLimitError, readJsonSmall,
  rejectCrossOrigin, requireEnabled,
} from "@/lib/account/http";
import {
  hashPassword,
  hashRecoveryCode,
  newRecoveryCode,
  newEmailToken,
  newSessionToken,
  normalizeEmail,
  validatePassword,
} from "@/lib/account/auth";
import { checkAttempts, refundAttempts, registerAttempts, spendAttempts } from "@/lib/account/ratelimit";
import { acceptanceFromRequest } from "@/lib/account/policy";
import { registrationEmail, enqueueAccountEmail, drainOutbox } from "@/lib/account/email";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as { email?: unknown; password?: unknown; hasLocalData?: unknown; policyAccepted?: unknown; privacyVersion?: unknown; termsVersion?: unknown };
  const email = normalizeEmail(value.email);
  if (!email.ok) return accountError(400, "invalid_email", email.error);
  const acceptance = acceptanceFromRequest(value);
  if (!acceptance) return accountError(400, "policy_acceptance_required", "Accept the current privacy notice and account terms before registering.");

  if (!cfg.emailVerification) return legacyRegister(request, cfg, email.value, value, acceptance);

  if (value.password !== undefined) {
    return accountError(400, "verification_required", "Verify the mailbox before choosing a password.");
  }
  if (!cfg.smtp) return accountError(503, "email_unavailable");

  const attempts = registerAttempts(request);
  const verdict = checkAttempts(attempts);
  if (!verdict.allowed) return rateLimitError(verdict.retryAfterSeconds);
  const db = getDb(cfg);
  deleteEmailTokensForEmail(db, email.value, "registration");
  const duplicate = Boolean(findAccountByEmail(db, email.value));
  const suppressed = isSuppressed(db, email.value);
  if (duplicate || suppressed) {
    spendAttempts(attempts);
    return accountJson({ ok: true, verificationRequired: true }, { status: 202 });
  }

  const token = newEmailToken();
  insertEmailToken(db, {
    tokenHash: token.hash,
    purpose: "registration",
    accountId: null,
    email: email.value,
    hasLocalData: value.hasLocalData === true,
    expiresAt: Date.now() + EMAIL_TOKEN_TTL_MS,
    privacyVersion: acceptance.privacyVersion,
    termsVersion: acceptance.termsVersion,
    acceptedAt: acceptance.acceptedAt,
  });
  if (!enqueueAccountEmail(db, token.hash, registrationEmail(cfg, email.value, token.token))) {
    deleteEmailToken(db, token.hash);
    spendAttempts(attempts);
    return accountError(503, "email_unavailable");
  }
  refundAttempts(attempts);
  void drainOutbox(cfg, db);
  return accountJson({ ok: true, verificationRequired: true }, { status: 202 });
}

/** Legacy-only local test path; never used while public verification is on. */
async function legacyRegister(
  request: Request,
  cfg: AccountConfig,
  emailValue: string,
  value: { password?: unknown; hasLocalData?: unknown },
  acceptance: { privacyVersion: string | null; termsVersion: string | null; acceptedAt: number | null },
): Promise<Response> {
  const password = validatePassword(value.password);
  if (!password.ok) return accountError(400, "invalid_password", password.error);
  const attempts = registerAttempts(request);
  const verdict = checkAttempts(attempts);
  if (!verdict.allowed) return rateLimitError(verdict.retryAfterSeconds);
  const db = getDb(cfg);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  if (count >= cfg.maxAccounts) {
    spendAttempts(attempts);
    return accountError(403, "account_limit", `This server holds at most ${cfg.maxAccounts} accounts (family scale).`);
  }
  if (findAccountByEmail(db, emailValue)) {
    spendAttempts(attempts);
    return accountError(409, "email_taken", "An account already exists for that e-mail address.");
  }
  const hasLocalData = value.hasLocalData === true;
  const recoveryCode = hasLocalData ? newRecoveryCode() : null;
  const accountId = insertAccount(db, {
    email: emailValue,
    passwordHash: await hashPassword(password.value),
    kdfSalt: randomBytes(16).toString("base64"),
    recoveryHash: recoveryCode ? await hashRecoveryCode(recoveryCode) : null,
    emailVerifiedAt: Date.now(),
    privacyVersion: acceptance.privacyVersion,
    termsVersion: acceptance.termsVersion,
    acceptedAt: acceptance.acceptedAt,
  });
  refundAttempts(attempts);
  const session = newSessionToken();
  insertSession(db, session.hash, accountId, cfg.sessionTtlMs);
  const kdfSalt = (db.prepare("SELECT kdf_salt FROM accounts WHERE id = ?").get(accountId) as { kdf_salt: string }).kdf_salt;
  const res = accountJson({ ok: true, email: emailValue, kdfSalt, recoveryCode, hasBlob: false, rev: 0 }, { status: 201 });
  applySessionCookie(res, session.token, Math.floor(cfg.sessionTtlMs / 1000));
  return res;
}

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
