/**
 * Wave N — client-side end-to-end encryption for the synced dataset.
 *
 * THE WHOLE POINT: the browser derives a 256-bit AES-GCM key from the
 * user's password and a public per-user salt, encrypts, and uploads. The
 * server receives ciphertext, stores ciphertext, and has no key that could
 * open it. It holds a *different* KDF's output (argon2id) over the same
 * password for login — different function, different salt — so one cannot be
 * turned into the other.
 *
 * Parameters:
 *   PBKDF2-HMAC-SHA256, 600 000 iterations (OWASP), 16-byte random salt
 *   per user → 256-bit AES-GCM, fresh random 96-bit IV per blob.
 *
 * 600k iterations is ~0.4 s on a laptop and minutes on a stolen database,
 * which is the asymmetry the whole scheme runs on. It is a module constant
 * precisely so a test can pin it: a silent cut to "make login snappy" would
 * quietly destroy the only thing standing between a leaked DB and the data.
 *
 * WHAT THIS DOES NOT PROTECT (stated, not glossed — see SECURITY.md):
 *   - someone who steals the database AND cracks the password gets both the
 *     salt and the ciphertext and can derive the key too;
 *   - anyone reading this browser profile already has the readings — they
 *     sit in localStorage in the clear, and always have.
 * E2EE turns a bulk server breach into a per-user, per-password crack. That
 * is the guarantee, and it is the one the PM ruling confirmed.
 *
 * Runs on WebCrypto (`globalThis.crypto.subtle`), available in every browser
 * this PWA targets and in Node ≥18, so the same code is exercised by vitest
 * without a shim.
 */

/** OWASP's current floor for PBKDF2-HMAC-SHA256. Do not lower silently. */
export const PBKDF2_ITERATIONS = 600_000;

export const PBKDF2_HASH = "SHA-256" as const;
export const KDF_SALT_BYTES = 16;
export const AES_KEY_BYTES = 32;
export const GCM_IV_BYTES = 12;

export type EncryptedBlob = { iv: string; data: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* --------------------------------------------------------------------------
 * Base64 — chunked, because a year of readings is ~350 KB and
 * `String.fromCharCode(...bigArray)` overflows the argument limit.
 * ------------------------------------------------------------------------ */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    // eslint-disable-next-line no-restricted-syntax -- chunked by construction: subarray holds at most CHUNK (32 768) elements
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// `Uint8Array<ArrayBuffer>` (not the bare `Uint8Array` alias, which widens
// to `ArrayBufferLike`): WebCrypto's `BufferSource` only accepts views over a
// real ArrayBuffer, so the annotation is load-bearing.
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* --------------------------------------------------------------------------
 * Key derivation + AES-GCM
 * ------------------------------------------------------------------------ */

async function subtle(): Promise<SubtleCrypto> {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    // HTTP on a LAN address is the only realistic way to reach this app
    // without TLS, and browsers refuse WebCrypto there. Saying so beats a
    // blank rejection.
    throw new Error(
      "This browser will not run the encryption (WebCrypto needs https or localhost). Nothing was uploaded.",
    );
  }
  return c.subtle;
}

/**
 * Derive the blob key.
 *
 * `extractable: true` is a deliberate choice, not a slip: a key with
 * `extractable: false` cannot be persisted, and re-deriving on every page
 * load would mean retyping the password on every page load. The raw bytes
 * therefore exist locally (see `ACCOUNT_KEY_ITEM` in `lib/account/sync.ts`
 * for the full reasoning — including why that adds no new local exposure to
 * a profile that already stores the readings in the clear) and never travel:
 * uploads carry ciphertext, and the session cookie that would be needed to
 * use any of it is HttpOnly.
 */
export async function deriveBlobKey(password: string, saltBase64: string): Promise<CryptoKey> {
  const subtleCrypto = await subtle();
  const base = await subtleCrypto.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtleCrypto.deriveKey(
    { name: "PBKDF2", salt: base64ToBytes(saltBase64), iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    base,
    { name: "AES-GCM", length: AES_KEY_BYTES * 8 },
    true,
    ["encrypt", "decrypt"],
  );
}

/**
 * Export the key material so a reload does not need the password again.
 * The lifetime decision (and its reasoning) lives with `ACCOUNT_KEY_ITEM`;
 * this function is only the mechanism.
 */
export async function exportSessionKey(key: CryptoKey): Promise<string> {
  const subtleCrypto = await subtle();
  return bytesToBase64(new Uint8Array(await subtleCrypto.exportKey("raw", key)));
}

export async function importSessionKey(base64: string): Promise<CryptoKey> {
  const subtleCrypto = await subtle();
  // `extractable: true` matches `deriveBlobKey` so EVERY key this app holds
  // satisfies the same invariant: it can be re-persisted. A key that arrives
  // from storage but cannot be written back would make any future "save the
  // key again" path fail at runtime, in the one place nobody tests.
  return subtleCrypto.importKey("raw", base64ToBytes(base64), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

/** Encrypt the serialized dataset. A fresh IV per call — never reused. */
export async function encryptBlob(key: CryptoKey, plaintext: string): Promise<EncryptedBlob> {
  const subtleCrypto = await subtle();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = await subtleCrypto.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(plaintext));
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
}

/**
 * Decrypt a blob from the server. Throws with a message a user can act on:
 * "wrong password" and "corrupt blob" are the same observable outcome here
 * (AES-GCM is authenticated), and pretending to distinguish them would be
 * guessing.
 */
export async function decryptBlob(key: CryptoKey, iv: string, data: string): Promise<string> {
  const subtleCrypto = await subtle();
  const plaintext = await subtleCrypto.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(data),
  );
  return textDecoder.decode(plaintext);
}
