/** Mailbox-proven, explicit POST for password recovery. GET never consumes. */

import {
  consumeEmailToken,
  deleteBlob,
  deleteSessionsForAccount,
  findAccountById,
  findEmailToken,
  getBlob,
  insertSession,
  setPasswordHash,
  setRecoveryHash,
} from "@/lib/account/db";
import { accountError, accountJson, applySessionCookie, getDb, isConfig, readJsonSmall, readTextCapped, rejectCrossOrigin, requireEnabled } from "@/lib/account/http";
import { hashPassword, hashToken, newSessionToken, validatePassword } from "@/lib/account/auth";
import { ACCOUNT_VERIFY_CSP } from "@/lib/account/verifyCsp";

export async function GET(_request: Request): Promise<Response> {
  void _request;
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerificationEnabled) return accountError(404, "not_found");
  if (!cfg.smtp) return accountError(503, "email_unavailable");
  // The token remains a fragment until this page copies it into the explicit
  // POST body. Fragments never reach nginx, access logs, error logs, or
  // Referer headers.
  const html = `<!doctype html><meta charset="utf-8"><title>Recover account</title><h1>Recover your account</h1><form method="post" action="/account/recover/verify"><input type="hidden" name="token" id="token"><label>New password <input type="password" name="newPassword" minlength="8" required></label><button type="submit">Set password</button></form><noscript>JavaScript is required to continue.</noscript><script>const token=document.getElementById("token");const match=/^#token=([A-Za-z0-9_-]{40,64})$/.exec(location.hash);if(token&&match){token.value=match[1];history.replaceState(null,"",location.pathname);}</script>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": ACCOUNT_VERIFY_CSP },
  });
}

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerificationEnabled) return accountError(404, "not_found");
  if (!cfg.smtp) return accountError(503, "email_unavailable");
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const body = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
    ? await readFormSmall(request)
    : await readJsonSmall(request);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);
  const value = (body.value ?? {}) as { token?: unknown; newPassword?: unknown };
  if (typeof value.token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(value.token)) return accountError(400, "invalid_recovery");
  const password = validatePassword(value.newPassword);
  if (!password.ok) return accountError(400, "invalid_password", password.error);

  const db = getDb(cfg);
  const tokenHash = hashToken(value.token);
  const token = findEmailToken(db, tokenHash);
  if (!token || token.purpose !== "recovery" || token.account_id === null || token.used_at !== null || token.expires_at <= Date.now()) {
    return accountError(400, "invalid_recovery");
  }
  const account = findAccountById(db, token.account_id);
  if (!account || account.email !== token.email) return accountError(400, "invalid_recovery");
  const hadBlob = Boolean(getBlob(db, account.id));
  const passwordHash = await hashPassword(password.value);
  if (!consumeEmailToken(db, tokenHash)) return accountError(400, "invalid_recovery");

  // E2EE boundary: resetting authentication cannot recover the blob key. The
  // opaque ciphertext is deleted instead of falsely presenting a backup that
  // the new password cannot decrypt. The mailbox proof is only auth proof.
  setPasswordHash(db, account.id, passwordHash);
  setRecoveryHash(db, account.id, null);
  if (hadBlob) deleteBlob(db, account.id);
  deleteSessionsForAccount(db, account.id);
  const session = newSessionToken();
  insertSession(db, session.hash, account.id, cfg.sessionTtlMs);
  const res = accountJson({
    ok: true,
    email: account.email,
    kdfSalt: account.kdf_salt,
    hadBlob,
    blobDropped: hadBlob,
    blobDroppedReason: hadBlob ? "Your stored copy was encrypted with the old password, so it could not be kept. Sync again from a device that still has your data." : null,
    hasBlob: false,
    rev: 0,
  });
  applySessionCookie(res, session.token, Math.floor(cfg.sessionTtlMs / 1000));
  return res;
}

export { wrongEmailMethod as PUT, wrongEmailMethod as PATCH, wrongEmailMethod as DELETE, wrongEmailMethod as OPTIONS } from "@/lib/account/http";

async function readFormSmall(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const body = await readTextCapped(request, 64 * 1024);
  if (!body.ok) return { ok: false, status: body.status, error: "Request body is too large." };
  const form = new URLSearchParams(body.value);
  return { ok: true, value: { token: form.get("token"), newPassword: form.get("newPassword") } };
}
