// @vitest-environment node
/**
 * Wave N — the client-side encryption, tested for the properties the whole
 * E2EE claim rests on.
 *
 * These are not "does it round-trip" tests (though they are that too). They
 * are the assertions that would fail if somebody quietly weakened the
 * scheme: the iteration count, the salt sensitivity, the per-blob IV, and
 * the fact that a wrong key produces nothing readable rather than something
 * plausible.
 */

import { describe, it, expect } from "vitest";
import {
  PBKDF2_ITERATIONS,
  KDF_SALT_BYTES,
  GCM_IV_BYTES,
  base64ToBytes,
  bytesToBase64,
  decryptBlob,
  deriveBlobKey,
  encryptBlob,
  exportSessionKey,
  importSessionKey,
} from "./crypto";

const SALT = bytesToBase64(crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES)));

describe("key derivation", () => {
  it("is pinned at OWASP's iteration floor", () => {
    // A silent cut to "make login snappy" would destroy the only thing
    // standing between a stolen database and the data. This is the guard.
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });

  it("produces a different key for a different password", async () => {
    const a = await deriveBlobKey("password-one", SALT);
    const b = await deriveBlobKey("password-two", SALT);
    expect((a.algorithm as KeyAlgorithm).name).toBe("AES-GCM");
    expect((a.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect(a.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
    const exportedA = await exportSessionKey(a);
    const exportedB = await exportSessionKey(b);
    expect(exportedA).not.toBe(exportedB);
  });

  it("produces a different key for a different salt (two accounts, same password)", async () => {
    const otherSalt = bytesToBase64(crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES)));
    const a = await deriveBlobKey("same-password", SALT);
    const b = await deriveBlobKey("same-password", otherSalt);
    expect(await exportSessionKey(a)).not.toBe(await exportSessionKey(b));
  });

  it("is deterministic: the same password and salt always re-derive the same key", async () => {
    const first = await deriveBlobKey("correct-horse", SALT);
    const second = await deriveBlobKey("correct-horse", SALT);
    expect(await exportSessionKey(first)).toBe(await exportSessionKey(second));
  });

  it("is exportable on purpose — and that is what makes a reload work", async () => {
    // The whole reason `extractable` is true: a page reload has no password,
    // so the key has to be recoverable from local storage (documented in
    // lib/account/sync.ts). A test that would fail if somebody "hardened"
    // this back to false and broke sync-on-reload in the same commit.
    const key = await deriveBlobKey("correct-horse", SALT);
    expect(key.extractable).toBe(true);
    const stored = await exportSessionKey(key);
    expect(stored.length).toBeGreaterThan(40);
    const restored = await importSessionKey(stored);
    expect(await exportSessionKey(restored)).toBe(stored);
  });
});

describe("encrypt / decrypt", () => {
  const payload = JSON.stringify({
    schema: "ontario-energy-optimizer.backup",
    version: 2,
    payload: { energy_data: Array.from({ length: 500 }, (_, i) => ({ timestamp: 1704067200 + i * 1800, usage_kwh: i * 0.25 })) },
  });

  it("round-trips a realistic payload", async () => {
    const key = await deriveBlobKey("correct-horse", SALT);
    const blob = await encryptBlob(key, payload);
    expect(blob.iv).toBeTruthy();
    expect(blob.data).not.toContain("ontario-energy-optimizer");
    expect(await decryptBlob(key, blob.iv, blob.data)).toBe(payload);
  });

  it("never stores the plaintext in the ciphertext", async () => {
    const key = await deriveBlobKey("correct-horse", SALT);
    const marker = "SUPER-RECONGIZABLE-MARKER";
    const blob = await encryptBlob(key, `{"note":"${marker}"}`);
    expect(blob.data).not.toContain(marker);
    expect(bytesToBase64(base64ToBytes(blob.data))).toBe(blob.data);
  });

  it("uses a fresh 96-bit IV every time, so the same plaintext never repeats", async () => {
    const key = await deriveBlobKey("correct-horse", SALT);
    const a = await encryptBlob(key, payload);
    const b = await encryptBlob(key, payload);
    expect(a.data).not.toBe(b.data);
    expect(base64ToBytes(a.iv).length).toBe(GCM_IV_BYTES);
    expect(base64ToBytes(b.iv).length).toBe(GCM_IV_BYTES);
    expect(a.iv).not.toBe(b.iv);
    expect(await decryptBlob(key, a.iv, a.data)).toBe(payload);
    expect(await decryptBlob(key, b.iv, b.data)).toBe(payload);
  });

  it("produces NOTHING readable under the wrong key — no partial, no plausible", async () => {
    const right = await deriveBlobKey("correct-horse", SALT);
    const wrong = await deriveBlobKey("incorrect-horse", SALT);
    const blob = await encryptBlob(right, payload);
    await expect(decryptBlob(wrong, blob.iv, blob.data)).rejects.toThrow();
  });

  it("detects tampering with the ciphertext", async () => {
    const key = await deriveBlobKey("correct-horse", SALT);
    const blob = await encryptBlob(key, payload);
    const bytes = base64ToBytes(blob.data);
    bytes[10] ^= 0xff;
    await expect(decryptBlob(key, blob.iv, bytesToBase64(bytes))).rejects.toThrow();
  });

  it("survives a payload big enough to exercise the base64 chunking", async () => {
    // A year of half-hourly readings ≈ 17k rows; the chunk boundary is 32k
    // BYTES, so anything larger than that is the case that used to blow the
    // argument limit in `String.fromCharCode(...array)`.
    const big = JSON.stringify(
      Array.from({ length: 40_000 }, (_, i) => ({ timestamp: 1704067200 + i * 1800, usage_kwh: (i % 97) / 4 })),
    );
    expect(big.length).toBeGreaterThan(64_000);
    const key = await deriveBlobKey("correct-horse", SALT);
    const blob = await encryptBlob(key, big);
    expect(await decryptBlob(key, blob.iv, blob.data)).toBe(big);
  });
});

describe("base64 helpers", () => {
  it("round-trips every length around the chunk boundary", () => {
    for (const length of [0, 1, 31_999, 32_000, 32_001, 65_537]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 31) % 256;
      expect(bytesToBase64(base64ToBytes(bytesToBase64(bytes)))).toBe(bytesToBase64(bytes));
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it("survives a round trip through the session-key persistence path", async () => {
    const key = await deriveBlobKey("correct-horse", SALT);
    const stored = await exportSessionKey(key);
    const restored = await importSessionKey(stored);
    expect(await exportSessionKey(restored)).toBe(stored);
    const blob = await encryptBlob(key, "payload");
    expect(await decryptBlob(restored, blob.iv, blob.data)).toBe("payload");
  });
});
