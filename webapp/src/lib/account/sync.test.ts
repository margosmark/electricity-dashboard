/**
 * Wave N — local ⇄ sync document plumbing.
 *
 * The property under test is the one the multi-device story depends on:
 * what leaves this device and what comes back are the SAME document Export
 * and Import use, so a device restored by a sync is indistinguishable from
 * one restored by a file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ACCOUNT_KEY_ITEM,
  SYNC_DATASET_KEYS,
  SYNC_REV_KEY,
  applyDocument,
  clearSessionKey,
  documentFingerprint,
  getLocalRev,
  hasLocalData,
  hasSyncedBefore,
  loadSessionKey,
  readLocalDocument,
  setLocalRev,
  wipeLocalDataset,
} from "./sync";
import { buildBackupDocument, parseBackup, serializeBackup, BACKUP_SCHEMA, BACKUP_VERSION, EXAMPLE_DATA_KEY } from "@/lib/backup";
import { PLAN_STORAGE_KEY } from "@/hooks/useSelectedPlan";

const ROWS = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.25 },
];

function seedLocal(overrides: Record<string, string> = {}) {
  localStorage.clear();
  localStorage.setItem("energy_data", JSON.stringify(ROWS));
  localStorage.setItem("billing_day", "7");
  localStorage.setItem("extra_charges", JSON.stringify({ hstPct: "13" }));
  localStorage.setItem(PLAN_STORAGE_KEY, "ULO");
  localStorage.setItem(EXAMPLE_DATA_KEY, "1");
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "") localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  }
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("readLocalDocument", () => {
  it("returns null when this browser has no readings", () => {
    expect(readLocalDocument()).toBeNull();
    expect(hasLocalData()).toBe(false);
  });

  it("snapshots all five dataset keys into a v2 document", () => {
    seedLocal();
    const doc = readLocalDocument();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(BACKUP_VERSION);
    expect(doc!.schema).toBe(BACKUP_SCHEMA);
    expect(doc!.payload.energy_data).toEqual(ROWS);
    expect(doc!.payload.billing_day).toBe(7);
    // whitelistCharges always normalises to the four known fields.
    expect(doc!.payload.extra_charges).toMatchObject({ hstPct: "13" });
    expect(doc!.payload.selected_plan).toBe("ULO");
    expect(doc!.payload.energy_data_is_example).toBe(true);
  });

  it("returns null for a corrupt profile rather than pushing garbage at a sync", () => {
    seedLocal({ energy_data: "{not json" });
    expect(readLocalDocument()).toBeNull();
  });

  it("returns null when the readings are empty — restoring them would wipe data", () => {
    seedLocal({ energy_data: "[]" });
    expect(readLocalDocument()).toBeNull();
  });
});

describe("applyDocument", () => {
  it("is the inverse of readLocalDocument: a full round trip, byte for byte", () => {
    seedLocal();
    const before = readLocalDocument()!;
    // What the server would have returned: serialize → validate → apply.
    const reparsed = parseBackup(serializeBackup(before));
    expect(reparsed.ok).toBe(true);
    applyDocument(reparsed.ok ? reparsed.value : before);
    const after = readLocalDocument()!;
    expect(after.payload).toEqual(before.payload);
  });

  it("restores a document that never recorded the optional v2 fields", () => {
    localStorage.clear();
    const legacy = buildBackupDocument({ energyData: ROWS, billingDay: 3 });
    // Simulate a v1 document (no plan, no example flag).
    const asV1 = { ...legacy, version: 1, payload: { ...legacy.payload } };
    delete (asV1.payload as Record<string, unknown>).selected_plan;
    delete (asV1.payload as Record<string, unknown>).energy_data_is_example;
    const parsed = parseBackup(JSON.stringify(asV1));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    seedLocal();
    applyDocument(parsed.value);
    const doc = readLocalDocument()!;
    // The plan is untouched (a v1 file has no opinion)...
    expect(doc.payload.selected_plan).toBe("ULO");
    // ...but the example flag is cleared: a restore replaces the profile, and
    // a stale "these are demo numbers" banner over real data is a lie.
    expect(doc.payload.energy_data_is_example).toBe(false);
    expect(localStorage.getItem(EXAMPLE_DATA_KEY)).toBeNull();
  });

  it("writes only whitelisted keys", () => {
    seedLocal();
    const doc = readLocalDocument()!;
    const { written } = applyDocument(doc);
    expect(written.sort()).toEqual(
      // `plan_timeline` is Wave P's field: it rides the same document, so a
      // device pull restores the plan periods as well (rebase onto main).
      ["billing_day", "energy_data", "energy_data_is_example", "extra_charges", "plan_timeline", PLAN_STORAGE_KEY].sort(),
    );
  });
});

describe("documentFingerprint", () => {
  it("ignores exportedAt — otherwise every snapshot would look dirty", () => {
    seedLocal();
    const a = readLocalDocument(new Date("2026-10-07T10:00:00Z"))!;
    const b = readLocalDocument(new Date("2026-10-07T23:59:59Z"))!;
    expect(a.exportedAt).not.toBe(b.exportedAt);
    expect(documentFingerprint(a)).toBe(documentFingerprint(b));
  });

  it("changes when ANY synced field changes", () => {
    seedLocal();
    const base = documentFingerprint(readLocalDocument()!);

    const mutations: Record<string, string>[] = [
      { billing_day: "8" },
      { [PLAN_STORAGE_KEY]: "Tiered" },
      { extra_charges: JSON.stringify({ hstPct: "14" }) },
      { [EXAMPLE_DATA_KEY]: "" },
      { energy_data: JSON.stringify([...ROWS, { timestamp: 1704074400, usage_kwh: 3 }]) },
    ];
    for (const mutation of mutations) {
      seedLocal(mutation);
      expect(documentFingerprint(readLocalDocument()!), JSON.stringify(mutation)).not.toBe(base);
    }
  });
});

describe("revision bookkeeping + wipe", () => {
  it("defaults to revision 0 and remembers an uploaded one", () => {
    expect(getLocalRev()).toBe(0);
    expect(hasSyncedBefore()).toBe(false);
    setLocalRev(4);
    expect(getLocalRev()).toBe(4);
    expect(hasSyncedBefore()).toBe(true);
    localStorage.setItem(SYNC_REV_KEY, "not-a-number");
    expect(getLocalRev()).toBe(0);
  });

  it("removes the dataset, the revision AND the derived key on logout", () => {
    seedLocal();
    setLocalRev(3);
    localStorage.setItem(ACCOUNT_KEY_ITEM, "Zm9vYmFy");

    const { removed } = wipeLocalDataset();
    // Everything the dataset occupies, and nothing that was not there.
    expect([...removed].sort()).toEqual([...SYNC_DATASET_KEYS, SYNC_REV_KEY].sort());
    for (const key of SYNC_DATASET_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(SYNC_REV_KEY)).toBeNull();
    expect(loadSessionKey()).toBeNull();
    expect(hasLocalData()).toBe(false);
    expect(hasSyncedBefore()).toBe(false);
  });

  it("keeps unrelated keys (other features own their own storage)", () => {
    seedLocal();
    localStorage.setItem("some_other_feature", "keep-me");
    wipeLocalDataset();
    expect(localStorage.getItem("some_other_feature")).toBe("keep-me");
  });
});

describe("session key storage", () => {
  it("stores and clears the derived key", () => {
    expect(loadSessionKey()).toBeNull();
    localStorage.setItem(ACCOUNT_KEY_ITEM, "abc123");
    expect(loadSessionKey()).toBe("abc123");
    clearSessionKey();
    expect(loadSessionKey()).toBeNull();
  });
});
