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

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

import { resetAccountConfigCache, getAccountConfig, MAX_SYNC_BYTES } from "./config";
import { closeAllDbs, openDb, getMeta, DEFAULT_PUSH_PREFS } from "./db";
import { resetAccountServices } from "./services";
import { decide, inQuietHours, localDayStart } from "./push";
import { ARGON2_OPTIONS, DUMMY_PASSWORD_HASH, hashPassword, newRecoveryCode, normalizeRecoveryCode } from "./auth";

import * as sessionRoute from "@/app/account/session/route";
import * as registerRoute from "@/app/account/register/route";
import * as loginRoute from "@/app/account/login/route";
import * as logoutRoute from "@/app/account/logout/route";
import * as syncRoute from "@/app/account/sync/route";
import * as notifyRoute from "@/app/account/notify/route";
import * as internalNotifyRoute from "@/app/account/internal/notify/route";
import * as prefsRoute from "@/app/account/push/preferences/route";

const BASE = "https://electricity.markarslan.ca";

/** Four Crockford-base32 groups — see `auth.ts#newRecoveryCode`. */
const RECOVERY_PATTERN = /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/;

let dbDir: string;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "wave-n-"));
  process.env.ACCT_ENABLED = "true";
  process.env.ACCT_DB_PATH = join(dbDir, "accounts.db");
  process.env.ACCT_PUBLIC_ORIGIN = BASE;
  process.env.ACCT_INTERNAL_TOKEN = "internal-token-for-tests";
  process.env.ACCT_MAX_ACCOUNTS = "10";
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
  delete process.env.ACCT_DB_PATH;
  delete process.env.ACCT_PUBLIC_ORIGIN;
  delete process.env.ACCT_INTERNAL_TOKEN;
  delete process.env.ACCT_MAX_ACCOUNTS;
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
});

afterEach(() => {
  resetAccountServices();
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
    body: JSON.stringify(body),
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
  hasLocalData = false,
): Promise<{ res: Response; cookie: string; body: Record<string, unknown> }> {
  const res = await registerRoute.POST(
    post(`${BASE}/account/register`, { email, password, hasLocalData }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { res, cookie: asCookie(sessionCookie(res))!, body };
}

const validIv = () => randomBytes(12).toString("base64");
const encryptLikeABrowser = (plaintext: string) => randomBytes(Math.ceil(plaintext.length * 0.75)).toString("base64");

/* ==========================================================================
 * Gate 1 — the feature flag
 * ========================================================================== */

describe("the feature flag", () => {
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

describe("register", () => {
  it("creates an account, signs it in, and returns the KDF salt the browser needs", async () => {
    const { res, cookie, body } = await register();
    expect(res.status).toBe(201);
    expect(cookie).toBeTruthy();
    expect(typeof body.kdfSalt).toBe("string");
    expect((body.kdfSalt as string).length).toBeGreaterThan(10);
    expect(body.hasBlob).toBe(false);
    expect(body.rev).toBe(0);
  });

  it("issues a recovery code ONLY when the device already has data", async () => {
    const withData = await register("a@example.com", "correct-horse-battery", true);
    expect(typeof withData.body.recoveryCode).toBe("string");
    expect(withData.body.recoveryCode as string).toMatch(RECOVERY_PATTERN);
    expect(withData.body.recoveryCode as string).not.toMatch(/[ILOU]/);

    const withoutData = await register("b@example.com", "correct-horse-battery", false);
    expect(withoutData.body.recoveryCode).toBeNull();
  });

  it("refuses a duplicate e-mail with 409", async () => {
    await register();
    const again = await registerRoute.POST(
      post(`${BASE}/account/register`, { email: "MARK@example.com", password: "correct-horse-battery" }),
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("email_taken");
  });

  it("rejects a short password and a malformed e-mail", async () => {
    const short = await registerRoute.POST(
      post(`${BASE}/account/register`, { email: "mark@example.com", password: "short" }),
    );
    expect(short.status).toBe(400);
    const badEmail = await registerRoute.POST(
      post(`${BASE}/account/register`, { email: "not-an-email", password: "correct-horse-battery" }),
    );
    expect(badEmail.status).toBe(400);
    expect(((await badEmail.json()) as { error: string }).error).toBe("invalid_email");
  });

  it("refuses a cross-site registration (the session rides a cookie)", async () => {
    const res = await registerRoute.POST(
      post(
        `${BASE}/account/register`,
        { email: "x@example.com", password: "correct-horse-battery" },
        undefined,
        { origin: "https://evil.example" },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("enforces the family-scale account ceiling", async () => {
    process.env.ACCT_MAX_ACCOUNTS = "1";
    resetAccountConfigCache();
    await register("first@example.com");
    const second = await registerRoute.POST(
      post(`${BASE}/account/register`, { email: "second@example.com", password: "correct-horse-battery" }),
    );
    expect(second.status).toBe(403);
    expect(((await second.json()) as { error: string }).error).toBe("account_limit");
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
    expect(fake).toBeGreaterThan(1);
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
    const code = body.recoveryCode as string;
    await syncRoute.PUT(put(`${BASE}/account/sync`, { iv: validIv(), data: encryptLikeABrowser("old"), baseRev: 0 }, cookie));

    const recovery = await import("@/app/account/recover/route");
    const out = await recovery.POST(
      post(`${BASE}/account/recover`, {
        email: "r@example.com",
        recoveryCode: code,
        newPassword: "a-brand-new-password",
      }),
    );
    expect(out.status).toBe(200);
    const payload = (await out.json()) as { blobDropped: boolean; recoveryCode: string; blobDroppedReason: string };
    expect(payload.blobDropped).toBe(true);
    expect(payload.blobDroppedReason).toMatch(/encrypted with the old password/);
    // A spent code must be replaced, not left valid.
    expect(payload.recoveryCode).not.toBe(code);

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
    expect(badCode.status).toBe(401);
    expect(unknown.status).toBe(401);
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

/** Silence an unused-import lint if the shape of the file changes. */
void json;
