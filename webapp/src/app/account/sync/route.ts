/**
 * GET/PUT /account/sync — the whole multi-device story in two verbs.
 *
 * The server stores CIPHERTEXT. It cannot read a single byte of what is in
 * `data`, has no key that could, and never derives one: the browser
 * encrypts with PBKDF2(password, salt) → AES-GCM before uploading
 * (`lib/account/crypto.ts`). What the server does own is:
 *
 *   - a monotonically increasing `rev`, so two devices cannot overwrite each
 *     other silently. `PUT` carries the `baseRev` it was built from; a
 *     mismatch is 409 and the loser re-pulls and asks the user (LWW, as the
 *     card allows — no CRDT, no per-field merge yet).
 *   - a 5 MB bounded body read, because an unauthenticated 64 MB request
 *     body is a disk-fill primitive and nginx admits 64 MB for `/import`.
 *
 * GET answers `rev: 0` for an account that has never uploaded: "nothing
 * there yet" is a normal state on a phone that has never synced, not an
 * error, and the client's first-login migration prompt depends on telling
 * the two apart.
 */

import { getBlob, putBlob, setRecoveryHash } from "@/lib/account/db";
import {
  accountError,
  accountJson,
  getDb,
  isAuth,
  isConfig,
  readJsonCapped,
  rejectCrossOrigin,
  requireEnabled,
  requireSession,
} from "@/lib/account/http";
import { hashRecoveryCode, newRecoveryCode } from "@/lib/account/auth";

export const dynamic = "force-dynamic";

/** 96-bit IV, base64 — the exact shape WebCrypto's AES-GCM produces. */
function validIv(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 12 && decoded.toString("base64") === value;
}

/** Base64 ciphertext: non-empty, decodable, and not larger than the cap. */
function validData(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > maxBytes) return false;
  // Round-trip check rejects junk that `Buffer.from` would silently pad.
  return Buffer.from(value, "base64").toString("base64") === value;
}

export async function GET(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) return auth;

  const db = getDb(cfg);
  const blob = getBlob(db, auth.account.id);
  return accountJson({
    rev: blob?.rev ?? 0,
    updatedAt: blob ? new Date(blob.updated_at).toISOString() : null,
    iv: blob?.iv ?? null,
    data: blob?.data ?? null,
    kdfSalt: auth.account.kdf_salt,
    hasRecoveryCode: Boolean(auth.account.recovery_hash),
  });
}

export async function PUT(request: Request): Promise<Response> {
  const cfg = requireEnabled();
  if (!isConfig(cfg)) return cfg;
  const csrf = rejectCrossOrigin(request);
  if (csrf) return csrf;
  const auth = requireSession(request, cfg);
  if (!isAuth(auth)) return auth;

  const body = await readJsonCapped(request, cfg.maxSyncBytes);
  if (!body.ok) return accountError(body.status, "bad_request", body.error);

  const value = (body.value ?? {}) as { iv?: unknown; data?: unknown; baseRev?: unknown };
  if (!validIv(value.iv)) return accountError(400, "invalid_blob", "The encryption IV is missing or malformed.");
  if (!validData(value.data, cfg.maxSyncBytes)) {
    return accountError(
      400,
      "invalid_blob",
      `The encrypted payload is not base64, or exceeds the ${Math.round(cfg.maxSyncBytes / (1024 * 1024))} MB limit.`,
    );
  }
  const baseRev = value.baseRev;
  if (typeof baseRev !== "number" || !Number.isInteger(baseRev) || baseRev < 0) {
    return accountError(400, "invalid_blob", "baseRev must be the integer revision this upload was built from.");
  }

  const db = getDb(cfg);
  const result = putBlob(db, auth.account.id, { iv: value.iv, data: value.data, baseRev });

  if (!result.ok) {
    // 409 is the contract: the client re-pulls and asks the user which copy
    // wins. Answering 200 here would silently discard one device's work.
    return accountJson({ error: "stale_revision", currentRev: result.currentRev }, { status: 409 });
  }

  // First server-side copy of the data ⇒ this is the moment a recovery code
  // matters ("iff data exists server-side"). It is generated here, once,
  // because there is no later moment at which the user is guaranteed to be
  // looking at the screen.
  let recoveryCode: string | null = null;
  if (!auth.account.recovery_hash) {
    recoveryCode = newRecoveryCode();
    setRecoveryHash(db, auth.account.id, await hashRecoveryCode(recoveryCode));
  }

  return accountJson({ rev: result.rev, updatedAt: new Date(result.updatedAt).toISOString(), recoveryCode });
}

/*
 * Wrong-method stubs — see `wrongMethod()` in `lib/account/http.ts`.
 *
 * Next routes by path and answers the verbs this route does not export
 * (and its auto-OPTIONS) before any handler runs, so without these a
 * disabled deployment would answer 405/204 and admit that an account API
 * exists here (SECURITY.md 5.1). With them: 404 while the feature is off,
 * an honest 405 — naming the method — once it is on.
 */
export { wrongMethod as POST, wrongMethod as PATCH, wrongMethod as DELETE, wrongMethod as OPTIONS } from "@/lib/account/http";
