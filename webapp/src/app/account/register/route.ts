/**
 * POST /account/register — create an account and sign in.
 *
 * No third-party identity provider, no e-mail verification, no invitation
 * loop: this is a self-hosted, family-scale tool and pretending otherwise
 * would mean standing up an IdP for two users (scope fence from the card).
 * `ACCT_MAX_ACCOUNTS` caps how many accounts exist at all, and this handler
 * refuses after a bounded number of attempts per source (see
 * `lib/account/ratelimit.ts`).
 *
 * The Pangolin PIN gate is NOT counted as a first lock here: measured from
 * the public internet on 2026-10-07 with no cookies, `GET /` answered 200
 * straight through (`x-edge-location: default`, `x-gb-process: app`) with no
 * challenge, so this endpoint is the only one an unauthenticated stranger
 * meets. That measurement is recorded in SECURITY.md §5 rather than assumed.
 *
 * Response carries three things the browser cannot get any other way:
 *
 *   kdfSalt      — the per-user salt for the CLIENT-SIDE key derivation. The
 *                  server never sees the derived key; it only stores a salt.
 *   recoveryCode — issued ONLY when the device already holds data this
 *                  account is about to mirror ("iff data exists server-side").
 *                  Shown once, stored as an argon2id hash, never retrievable.
 *   session      — register signs you in, same contract as login.
 *
 * The password never leaves this handler in a form the server can reuse: it
 * is argon2id'd here for the login verifier, and the blob key it will later
 * encrypt with is derived in the browser from the same input but a different
 * salt and a different KDF (see `lib/account/crypto.ts`).
 */

import { randomBytes } from "node:crypto";
import { findAccountByEmail, insertAccount, insertSession } from "@/lib/account/db";
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
  hashPassword,
  newRecoveryCode,
  hashRecoveryCode,
  newSessionToken,
  normalizeEmail,
  validatePassword,
} from "@/lib/account/auth";
import { checkAttempts, refundAttempts, registerAttempts, spendAttempts } from "@/lib/account/ratelimit";

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

  // Registration is the ONLY unauthenticated endpoint that creates state, so
  // it gets the same brake as login — a stranger does not get an unbounded
  // number of attempts at the account ceiling (see `ratelimit.ts`).
  const attempts = registerAttempts(request);
  const verdict = checkAttempts(attempts);
  if (!verdict.allowed) return rateLimitError(verdict.retryAfterSeconds);

  const hasLocalData = (body.value as { hasLocalData?: unknown } | null)?.hasLocalData === true;

  const db = getDb(cfg);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  if (count >= cfg.maxAccounts) {
    spendAttempts(attempts);
    return accountError(
      403,
      "account_limit",
      `This server holds at most ${cfg.maxAccounts} accounts (family scale). Ask the operator to raise ACCT_MAX_ACCOUNTS.`,
    );
  }
  if (findAccountByEmail(db, email.value)) {
    // Deliberately the same answer as "wrong password" would be at login
    // is NOT applied here — registration must tell you the name is taken,
    // otherwise the flow is unusable. There is no e-mail to send a
    // "someone tried to register" notice through anyway.
    spendAttempts(attempts);
    return accountError(409, "email_taken", "An account already exists for that e-mail address.");
  }

  const passwordHash = await hashPassword(password.value);
  // A fresh salt per account, generated server-side so two accounts with the
  // same password never share a derivation input.
  const kdfSalt = randomBytes(16).toString("base64");
  const recoveryCode = hasLocalData ? newRecoveryCode() : null;

  let accountId: number;
  try {
    accountId = insertAccount(db, {
      email: email.value,
      passwordHash,
      kdfSalt,
      recoveryHash: recoveryCode ? await hashRecoveryCode(recoveryCode) : null,
    });
  } catch {
    spendAttempts(attempts);
    return accountError(409, "email_taken", "An account already exists for that e-mail address.");
  }

  // A completed registration hands the budget back — see `refundAttempts`.
  refundAttempts(attempts);

  const session = newSessionToken();
  insertSession(db, session.hash, accountId, cfg.sessionTtlMs);

  const res = accountJson(
    {
      ok: true,
      email: email.value,
      kdfSalt,
      recoveryCode,
      hasBlob: false,
      rev: 0,
    },
    { status: 201 },
  );
  applySessionCookie(res, session.token, Math.floor(cfg.sessionTtlMs / 1000));
  return res;
}
