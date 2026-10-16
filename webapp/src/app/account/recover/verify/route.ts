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

export async function GET(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerification) return accountError(404, "not_found");
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const safeToken = /^[A-Za-z0-9_-]{40,64}$/.test(token) ? token : "";
  const html = `<!doctype html><meta charset="utf-8"><title>Recover account</title><h1>Recover your account</h1><form method="post" action="/account/recover/verify"><input type="hidden" name="token" value="${safeToken}"><label>New password <input type="password" name="newPassword" minlength="8" required></label><button type="submit">Set password</button></form>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; form-action 'self'" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerification) return accountError(404, "not_found");
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

export { wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";

async function readFormSmall(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const body = await readTextCapped(request, 64 * 1024);
  if (!body.ok) return { ok: false, status: body.status, error: "Request body is too large." };
  const form = new URLSearchParams(body.value);
  return { ok: true, value: { token: form.get("token"), newPassword: form.get("newPassword") } };
}
