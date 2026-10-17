// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimEmailOutbox, closeAllDbs, deleteAccount, EMAIL_OUTBOX_MAX_AGE_MS, EMAIL_OUTBOX_MAX_ATTEMPTS, enqueueEmailOutbox, insertAccount, insertSession, markEmailOutboxSent, openDb, putBlob, retryEmailOutbox } from "./db";
import { ACCOUNT_TERMS_VERSION, PRIVACY_POLICY_VERSION, hasCurrentPolicyAcceptance } from "./policy";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "account-db-migrations-")); });

function legacyDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, kdf_salt TEXT NOT NULL, recovery_hash TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE notify_log (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, topic TEXT NOT NULL,
      title TEXT NOT NULL, sent_at INTEGER NOT NULL, outcome TEXT NOT NULL, detail TEXT);
    CREATE INDEX notify_log_account_topic ON notify_log(account_id, topic, sent_at);
    INSERT INTO accounts(email,password_hash,kdf_salt,created_at) VALUES('legacy@example.com','hash','salt',1);
    INSERT INTO notify_log(account_id,topic,title,sent_at,outcome) VALUES(1,'anomaly','old title',2,'sent');
    INSERT INTO notify_log(account_id,topic,title,sent_at,outcome) VALUES(999,'anomaly','orphan',3,'sent');
  `);
  db.close();
}

describe("account database integrity", () => {
  it("migrates the previous unversioned schema transactionally and preserves rows idempotently", () => {
    const path = join(root, "legacy.db");
    legacyDatabase(path);
    const db = openDb(path);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    expect(db.prepare("SELECT title FROM notify_log WHERE account_id=1").get()).toEqual({ title: "old title" });
    expect(db.prepare("PRAGMA foreign_key_list(notify_log)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "accounts", from: "account_id", on_delete: "CASCADE" }),
    ]));
    closeAllDbs();
    const reopened = openDb(path);
    expect((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM notify_log").get() as { n: number }).n).toBe(1);
  });

  it("adds nullable policy columns idempotently and records an explicit current acceptance", () => {
    const path = join(root, "policy.db");
    const db = openDb(path);
    const columns = (db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["privacy_version", "terms_version", "accepted_at"]));
    const acceptedAt = Date.now();
    const accountId = insertAccount(db, {
      email: "accepted@example.com",
      passwordHash: "hash",
      kdfSalt: "salt",
      recoveryHash: null,
      privacyVersion: PRIVACY_POLICY_VERSION,
      termsVersion: ACCOUNT_TERMS_VERSION,
      acceptedAt,
    });
    const row = db.prepare("SELECT privacy_version, terms_version, accepted_at FROM accounts WHERE id=?").get(accountId) as {
      privacy_version: string;
      terms_version: string;
      accepted_at: number;
    };
    expect(row).toEqual({
      privacy_version: PRIVACY_POLICY_VERSION,
      terms_version: ACCOUNT_TERMS_VERSION,
      accepted_at: acceptedAt,
    });
    expect(hasCurrentPolicyAcceptance({
      privacyVersion: row.privacy_version,
      termsVersion: row.terms_version,
      acceptedAt: row.accepted_at,
    })).toBe(true);
    closeAllDbs();
    const reopened = openDb(path);
    expect((reopened.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).filter((column) => column.name === "accepted_at")).toHaveLength(1);
  });

  it("deletes all account-associated metadata including the notification log", () => {
    const db = openDb(join(root, "cascade.db"));
    const accountId = insertAccount(db, { email: "delete@example.com", passwordHash: "hash", kdfSalt: "salt", recoveryHash: null });
    insertSession(db, "hashed-session-token", accountId, 60_000);
    db.prepare("INSERT INTO blobs(account_id,iv,data,rev,updated_at,bytes) VALUES(?,?,?,?,?,?)").run(accountId,"iv","ciphertext",1,1,10);
    db.prepare("INSERT INTO push_subs(account_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?)").run(accountId,"https://push.example/sub","p","a",1);
    db.prepare("INSERT INTO push_prefs(account_id,topics,daily_cap,quiet_start,quiet_end,tz_offset,updated_at) VALUES(?,?,?,?,?,?,?)").run(accountId,"[]",3,0,0,0,1);
    db.prepare("INSERT INTO notify_log(account_id,topic,title,sent_at,outcome) VALUES(?,?,?,?,?)").run(accountId,"anomaly","title",1,"sent");
    deleteAccount(db, accountId);
    for (const table of ["accounts", "sessions", "blobs", "push_subs", "push_prefs", "notify_log"]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    }
  });

  it("serializes optimistic writes: only one request with a shared base revision wins", () => {
    const db = openDb(join(root, "cas.db"));
    const accountId = insertAccount(db, { email: "cas@example.com", passwordHash: "hash", kdfSalt: "salt", recoveryHash: null });
    const results = ["ciphertext-a", "ciphertext-b"].map((data) => putBlob(db, accountId, { iv: "iv", data, baseRev: 0 }));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, currentRev: 1 }]);
    expect(db.prepare("SELECT rev FROM blobs WHERE account_id=?").get(accountId)).toEqual({ rev: 1 });
  });

  it("clears bearer-bearing payloads after terminal outbox transitions but retains transient retries", () => {
    const db = openDb(join(root, "outbox.db"));
    const message = { to: "owner@example.test", subject: "verify", text: "https://example.test/#token=bearer-token", html: "<a href=\"https://example.test/#token=bearer-token\">verify</a>" };
    expect(enqueueEmailOutbox(db, { tokenHash: "sent-hash", ...message })).toBe(true);
    const sent = claimEmailOutbox(db, Date.now() + 1)!;
    markEmailOutboxSent(db, sent.id, Date.now() + 2);
    expect(db.prepare("SELECT status, text, html FROM email_outbox WHERE id=?").get(sent.id)).toEqual({ status: "sent", text: "", html: "" });

    expect(enqueueEmailOutbox(db, { tokenHash: "failed-hash", ...message })).toBe(true);
    const failed = claimEmailOutbox(db, Date.now() + 3)!;
    retryEmailOutbox(db, failed.id, true, Date.now() + 4);
    expect(db.prepare("SELECT status, text, html FROM email_outbox WHERE id=?").get(failed.id)).toEqual({ status: "failed", text: "", html: "" });

    expect(enqueueEmailOutbox(db, { tokenHash: "retry-hash", ...message })).toBe(true);
    const retry = claimEmailOutbox(db, Date.now() + 5)!;
    retryEmailOutbox(db, retry.id, false, Date.now() + 6);
    expect(db.prepare("SELECT status, text, html FROM email_outbox WHERE id=?").get(retry.id)).toEqual(expect.objectContaining({ status: "pending", text: message.text, html: message.html }));

    let now = Date.now() + 7;
    for (let attempt = 1; attempt < EMAIL_OUTBOX_MAX_ATTEMPTS; attempt++) {
      const claimed = claimEmailOutbox(db, now + 30_001);
      expect(claimed).not.toBeNull();
      retryEmailOutbox(db, claimed!.id, false, now);
      now += 30_001;
    }
    expect(db.prepare("SELECT status, attempts, text, html FROM email_outbox WHERE id=?").get(retry.id)).toEqual({
      status: "failed",
      attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
      text: "",
      html: "",
    });

    expect(enqueueEmailOutbox(db, { tokenHash: "expired-hash", ...message })).toBe(true);
    const expired = claimEmailOutbox(db, Date.now() + 10)!;
    expect(expired).not.toBeNull();
    const expiry = expired.created_at + EMAIL_OUTBOX_MAX_AGE_MS;
    expect(claimEmailOutbox(db, expiry + 1)).toBeNull();
    expect(db.prepare("SELECT status, text, html FROM email_outbox WHERE id=?").get(expired.id)).toEqual({ status: "failed", text: "", html: "" });
  });
});

afterEach(() => {
  closeAllDbs();
  rmSync(root, { recursive: true, force: true });
});
