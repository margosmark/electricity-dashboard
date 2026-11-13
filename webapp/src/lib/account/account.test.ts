// @vitest-environment node
/**
 * Wave N — the account server, tested as routes rather than as functions.
 *
 * Every test here drives a real `Request` through a real handler with a real
 * SQLite file, because the properties that matter are the ones that only
 * exist at that level: which gate answers, what lands in the cookie, whether
 * a stale revision is refused, and — the one this whole feature is about —
 * that the server ends up holding bytes it cannot read.
 *
 * The fixture sets `ACCT_ENABLED` and points `ACCT_DB_PATH` at a temp dir so
 * no test can ever touch a real database.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

import { resetAccountConfigCache, getAccountConfig, MAX_SYNC_BYTES } from "./config";
import { closeAllDbs, openDb, getMeta, DEFAULT_PUSH_PREFS, insertAccount } from "./db";
import { resetAccountServices } from "./services";
import { resetRateLimits, LIMITS } from "./ratelimit";
import { decide, inQuietHours, localDayStart } from "./push";
import { ARGON2_OPTIONS, DUMMY_PASSWORD_HASH, hashPassword, newRecoveryCode, normalizeRecoveryCode } from "./auth";

const emailTestState = vi.hoisted(() => ({ tokens: [] as string[] }));
vi.mock("@/lib/account/email", () => ({
  registrationEmail: (_cfg: unknown, email: string, token: string) => {
    emailTestState.tokens.push(token);
    return { to: email, subject: "verify", text: token, html: token };
  },
  recoveryEmail: (_cfg: unknown, email: string, token: string) => {
    emailTestState.tokens.push(token);
    return { to: email, subject: "recover", text: token, html: token };
  },
  enqueueAccountEmail: vi.fn(() => true),
  drainOutbox: vi.fn(),
}));

import * as sessionRoute from "@/app/account/session/route";
import * as registerRoute from "@/app/account/register/route";
import * as recoverRoute from "@/app/account/recover/route";
import * as verifyRoute from "@/app/account/verify/route";
import * as recoveryVerifyRoute from "@/app/account/recover/verify/route";
import * as smtpEventsRoute from "@/app/account/smtp-events/route";
import * as loginRoute from "@/app/account/login/route";
import * as logoutRoute from "@/app/account/logout/route";
import * as syncRoute from "@/app/account/sync/route";
import * as notifyRoute from "@/app/account/notify/route";
import * as internalNotifyRoute from "@/app/account/internal/notify/route";
import * as prefsRoute from "@/app/account/push/preferences/route";
import * as subscribeRoute from "@/app/account/push/subscribe/route";

const BASE = "https://electricity.markarslan.ca";

/** Four Crockford-base32 groups — see `auth.ts#newRecoveryCode`. */
const RECOVERY_PATTERN = /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/;

let dbDir: string;
let smtpUsernameFile: string;
let smtpPasswordFile: string;
let smtpEventsFile: string;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "wave-n-"));
  smtpUsernameFile = join(dbDir, "smtp-username");
  smtpPasswordFile = join(dbDir, "smtp-password");
  smtpEventsFile = join(dbDir, "smtp-events-secret");
  for (const file of [smtpUsernameFile, smtpPasswordFile, smtpEventsFile]) {
    writeFileSync(file, "test-secret", { mode: 0o400 });
    chmodSync(file, 0o400);
  }
  process.env.ACCT_ENABLED = "true";
  process.env.ACCT_DATA_DIR = dbDir;
  process.env.ACCT_DATA_DIR_HOST = dbDir;
  process.env.ACCT_REPO_HOST_DIR = process.cwd();
  process.env.ACCT_DB_PATH = join(dbDir, "accounts.db");
  process.env.ACCT_PUBLIC_ORIGIN = BASE;
  process.env.ACCT_INTERNAL_TOKEN = "internal-token-for-tests";
  process.env.ACCT_MAX_ACCOUNTS = "10";
  process.env.ACCT_EMAIL_VERIFICATION_ENABLED = "true";
  process.env.ACCT_SMTP_HOST = "smtp.example.test";
  process.env.ACCT_SMTP_PORT = "587";
  process.env.ACCT_SMTP_TLS_MODE = "starttls";
  process.env.ACCT_SMTP_HELO = "electricity.markarslan.ca";
  process.env.ACCT_SMTP_FROM = "accounts@electricity.markarslan.ca";
  process.env.ACCT_SMTP_REPLY_TO = "support@electricity.markarslan.ca";
  process.env.ACCT_SMTP_TIMEOUT_MS = "1000";
  process.env.ACCT_SMTP_USERNAME_FILE = smtpUsernameFile;
  process.env.ACCT_SMTP_PASSWORD_FILE = smtpPasswordFile;
  process.env.ACCT_SMTP_EVENTS_SECRET_FILE = smtpEventsFile;
  process.env.ACCT_RATES_URL = "http://127.0.0.1:1/api/rates";
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  resetAccountConfigCache();
});

afterAll(() => {
  resetAccountServices();
  closeAllDbs();
  resetAccountConfigCache();
  delete process.env.ACCT_ENABLED;
  delete process.env.ACCT_DATA_DIR;
  delete process.env.ACCT_DATA_DIR_HOST;
  delete process.env.ACCT_REPO_HOST_DIR;
  delete process.env.ACCT_DB_PATH;
  delete process.env.ACCT_PUBLIC_ORIGIN;
  delete process.env.ACCT_INTERNAL_TOKEN;
  delete process.env.ACCT_MAX_ACCOUNTS;
  for (const key of ["ACCT_EMAIL_VERIFICATION_ENABLED", "ACCT_SMTP_HOST", "ACCT_SMTP_PORT", "ACCT_SMTP_TLS_MODE", "ACCT_SMTP_HELO", "ACCT_SMTP_FROM", "ACCT_SMTP_REPLY_TO", "ACCT_SMTP_TIMEOUT_MS", "ACCT_SMTP_USERNAME_FILE", "ACCT_SMTP_PASSWORD_FILE", "ACCT_SMTP_EVENTS_SECRET_FILE"]) delete process.env[key];
  delete process.env.ACCT_RATES_URL;
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * Each test starts from an empty database so an ordering accident can never
 * make a later assertion pass for the wrong reason.
 */
beforeEach(() => {
  closeAllDbs();
  rmSync(process.env.ACCT_DB_PATH!, { force: true });
  rmSync(`${process.env.ACCT_DB_PATH!}-wal`, { force: true });
  rmSync(`${process.env.ACCT_DB_PATH!}-shm`, { force: true });
  resetAccountConfigCache();
  // The attempt budget is process state, not database state: a fresh DB with
  // stale buckets would make the rate-limit cases pass or fail for the wrong
  // reason (and would let one test's failures leak into the next one's).
  resetRateLimits();
  emailTestState.tokens.length = 0;
});

afterEach(() => {
  resetAccountServices();
  // A test that pins the clock (quiet hours are wall-clock) must not leak it.
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------ */

const json = (body: unknown, init: RequestInit = {}) =>
  new Request(`${BASE}/account/test`, {
    headers: { "content-type": "application/json", origin: BASE, ...(init.headers ?? {}) },
    ...init,
  });

const post = (url: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(
      url.endsWith("/account/register") && body && typeof body === "object" && !("policyAccepted" in body)
        ? { ...(body as Record<string, unknown>), policyAccepted: true, privacyVersion: "2026-10-16", termsVersion: "2026-10-16" }
        : body,
    ),
  });

const put = (url: string, body: unknown, cookie?: string) =>
  new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** The `acct_session` value out of a `Set-Cookie` header (or null). */
function sessionCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const match = /(?:^|,\s*)acct_session=([^;]*)/.exec(raw);
  return match ? match[1] : null;
}

function asCookie(value: string | null): string | undefined {
  return value ? `acct_session=${value}` : undefined;
}

async function register(
  email = "mark@example.com",
  password = "correct-horse-battery",
  _hasLocalData = false,
): Promise<{ res: Response; cookie: string; body: Record<string, unknown> }> {
  const res = await registerRoute.POST(
    post(`${BASE}/account/register`, {
      email,
      hasLocalData: _hasLocalData,
      policyAccepted: true,
      privacyVersion: "2026-10-16",
      termsVersion: "2026-10-16",
    }),
  );
  if (res.status === 202) {
    const token = emailTestState.tokens.pop();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
    const verified = await verifyRoute.POST(post(`${BASE}/account/verify`, { token, password }));
    const body = (await verified.json()) as Record<string, unknown>;
    return { res: verified, cookie: asCookie(sessionCookie(verified))!, body };
  }
  const body = (await res.json()) as Record<string, unknown>;
  return { res, cookie: asCookie(sessionCookie(res))!, body };
}

const validIv = () => randomBytes(12).toString("base64");
const encryptLikeABrowser = (plaintext: string) => randomBytes(Math.ceil(plaintext.length * 0.75)).toString("base64");

/* ==========================================================================
 * Gate 1 — the feature flag
 * ========================================================================== */

describe("the feature flag", () => {
  it("keeps email-dependent routes invisible when email verification is disabled", async () => {
    const smtpKeys = ["ACCT_SMTP_HOST", "ACCT_SMTP_PORT", "ACCT_SMTP_TLS_MODE", "ACCT_SMTP_HELO", "ACCT_SMTP_FROM", "ACCT_SMTP_REPLY_TO", "ACCT_SMTP_TIMEOUT_MS", "ACCT_SMTP_USERNAME_FILE", "ACCT_SMTP_PASSWORD_FILE", "ACCT_SMTP_EVENTS_SECRET_FILE"];
    const saved = Object.fromEntries(smtpKeys.map((key) => [key, process.env[key]]));
    const savedEmailVerification = process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
    // Omit the variable entirely: the default must be the same hard-disabled
    // behavior as an explicit false, even when SMTP mounts are absent.
    delete process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
    for (const key of smtpKeys) delete process.env[key];
    resetAccountConfigCache();
    try {
      const register = await registerRoute.POST(post(`${BASE}/account/register`, { email: "off@example.com" }));
      const recover = await (await import("@/app/account/recover/route")).POST(post(`${BASE}/account/recover`, { email: "off@example.com" }));
      const verify = await verifyRoute.POST(post(`${BASE}/account/verify`, { token: "A".repeat(40), password: "correct password" }));
      expect(register.status).toBe(404);
      expect(recover.status).toBe(404);
      expect(verify.status).toBe(404);
      const db = openDb(process.env.ACCT_DB_PATH!);
      expect((db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM email_tokens").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get() as { n: number }).n).toBe(0);
    } finally {
      if (savedEmailVerification === undefined) delete process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
      else process.env.ACCT_EMAIL_VERIFICATION_ENABLED = savedEmailVerification;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetAccountConfigCache();
    }
  });

  it("keeps all email-dependent routes invisible when the account server is disabled", async () => {
    const savedEnabled = process.env.ACCT_ENABLED;
    const savedEmailVerification = process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
    delete process.env.ACCT_ENABLED;
    process.env.ACCT_EMAIL_VERIFICATION_ENABLED = "true";
    resetAccountConfigCache();
    try {
      const register = await registerRoute.POST(post(`${BASE}/account/register`, { email: "account-off@example.com" }));
      const recover = await (await import("@/app/account/recover/route")).POST(post(`${BASE}/account/recover`, { email: "account-off@example.com" }));
      const verify = await verifyRoute.POST(post(`${BASE}/account/verify`, { token: "B".repeat(40), password: "correct password" }));
      expect(register.status).toBe(404);
      expect(recover.status).toBe(404);
      expect(verify.status).toBe(404);
    } finally {
      if (savedEnabled === undefined) delete process.env.ACCT_ENABLED;
      else process.env.ACCT_ENABLED = savedEnabled;
      if (savedEmailVerification === undefined) delete process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
      else process.env.ACCT_EMAIL_VERIFICATION_ENABLED = savedEmailVerification;
      resetAccountConfigCache();
    }
  });

  it("returns the same 404 for supported, wrong-method, and OPTIONS email probes when verification is off", async () => {
    const saved = process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
    process.env.ACCT_EMAIL_VERIFICATION_ENABLED = "false";
    resetAccountConfigCache();
    try {
      const probes = [
        registerRoute.POST(post(`${BASE}/account/register`, { email: "off-method@example.com" })),
        registerRoute.OPTIONS(new Request(`${BASE}/account/register`, { method: "OPTIONS" })),
        recoverRoute.POST(post(`${BASE}/account/recover`, { email: "off-method@example.com" })),
        recoverRoute.OPTIONS(new Request(`${BASE}/account/recover`, { method: "OPTIONS" })),
        verifyRoute.POST(post(`${BASE}/account/verify`, { token: "A".repeat(40), password: "correct password" })),
        verifyRoute.OPTIONS(new Request(`${BASE}/account/verify`, { method: "OPTIONS" })),
        recoveryVerifyRoute.POST(post(`${BASE}/account/recover/verify`, { token: "A".repeat(40), newPassword: "correct password" })),
        recoveryVerifyRoute.OPTIONS(new Request(`${BASE}/account/recover/verify`, { method: "OPTIONS" })),
        smtpEventsRoute.POST(post(`${BASE}/account/smtp-events`, {})),
        smtpEventsRoute.OPTIONS(new Request(`${BASE}/account/smtp-events`, { method: "OPTIONS" })),
      ];
      for (const res of await Promise.all(probes)) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    } finally {
      if (saved === undefined) delete process.env.ACCT_EMAIL_VERIFICATION_ENABLED;
      else process.env.ACCT_EMAIL_VERIFICATION_ENABLED = saved;
      resetAccountConfigCache();
    }
  });

  it("fails closed when email verification is enabled without the full SMTP contract", async () => {
    const passwordFile = process.env.ACCT_SMTP_PASSWORD_FILE!;
    delete process.env.ACCT_SMTP_PASSWORD_FILE;
    resetAccountConfigCache();
    try {
      const res = await registerRoute.POST(post(`${BASE}/account/register`, { email: "incomplete@example.com" }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "email_unavailable" });
      const db = openDb(process.env.ACCT_DB_PATH!);
      expect((db.prepare("SELECT COUNT(*) AS n FROM email_tokens").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get() as { n: number }).n).toBe(0);
    } finally {
      process.env.ACCT_SMTP_PASSWORD_FILE = passwordFile;
      resetAccountConfigCache();
    }
  });

  it("404s every account route when this process is not the account server", async () => {
    delete process.env.ACCT_ENABLED;
    resetAccountConfigCache();
    const res = await sessionRoute.GET(new Request(`${BASE}/account/session`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // Indistinguishable from "no such route": an app-container response must
    // not confirm that an account system exists behind the router.
    expect(res.headers.get("x-acct-anything")).toBeNull();
    process.env.ACCT_ENABLED = "true";
    resetAccountConfigCache();
  });

  it("404s every method on every route while the feature is off — wrong-method probes included", async () => {
    // The router answers a method the route does not export BEFORE any
    // handler runs, so `requireEnabled()` alone never saw these: a bundle
    // that contains the route answered 405 (and auto-OPTIONS 204 + Allow)
    // on a deployment that claims to have no account API. The per-route
    // `wrongMethod` stubs carry Gate 1 to those verbs.
    delete process.env.ACCT_ENABLED;
    resetAccountConfigCache();
    const probes = [
      await loginRoute.GET(new Request(`${BASE}/account/login`)),
      await loginRoute.OPTIONS(new Request(`${BASE}/account/login`, { method: "OPTIONS" })),
      await sessionRoute.POST(new Request(`${BASE}/account/session`, { method: "POST" })),
      await notifyRoute.GET(new Request(`${BASE}/account/notify`)),
      await syncRoute.DELETE(new Request(`${BASE}/account/sync`, { method: "DELETE" })),
      await prefsRoute.PATCH(new Request(`${BASE}/account/push/preferences`, { method: "PATCH" })),
      await subscribeRoute.GET(new Request(`${BASE}/account/push/subscribe`)),
      await internalNotifyRoute.PUT(new Request(`${BASE}/account/internal/notify`, { method: "PUT" })),
    ];
    for (const res of probes) {
      expect(res.status).toBe(404);
      // Byte-identical to `requireEnabled()`'s answer — no detail, no header
      // that could tell a probe which of these routes exist.
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    process.env.ACCT_ENABLED = "true";
    resetAccountConfigCache();
  });

  it("keeps an honest 405 for those methods once the feature IS on (the stub must not blanket-404)", async () => {
    const res = await loginRoute.GET(new Request(`${BASE}/account/login`));
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("method_not_allowed");
    expect(body.detail).toContain("GET");
  });

  it("answers 200 with enabled:false when signed out, so the UI knows the feature exists", async () => {
    const res = await sessionRoute.GET(new Request(`${BASE}/account/session`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.authed).toBe(false);
    expect(body.pushConfigured).toBe(false); // no VAPID keys in this fixture
  });

  it("never caches a session response", async () => {
    const res = await sessionRoute.GET(new Request(`${BASE}/account/session`));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

/* ==========================================================================
 * Registration + login
 * ========================================================================== */

describe("registration verification gate", () => {
  it("rejects an embedded password before any account work, without creating an account or session", async () => {
    const res = await registerRoute.POST(post(`${BASE}/account/register`, { email: "mark@example.com", password: "attacker-owned-password" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "verification_required" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((openDb(process.env.ACCT_DB_PATH!).prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n).toBe(0);
  });

  it("does not reveal whether an address already has an account", async () => {
    await register("known@example.com");
    const known = await registerRoute.POST(post(`${BASE}/account/register`, { email: "KNOWN@example.com" }));
    const unknown = await registerRoute.POST(post(`${BASE}/account/register`, { email: "unknown@example.com" }));
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("rejects an explicit unchecked policy acknowledgement before registration can proceed", async () => {
    const res = await registerRoute.POST(post(`${BASE}/account/register`, {
      email: "mark@example.com",
      policyAccepted: false,
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "policy_acceptance_required" });
    expect((openDb(process.env.ACCT_DB_PATH!).prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n).toBe(0);
  });

  it("does not reveal whether an address already has an account", async () => {
    await register("known@example.com");
    const known = await registerRoute.POST(post(`${BASE}/account/register`, { email: "KNOWN@example.com" }));
    const unknown = await registerRoute.POST(post(`${BASE}/account/register`, { email: "unknown@example.com" }));
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
  });


  it("does not disclose a duplicate e-mail from the verification request", async () => {
    await register();
    const again = await registerRoute.POST(
      post(`${BASE}/account/register`, { email: "MARK@example.com" }),
    );
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ ok: true, verificationRequired: true });
  });

  it("refuses a cross-site registration", async () => {
    const res = await registerRoute.POST(post(`${BASE}/account/register`, { email: "x@example.com" }, undefined, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("enforces the family-scale account ceiling", async () => {
    process.env.ACCT_MAX_ACCOUNTS = "1";
    resetAccountConfigCache();
    await register("first@example.com");
    const second = await registerRoute.POST(post(`${BASE}/account/register`, { email: "second@example.com" }));
    expect(second.status).toBe(202);
    const token = emailTestState.tokens.pop()!;
    const verified = await verifyRoute.POST(post(`${BASE}/account/verify`, { token, password: "correct-horse-battery" }));
    expect(verified.status).toBe(403);
    expect(((await verified.json()) as { error: string }).error).toBe("account_limit");
    process.env.ACCT_MAX_ACCOUNTS = "10";
    resetAccountConfigCache();
  });
});

describe("login", () => {
  it("returns the KDF salt and revision for a correct password", async () => {
    await register();
    const res = await loginRoute.POST(
      post(`${BASE}/account/login`, { email: "mark@example.com", password: "correct-horse-battery" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.rev).toBe(0);
    expect(sessionCookie(res)).toBeTruthy();
  });

  it("answers 401 for a wrong password AND for an unknown address, with the same message", async () => {
    await register();
    const wrong = await loginRoute.POST(
      post(`${BASE}/account/login`, { email: "mark@example.com", password: "not-the-password" }),
    );
    const unknown = await loginRoute.POST(
      post(`${BASE}/account/login`, { email: "nobody@example.com", password: "not-the-password" }),
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await wrong.json()) as unknown).toEqual((await unknown.json()) as unknown);
  });

  it("costs the same work for an unknown address as for a real one (no stopwatch enumeration)", async () => {
    await register();
    const timeOf = async (email: string) => {
      const t0 = process.hrtime.bigint();
      await loginRoute.POST(post(`${BASE}/account/login`, { email, password: "whatever-wrong" }));
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const real = await timeOf("mark@example.com");
    const fake = await timeOf("nobody@example.com");
    // Both paths run argon2id at the same parameters; the dummy hash exists
    // precisely so `fake` is not ~0 ms.
    expect(fake).toBeGreaterThan(0.1);
    expect(Math.abs(fake - real)).toBeLessThan(Math.max(real, fake));
  });

  it("stores only an argon2id verifier — never the password", async () => {
    await register();
    const db = openDb(getAccountConfig().dbPath);
    const row = db.prepare("SELECT password_hash, kdf_salt FROM accounts").get() as {
      password_hash: string;
      kdf_salt: string;
    };
    expect(row.password_hash.startsWith("$argon2id$")).toBe(true);
    expect(row.password_hash).not.toContain("correct-horse-battery");
    // The blob salt is a different value: the two KDFs never share inputs.
    expect(row.kdf_salt).not.toBe(row.password_hash);
  });

  it("does not create a session for a legacy unverified account, then permits explicit mailbox migration", async () => {
    await register("legacy@example.com", "legacy-password");
    const db = openDb(getAccountConfig().dbPath);
    db.prepare("UPDATE accounts SET email_verified_at = NULL").run();
    db.prepare("DELETE FROM sessions").run();
    const sessionsBefore = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

    const blocked = await loginRoute.POST(post(`${BASE}/account/login`, { email: "legacy@example.com", password: "legacy-password" }));
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual({ error: "invalid_credentials", detail: "That e-mail address and password do not match." });
    expect(sessionCookie(blocked)).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(sessionsBefore);

    const migrationRequest = await registerRoute.POST(post(`${BASE}/account/register`, { email: "legacy@example.com" }));
    expect(migrationRequest.status).toBe(202);
    const token = emailTestState.tokens.pop();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
    const migrated = await verifyRoute.POST(post(`${BASE}/account/verify`, { token, password: "legacy-password" }));
    expect(migrated.status).toBe(200);
    expect(sessionCookie(migrated)).toBeTruthy();
    expect((db.prepare("SELECT email_verified_at FROM accounts WHERE email=?").get("legacy@example.com") as { email_verified_at: number | null }).email_verified_at).not.toBeNull();
  });
});

/* ==========================================================================
 * Sync — ciphertext at rest, revisions in front
 * ========================================================================== */

describe("sync", () => {
  it("round-trips ciphertext and reports what the browser needs to decrypt it", async () => {
    const { cookie } = await register();
    const iv = validIv();
    const data = encryptLikeABrowser("pretend-this-is-aes-gcm");

    const write = await syncRoute.PUT(
      put(`${BASE}/account/sync`, { iv, data, baseRev: 0 }, cookie),
    );
    expect(write.status).toBe(200);
    expect(((await write.json()) as { rev: number }).rev).toBe(1);

    const read = await syncRoute.GET(new Request(`${BASE}/account/sync`, { headers: { cookie: cookie! } }));
    const body = (await read.json()) as { rev: number; iv: string; data: string; kdfSalt: string };
    expect(body.rev).toBe(1);
    expect(body.iv).toBe(iv);
    expect(body.data).toBe(data);
    expect(body.kdfSalt).toBeTruthy();
  });

  it("generates a recovery code on the FIRST server-side copy of the data", async () => {
    const { cookie } = await register(); // registered with no local data
    const first = await syncRoute.PUT(
      put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("x"), baseRev: 0 }, cookie),
    );
    const firstBody = (await first.json()) as { rev: number; recoveryCode: string | null };
    expect(firstBody.rev).toBe(1);
    expect(firstBody.recoveryCode as string).toMatch(RECOVERY_PATTERN);

    const second = await syncRoute.PUT(
      put(
        `${BASE}/account/sync`,
        { iv: validIv(), data: encryptLikeABrowser("y"), baseRev: 1 },
        cookie,
      ),
    );
    expect(((await second.json()) as { recoveryCode: string | null }).recoveryCode).toBeNull();
  });

  it("refuses a write built from a stale revision (409 with the current one)", async () => {
    const { cookie } = await register();
    await syncRoute.PUT(put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("a"), baseRev: 0 }, cookie));
    const stale = await syncRoute.PUT(
      put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("b"), baseRev: 0 }, cookie),
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; currentRev: number };
    expect(body.error).toBe("stale_revision");
    expect(body.currentRev).toBe(1);

    // The refused write must not have landed.
    const read = await syncRoute.GET(new Request(`${BASE}/account/sync`, { headers: { cookie: cookie! } }));
    expect(((await read.json()) as { rev: number }).rev).toBe(1);
  });

  it("keeps 409 conflict semantics when two HTTP writes race on the same base revision", async () => {
    const { cookie } = await register();
    const writes = await Promise.all([
      syncRoute.PUT(put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("writer-one"), baseRev: 0 }, cookie)),
      syncRoute.PUT(put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("writer-two"), baseRev: 0 }, cookie)),
    ]);
    expect(writes.map((res) => res.status).sort()).toEqual([200, 409]);
    const conflict = writes.find((res) => res.status === 409)!;
    expect(await conflict.json()).toMatchObject({ error: "stale_revision", currentRev: 1 });
    expect(((await syncRoute.GET(new Request(`${BASE}/account/sync`, { headers: { cookie } })).then((r) => r.json())) as { rev: number }).rev).toBe(1);
  });

  it("rejects a malformed IV, non-base64 ciphertext and a non-integer baseRev", async () => {
    const { cookie } = await register();
    const cases = [
      { iv: "too-short", data: encryptLikeABrowser("x"), baseRev: 0 },
      { iv: validIv(), data: "!!! not base64 !!!", baseRev: 0 },
      { iv: validIv(), data: encryptLikeABrowser("x"), baseRev: "0" },
      { iv: validIv(), data: encryptLikeABrowser("x"), baseRev: -1 },
    ];
    for (const body of cases) {
      const res = await syncRoute.PUT(put(`${BASE}/account/sync`, body, cookie));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("bounds the body read instead of buffering whatever nginx admits", async () => {
    const { cookie } = await register();
    // 64 MB is what the edge admits for /import; the account API must not.
    const res = await syncRoute.PUT(
      put(
        `${BASE}/account/sync`,
        { iv: validIv(), data: "A".repeat(MAX_SYNC_BYTES + 1024), baseRev: 0 },
        cookie,
      ),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  it("401s every sync call without the session cookie", async () => {
    const read = await syncRoute.GET(new Request(`${BASE}/account/sync`));
    expect(read.status).toBe(401);
    const write = await syncRoute.PUT(put(`${BASE}/account/sync`, { iv: validIv(), data: "AAAA", baseRev: 0 }));
    expect(write.status).toBe(401);
  });

  it("does not publish the blob to a signed-out caller", async () => {
    const { cookie } = await register();
    await syncRoute.PUT(put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("secret"), baseRev: 0 }, cookie));
    const anon = await syncRoute.GET(new Request(`${BASE}/account/session`));
    const body = (await anon.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.hasBlob).toBeUndefined();
  });
});

/* ==========================================================================
 * Logout + recovery
 * ========================================================================== */

describe("logout", () => {
  it("deletes the session server-side, so the cookie stops working even if kept", async () => {
    const { cookie } = await register();
    expect(
      (await syncRoute.GET(new Request(`${BASE}/account/sync`, { headers: { cookie: cookie! } }))).status,
    ).toBe(200);

    const out = await logoutRoute.POST(post(`${BASE}/account/logout`, {}, cookie));
    expect(out.status).toBe(200);
    expect(sessionCookie(out)).toBe("");

    // The raw cookie value, replayed after logout, must be dead.
    const replay = await syncRoute.GET(new Request(`${BASE}/account/sync`, { headers: { cookie: cookie! } }));
    expect(replay.status).toBe(401);
  });

  it("is idempotent", async () => {
    const first = await logoutRoute.POST(post(`${BASE}/account/logout`, {}));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { wasAuthenticated: boolean }).wasAuthenticated).toBe(false);
  });
});

describe("recover", () => {
  it("accepts the recovery code, replaces the verifier, and DROPS the unreadable blob", async () => {
    const { cookie, body } = await register("r@example.com", "correct-horse-battery", true);
    expect(body.recoveryCode).toMatch(RECOVERY_PATTERN);
    await syncRoute.PUT(put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("old"), baseRev: 0 }, cookie));

    const recovery = await import("@/app/account/recover/route");
    const requested = await recovery.POST(post(`${BASE}/account/recover`, { email: "r@example.com" }));
    expect(requested.status).toBe(202);
    const token = emailTestState.tokens.pop()!;
    const out = await recoveryVerifyRoute.POST(post(`${BASE}/account/recover/verify`, { token, newPassword: "a-brand-new-password" }));
    expect(out.status).toBe(200);
    const payload = (await out.json()) as { blobDropped: boolean; recoveryCode: string; blobDroppedReason: string };
    expect(payload.blobDropped).toBe(true);
    expect(payload.blobDroppedReason).toMatch(/encrypted with the old password/);
    // Mailbox proof recovery never returns a reusable recovery code.
    expect(payload.recoveryCode).toBeUndefined();

    // The old password is dead, the new one works.
    const old = await loginRoute.POST(
      post(`${BASE}/account/login`, { email: "r@example.com", password: "correct-horse-battery" }),
    );
    expect(old.status).toBe(401);
    const fresh = await loginRoute.POST(
      post(`${BASE}/account/login`, { email: "r@example.com", password: "a-brand-new-password" }),
    );
    expect(fresh.status).toBe(200);

    // ...and there is no orphaned ciphertext pretending to be a backup.
    const read = await syncRoute.GET(
      new Request(`${BASE}/account/sync`, { headers: { cookie: asCookie(sessionCookie(fresh))! } }),
    );
    const syncBody = (await read.json()) as { rev: number; data: string | null };
    expect(syncBody.rev).toBe(0);
    expect(syncBody.data).toBeNull();
  });

  it("refuses a wrong code, and says the same thing for an unknown address", async () => {
    await register("r@example.com", "correct-horse-battery", true);
    const badCode = await import("@/app/account/recover/route").then((m) =>
      m.POST(
        post(`${BASE}/account/recover`, {
          email: "r@example.com",
          recoveryCode: "AAAAA-BBBBB-CCCCC-DDDDD",
          newPassword: "a-brand-new-password",
        }),
      ),
    );
    const unknown = await import("@/app/account/recover/route").then((m) =>
      m.POST(
        post(`${BASE}/account/recover`, {
          email: "nobody@example.com",
          recoveryCode: "AAAAA-BBBBB-CCCCC-DDDDD",
          newPassword: "a-brand-new-password",
        }),
      ),
    );
    expect(badCode.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect((await badCode.json()) as unknown).toEqual((await unknown.json()) as unknown);
  });
});

/* ==========================================================================
 * Internal fan-out (shim → account), denied at the edge
 * ========================================================================== */

describe("internal notify", () => {
  it("404s without the shared token — indistinguishable from no such route", async () => {
    const res = await internalNotifyRoute.POST(
      post(`${BASE}/account/internal/notify`, { topic: "data_available", title: "x" }),
    );
    expect(res.status).toBe(404);
  });

  it("404s with a WRONG token, and 200s with the right one", async () => {
    // Quiet hours are wall-clock, so this assertion is pinned to a time
    // outside every default quiet window (noon local): run at 23:00 the same
    // request is suppressed as `quiet_hours` and the test reads as a defect.
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00-04:00"), toFake: ["Date"] });
    // A real account, so the fan-out has somebody to be suppressed FOR —
    // "no subscriptions" is only meaningful when a subscriber could exist.
    await register("fanout@example.com");
    const wrong = await internalNotifyRoute.POST(
      post(`${BASE}/account/internal/notify`, { topic: "data_available", title: "x" }, undefined, {
        "x-account-internal": "not-the-token",
      }),
    );
    expect(wrong.status).toBe(404);

    const right = await internalNotifyRoute.POST(
      post(`${BASE}/account/internal/notify`, { topic: "data_available", title: "New data" }, undefined, {
        "x-account-internal": "internal-token-for-tests",
      }),
    );
    expect(right.status).toBe(200);
    // No subscriptions yet ⇒ suppressed, but accepted.
    expect(((await right.json()) as { suppressed: string | null }).suppressed).toBe("no_subscriptions");
  });

  it("rejects an unknown topic", async () => {
    const res = await internalNotifyRoute.POST(
      post(`${BASE}/account/internal/notify`, { topic: "exfiltrate", title: "x" }, undefined, {
        "x-account-internal": "internal-token-for-tests",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("session-authed notify", () => {
  it("401s without a session and 200s with one", async () => {
    const anon = await notifyRoute.POST(post(`${BASE}/account/notify`, { topic: "anomaly", title: "x" }));
    expect(anon.status).toBe(401);

    const { cookie } = await register();
    const ok = await notifyRoute.POST(
      post(`${BASE}/account/notify`, { topic: "anomaly", title: "Unusual usage" }, cookie),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { sent: number }).toMatchObject({ sent: 0 });
  });

  it("reaches the CALLER's account only — never every account (round-1 H1)", async () => {
    const ann = await register("ann@example.com");
    const bob = await register("bob@example.com");
    const db = openDb(getAccountConfig().dbPath);
    const idOf = (email: string) =>
      (db.prepare("SELECT id FROM accounts WHERE email = ?").get(email) as { id: number }).id;
    const annId = idOf("ann@example.com");
    const bobId = idOf("bob@example.com");

    // BOTH accounts subscribe. Under the old `fanOut(cfg, db, payload)` — no
    // target argument — one POST from Ann produced a send attempt against
    // Bob's endpoint with Ann's usage-derived text in it.
    for (const id of [annId, bobId]) {
      db.prepare(
        "INSERT INTO push_subs (account_id, endpoint, p256dh, auth, created_at, failures) VALUES (?, ?, ?, ?, ?, 0)",
      ).run(id, `https://push.example/device-${id}`, "p256dh", "auth", Date.now());
    }

    const res = await notifyRoute.POST(
      post(
        `${BASE}/account/notify`,
        { topic: "anomaly", title: "Unusual usage on Oct 3", body: "42 kWh that day — about 2.3x the usual." },
        ann.cookie,
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { sent: number }).toMatchObject({ sent: 0 });

    const rows = () =>
      db.prepare("SELECT account_id FROM notify_log ORDER BY id").all() as { account_id: number }[];
    // Exactly one decision was made, and it was Ann's: no log row, no send
    // attempt, no interval consumed on Bob's side.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].account_id).toBe(annId);

    // Bob's own notification is decided from scratch afterwards.
    const bobRes = await notifyRoute.POST(
      post(`${BASE}/account/notify`, { topic: "anomaly", title: "Something else" }, bob.cookie),
    );
    expect(bobRes.status).toBe(200);
    expect(rows().filter((r) => r.account_id === bobId)).toHaveLength(1);
    expect(rows().filter((r) => r.account_id === annId)).toHaveLength(1);
  });

  it("refuses a SERVER-origin topic from a browser session", async () => {
    const { cookie } = await register();
    const res = await notifyRoute.POST(
      post(`${BASE}/account/notify`, { topic: "oeb_rates", title: "New rates" }, cookie),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_topic");
    // Nothing was decided, so nothing was logged against the caller's cap.
    const db = openDb(getAccountConfig().dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM notify_log").get() as { n: number }).n).toBe(0);
  });

  it("refuses a CLIENT-origin topic on the internal (shim) route", async () => {
    await register("internal@example.com");
    const res = await internalNotifyRoute.POST(
      post(
        `${BASE}/account/internal/notify`,
        { topic: "anomaly", title: "not the shim's business" },
        undefined,
        { "x-account-internal": "internal-token-for-tests" },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_topic");
  });
});

/* ==========================================================================
 * Push preferences + the cap policy
 * ========================================================================== */

describe("push preferences", () => {
  it("returns the defaults for a new account and persists an update", async () => {
    const { cookie } = await register();
    const initial = await prefsRoute.GET(new Request(`${BASE}/account/push/preferences`, { headers: { cookie: cookie! } }));
    const body = (await initial.json()) as { prefs: { topics: string[]; dailyCap: number } };
    expect(body.prefs.dailyCap).toBe(3);
    expect(body.prefs.topics).toContain("oeb_rates");

    const saved = await prefsRoute.PUT(
      put(`${BASE}/account/push/preferences`, { topics: ["anomaly"], dailyCap: 1 }, cookie),
    );
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { prefs: { topics: string[]; dailyCap: number } }).prefs).toEqual({
      topics: ["anomaly"],
      dailyCap: 1,
      quietStart: DEFAULT_PUSH_PREFS.quietStart,
      quietEnd: DEFAULT_PUSH_PREFS.quietEnd,
      tzOffset: DEFAULT_PUSH_PREFS.tzOffset,
    });

    const reread = await prefsRoute.GET(new Request(`${BASE}/account/push/preferences`, { headers: { cookie: cookie! } }));
    expect(((await reread.json()) as { prefs: { topics: string[] } }).prefs.topics).toEqual(["anomaly"]);
  });

  it("whitelists topics and clamps the numeric fields", async () => {
    const { cookie } = await register();
    const res = await prefsRoute.PUT(
      put(
        `${BASE}/account/push/preferences`,
        { topics: ["anomaly", "drop_tables"], dailyCap: 9999, quietStart: -5, tzOffset: 99999 },
        cookie,
      ),
    );
    const prefs = ((await res.json()) as { prefs: { topics: string[]; dailyCap: number; quietStart: number; tzOffset: number } }).prefs;
    expect(prefs.topics).toEqual(["anomaly"]);
    expect(prefs.dailyCap).toBe(20);
    expect(prefs.quietStart).toBe(0);
    expect(prefs.tzOffset).toBe(840);
  });

  it("401s for a signed-out caller", async () => {
    const res = await prefsRoute.GET(new Request(`${BASE}/account/push/preferences`));
    expect(res.status).toBe(401);
  });
});

describe("the cap policy (decide)", () => {
  const db = () => openDb(getAccountConfig().dbPath);
  const ACCOUNT = 1;
  beforeEach(() => {
    insertAccount(db(), { email: "cap-policy@example.com", passwordHash: DUMMY_PASSWORD_HASH, kdfSalt: "test-salt", recoveryHash: null });
  });

  const prefs = (over: Partial<typeof DEFAULT_PUSH_PREFS> = {}) => ({ ...DEFAULT_PUSH_PREFS, ...over, topics: over.topics ?? [...DEFAULT_PUSH_PREFS.topics] });

  it("suppresses a topic the user turned off", () => {
    const verdict = decide(db(), ACCOUNT, "anomaly", "title", prefs({ topics: [] }), Date.now());
    expect(verdict).toEqual({ send: false, outcome: "topic_off" });
  });

  it("suppresses within the per-topic minimum interval", () => {
    const now = Date.now();
    const d = db();
    d.prepare("INSERT INTO notify_log (account_id, topic, title, sent_at, outcome) VALUES (?, ?, ?, ?, ?)").run(
      ACCOUNT, "oeb_rates", "New rates", now - 60_000, "sent",
    );
    expect(decide(d, ACCOUNT, "oeb_rates", "Different rates", prefs(), now)).toEqual({
      send: false,
      outcome: "capped_interval",
    });
  });

  it("suppresses identical text even when the interval has elapsed (plan flapping)", () => {
    const now = Date.now();
    const d = db();
    const week = 7 * 24 * 60 * 60 * 1000;
    d.prepare("INSERT INTO notify_log (account_id, topic, title, sent_at, outcome) VALUES (?, ?, ?, ?, ?)").run(
      ACCOUNT, "oeb_rates", "New rates", now - week - 1000, "sent",
    );
    expect(decide(d, ACCOUNT, "oeb_rates", "New rates", prefs(), now)).toEqual({
      send: false,
      outcome: "duplicate",
    });
  });

  it("suppresses during quiet hours, in the USER's timezone", () => {
    const d = db();
    // 03:00 UTC, user at UTC-5 ⇒ 22:00 local ⇒ inside 22:00–07:00.
    const at = Date.UTC(2026, 0, 5, 3, 0, 0);
    const userPrefs = prefs({ tzOffset: -300 });
    expect(inQuietHours(at, userPrefs)).toBe(true);
    expect(decide(d, ACCOUNT, "anomaly", "title", userPrefs, at)).toEqual({
      send: false,
      outcome: "quiet_hours",
    });
    // The same instant for a user ten hours east: 13:00 local — broad
    // daylight, so the policy is the user's clock and not UTC's.
    expect(inQuietHours(at, prefs({ tzOffset: 600 }))).toBe(false);
    expect(decide(d, ACCOUNT, "anomaly", "title", prefs({ tzOffset: 600 }), at)).toEqual({ send: true });
  });

  it("suppresses past the global daily cap, counted in the user's local day", () => {
    const d = db();
    const now = Date.UTC(2026, 0, 5, 12, 0, 0);
    const start = localDayStart(now, 0);
    for (let i = 0; i < 3; i++) {
      d.prepare("INSERT INTO notify_log (account_id, topic, title, sent_at, outcome) VALUES (?, ?, ?, ?, 'sent')").run(
        ACCOUNT, i === 0 ? "oeb_rates" : i === 1 ? "anomaly" : "data_available", `t${i}`, start + 1000 + i,
      );
    }
    expect(sentCount(d, ACCOUNT, start)).toBe(3);
    expect(decide(d, ACCOUNT, "plan_change", "title", prefs({ dailyCap: 3 }), now)).toEqual({
      send: false,
      outcome: "capped_daily",
    });
    // ...and with room, it sends.
    expect(decide(d, ACCOUNT, "plan_change", "title", prefs({ dailyCap: 4 }), now)).toEqual({ send: true });
  });

  it("does NOT let a suppression consume the interval or the cap", () => {
    const d = db();
    const now = Date.UTC(2026, 0, 5, 23, 30, 0);
    d.prepare("INSERT INTO notify_log (account_id, topic, title, sent_at, outcome) VALUES (?, ?, ?, ?, ?)").run(
      ACCOUNT, "oeb_rates", "Old rates", now - 8 * 24 * 60 * 60 * 1000, "sent",
    );
    const quiet = decide(d, ACCOUNT, "oeb_rates", "New rates", prefs({ tzOffset: 0 }), now);
    expect(quiet).toEqual({ send: false, outcome: "quiet_hours" });
    d.prepare("INSERT INTO notify_log (account_id, topic, title, sent_at, outcome) VALUES (?, ?, ?, ?, 'quiet_hours')").run(
      ACCOUNT, "oeb_rates", "New rates", now,
    );
    // 10 minutes later it is a new day: the earlier attempt must not have
    // eaten the weekly interval.
    const morning = now + 7.5 * 60 * 60 * 1000;
    expect(decide(d, ACCOUNT, "oeb_rates", "New rates", prefs({ tzOffset: 0 }), morning)).toEqual({ send: true });
  });
});

function sentCount(db: ReturnType<typeof openDb>, accountId: number, since: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM notify_log WHERE account_id = ? AND outcome = 'sent' AND sent_at >= ?")
    .get(accountId, since) as { n: number };
  return Number(row.n);
}

/* ==========================================================================
 * The rate watcher (the server-computable `oeb_rates` trigger)
 * ========================================================================== */

describe("rate-change detection", () => {
  it("baselines silently, then notifies exactly when the fingerprint moves", async () => {
    await register("rates@example.com");
    const { checkRates } = await import("./services");
    const cfg = { ...getAccountConfig(), ratesUrl: "http://rates.test/api/rates" };
    const payload = (version: string) =>
      ({
        ratesSourceVersion: version,
        historicalRates: [{ effectiveDate: "2026-11-01" }],
      }) as unknown;

    const okFetch = (version: string) => (async () => ({ ok: true, json: async () => payload(version) })) as unknown as typeof fetch;

    // First observation: a baseline. Announcing "rates changed" for rates
    // that shipped before anyone subscribed would be noise on day one.
    expect(await checkRates(cfg, okFetch("v1"))).toBe("baseline");
    expect(await checkRates(cfg, okFetch("v1"))).toBe("unchanged");

    expect(await checkRates(cfg, okFetch("v2"))).toBe("changed");

    const db = openDb(cfg.dbPath);
    expect(getMeta(db, "rates_source_version")).toBe("v2");
    const logged = db.prepare("SELECT topic, outcome FROM notify_log ORDER BY id").all() as {
      topic: string;
      outcome: string;
    }[];
    expect(logged.some((r) => r.topic === "oeb_rates")).toBe(true);

    // An unreachable app must never be an exception that escapes.
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await checkRates(cfg, dead)).toBe("unreachable");
  });
});

/* ==========================================================================
 * The two KDFs must stay independent
 * ========================================================================== */

describe("auth primitives", () => {
  it("emits argon2id at the declared cost — not whatever the library defaults to", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain(`m=${ARGON2_OPTIONS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2_OPTIONS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2_OPTIONS.parallelism}`);
  });

  it("keeps the timing-equalizer hash on the same parameters", () => {
    expect(DUMMY_PASSWORD_HASH).toContain(`m=${ARGON2_OPTIONS.memoryCost}`);
    expect(DUMMY_PASSWORD_HASH).toContain(`t=${ARGON2_OPTIONS.timeCost}`);
  });

  it("generates recovery codes without ambiguous characters, normalized on compare", () => {
    for (let i = 0; i < 50; i++) {
      const code = newRecoveryCode();
      expect(code).toMatch(RECOVERY_PATTERN);
      // The letters a human cannot read off a screen are absent...
      expect(code).not.toMatch(/[ILOU]/);
      // ...and the obvious misreadings still normalize to the same code.
      expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(code.replace(/-/g, ""));
      expect(normalizeRecoveryCode(code.replace(/0/g, "o").replace(/1/g, "i"))).toBe(
        normalizeRecoveryCode(code.replace(/0/g, "0").replace(/1/g, "1")),
      );
    }
  });

  it("stores sessions as a SHA-256 hash, never the token", async () => {
    const { cookie } = await register();
    const token = cookie!.replace(/^acct_session=/, "");
    const db = openDb(getAccountConfig().dbPath);
    const row = db.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  });
});

/* ==========================================================================
 * Attempt budget — the three unauthenticated endpoints (round-1 M2)
 * ========================================================================== */

describe("attempt budget", () => {
  const badLogin = (email: string) =>
    loginRoute.POST(post(`${BASE}/account/login`, { email, password: "definitely-not-it" }));

  it("answers 401 for each guess, then 429 with Retry-After once the address budget is spent", async () => {
    await register("budget@example.com");
    const capacity = LIMITS.loginIdentity.capacity;
    for (let i = 0; i < capacity; i++) {
      const res = await badLogin("budget@example.com");
      expect(res.status).toBe(401);
    }
    const blocked = await badLogin("budget@example.com");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const payload = (await blocked.json()) as { error: string; retryAfterSeconds: number };
    expect(payload.error).toBe("rate_limited");
    expect(payload.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // The answer is a wait, not a lockout: a different address is unaffected
    // and the budget refills instead of demanding an operator.
    const other = await badLogin("somebody-else@example.com");
    expect(other.status).toBe(401);
  });

  it("refuses BEFORE the argon2 work, not after it", async () => {
    await register("fast@example.com");
    for (let i = 0; i < LIMITS.loginIdentity.capacity; i++) await badLogin("fast@example.com");

    const t0 = process.hrtime.bigint();
    const blocked = await badLogin("fast@example.com");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(blocked.status).toBe(429);
    // A verification costs ~17 ms; a refused one costs nothing measurable.
    expect(ms).toBeLessThan(5);
  });

  it("hands the address budget back when the password is correct", async () => {
    await register("recovers@example.com");
    for (let i = 0; i < LIMITS.loginIdentity.capacity - 1; i++) {
      expect((await badLogin("recovers@example.com")).status).toBe(401);
    }
    const ok = await loginRoute.POST(
      post(`${BASE}/account/login`, { email: "recovers@example.com", password: "correct-horse-battery" }),
    );
    expect(ok.status).toBe(200);
    // Budget refunded: the next mistake is a plain 401 again, not a 429.
    expect((await badLogin("recovers@example.com")).status).toBe(401);
  });

  it("requires mailbox proof before recovery or registration rate-limit work", async () => {
    await register("recovery-budget@example.com", "correct-horse-battery", true);
    const recover = () =>
      import("@/app/account/recover/route").then((m) =>
        m.POST(
          post(`${BASE}/account/recover`, {
            email: "recovery-budget@example.com",
            recoveryCode: "AAAAA-BBBBB-CCCCC-DDDDD",
            newPassword: "a-brand-new-password",
          }),
        ),
      );
    for (let i = 0; i < LIMITS.recoverIdentity.capacity + 1; i++) {
      expect((await recover()).status).toBe(400);
    }

    // Registration with an embedded password is rejected before account work.
    const duplicate = () =>
      registerRoute.POST(
        post(`${BASE}/account/register`, { email: "recovery-budget@example.com", password: "correct-horse-battery" }),
      );
    for (let i = 0; i < LIMITS.registerGlobal.capacity + 1; i++) {
      expect((await duplicate()).status).toBe(400);
    }
  });
});

/* ==========================================================================
 * Session rotation — a token may only be minted where it is applied (L1)
 * ========================================================================== */

describe("session rotation", () => {
  it("never rotates on a route that cannot set the cookie, and always does on /account/session", async () => {
    const { cookie } = await register();
    const db = openDb(getAccountConfig().dbPath);
    const age = () =>
      db.prepare("UPDATE sessions SET last_seen_at = ?").run(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const syncGet = () =>
      syncRoute.GET(new Request(`${BASE}/account/sync`, { headers: { cookie: cookie! } }));

    age();
    const first = await syncGet();
    expect(first.status).toBe(200);
    // A rotation would have handed back a replacement; `sync` never does.
    expect(first.headers.get("set-cookie")).toBeNull();
    // …and the proof that no orphaned row was left behind: the SAME cookie
    // still authenticates on the next request.
    expect((await syncGet()).status).toBe(200);

    age();
    const probe = await sessionRoute.GET(
      new Request(`${BASE}/account/session`, { headers: { cookie: cookie! } }),
    );
    expect(probe.status).toBe(200);
    const rotated = sessionCookie(probe);
    expect(rotated).toBeTruthy();
    expect(`acct_session=${rotated}`).not.toBe(cookie);

    expect(
      (await syncRoute.GET(
        new Request(`${BASE}/account/sync`, { headers: { cookie: `acct_session=${rotated}` } }),
      )).status,
    ).toBe(200);
    // The old value was replaced, not duplicated: it is dead now.
    expect((await syncGet()).status).toBe(401);
  });
});

/* ==========================================================================
 * Push endpoints are bound to the account that registered them (L2)
 * ========================================================================== */

describe("push endpoint ownership", () => {
  const subBody = (endpoint: string) => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } });

  it("refuses to re-point an endpoint another account already owns", async () => {
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    resetAccountConfigCache();
    try {
      const ann = await register("ann-own@example.com");
      const bob = await register("bob-own@example.com");
      const db = openDb(getAccountConfig().dbPath);
      const ownerOf = (endpoint: string) =>
        (db.prepare("SELECT account_id FROM push_subs WHERE endpoint = ?").get(endpoint) as
          | { account_id: number }
          | undefined)?.account_id ?? null;
      const endpoint = "https://push.example/one-device";

      expect((await subscribeRoute.POST(post(`${BASE}/account/push/subscribe`, subBody(endpoint), ann.cookie))).status)
        .toBe(201);

      const stolen = await subscribeRoute.POST(
        post(`${BASE}/account/push/subscribe`, subBody(endpoint), bob.cookie),
      );
      expect(stolen.status).toBe(409);
      expect(((await stolen.json()) as { error: string }).error).toBe("endpoint_taken");
      expect(ownerOf(endpoint)).toBe(
        (db.prepare("SELECT id FROM accounts WHERE email = ?").get("ann-own@example.com") as { id: number }).id,
      );

      // The owner may still refresh her own keys…
      expect((await subscribeRoute.POST(post(`${BASE}/account/push/subscribe`, subBody(endpoint), ann.cookie))).status)
        .toBe(201);
      // …and somebody else's DELETE cannot remove her subscription either.
      const removed = await subscribeRoute.DELETE(
        new Request(`${BASE}/account/push/subscribe`, {
          method: "DELETE",
          headers: { "content-type": "application/json", origin: BASE, cookie: bob.cookie! },
          body: JSON.stringify({ endpoint }),
        }),
      );
      expect(removed.status).toBe(200);
      expect(ownerOf(endpoint)).not.toBeNull();
    } finally {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      resetAccountConfigCache();
    }
  });
});

/** Silence an unused-import lint if the shape of the file changes. */
void json;
