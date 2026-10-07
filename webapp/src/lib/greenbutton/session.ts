/**
 * Ephemeral, in-memory state for the Green Button CMD shim.
 *
 * Two things live here and nothing else:
 *
 *  1. CSRF `state` values for the 10-minute window between /start and
 *     /callback. Single-process, TTL'd, single-use — parked alongside each
 *     one is the PKCE `code_verifier` for that attempt (when PKCE is on),
 *     so the two die together and a verifier can never outlive the state it
 *     belongs to.
 *  2. Sync metadata — timestamps and byte counts only. The shim never parses
 *     or stores readings (zero data at rest); it can honestly report "the
 *     feed was 1.2 MB at 14:03" and "the custodian says data changed at
 *     09:11", because neither says anything about the customer's usage.
 *
 * Everything here dies with the process. That is deliberate: nothing the
 * utility tells us should outlive a restart.
 */

import { randomBytes } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

export type StateEntry = {
  createdAt: number;
  /** RFC 7636 verifier for this attempt; present only when PKCE was on. */
  codeVerifier?: string;
};

const states = new Map<string, StateEntry>();

export function newState(codeVerifier?: string): string {
  prune();
  const value = randomBytes(24).toString("hex");
  const entry: StateEntry = { createdAt: Date.now() };
  if (codeVerifier) entry.codeVerifier = codeVerifier;
  states.set(value, entry);
  return value;
}

/**
 * Single-use: a state can be redeemed exactly once, then it is gone.
 * Returns what the state was carrying (the PKCE verifier, if any) or `null`
 * when it was never issued. Consumption happens BEFORE any comparison the
 * caller makes, so a cross-site attempt burns its own state.
 */
export function consumeState(value: string | undefined | null): StateEntry | null {
  if (!value) return null;
  prune();
  const found = states.get(value);
  if (!found) return null;
  states.delete(value);
  return Date.now() - found.createdAt <= STATE_TTL_MS ? found : null;
}

function prune(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of states) if (v.createdAt < cutoff) states.delete(k);
}

/** In-memory sync metadata. Scalars only — no readings, ever. */
export type SyncMeta = {
  /** Epoch ms of the last successful pipe-through. */
  lastSyncAt?: number;
  /** Bytes the feed was on the last successful pipe-through. */
  lastSyncBytes?: number;
  /** Epoch ms the custodian says data changed (from a /notify POST). */
  dataAvailableSince?: number;
};

let meta: SyncMeta = {};

export function getSyncMeta(): SyncMeta {
  return { ...meta };
}

export function markSync(bytes: number): void {
  meta = { ...meta, lastSyncAt: Date.now(), lastSyncBytes: bytes };
}

export function markDataAvailable(at = Date.now()): void {
  // Never move the marker backwards (retries / duplicated notifications).
  if (!meta.dataAvailableSince || at > meta.dataAvailableSince) {
    meta = { ...meta, dataAvailableSince: at };
  }
}

/** Called once the client has ingested a fresh feed. */
export function clearDataAvailable(): void {
  const rest = { ...meta };
  delete rest.dataAvailableSince;
  meta = rest;
}

export function clearSyncMeta(): void {
  meta = {};
}

/** Test hook. */
export function resetSessionState(): void {
  states.clear();
  meta = {};
}
