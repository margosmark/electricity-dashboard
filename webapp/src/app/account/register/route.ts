/**
 * POST /account/register.
 *
 * Public mode is a two-step flow: this endpoint accepts an e-mail address only,
 * sends a mailbox-proof link, and creates no account, password verifier or
 * session. The password is submitted only to POST /account/verify after the
 * link has been opened. The independent email flag is a hard gate: disabled
 * mode never falls back to unverified account creation.
 */

import { findAccountByEmail, insertEmailToken, deleteEmailToken, deleteEmailTokensForEmail, isSuppressed } from "@/lib/account/db";
import { EMAIL_TOKEN_TTL_MS } from "@/lib/account/config";
import {
  accountError,
  accountJson,
  getDb,
  isConfig,
  rateLimitError,
  readJsonSmall,
  rejectCrossOrigin,
  requireEnabled,
} from "@/lib/account/http";
import {
  newEmailToken,
  normalizeEmail,
} from "@/lib/account/auth";
import { checkAttempts, refundAttempts, registerAttempts, spendAttempts } from "@/lib/account/ratelimit";
import { acceptanceFromRequest } from "@/lib/account/policy";
import { registrationEmail, enqueueAccountEmail, drainOutbox } from "@/lib/account/email";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerificationEnabled) return accountError(404, "not_found");
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as { email?: unknown; password?: unknown; hasLocalData?: unknown; policyAccepted?: unknown; privacyVersion?: unknown; termsVersion?: unknown };
  const email = normalizeEmail(value.email);
  if (!email.ok) return accountError(400, "invalid_email", email.error);
  const acceptance = acceptanceFromRequest(value);
  if (!acceptance) return accountError(400, "policy_acceptance_required", "Accept the current privacy notice and account terms before registering.");


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

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
