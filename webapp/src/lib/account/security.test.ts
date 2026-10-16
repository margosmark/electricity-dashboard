// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHostDataLocation, assertSecureDataDir } from "./config";
import { validateLoginPassword, validatePassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "./auth";
import { validateEmailConfig } from "./email";

describe("E2EE passphrase policy", () => {
  it("requires a 15-character new passphrase and returns actionable rejection feedback", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(15);
    expect(validatePassword("fourteen-chars")).toMatchObject({ ok: false, error: "Use at least 15 characters." });
    expect(validatePassword("a long memorable passphrase")).toMatchObject({ ok: true });
    expect(validatePassword("x".repeat(MAX_PASSWORD_LENGTH + 1)).ok).toBe(false);
  });

  it("still permits legacy short passwords at login", () => {
    expect(validateLoginPassword("old-pass")).toEqual({ ok: true, value: "old-pass" });
  });
});

describe("email delivery boundary config", () => {
  it("defaults to off and does not require delivery credentials", () => {
    expect(validateEmailConfig({})).toEqual({ mode: "off", provider: null, from: null, credentialFile: null });
    expect(validateEmailConfig({ ACCT_EMAIL_MODE: "test" }).mode).toBe("test");
  });

  it("validates live provider/from/secret-mount contract without reading or delivering secrets", () => {
    expect(() => validateEmailConfig({ ACCT_EMAIL_MODE: "live" })).toThrow("ACCT_EMAIL_PROVIDER");
    expect(() => validateEmailConfig({ ACCT_EMAIL_MODE: "live", ACCT_EMAIL_PROVIDER: "postmark", ACCT_EMAIL_FROM: "bad", ACCT_EMAIL_API_KEY_FILE: "/not/a/secret" })).toThrow("valid ACCT_EMAIL_FROM");
    const dir = mkdtempSync(join(tmpdir(), "email-secret-"));
    const file = join(dir, "key");
    try {
      writeFileSync(file, "test-secret-never-returned", { mode: 0o600 });
      chmodSync(file, 0o600);
      expect(validateEmailConfig({ ACCT_EMAIL_MODE: "live", ACCT_EMAIL_PROVIDER: "resend", ACCT_EMAIL_FROM: "verified@example.com", ACCT_EMAIL_API_KEY_FILE: file })).toEqual({
        mode: "live", provider: "resend", from: "verified@example.com", credentialFile: file,
      });
      chmodSync(file, 0o644);
      expect(() => validateEmailConfig({ ACCT_EMAIL_MODE: "live", ACCT_EMAIL_PROVIDER: "resend", ACCT_EMAIL_FROM: "verified@example.com", ACCT_EMAIL_API_KEY_FILE: file })).toThrow("mode 0600");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("external account storage guard", () => {
  it("fails clearly for unsafe permissions and repository-local bind sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "account-unsafe-"));
    try {
      chmodSync(dir, 0o755);
      expect(() => assertSecureDataDir(dir)).toThrow("mode 0700");
      expect(() => assertHostDataLocation(dir, dir)).toThrow("outside the host repository checkout");
      expect(() => assertHostDataLocation("relative/path", "/repo")).toThrow("absolute host path");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
