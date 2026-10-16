/**
 * GET /account/verify is scanner-safe: it never consumes a token.
 * POST /account/verify is the explicit consuming action and is the first
 * endpoint allowed to read/hash a registration password.
 */

import { randomBytes } from "node:crypto";
import {
  consumeEmailToken,
  findAccountByEmail,
  findEmailToken,
  getBlob,
  insertAccount,
  insertSession,
} from "@/lib/account/db";
import { accountError, accountJson, applySessionCookie, getDb, isConfig, readJsonSmall, readTextCapped, rejectCrossOrigin, requireEnabled } from "@/lib/account/http";
import { hashPassword, hashToken, hashRecoveryCode, newRecoveryCode, newSessionToken, validatePassword } from "@/lib/account/auth";

export async function GET(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  if (!cfg.emailVerification) return accountError(404, "not_found");
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const safeToken = /^[A-Za-z0-9_-]{40,64}$/.test(token) ? token : "";
  // GET only renders a form. It never resolves/consumes the token or sets a
  // cookie, so mail scanners cannot create an account.
  const html = `<!doctype html><meta charset="utf-8"><title>Verify account</title><h1>Verify your account</h1><form method="post" action="/account/verify"><input type="hidden" name="token" value="${safeToken}"><label>New password <input type="password" name="password" minlength="8" required></label><button type="submit">Create account</button></form>`;
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
  const value = (body.value ?? {}) as { token?: unknown; password?: unknown };
  if (typeof value.token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(value.token)) return accountError(400, "invalid_verification");
  const password = validatePassword(value.password);
  if (!password.ok) return accountError(400, "invalid_password", password.error);

  const db = getDb(cfg);
  const tokenHash = hashToken(value.token);
  const pending = findEmailToken(db, tokenHash);
  if (!pending || pending.purpose !== "registration" || pending.used_at !== null || pending.expires_at <= Date.now()) {
    return accountError(400, "invalid_verification");
  }
  if (findAccountByEmail(db, pending.email)) {
    consumeEmailToken(db, tokenHash);
    return accountError(400, "invalid_verification");
  }
  const count = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  if (count >= cfg.maxAccounts) return accountError(403, "account_limit");

  const recoveryCode = pending.has_local_data ? newRecoveryCode() : null;
  const passwordHash = await hashPassword(password.value);
  // The token is single-use. Consume immediately before the account insert; a
  // second concurrent POST cannot create another account from this mailbox.
  if (!consumeEmailToken(db, tokenHash)) return accountError(400, "invalid_verification");
  const accountId = insertAccount(db, {
    email: pending.email,
    passwordHash,
    kdfSalt: randomBytes(16).toString("base64"),
    recoveryHash: recoveryCode ? await hashRecoveryCode(recoveryCode) : null,
    emailVerifiedAt: Date.now(),
  });
  const account = findAccountByEmail(db, pending.email);
  if (!account) return accountError(500, "verification_failed");
  const session = newSessionToken();
  insertSession(db, session.hash, accountId, cfg.sessionTtlMs);
  const res = accountJson({ ok: true, email: account.email, kdfSalt: account.kdf_salt, recoveryCode, hasBlob: Boolean(getBlob(db, account.id)), rev: 0 }, { status: 201 });
  applySessionCookie(res, session.token, Math.floor(cfg.sessionTtlMs / 1000));
  return res;
}

export { wrongMethod as PUT, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";

async function readFormSmall(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const body = await readTextCapped(request, 64 * 1024);
  if (!body.ok) return { ok: false, status: body.status, error: "Request body is too large." };
  const form = new URLSearchParams(body.value);
  return { ok: true, value: { token: form.get("token"), password: form.get("password") } };
}
