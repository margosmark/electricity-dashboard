// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllDbs, deleteAccount, insertAccount, insertSession, openDb, putBlob } from "./db";
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
});

afterEach(() => {
  closeAllDbs();
  rmSync(root, { recursive: true, force: true });
});
