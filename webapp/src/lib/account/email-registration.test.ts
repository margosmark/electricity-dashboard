// @vitest-environment node
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sent: Array<{ to: string; text: string }> = [];
vi.mock("@/lib/account/email", () => ({
  registrationEmail: (_cfg: unknown, email: string, token: string) => ({ to: email, subject: "verify", text: token, html: token }),
  recoveryEmail: (_cfg: unknown, email: string, token: string) => ({ to: email, subject: "recover", text: token, html: token }),
  enqueueAccountEmail: vi.fn((_db: unknown, _hash: string, message: { to: string; text: string }) => {
    sent.push(message);
    return true;
  }),
  drainOutbox: vi.fn(),
}));

import { resetAccountConfigCache } from "./config";
import { closeAllDbs, findAccountByEmail, findEmailToken, getBlob, openDb, putBlob, isSuppressed } from "./db";
import { resetAccountServices } from "./services";
import * as registerRoute from "@/app/account/register/route";
import * as verifyRoute from "@/app/account/verify/route";
import * as recoverRoute from "@/app/account/recover/route";
import * as recoveryVerifyRoute from "@/app/account/recover/verify/route";
import * as smtpEventsRoute from "@/app/account/smtp-events/route";

const BASE = "https://electricity.markarslan.ca";
let dir: string;
let dbPath: string;
let usernameFile: string;
let passwordFile: string;
let eventsFile: string;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(
      path === "/account/register" && body && typeof body === "object" && !("policyAccepted" in body)
        ? { ...(body as Record<string, unknown>), policyAccepted: true, privacyVersion: "2026-10-16", termsVersion: "2026-10-16" }
        : body,
    ),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function latestToken(): string {
  const token = sent.at(-1)?.text;
  expect(token).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
  return token!;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "account-email-"));
  dbPath = join(dir, "accounts.db");
  usernameFile = join(dir, "smtp-username");
  passwordFile = join(dir, "smtp-password");
  eventsFile = join(dir, "smtp-events-secret");
  for (const [file, value] of [[usernameFile, "[REDACTED]"], [passwordFile, "[REDACTED]"], [eventsFile, "[REDACTED]"]]) {
    writeFileSync(file, value, { mode: 0o400 });
    chmodSync(file, 0o400);
  }
  Object.assign(process.env, {
    ACCT_ENABLED: "true",
    ACCT_DATA_DIR_HOST: dir,
    ACCT_REPO_HOST_DIR: join(dir, "repo"),
    ACCT_DB_PATH: dbPath,
    ACCT_PUBLIC_ORIGIN: BASE,
    ACCT_EMAIL_VERIFICATION_ENABLED: "true",
    ACCT_SMTP_HOST: "smtp.example.test",
    ACCT_SMTP_PORT: "587",
    ACCT_SMTP_TLS_MODE: "starttls",
    ACCT_SMTP_HELO: "electricity.markarslan.ca",
    ACCT_SMTP_FROM: "accounts@electricity.markarslan.ca",
    ACCT_SMTP_REPLY_TO: "support@electricity.markarslan.ca",
    ACCT_SMTP_TIMEOUT_MS: "15000",
    ACCT_SMTP_USERNAME_FILE: usernameFile,
    ACCT_SMTP_PASSWORD_FILE: passwordFile,
    ACCT_SMTP_EVENTS_SECRET_FILE: eventsFile,
    ACCT_RATES_URL: "http://127.0.0.1:1/api/rates",
  });
  resetAccountConfigCache();
});

beforeEach(() => {
  closeAllDbs();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  resetAccountConfigCache();
  resetAccountServices();
  sent.length = 0;
});

afterAll(() => {
  closeAllDbs();
  resetAccountServices();
  resetAccountConfigCache();
  for (const key of ["ACCT_ENABLED", "ACCT_DATA_DIR_HOST", "ACCT_REPO_HOST_DIR", "ACCT_DB_PATH", "ACCT_PUBLIC_ORIGIN", "ACCT_EMAIL_VERIFICATION_ENABLED", "ACCT_SMTP_HOST", "ACCT_SMTP_PORT", "ACCT_SMTP_TLS_MODE", "ACCT_SMTP_HELO", "ACCT_SMTP_FROM", "ACCT_SMTP_REPLY_TO", "ACCT_SMTP_TIMEOUT_MS", "ACCT_SMTP_USERNAME_FILE", "ACCT_SMTP_PASSWORD_FILE", "ACCT_SMTP_EVENTS_SECRET_FILE", "ACCT_RATES_URL"]) delete process.env[key];
  rmSync(dir, { recursive: true, force: true });
});

describe("verified registration and mailbox recovery", () => {
  it("does not persist a password or issue a session before explicit mailbox proof", async () => {
    const start = await registerRoute.POST(post("/account/register", { email: "owner@example.test", hasLocalData: true }));
    expect(start.status).toBe(202);
    expect(await json(start)).toEqual({ ok: true, verificationRequired: true });
    const db = openDb(dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n).toBe(0);

    const token = latestToken();
    const hash = token.replace(/^$/, "");
    const pending = findEmailToken(db, (await import("./auth")).hashToken(hash));
    expect(pending?.purpose).toBe("registration");
    expect(pending?.token_hash).not.toContain(token);

    const scanned = await verifyRoute.GET(new Request(`${BASE}/account/verify#token=${token}`));
    expect(scanned.status).toBe(200);
    const scannedHtml = await scanned.text();
    expect(scannedHtml).toContain("location.hash");
    expect(scannedHtml).not.toContain(token);
    expect(findEmailToken(db, pending!.token_hash)?.used_at).toBeNull();

    const verified = await verifyRoute.POST(post("/account/verify", { token, password: "correct horse battery staple" }));
    expect(verified.status).toBe(201);
    expect(verified.headers.get("set-cookie")).toContain("acct_session=");
    const account = findAccountByEmail(db, "owner@example.test");
    expect(account?.email_verified_at).toEqual(expect.any(Number));
    expect(account?.password_hash).not.toContain("correct horse battery");
    expect(findEmailToken(db, pending!.token_hash)?.used_at).toEqual(expect.any(Number));

    const replay = await verifyRoute.POST(post("/account/verify", { token, password: "another password" }));
    expect(replay.status).toBe(400);
    expect((await json(replay)).error).toBe("invalid_verification");
  });

  it("keeps registration and recovery responses non-enumerating", async () => {
    const knownStart = await registerRoute.POST(post("/account/register", { email: "known@example.test" }));
    expect(knownStart.status).toBe(202);
    const knownToken = latestToken();
    expect((await verifyRoute.POST(post("/account/verify", { token: knownToken, password: "known-password-2026" }))).status).toBe(201);

    const known = await registerRoute.POST(post("/account/register", { email: "known@example.test" }));
    const unknown = await registerRoute.POST(post("/account/register", { email: "unknown@example.test" }));
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await json(known)).toEqual(await json(unknown));

    const recoveryKnown = await recoverRoute.POST(post("/account/recover", { email: "known@example.test" }));
    const recoveryUnknown = await recoverRoute.POST(post("/account/recover", { email: "unknown@example.test" }));
    expect(recoveryKnown.status).toBe(202);
    expect(recoveryUnknown.status).toBe(202);
    expect(await json(recoveryKnown)).toEqual(await json(recoveryUnknown));
  });

  it("recovers authentication only and drops the unreadable encrypted blob", async () => {
    const started = await registerRoute.POST(post("/account/register", { email: "recover@example.test", hasLocalData: true }));
    expect(started.status).toBe(202);
    const registrationToken = latestToken();
    expect((await verifyRoute.POST(post("/account/verify", { token: registrationToken, password: "old-password-2026" }))).status).toBe(201);
    const db = openDb(dbPath);
    const account = findAccountByEmail(db, "recover@example.test")!;
    putBlob(db, account.id, { iv: Buffer.from("123456789012").toString("base64"), data: Buffer.from("ciphertext").toString("base64"), baseRev: 0 });

    const requested = await recoverRoute.POST(post("/account/recover", { email: "recover@example.test" }));
    expect(requested.status).toBe(202);
    const token = latestToken();
    const scanned = await recoveryVerifyRoute.GET(new Request(`${BASE}/account/recover/verify#token=${token}`));
    expect(scanned.status).toBe(200);
    const scannedHtml = await scanned.text();
    expect(scannedHtml).toContain("location.hash");
    expect(scannedHtml.includes(token)).toBe(false);

    const recovered = await recoveryVerifyRoute.POST(post("/account/recover/verify", { token, newPassword: "new-password-2026" }));
    const payload = await json(recovered);
    expect(recovered.status).toBe(200);
    expect(payload.blobDropped).toBe(true);
    expect(getBlob(db, account.id)).toBeNull();
    expect(payload).not.toHaveProperty("data");
    expect((await recoveryVerifyRoute.POST(post("/account/recover/verify", { token, newPassword: "third-password-2026" }))).status).toBe(400);
  });

  it("authenticates signed bounce events, suppresses the mailbox, and rejects replay", async () => {
    const raw = JSON.stringify({ event: "bounce", email: "bad@example.test", reason: "permanent" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", readFileSync(eventsFile, "utf8")).update(`${timestamp}.${raw}`).digest("hex");
    const req = () => new Request(`${BASE}/account/smtp-events`, { method: "POST", headers: { "content-type": "application/json", "x-smtp-timestamp": timestamp, "x-smtp-signature": signature }, body: raw });
    const first = await smtpEventsRoute.POST(req());
    expect(first.status).toBe(200);
    expect(isSuppressed(openDb(dbPath), "bad@example.test")).toBe(true);
    expect((await smtpEventsRoute.POST(req())).status).toBe(409);
  });
});
