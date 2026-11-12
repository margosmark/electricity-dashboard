/**
 * Durable, versioned browser storage for the Ontario Energy Optimizer.
 *
 * Contract:
 *  - Every read/write goes through a discriminated union result so failure
 *    modes (`quota`, `corrupt`) surface to the caller instead of being
 *    swallowed by a bare try/catch.
 *  - Data lives under the versioned key `energy_data_v2` with an explicit
 *    payload `{ version, uploadedAt, source, points }` — ELECTRICITY ONLY.
 *    Gas volume lives under `energy_gas_v2` (see ENERGY_GAS_KEY) and is
 *    never written to, read as, or merged into the electric key.
 *  - The legacy v1 key `energy_data` (bare array of points) is migrated
 *    on read: parsed, re-written under the v2 key, then removed. Live users
 *    already have `energy_data` populated, so it is never dropped before a
 *    successful v2 write.
 *  - `localStorage.clear()` is never used: reset removes only OUR_STORAGE_KEYS.
 *
 * Warning kinds (carried on otherwise-successful results):
 *  - `quota`   — a write could not be persisted (data still held in memory).
 *  - `cleanup` — the write landed but a follow-up cleanup step did not.
 */

/* Wave U — storage failures are surfaced in the UI, so they translate. */
import { t } from '@/i18n';
import type { DataPoint } from './energy';

export const SCHEMA_VERSION = 2;
export const ENERGY_KEY_V2 = 'energy_data_v2';
export const LEGACY_ENERGY_KEY = 'energy_data';
export const BILLING_DAY_KEY = 'billing_day';

/**
 * Natural gas lives under its OWN key (t_8a9038d6).
 *
 * `energy_data_v2` holds `DataPoint`s — `{timestamp, usage_kwh}` — and every
 * consumer prices those as electricity. A gas extract carries cubic metres,
 * so writing it there either wipes the electric dataset (a gas file's
 * `g.readings` is empty) or lands m³ where kWh is assumed. The two keys are
 * therefore disjoint by TYPE: a `GasPoint` has no `usage_kwh`, so it cannot
 * pass `isDataPoint`, and an electric `DataPoint` cannot pass `isGasPoint`.
 * Neither write path can address the other's key.
 */
export const ENERGY_GAS_KEY = 'energy_gas_v2';
export const GAS_SCHEMA_VERSION = 1;

/** Every localStorage key this app owns. Reset touches these and nothing else. */
export const OUR_STORAGE_KEYS: readonly string[] = [
  ENERGY_KEY_V2,
  ENERGY_GAS_KEY,
  LEGACY_ENERGY_KEY,
  BILLING_DAY_KEY,
];

export type StoredPayload = {
  version: number;
  uploadedAt: string;
  source: string;
  points: DataPoint[];
};

/**
 * One gas interval. `volume_m3` is `raw × 10^powerOfTenMultiplier` computed
 * by the parser against the ReadingType's own scale — never re-derived here,
 * and never convertible to kWh by anything downstream.
 */
export type GasPoint = {
  /** UTC epoch seconds of the interval start. */
  timestamp: number;
  /** Interval length in seconds when the feed states one. */
  duration_s: number | null;
  /** Cubic metres for that interval. */
  volume_m3: number;
};

export type GasStoredPayload = {
  version: number;
  uploadedAt: string;
  source: string;
  points: GasPoint[];
};

export type StorageFailureReason = 'quota' | 'corrupt';

export type StorageWarningKind = 'quota' | 'cleanup';

export type StorageWarning = { kind: StorageWarningKind; detail: string };

export type StorageResult<T> =
  | { ok: true; value: T; warnings: StorageWarning[] }
  | { ok: false; reason: StorageFailureReason; detail: string };

function ok<T>(value: T, warnings: StorageWarning[] = []): StorageResult<T> {
  return { ok: true, value, warnings };
}

function fail<T>(reason: StorageFailureReason, detail: string): StorageResult<T> {
  return { ok: false, reason, detail };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function isQuotaError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    if (err.code === 22 || err.code === 1014) return true;
  }
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /quota|exceeded the quota|exceeded.*storage/i.test(msg);
}

// --- Validation ------------------------------------------------------------

export function isDataPoint(value: unknown): value is DataPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.timestamp === 'number' &&
    Number.isFinite(point.timestamp) &&
    typeof point.usage_kwh === 'number' &&
    Number.isFinite(point.usage_kwh)
  );
}

function parsePointsArray(value: unknown): DataPoint[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isDataPoint)) return null;
  return value as DataPoint[];
}

export function isStoredPayload(value: unknown): value is StoredPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.version === 'number' &&
    typeof payload.uploadedAt === 'string' &&
    typeof payload.source === 'string' &&
    Array.isArray(payload.points) &&
    payload.points.every(isDataPoint)
  );
}

export function buildPayload(
  points: DataPoint[],
  source: string,
  uploadedAt: string = new Date().toISOString(),
): StoredPayload {
  return { version: SCHEMA_VERSION, uploadedAt, source, points };
}

/**
 * A gas interval — the MIRROR of `isDataPoint`, and deliberately
 * mutually exclusive with it: `volume_m3` carries no `usage_kwh`, so a gas
 * point can never be persisted (or later read back) as electricity.
 */
export function isGasPoint(value: unknown): value is GasPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  if (typeof point.timestamp !== 'number' || !Number.isFinite(point.timestamp)) return false;
  if (typeof point.volume_m3 !== 'number' || !Number.isFinite(point.volume_m3)) return false;
  if (point.volume_m3 < 0) return false;
  return point.duration_s === null || (typeof point.duration_s === 'number' && Number.isFinite(point.duration_s));
}

export function isGasStoredPayload(value: unknown): value is GasStoredPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.version === 'number' &&
    typeof payload.uploadedAt === 'string' &&
    typeof payload.source === 'string' &&
    Array.isArray(payload.points) &&
    payload.points.every(isGasPoint)
  );
}

export function buildGasPayload(
  points: GasPoint[],
  source: string,
  uploadedAt: string = new Date().toISOString(),
): GasStoredPayload {
  return { version: GAS_SCHEMA_VERSION, uploadedAt, source, points };
}

// --- Low level IO ----------------------------------------------------------

type WriteOutcome = { ok: true } | { ok: false; detail: string };

function safeSetItem(key: string, value: string): WriteOutcome {
  try {
    localStorage.setItem(key, value);
    return { ok: true };
  } catch (err) {
    const reason = isQuotaError(err) ? t('storage.reasonQuota') : t('storage.reasonWrite');
    return { ok: false, detail: t('storage.writeFail', { reason, key, detail: describeError(err) }) };
  }
}

function safeGetItem(key: string): StorageResult<string | null> {
  try {
    return ok(localStorage.getItem(key));
  } catch (err) {
    return fail<string | null>('quota', t('storage.readFail', { key, reason: describeError(err) }));
  }
}

/**
 * Write (or, with `value: null`, remove) ONE key that storage.ts does not
 * itself own, through the same error classification every write here uses.
 *
 * `usage_summaries` / `local_time_parameters` are declared in useDashboard
 * because the parse that fills them lives there — but their write must not be
 * a second, quieter contract. For a gas-only import those keys are the ONLY
 * persisted copy of the data (no electric `DataPoint`s are committed), so a
 * failure here has to come back as the same `StorageResult`, the same
 * quota/corrupt reason and the same sentence the readings write reports,
 * instead of vanishing into an empty catch.
 */
export function writeStoredKey(key: string, value: string | null): StorageResult<true> {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return ok(true);
  } catch (err) {
    const reason: StorageFailureReason = isQuotaError(err) ? 'quota' : 'corrupt';
    const word = reason === 'quota' ? t('storage.reasonQuota') : t('storage.reasonWrite');
    return fail<true>(reason, t('storage.writeFail', { reason: word, key, detail: describeError(err) }));
  }
}

// --- Energy data -----------------------------------------------------------

/**
 * Read the current energy payload, migrating the legacy v1 key on the way.
 * Returns `value: null` when nothing has ever been stored.
 */
export function loadEnergyData(): StorageResult<StoredPayload | null> {
  const current = safeGetItem(ENERGY_KEY_V2);
  if (!current.ok) return current;
  const raw = current.value;

  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return fail<StoredPayload | null>('corrupt', `${ENERGY_KEY_V2} is not valid JSON: ${describeError(err)}`);
    }
    if (!isStoredPayload(parsed)) {
      return fail<StoredPayload | null>('corrupt', `${ENERGY_KEY_V2} does not match the v${SCHEMA_VERSION} payload schema`);
    }
    return ok<StoredPayload | null>(parsed);
  }

  return loadLegacy();
}

/** v1 -> v2 migration: bare `energy_data` array becomes an `energy_data_v2` payload. */
function loadLegacy(): StorageResult<StoredPayload | null> {
  const legacy = safeGetItem(LEGACY_ENERGY_KEY);
  if (!legacy.ok) return legacy;
  const raw = legacy.value;
  if (raw === null) return ok<StoredPayload | null>(null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail<StoredPayload | null>('corrupt', `${LEGACY_ENERGY_KEY} is not valid JSON: ${describeError(err)}`);
  }

  let points: DataPoint[] | null;
  let uploadedAt = new Date().toISOString();
  let source = 'legacy-migration';

  if (Array.isArray(parsed)) {
    points = parsePointsArray(parsed);
  } else if (isStoredPayload(parsed)) {
    // Already-shaped payload parked under the legacy key.
    points = parsed.points;
    uploadedAt = parsed.uploadedAt;
    source = parsed.source;
  } else {
    points = null;
  }

  if (!points) {
    return fail<StoredPayload | null>('corrupt', `${LEGACY_ENERGY_KEY} does not contain a valid point list`);
  }

  const payload = buildPayload(points, source, uploadedAt);
  const warnings: StorageWarning[] = [];

  const written = safeSetItem(ENERGY_KEY_V2, JSON.stringify(payload));
  if (!written.ok) {
    // The legacy copy is deliberately left in place: never delete data we
    // could not re-write. The caller still gets the points (in memory) plus
    // a warning so the UI can tell the user to export before it is lost.
    warnings.push({
      kind: 'quota',
      detail: t('storage.migrateFail', { reason: written.detail }),
    });
    return ok<StoredPayload | null>(payload, warnings);
  }

  try {
    localStorage.removeItem(LEGACY_ENERGY_KEY);
  } catch (err) {
    warnings.push({
      kind: 'cleanup',
      detail: t('storage.migrateCleanupFail', { key: LEGACY_ENERGY_KEY, reason: describeError(err) }),
    });
  }

  return ok<StoredPayload | null>(payload, warnings);
}

export type SaveOptions = {
  source?: string;
  uploadedAt?: string;
};

/** Persist points under the versioned key. Quota failures come back as `{ok:false, reason:'quota'}`. */
export function saveEnergyData(points: DataPoint[], options: SaveOptions = {}): StorageResult<StoredPayload> {
  if (!Array.isArray(points) || !points.every(isDataPoint)) {
    return fail<StoredPayload>('corrupt', t('storage.errSaveShape'));
  }

  const payload = buildPayload(points, options.source ?? 'upload', options.uploadedAt);

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    return fail<StoredPayload>('corrupt', `Payload is not serializable: ${describeError(err)}`);
  }

  const written = safeSetItem(ENERGY_KEY_V2, serialized);
  if (!written.ok) return fail<StoredPayload>('quota', written.detail);

  const warnings: StorageWarning[] = [];
  try {
    if (localStorage.getItem(LEGACY_ENERGY_KEY) !== null) localStorage.removeItem(LEGACY_ENERGY_KEY);
  } catch (err) {
    warnings.push({ kind: 'cleanup', detail: `Saved, but the stale "${LEGACY_ENERGY_KEY}" copy could not be removed: ${describeError(err)}` });
  }

  return ok(payload, warnings);
}

// --- Gas volume data -------------------------------------------------------

/**
 * Read the gas payload. Returns `value: null` when no gas file has ever been
 * stored — the honest "no gas data yet" state, never a zeroed dataset that
 * looks like an import that produced nothing.
 *
 * A corrupt gas key fails on its own terms and never degrades into "no
 * data": reporting 0 points for a key that actually holds unreadable bytes
 * would be a lie the user cannot act on.
 */
export function loadGasData(): StorageResult<GasStoredPayload | null> {
  const current = safeGetItem(ENERGY_GAS_KEY);
  if (!current.ok) return current;
  const raw = current.value;
  if (raw === null) return ok<GasStoredPayload | null>(null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail<GasStoredPayload | null>('corrupt', `${ENERGY_GAS_KEY} is not valid JSON: ${describeError(err)}`);
  }
  if (!isGasStoredPayload(parsed)) {
    return fail<GasStoredPayload | null>('corrupt', `${ENERGY_GAS_KEY} does not match the v${GAS_SCHEMA_VERSION} gas payload schema`);
  }
  return ok<GasStoredPayload | null>(parsed);
}

/**
 * Persist gas intervals under the gas key.
 *
 * Never touches `energy_data_v2` or `energy_data`: a gas import rewrites the
 * gas bucket only, which is what makes the two upload orders safe in both
 * directions. Quota failures come back as `{ok:false, reason:'quota'}` so the
 * caller raises the same notice row the electric write does.
 */
export function saveGasData(points: GasPoint[], options: SaveOptions = {}): StorageResult<GasStoredPayload> {
  if (!Array.isArray(points) || !points.every(isGasPoint)) {
    return fail<GasStoredPayload>('corrupt', t('storage.errSaveShape'));
  }

  const payload = buildGasPayload(points, options.source ?? 'upload', options.uploadedAt);

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    return fail<GasStoredPayload>('corrupt', `Payload is not serializable: ${describeError(err)}`);
  }

  const written = safeSetItem(ENERGY_GAS_KEY, serialized);
  if (!written.ok) return fail<GasStoredPayload>('quota', written.detail);
  return ok(payload, []);
}

export function loadBillingDay(): StorageResult<number | null> {
  const stored = safeGetItem(BILLING_DAY_KEY);
  if (!stored.ok) return stored;
  const raw = stored.value;
  if (raw === null) return ok<number | null>(null);

  const day = Number(raw.trim());
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return fail<number | null>('corrupt', `${BILLING_DAY_KEY}="${raw}" is not an integer between 1 and 31`);
  }
  return ok<number | null>(day);
}

export function saveBillingDay(day: number): StorageResult<number> {
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return fail<number>('corrupt', t('storage.errBillingDay', { got: String(day) }));
  }
  const written = safeSetItem(BILLING_DAY_KEY, String(day));
  if (!written.ok) return fail<number>('quota', written.detail);
  return ok(day);
}

// --- Export / import -------------------------------------------------------

/** Serialize the current payload for download. Works from in-memory points even if the last save failed. */
export function exportEnergyData(points: DataPoint[], source = 'export'): StorageResult<string> {
  if (!Array.isArray(points) || !points.every(isDataPoint)) {
    return fail<string>('corrupt', t('storage.errExportShape'));
  }
  try {
    return ok(JSON.stringify(buildPayload(points, source), null, 2));
  } catch (err) {
    return fail<string>('corrupt', `Export could not be serialized: ${describeError(err)}`);
  }
}

/** Validate an export file before it is allowed to replace stored data. */
export function parseImport(text: string): StorageResult<StoredPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail<StoredPayload>('corrupt', `Import file is not valid JSON: ${describeError(err)}`);
  }

  if (Array.isArray(parsed)) {
    const points = parsePointsArray(parsed);
    if (!points) {
      return fail<StoredPayload>('corrupt', t('storage.errImportArrayShape'));
    }
    return ok(buildPayload(points, 'import'));
  }

  if (!parsed || typeof parsed !== 'object') {
    return fail<StoredPayload>('corrupt', t('storage.errImportKind'));
  }

  const obj = parsed as Record<string, unknown>;
  const points = parsePointsArray(obj.points);
  if (!points) {
    return fail<StoredPayload>('corrupt', t('storage.errImportNoPoints'));
  }

  const uploadedAt =
    typeof obj.uploadedAt === 'string' && !Number.isNaN(Date.parse(obj.uploadedAt))
      ? obj.uploadedAt
      : new Date().toISOString();
  const source = typeof obj.source === 'string' && obj.source.length > 0 ? obj.source : 'import';
  const version = typeof obj.version === 'number' ? obj.version : SCHEMA_VERSION;

  return ok({ version, uploadedAt, source, points });
}

// --- Reset -----------------------------------------------------------------

/**
 * The keys a reset covers: the three this module owns, plus whatever the app
 * layer registers (plan choice, tab, bill add-ons, …). The caller passes its
 * own list rather than this module importing the whole app, so `storage.ts`
 * stays dependency-free and the extra keys are still named constants instead
 * of duplicated string literals.
 */
function resettableKeys(extraKeys: readonly string[]): string[] {
  return Array.from(new Set([...OUR_STORAGE_KEYS, ...extraKeys]));
}

/** Keys this app currently occupies (for confirm dialogs). */
export function listOurStoredKeys(extraKeys: readonly string[] = []): StorageResult<string[]> {
  try {
    return ok(resettableKeys(extraKeys).filter((key) => localStorage.getItem(key) !== null));
  } catch (err) {
    return fail<string[]>('quota', `Cannot inspect browser storage: ${describeError(err)}`);
  }
}

function removeKeys(keys: readonly string[]): StorageResult<string[]> {
  const removed: string[] = [];
  for (const key of keys) {
    try {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        removed.push(key);
      }
    } catch (err) {
      return fail<string[]>('quota', t('storage.errReset', { key, reason: describeError(err) }));
    }
  }
  return ok(removed);
}

/**
 * Remove ONLY the keys this app owns. Never calls `localStorage.clear()` —
 * unrelated keys (other apps on the same origin) are untouched.
 */
export function resetStoredData(extraKeys: readonly string[] = []): StorageResult<string[]> {
  return removeKeys(resettableKeys(extraKeys));
}

/**
 * Drop the stored readings (v2 and legacy) while keeping `billing_day` and
 * everything else. The "discard the example set" flow needs exactly this:
 * readings go away, the user's settings stay.
 */
export function clearEnergyData(): StorageResult<string[]> {
  return removeKeys([ENERGY_KEY_V2, LEGACY_ENERGY_KEY]);
}

/**
 * Drop ONLY the gas readings. Never called by an electric flow: clearing the
 * electric example set (or a reset of one commodity) must leave the other
 * commodity's dataset in place.
 */
export function clearGasData(): StorageResult<string[]> {
  return removeKeys([ENERGY_GAS_KEY]);
}
