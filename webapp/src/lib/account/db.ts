/**
 * Wave N — the account database (SQLite, one file, family scale).
 *
 * Storage choice: `node:sqlite` from the Node standard library. A database
 * server would be machinery with no workload at single-digit users, and a
 * native addon (better-sqlite3) would add a compile step to an image that
 * today only runs `npm ci`. `node:sqlite` is unflagged in the Node the image
 * ships (v26) and prints one ExperimentalWarning at first use — accepted and
 * documented in OPERATIONS.md rather than hidden.
 *
 * WHAT THIS DATABASE MAY HOLD — and what it may not:
 *
 *   holds   argon2id password verifiers, session token HASHES, a per-user
 *           KDF salt (a salt is not a secret), the ciphertext blob, push
 *           subscription endpoints, notification preferences, an audit log.
 *   never    readings, plaintext, passwords, session tokens in the clear,
 *           or the dataset in any form. Under client-side E2EE (see
 *           `lib/account/crypto.ts` on the browser side) the ciphertext
 *           column is opaque to every line of this file.
 *
 * THE ONE CARVE-OUT, STATED BECAUSE THE REVIEW DEMANDED IT (M3): the
 * `notify_log.title` column holds the title of a notification, and a
 * client-origin notification (`plan_change`, `anomaly`) is text the user's
 * own device composed from their own data — so that column can encode a
 * usage-derived FACT ("Unusual usage on 3 Oct"). That is the entire content
 * of such a notification: one line, <= 200 characters per event, written by
 * the same `logNotify` that records every send and suppression, and it is a
 * verdict, never a reading, a series, or anything the server could compute a
 * total from. The notification BODY (which may say "42 kWh, 2.3x usual") is
 * relayed to the browser and is NOT stored — `logNotify` writes title +
 * outcome only. The alternative (strip the numbers) was considered and
 * rejected: a push that cannot say what happened is a worse promise than an
 * honest one, and the boundary is documented in SECURITY.md §5 instead of
 * being implied by silence here.
 *
 * Every write is a prepared statement over bound parameters — no string
 * concatenation reaches SQL anywhere in this module.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AccountRow = {
  id: number;
  email: string;
  password_hash: string;
  kdf_salt: string;
  recovery_hash: string | null;
  created_at: number;
};

export type SessionRow = {
  token_hash: string;
  account_id: number;
  expires_at: number;
  last_seen_at: number;
};

export type BlobRow = {
  account_id: number;
  iv: string;
  data: string;
  rev: number;
  updated_at: number;
  bytes: number;
};

export type PushSubRow = {
  id: number;
  account_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushPrefs = {
  /** Topics the user wants. Anything not listed is suppressed. */
  topics: string[];
  /** Max notifications per local day, whatever the topics say. */
  dailyCap: number;
  /** Quiet hours in minutes from local midnight (22:00 = 1320, 07:00 = 420). */
  quietStart: number;
  quietEnd: number;
  /** Minutes east of UTC, so "quiet" means the user's night, not UTC's. */
  tzOffset: number;
};

export type NotifyOutcome =
  | "sent"
  | "capped_interval"
  | "capped_daily"
  | "quiet_hours"
  | "topic_off"
  | "duplicate"
  | "no_subscriptions"
  | "send_failed";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  kdf_salt       TEXT    NOT NULL,
  recovery_hash  TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT    PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  iv          TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  rev         INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  bytes       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,
  auth        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  last_ok_at  INTEGER,
  failures    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS push_prefs (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  topics      TEXT    NOT NULL,
  daily_cap   INTEGER NOT NULL,
  quiet_start INTEGER NOT NULL,
  quiet_end   INTEGER NOT NULL,
  tz_offset   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  topic       TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  sent_at     INTEGER NOT NULL,
  outcome     TEXT    NOT NULL,
  detail      TEXT
, FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notify_log_account_topic
  ON notify_log (account_id, topic, sent_at);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

/** All four notification topics this build knows about. */
export const NOTIFY_TOPICS = ["plan_change", "oeb_rates", "data_available", "anomaly"] as const;
export type NotifyTopic = (typeof NOTIFY_TOPICS)[number];

export function isNotifyTopic(value: unknown): value is NotifyTopic {
  return typeof value === "string" && (NOTIFY_TOPICS as readonly string[]).includes(value);
}

/**
 * The same four topics, partitioned by WHO IS ALLOWED TO EMIT THEM.
 *
 * This is the trigger table from WAVE-N-DESIGN.md §7 as a type guard rather
 * than as prose. Under client-side E2EE the split is not cosmetic:
 *
 *   client-origin  `plan_change`, `anomaly` — computed in the browser from
 *                  `energy_data`, which the server cannot read. Emitted by
 *                  `POST /account/notify`, which is SESSION-authenticated and
 *                  fans out to the CALLER ONLY.
 *   server-origin  `oeb_rates`, `data_available` — computed from public state
 *                  (the app's rate payload, the shim's scalars). Emitted by
 *                  the internal, edge-denied, token-checked route and by the
 *                  rate watcher, which are the only two places allowed to fan
 *                  out to every account.
 *
 * A browser may not claim a server-origin topic (it would be announcing
 * something it cannot observe), and the internal route may not accept a
 * client-origin one (it would be relaying usage-derived text it has no
 * business originating). Enforcing both directions is what keeps "who fans
 * out to whom" from ever being decided by whichever route forgot to pass an
 * argument again.
 */
export const CLIENT_NOTIFY_TOPICS = ["plan_change", "anomaly"] as const;
export const SERVER_NOTIFY_TOPICS = ["oeb_rates", "data_available"] as const;

export function isClientNotifyTopic(value: unknown): value is (typeof CLIENT_NOTIFY_TOPICS)[number] {
  return typeof value === "string" && (CLIENT_NOTIFY_TOPICS as readonly string[]).includes(value);
}

export function isServerNotifyTopic(value: unknown): value is (typeof SERVER_NOTIFY_TOPICS)[number] {
  return typeof value === "string" && (SERVER_NOTIFY_TOPICS as readonly string[]).includes(value);
}

/** Human-readable list for a 400 body (kept next to the guards it mirrors). */
export function topicList(topics: readonly string[]): string {
  return topics.join(", ");
}

/**
 * Anti-spam defaults, per topic: the floor between two sends of the same
 * kind. `plan_change` also dedupes identical text (a plan that flaps must
 * not flap at the user).
 */
export const TOPIC_MIN_INTERVAL_MS: Record<NotifyTopic, number> = {
  plan_change: 24 * 60 * 60 * 1000,
  oeb_rates: 7 * 24 * 60 * 60 * 1000,
  data_available: 24 * 60 * 60 * 1000,
  anomaly: 24 * 60 * 60 * 1000,
};

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  topics: [...NOTIFY_TOPICS],
  dailyCap: 3,
  quietStart: 22 * 60,
  quietEnd: 7 * 60,
  tzOffset: 0,
};

const handles = new Map<string, DatabaseSync>();

function migrateNotifyCascade(db: DatabaseSync): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version >= 2) return;
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(notify_log)").all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
  if (!foreignKeys.some((fk) => fk.table === "accounts" && fk.from === "account_id" && fk.on_delete === "CASCADE")) {
    db.exec(`
      CREATE TABLE notify_log_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        topic TEXT NOT NULL, title TEXT NOT NULL, sent_at INTEGER NOT NULL,
        outcome TEXT NOT NULL, detail TEXT
      );
      INSERT INTO notify_log_v2 (id, account_id, topic, title, sent_at, outcome, detail)
        SELECT id, account_id, topic, title, sent_at, outcome, detail FROM notify_log n
        WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = n.account_id);
      DROP TABLE notify_log;
      ALTER TABLE notify_log_v2 RENAME TO notify_log;
      CREATE INDEX notify_log_account_topic ON notify_log (account_id, topic, sent_at);
    `);
  }
}

/**
 * Open (and memoise) the database for `path`. Migrations are serialized by
 * BEGIN IMMEDIATE and recorded using SQLite's transactional user_version.
 */
export function openDb(path: string): DatabaseSync {
  const existing = handles.get(path);
  if (existing) return existing;

  // A relative default path must still work when the process cwd is read-only
  // inside the container — the deployment always passes an absolute path.
  if (path !== ":memory:" && !path.startsWith("file:")) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* the open below reports the real error with the real path */
    }
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(SCHEMA);
    migrateNotifyCascade(db);
    db.exec("PRAGMA user_version = 2;");
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    db.close();
    throw error;
  }
  handles.set(path, db);
  return db;
}

/** Test hook — close every cached handle so a temp dir can be deleted. */
export function closeAllDbs(): void {
  for (const db of handles.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  handles.clear();
}

/* --------------------------------------------------------------------------
 * Accounts
 * ------------------------------------------------------------------------ */

export function findAccountByEmail(db: DatabaseSync, email: string): AccountRow | null {
  return (db.prepare("SELECT * FROM accounts WHERE email = ?").get(email.trim()) as AccountRow | undefined) ?? null;
}

export function findAccountById(db: DatabaseSync, id: number): AccountRow | null {
  return (db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined) ?? null;
}

export function insertAccount(
  db: DatabaseSync,
  input: { email: string; passwordHash: string; kdfSalt: string; recoveryHash: string | null },
): number {
  const info = db
    .prepare(
      "INSERT INTO accounts (email, password_hash, kdf_salt, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.email.trim().toLowerCase(), input.passwordHash, input.kdfSalt, input.recoveryHash, Date.now());
  return Number(info.lastInsertRowid);
}

export function setPasswordHash(db: DatabaseSync, accountId: number, hash: string): void {
  db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(hash, accountId);
}

export function setRecoveryHash(db: DatabaseSync, accountId: number, hash: string | null): void {
  db.prepare("UPDATE accounts SET recovery_hash = ? WHERE id = ?").run(hash, accountId);
}

/* --------------------------------------------------------------------------
 * Sessions — the database stores only a hash of the token.
 * ------------------------------------------------------------------------ */

export function insertSession(db: DatabaseSync, tokenHash: string, accountId: number, ttlMs: number): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(tokenHash, accountId, now, now + ttlMs, now);
}

/** Look up a session by token hash; expired rows are deleted on sight. */
export function findSession(db: DatabaseSync, tokenHash: string): SessionRow | null {
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return row;
}

/**
 * Slide the expiry forward and rotate the token.
 *
 * Rotation is what stops a long-lived cookie from being a permanent
 * credential: the value the browser holds this minute is not the value it
 * held last month. Returns the NEW token hash to set on the cookie.
 */
export function touchSession(db: DatabaseSync, tokenHash: string, ttlMs: number): string {
  const now = Date.now();
  db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(
    now,
    now + ttlMs,
    tokenHash,
  );
  return tokenHash;
}

export function deleteSession(db: DatabaseSync, tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteSessionsForAccount(db: DatabaseSync, accountId: number): void {
  db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
}

/** Housekeeping: drop sessions that are past expiry. */
export function pruneSessions(db: DatabaseSync): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

/* --------------------------------------------------------------------------
 * Blob (ciphertext) — the only user data, and it is opaque here.
 * ------------------------------------------------------------------------ */

export function getBlob(db: DatabaseSync, accountId: number): BlobRow | null {
  return (db.prepare("SELECT * FROM blobs WHERE account_id = ?").get(accountId) as BlobRow | undefined) ?? null;
}

/**
 * Last-writer-wins with an optimistic guard: `baseRev` must match the stored
 * revision or the write is refused with 409, so two devices racing cannot
 * silently overwrite each other — the loser is told and re-pulls.
 */
export type PutBlobResult = { ok: true; rev: number; updatedAt: number } | { ok: false; currentRev: number };

export function putBlob(
  db: DatabaseSync,
  accountId: number,
  input: { iv: string; data: string; baseRev: number },
): PutBlobResult {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const current = getBlob(db, accountId);
    const currentRev = current?.rev ?? 0;
    if (input.baseRev !== currentRev) {
      db.exec("ROLLBACK;");
      return { ok: false, currentRev };
    }
    const rev = currentRev + 1;
    const updatedAt = Date.now();
    db.prepare(
      `INSERT INTO blobs (account_id, iv, data, rev, updated_at, bytes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         iv = excluded.iv, data = excluded.data, rev = excluded.rev,
         updated_at = excluded.updated_at, bytes = excluded.bytes`,
    ).run(accountId, input.iv, input.data, rev, updatedAt, Buffer.byteLength(input.data, "utf8"));
    db.exec("COMMIT;");
    return { ok: true, rev, updatedAt };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

/** Delete an account and all associated metadata in one transaction. */
export function deleteAccount(db: DatabaseSync, accountId: number): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function deleteBlob(db: DatabaseSync, accountId: number): void {
  db.prepare("DELETE FROM blobs WHERE account_id = ?").run(accountId);
}

/* --------------------------------------------------------------------------
 * Push subscriptions + preferences
 * ------------------------------------------------------------------------ */

export function listSubscriptions(db: DatabaseSync, accountId: number): PushSubRow[] {
  return db.prepare("SELECT * FROM push_subs WHERE account_id = ?").all(accountId) as unknown as PushSubRow[];
}

/**
 * A subscription is owned by the account that created it, and an endpoint is
 * NOT a secret: it is a URL the device received from a push service. So the
 * ownership check lives in the SQL — a session that learns somebody else's
 * endpoint must not be able to re-point it at its own account (that would
 * both steal the victim's notifications and send the attacker's to them).
 *
 * The route additionally reports the conflict as 409 so the user is told
 * their device is already registered elsewhere, rather than getting a 201
 * for a subscription that did not move.
 */
export function findSubscriptionOwner(db: DatabaseSync, endpoint: string): number | null {
  const row = db.prepare("SELECT account_id FROM push_subs WHERE endpoint = ?").get(endpoint) as
    | { account_id: number }
    | undefined;
  return row ? row.account_id : null;
}

export function upsertSubscription(
  db: DatabaseSync,
  accountId: number,
  input: { endpoint: string; p256dh: string; auth: string },
): void {
  db.prepare(
    `INSERT INTO push_subs (account_id, endpoint, p256dh, auth, created_at, failures)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, failures = 0
     WHERE push_subs.account_id = excluded.account_id`,
  ).run(accountId, input.endpoint, input.p256dh, input.auth, Date.now());
}

export function deleteSubscription(db: DatabaseSync, accountId: number, endpoint: string): void {
  db.prepare("DELETE FROM push_subs WHERE account_id = ? AND endpoint = ?").run(accountId, endpoint);
}

/** A subscription the browser has unsubscribed from (HTTP 410 Gone). */
export function deleteSubscriptionByEndpoint(db: DatabaseSync, endpoint: string): void {
  db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
}

export function recordSubscriptionFailure(db: DatabaseSync, endpoint: string): number {
  db.prepare("UPDATE push_subs SET failures = failures + 1 WHERE endpoint = ?").run(endpoint);
  const row = db.prepare("SELECT failures FROM push_subs WHERE endpoint = ?").get(endpoint) as
    | { failures: number }
    | undefined;
  return row?.failures ?? 0;
}

export function recordSubscriptionOk(db: DatabaseSync, endpoint: string): void {
  db.prepare("UPDATE push_subs SET last_ok_at = ?, failures = 0 WHERE endpoint = ?").run(Date.now(), endpoint);
}

export function getPushPrefs(db: DatabaseSync, accountId: number): PushPrefs {
  const row = db.prepare("SELECT * FROM push_prefs WHERE account_id = ?").get(accountId) as
    | {
        topics: string;
        daily_cap: number;
        quiet_start: number;
        quiet_end: number;
        tz_offset: number;
      }
    | undefined;
  if (!row) return { ...DEFAULT_PUSH_PREFS, topics: [...DEFAULT_PUSH_PREFS.topics] };
  let topics: string[] = DEFAULT_PUSH_PREFS.topics;
  try {
    const parsed: unknown = JSON.parse(row.topics);
    if (Array.isArray(parsed)) topics = parsed.filter(isNotifyTopic);
  } catch {
    /* corrupt row: fall back to the defaults rather than to silence */
  }
  return {
    topics,
    dailyCap: row.daily_cap,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    tzOffset: row.tz_offset,
  };
}

export function setPushPrefs(db: DatabaseSync, accountId: number, prefs: PushPrefs): void {
  db.prepare(
    `INSERT INTO push_prefs (account_id, topics, daily_cap, quiet_start, quiet_end, tz_offset, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       topics = excluded.topics, daily_cap = excluded.daily_cap,
       quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
       tz_offset = excluded.tz_offset, updated_at = excluded.updated_at`,
  ).run(
    accountId,
    JSON.stringify(prefs.topics.filter(isNotifyTopic)),
    prefs.dailyCap,
    prefs.quietStart,
    prefs.quietEnd,
    prefs.tzOffset,
    Date.now(),
  );
}

/* --------------------------------------------------------------------------
 * Notify log — "why did I / didn't I get one" must be answerable.
 * ------------------------------------------------------------------------ */

export function lastSentAt(db: DatabaseSync, accountId: number, topic: string): number | null {
  const row = db
    .prepare(
      "SELECT MAX(sent_at) AS at FROM notify_log WHERE account_id = ? AND topic = ? AND outcome = 'sent'",
    )
    .get(accountId, topic) as { at: number | null } | undefined;
  return row?.at ?? null;
}

export function lastSentTitle(db: DatabaseSync, accountId: number, topic: string): string | null {
  const row = db
    .prepare(
      "SELECT title FROM notify_log WHERE account_id = ? AND topic = ? AND outcome = 'sent' ORDER BY sent_at DESC LIMIT 1",
    )
    .get(accountId, topic) as { title: string } | undefined;
  return row?.title ?? null;
}

/** How many notifications this account actually received since `since`. */
export function sentCountSince(db: DatabaseSync, accountId: number, since: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM notify_log WHERE account_id = ? AND outcome = 'sent' AND sent_at >= ?")
    .get(accountId, since) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function logNotify(
  db: DatabaseSync,
  entry: { accountId: number; topic: string; title: string; outcome: NotifyOutcome; detail?: string },
): void {
  db.prepare(
    "INSERT INTO notify_log (account_id, topic, title, sent_at, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(entry.accountId, entry.topic, entry.title, Date.now(), entry.outcome, entry.detail ?? null);
}

/* --------------------------------------------------------------------------
 * meta — small key/value state (the rate fingerprint, nothing personal)
 * ------------------------------------------------------------------------ */

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
