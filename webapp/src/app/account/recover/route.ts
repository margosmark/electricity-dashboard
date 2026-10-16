/**
 * POST /account/recover.
 *
 * In verified mode this only requests a mailbox link and always returns the
 * same 202 shape for an unknown, existing, or suppressed address. The password
 * is accepted only by POST /account/recover/verify after that link is proven.
 * The independent email-verification flag is a hard gate; there is no
 * unverified recovery fallback.
 */

import {
  deleteEmailToken,
  deleteEmailTokensForEmail,
  findAccountByEmail,
  insertEmailToken,
  isSuppressed,
} from "@/lib/account/db";
import { EMAIL_TOKEN_TTL_MS } from "@/lib/account/config";
import { accountError, accountJson, getDb, isConfig, rateLimitError, readJsonSmall, rejectCrossOrigin, requireEnabled } from "@/lib/account/http";
import { newEmailToken, normalizeEmail } from "@/lib/account/auth";
import { checkAttempts, recoverAttempts, refundIdentity, spendAttempts } from "@/lib/account/ratelimit";
import { recoveryEmail, enqueueAccountEmail, drainOutbox } from "@/lib/account/email";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerificationEnabled) return accountError(404, "not_found");
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const body = await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as { email?: unknown; recoveryCode?: unknown; newPassword?: unknown };
  const email = normalizeEmail(value.email);
  if (!email.ok) return accountError(400, "invalid_email", email.error);

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

export { wrongMethod as GET, wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
