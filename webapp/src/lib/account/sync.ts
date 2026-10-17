/**
 * Wave N — reading, writing and hashing the local dataset for sync.
 *
 * One schema, three consumers: Export JSON, Import JSON and multi-device sync
 * all go through `lib/backup.ts`, so "what a sync moves" and "what a backup
 * file moves" can never drift apart — a v2 document is a v2 document whether
 * it goes to disk, to the server, or to another device.
 *
 * LOCAL IS THE SOURCE OF TRUTH. This module never treats the server copy as
 * authoritative: it reads localStorage, encrypts it and offers it up. A
 * failed or absent account server must leave the dashboard behaving exactly
 * as it does today, which is the invariant that keeps the feature from
 * becoming an outage.
 */

import {
  BACKUP_SCHEMA,
  BACKUP_VERSION,
  EXAMPLE_DATA_KEY,
  parseBackup,
  serializeBackup,
  type BackupDocument,
} from "@/lib/backup";
import { PLAN_STORAGE_KEY } from "@/hooks/useSelectedPlan";
import {
  BILLING_DAY_KEY,
  ENERGY_KEY_V2,
  LEGACY_ENERGY_KEY,
  loadEnergyData,
  saveEnergyData,
} from "@/lib/storage";

/**
 * The dataset keys a sync moves, and the one bookkeeping key it owns.
 *
 * `account_sync_rev` is the server revision this device's data corresponds
 * to. It is what makes "is the server ahead of me, or am I ahead of it?"
 * answerable without guessing, and what turns a blind overwrite into a
 * 409-and-ask. It is not sensitive: a revision number, not a credential.
 */
export const SYNC_DATASET_KEYS = [
  ENERGY_KEY_V2,
  LEGACY_ENERGY_KEY,
  BILLING_DAY_KEY,
  "extra_charges",
  PLAN_STORAGE_KEY,
  EXAMPLE_DATA_KEY,
  "plan_timeline",
] as const;

export const SYNC_REV_KEY = "account_sync_rev";

/**
 * Where the derived key is kept between page loads.
 *
 * localStorage, deliberately, and this is the trade the design says must be
 * stated rather than assumed:
 *
 *   - a `CryptoKey` created with `extractable: false` cannot be persisted, so
 *     keeping it across reloads means keeping its bytes somewhere;
 *   - keeping the bytes anywhere the page can read is equally readable by
 *     XSS — sessionStorage included — so the choice is only about LIFETIME;
 *   - and this profile already holds the readings themselves, in the clear,
 *     where they have always lived. An attacker who can read this store
 *     already has the data without the key.
 *
 * So the key's presence adds no new LOCAL exposure; what it buys is that
 * sync keeps working across restarts, which is the entire point of the
 * feature. It never travels to the server — uploads carry ciphertext — and
 * it dies with `wipeLocalDataset()` on logout. The session cookie that would
 * be needed to USE it is HttpOnly, i.e. precisely what XSS cannot read.
 *
 * sessionStorage would shorten the lifetime at the cost of a password prompt
 * on every browser launch. SECURITY.md records both options; this is the one
 * the build takes.
 */
export const ACCOUNT_KEY_ITEM = "account_blob_key";

function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    /* quota / private mode: sync degrades to "ask me for the password" */
  }
}

function safeRemove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}

/* --------------------------------------------------------------------------
 * The derived key — kept on this device only, never uploaded.
 * (Lifetime and the reasoning behind it: see ACCOUNT_KEY_ITEM above.)
 * ------------------------------------------------------------------------ */

export function saveSessionKey(base64Key: string): void {
  safeSet(localStorage, ACCOUNT_KEY_ITEM, base64Key);
}

export function loadSessionKey(): string | null {
  return safeGet(localStorage, ACCOUNT_KEY_ITEM);
}

export function clearSessionKey(): void {
  safeRemove(localStorage, ACCOUNT_KEY_ITEM);
}

/* --------------------------------------------------------------------------
 * Local document
 * ------------------------------------------------------------------------ */

function readJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Snapshot localStorage as a validated backup document, or null when there is
 * nothing worth syncing.
 *
 * The snapshot goes back through `parseBackup` — the SAME strict validator an
 * import uses — so what leaves this device is already known-good, and a
 * corrupt local profile cannot be pushed into another device under the
 * banner of a sync.
 */
export function readLocalDocument(now: Date = new Date()): BackupDocument | null {
  // The account feature must follow the same versioned storage contract as the
  // dashboard. In particular, current profiles have no legacy `energy_data`
  // key to read. `loadEnergyData` also gives an old profile one safe migration
  // path, without allowing a corrupt payload to become an empty upload.
  const energy = loadEnergyData();
  if (!energy.ok || energy.value === null) return null;

  const candidate = {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    payload: {
      energy_data: energy.value.points,
      billing_day: Number(safeGet(localStorage, BILLING_DAY_KEY) ?? 1),
      extra_charges: readJson<unknown>(safeGet(localStorage, "extra_charges")) ?? {},
      plan_timeline: readJson<unknown>(safeGet(localStorage, "plan_timeline")) ?? [],
      selected_plan: safeGet(localStorage, PLAN_STORAGE_KEY) ?? undefined,
      energy_data_is_example: safeGet(localStorage, EXAMPLE_DATA_KEY) === "1",
    },
  };

  const parsed = parseBackup(JSON.stringify(candidate));
  return parsed.ok ? parsed.value : null;
}

/** Apply a document the server handed back. Every key is written or cleared. */
export function applyDocument(doc: BackupDocument): { written: string[] } {
  // `storageValuesFromBackup` is intentionally a backup/import representation
  // and names the historical `energy_data` field. Account sync writes through
  // the live storage service instead, so a remote apply cannot leave a stale
  // v2 payload beside a newly-written legacy payload.
  const savedEnergy = saveEnergyData(doc.payload.energy_data, {
    source: "account-sync",
    uploadedAt: doc.exportedAt || new Date().toISOString(),
  });
  if (!savedEnergy.ok) return { written: [] };

  const values: Record<string, string> = {
    billing_day: String(doc.payload.billing_day),
    extra_charges: JSON.stringify(doc.payload.extra_charges),
    plan_timeline: JSON.stringify(doc.payload.plan_timeline ?? []),
    ...(doc.payload.selected_plan !== undefined ? { [PLAN_STORAGE_KEY]: doc.payload.selected_plan } : {}),
    [EXAMPLE_DATA_KEY]: doc.payload.energy_data_is_example === true ? "1" : "",
  };
  const written: string[] = [ENERGY_KEY_V2];
  for (const [key, value] of Object.entries(values)) {
    if (value === "") safeRemove(localStorage, key);
    else safeSet(localStorage, key, value);
    written.push(key);
  }
  return { written };
}

/**
 * Fingerprint of what this device would upload.
 *
 * Used to answer "did anything change since the last push?" without a
 * network round trip. `exportedAt` is deliberately excluded — it changes on
 * every snapshot and would make every check look dirty.
 */
export function documentFingerprint(doc: BackupDocument): string {
  const body = serializeBackup({ ...doc, exportedAt: "" });
  // FNV-1a: not cryptography, just a cheap content id. The security-relevant
  // check is the server's `rev`, not this.
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${doc.payload.energy_data.length}:${hash.toString(16)}`;
}

/* --------------------------------------------------------------------------
 * Revision bookkeeping + local wipe
 * ------------------------------------------------------------------------ */

export function getLocalRev(): number {
  const raw = safeGet(localStorage, SYNC_REV_KEY);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function setLocalRev(rev: number): void {
  safeSet(localStorage, SYNC_REV_KEY, String(rev));
}

/** True when this device has never successfully synced with the account. */
export function hasSyncedBefore(): boolean {
  return safeGet(localStorage, SYNC_REV_KEY) !== null;
}

/**
 * Remove the dataset from this browser (logout).
 *
 * The card's one unacceptable failure mode is losing UNSYNCED local data, so
 * callers must check `localRev <= serverRev` first — see `useAccount`.
 * The derived key goes too: after this, the device cannot produce or read a
 * server copy until the password is entered again.
 */
export function wipeLocalDataset(): { removed: string[] } {
  const removed: string[] = [];
  for (const key of [...SYNC_DATASET_KEYS, SYNC_REV_KEY]) {
    if (safeGet(localStorage, key) !== null) removed.push(key);
    safeRemove(localStorage, key);
  }
  clearSessionKey();
  return { removed };
}

/** Does this browser hold a dataset a sync could move? */
export function hasLocalData(): boolean {
  const result = loadEnergyData();
  return result.ok && result.value !== null && result.value.points.length > 0;
}
