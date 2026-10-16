/**
 * Wave N — password + identity rules for the account server.
 *
 * Two independent KDFs, deliberately NOT interchangeable:
 *
 *   1. argon2id over the login password  → proves the password at login.
 *      Memory-hard, so a stolen database is expensive to attack offline.
 *   2. PBKDF2-HMAC-SHA256, 600 000 iters, over the SAME password but a
 *      DIFFERENT (per-user, public) salt, computed IN THE BROWSER
 *      (`lib/account/crypto.ts`) → the key that encrypts the data blob.
 *
 * They use different salts and different functions, so a captured login
 * verifier cannot be replayed as a blob key and vice versa. The server only
 * ever runs (1); it never sees (2) in any form — that is the whole point of
 * client-side E2EE.
 *
 * Public registration/recovery use the configurable SMTP transport: the
 * mailbox must be proven before a password verifier or session exists. The
 * legacy recovery CODE path is retained only for the local compatibility mode.
 * copy of the data comes into existence (registration on a device that
 * already has data, or the first upload otherwise). See `POST
 * /account/recover`. Losing the password still means losing the SERVER copy —
 * the local browser copy is untouched — and the UI says so before the user
 * types anything.
 */

import { hash, verify } from "@node-rs/argon2";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * OWASP's floor for argon2id (19 MiB, t=2, p=1). Measured on the build box:
 * ~17 ms per hash — cheap enough for a login, expensive enough to matter
 * offline where an attacker must pay it per stolen account.
 *
 * `algorithm` is not set explicitly because `@node-rs/argon2` declares it as
 * an ambient const enum, which is erased under `isolatedModules` (the
 * package's own default is Argon2id). `auth.test.ts` asserts the emitted PHC
 * string starts with `$argon2id$`, so a library default change fails the
 * suite instead of silently downgrading the KDF.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Minimum 15 characters: the verifier protects against offline Argon2id
 * guessing, while this same secret derives the E2EE key from public salt and
 * stolen ciphertext. Favor memorable passphrases; do not silently trim them.
 */
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 254;

export type CredentialResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password, ARGON2_OPTIONS).catch(() => false);
}

/**
 * A real argon2id hash of a value nobody knows, used to make "no such
 * account" cost the same wall-clock time as "wrong password".
 *
 * Without it, a login that returns in 1 ms is an account that does not
 * exist — enumeration for free. Cost parameters must match
 * `ARGON2_OPTIONS`, which `auth.test.ts` asserts.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$ZwkMZ4mumQb9kUZ4PAPI7A$Rd0ss2akSuY2n/uBusb/iU2lIV8A4YWk6xd5vaTOvaI";

/** Burn the same work an unknown account would, then answer `false`. */
export async function timingEqualize(password: string): Promise<false> {
  await verifyPassword(DUMMY_PASSWORD_HASH, password);
  return false;
}

/** Normalize + validate an e-mail address. No delivery is attempted. */
export function normalizeEmail(raw: unknown): CredentialResult<string> {
  if (typeof raw !== "string") return { ok: false, error: "Enter an e-mail address." };
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, error: "Enter an e-mail address." };
  if (email.length > MAX_EMAIL_LENGTH) return { ok: false, error: "That e-mail address is too long." };
  // Deliberately permissive: there is no SMTP to bounce through, and a
  // stricter regex would only reject addresses that would have worked.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
    return { ok: false, error: "That does not look like an e-mail address (expected name@example.com)." };
  }
  return { ok: true, value: email };
}

export function validateLoginPassword(raw: unknown): CredentialResult<string> {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "Enter a password." };
  if (raw.length > MAX_PASSWORD_LENGTH) return { ok: false, error: `Passwords are limited to ${MAX_PASSWORD_LENGTH} characters.` };
  return { ok: true, value: raw };
}

export function validatePassword(raw: unknown): CredentialResult<string> {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "Enter a password." };
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Passwords are limited to ${MAX_PASSWORD_LENGTH} characters.` };
  }
  return { ok: true, value: raw };
}

/* --------------------------------------------------------------------------
 * Session tokens — 24 random bytes, stored only as a SHA-256 hash.
 *
 * The hash is not for secrecy (the token is already unguessable); it means a
 * stolen database cannot be replayed as a live session, the same reason the
 * password verifier exists.
 * ------------------------------------------------------------------------ */

export type SessionToken = { token: string; hash: string };

export function newSessionToken(): SessionToken {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A URL-safe, 256-bit one-use token. Only its hash is stored server-side. */
export function newEmailToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

/** Constant-time compare that tolerates a length mismatch (never throws). */
export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* --------------------------------------------------------------------------
 * Recovery code — shown exactly once, never retrievable again.
 *
 * WHAT IT IS: a one-time secret that lets a user who forgot their PASSWORD
 * get back into the ACCOUNT (set a new verifier).
 *
 * WHAT IT IS NOT: a way to read the data. The blob is encrypted with a key
 * derived from the password; the server holds no key, so a password reset
 * makes the stored ciphertext unreadable and it is DELETED rather than left
 * as a lie. The user re-uploads from whichever device still has the local
 * copy — which is exactly why the UI calls the local copy the real one.
 * ------------------------------------------------------------------------ */

/**
 * Crockford base32 → 20 characters in four groups:
 * `ANAR-AR5T-B3CD-EFGH`.
 *
 * The alphabet is exactly 32 symbols so a 5-bit value maps 1:1 with no
 * rejection sampling, and it excludes `I`, `L`, `O`, `U` so a code survives
 * being read aloud, copied off a screen photo, or typed by someone who
 * cannot tell `0` from `O`. `normalizeRecoveryCode` maps the ambiguous
 * letters back (`I`/`L` → `1`, `O` → `0`) on the way in, so a user who types
 * the obvious wrong character still gets in.
 *
 * 100 bits of entropy: with argon2id guarding the compare, guessing one is
 * not a practical attack, and a longer code would stop being writeable-down.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 symbols, no I/L/O/U

export function newRecoveryCode(): string {
  const bytes = randomBytes(13); // 104 bits, of which the first 100 are used
  const chars: string[] = [];
  let acc = 0;
  let nbits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) >>> 0;
    nbits += 8;
    while (nbits >= 5 && chars.length < 20) {
      nbits -= 5;
      chars.push(CROCKFORD[(acc >>> nbits) & 31]);
    }
    // Keep only the unconsumed bits, so the accumulator can never grow past
    // the 32-bit width these operators work on.
    acc &= (1 << nbits) - 1;
  }
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 5) groups.push(chars.slice(i, i + 5).join(""));
  return groups.join("-");
}

/** The code is stored as an argon2id hash, exactly like a password. */
export function hashRecoveryCode(code: string): Promise<string> {
  return hash(normalizeRecoveryCode(code), ARGON2_OPTIONS);
}

export function verifyRecoveryCode(recoveryHash: string, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || code.trim() === "") return Promise.resolve(false);
  return verify(recoveryHash, normalizeRecoveryCode(code), ARGON2_OPTIONS).catch(() => false);
}

/**
 * Compare `XXXXX-YYYYY-…`, `xxxxxyyyyy…` and the obvious misreadings
 * (`O`→`0`, `I`/`L`→`1`) as the same code.
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .replace(/[^0-9a-z]/gi, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}
