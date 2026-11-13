/**
 * Wave G item 1 — localStorage backup / restore.
 *
 * WHY: this app stores everything in the browser profile (`energy_data`,
 * `billing_day`, `extra_charges`) and nothing server-side, so a cleared
 * profile, a new device, or a profile migration is total data loss. The only
 * recovery today is re-uploading the utility XML — which the user may no
 * longer have. Export writes one self-describing JSON document; Import puts
 * it back.
 *
 * Design rules (all covered by backup.test.ts):
 *  - Versioned + self-describing: `schema` + `version`, so a future build can
 *    refuse documents it does not understand instead of importing half of one.
 *  - Import is STRICT: any malformed row / out-of-range field is an error that
 *    names the problem. Silently dropping rows during a *restore* would turn a
 *    backup into a data-loss vector.
 *  - Unknown keys are never copied into app state (whitelist only), so a
 *    hostile JSON file cannot smuggle keys through an import.
 *  - No prototype pollution: keys are read explicitly from a whitelist;
 *    `__proto__` / `constructor` in the file are never assigned anywhere.
 */

/* Wave U — restore errors are shown in the backup drawer, so they translate. */
import { t } from '@/i18n';
import { EMPTY_EXTRA_CHARGES, EXTRA_CHARGE_FIELDS, type DataPoint, type ExtraCharges, type LocalTimeParams, type UsageSummary } from './energy';
import { isValidPlanTimelineEntry, type PlanTimelineEntry } from './planTimeline';
import { PLAN_STORAGE_KEY, PLAN_IDS, isPlanId } from '@/hooks/useSelectedPlan';
import {
  ENERGY_GAS_KEY,
  GAS_LOCAL_TIME_KEY,
  GAS_USAGE_SUMMARIES_KEY,
  LOCAL_TIME_KEY,
  USAGE_SUMMARIES_KEY,
  isGasStoredPayload,
  isReadableGasSummary,
  isReadableLocalTime,
  type GasStoredPayload,
} from './storage';

/**
 * The flag that marks the loaded readings as the bundled example set
 * (Wave H item 1). Declared HERE — not in `hooks/useDashboard.ts` — because
 * this module must be able to write it without importing the hook (which
 * imports this module: that would be a cycle). `useDashboard` re-exports it
 * so every existing import keeps working.
 */
export const EXAMPLE_DATA_KEY = 'energy_data_is_example';

/** Marker written into every export; Import refuses files without it. */
export const BACKUP_SCHEMA = 'ontario-energy-optimizer.backup';

/**
 * Schema version of THIS build. Bump when the payload shape changes:
 *   - additive/optional change → also accept the previous version explicitly.
 *   - breaking change          → readers reject older/newer versions loudly.
 *
 * History: v2 added `selected_plan` / `energy_data_is_example` (Wave N).
 * v3 (t_578268b7) adds the GAS section (`gas_data` + the two gas bill keys).
 * v4 (t_92755069) adds the ELECTRIC bill section (`usage_summaries` +
 * `local_time_parameters`).
 * The bump is not decoration: a v3 reader whitelists payload keys, so it
 * would parse a v4 file happily and silently drop every electric bill
 * period in it — the exact data loss this section exists to stop. Loud
 * refusal on an old build beats a quiet half-restore.
 */
export const BACKUP_VERSION = 4;

/**
 * Schema versions THIS build reads. An explicit set, not `<= BACKUP_VERSION`,
 * so the compatibility promise is testable in one place: v1 predates
 * `selected_plan` / `energy_data_is_example` and still restores, v2
 * predates the gas section and still restores, and v3 predates the electric
 * bill section and still restores (the file's own rule: "additive/optional
 * change → also accept the PREVIOUS version").
 */
export const SUPPORTED_BACKUP_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3, 4]);

const PLAN_IDS_FOR_ERROR = PLAN_IDS.map((id) => `"${id}"`).join(', ');

export type BackupPayload = {
  /**
   * The parsed Green Button rows (same shape localStorage.energy_data holds).
   * May be empty ONLY when this document carries a gas section — that is a
   * gas-only export, and `parseBackup` refuses an empty array anywhere else
   * (an empty restore is a trap).
   */
  energy_data: DataPoint[];
  /** Billing anchor day of month, 1..31. */
  billing_day: number;
  /** Local bill add-ons typed by the user (delivery / regulatory / HST). */
  extra_charges: ExtraCharges;
  /** The user's plan-type timeline (Wave P), when they have one. Optional:
   *  documents built before Wave P (or without entries) simply lack the key,
   *  and the reader treats its absence as an empty timeline. */
  plan_timeline?: PlanTimelineEntry[];
  /**
   * v2, additive: which plan the user had selected (Wave H).
   * Optional so a v1 document still parses — see `BACKUP_VERSION`.
   */
  selected_plan?: string;
  /**
   * v2, additive: whether these readings are the synthetic example set.
   * Optional for the same reason.
   */
  energy_data_is_example?: boolean;
  /**
   * v3, additive (t_578268b7): the gas readings under `energy_gas_v2` — the
   * FULL stored payload (envelope + points), not just the rows, so a restore
   * can reproduce the stored key byte-for-byte instead of re-stamping it as
   * a fresh import. Absent means "this export held no gas readings", and a
   * restore of such a document must leave this browser's gas data alone.
   */
  gas_data?: GasStoredPayload;
  /**
   * v3, additive: the gas billing periods under `gas_usage_summaries`, as
   * stored. Absent means "no gas bills to carry" — never "clear them".
   */
  gas_usage_summaries?: UsageSummary[];
  /**
   * v3, additive: the gas feed's clock rules under
   * `gas_local_time_parameters`, when one was declared.
   */
  gas_local_time_parameters?: LocalTimeParams;
  /**
   * v4, additive (t_92755069): the ELECTRICITY billing periods under
   * `usage_summaries`, as stored. Absent means "no electric bills to carry"
   * — never "clear them". Same rule as the gas pair: a document without the
   * section has no opinion about this browser's bills.
   */
  usage_summaries?: UsageSummary[];
  /**
   * v4, additive: the electric feed's clock rules under
   * `local_time_parameters`, when one was declared.
   */
  local_time_parameters?: LocalTimeParams;
};

export type BackupDocument = {
  schema: typeof BACKUP_SCHEMA;
  version: number;
  /** ISO-8601 instant the export was taken. */
  exportedAt: string;
  payload: BackupPayload;
};

export type BackupInput = {
  energyData: DataPoint[];
  billingDay: number;
  extraCharges?: ExtraCharges;
  /** Declared plan periods to carry across a restore. */
  planTimeline?: PlanTimelineEntry[];
  /** Wave N: restore must also restore the plan, not just the readings. */
  selectedPlan?: string;
  isExample?: boolean;
  /**
   * v3: the gas readings as a FULL stored payload (envelope + points).
   * Validated here too — "filter, don't trust" applies to storage as much as
   * to a file: a payload that is not a valid gas dataset is dropped rather
   * than written into a document the importer would then refuse.
   */
  gasData?: GasStoredPayload;
  /** v3: gas billing periods to carry across a restore. */
  gasSummaries?: UsageSummary[];
  /** v3: the gas clock rules, when the feed declared them. */
  gasLocalTime?: LocalTimeParams | null;
  /** v4: ELECTRIC billing periods to carry across a restore. */
  electricSummaries?: UsageSummary[];
  /** v4: the electric clock rules, when the feed declared them. */
  electricLocalTime?: LocalTimeParams | null;
  exportedAt?: Date;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Build the document an Export click writes to disk. */
export function buildBackupDocument(input: BackupInput): BackupDocument {
  // Filter, don't trust: storage is an external source as far as this
  // function is concerned, and a document with an invalid entry could never
  // be parsed back by its own importer.
  const planTimeline = (input.planTimeline ?? []).filter(isValidPlanTimelineEntry);
  const gasSummaries = (input.gasSummaries ?? []).filter(isReadableGasSummary);
  // The electric bill half (t_92755069): same readability filter, same
  // "only what this build can read back" rule as the gas pair.
  const electricSummaries = (input.electricSummaries ?? []).filter(isReadableGasSummary);
  // The gas payload is rebuilt field by field (the whitelist rule): only the
  // four fields this build writes survive, and the points are re-emitted in
  // GasPoint field order so the bytes a restore writes match the bytes the
  // export read.
  const gasData =
    input.gasData && isGasStoredPayload(input.gasData) && input.gasData.points.length > 0
      ? {
          version: input.gasData.version,
          uploadedAt: input.gasData.uploadedAt,
          source: input.gasData.source,
          points: input.gasData.points.map((p) => ({
            timestamp: p.timestamp,
            duration_s: p.duration_s,
            volume_m3: p.volume_m3,
          })),
        }
      : undefined;
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    payload: {
      energy_data: input.energyData.map((d) => ({ timestamp: d.timestamp, usage_kwh: d.usage_kwh })),
      billing_day: normalizeBillingDay(input.billingDay),
      extra_charges: whitelistCharges(input.extraCharges),
      ...(planTimeline.length > 0 ? { plan_timeline: planTimeline } : {}),
      // Only written when known: a caller that has no plan must not stamp
      // "TOU" onto a document that means "nothing was recorded".
      ...(isPlanId(input.selectedPlan) ? { selected_plan: input.selectedPlan } : {}),
      ...(typeof input.isExample === 'boolean' ? { energy_data_is_example: input.isExample } : {}),
      // v3 gas sections: ABSENT — not empty — when the export held none, so a
      // document that lacks a section can never be read as "clear the gas
      // data" (and a v1/v2 document restores without touching it at all).
      ...(gasData ? { gas_data: gasData } : {}),
      ...(gasSummaries.length > 0 ? { gas_usage_summaries: gasSummaries } : {}),
      ...(input.gasLocalTime && isReadableLocalTime(input.gasLocalTime)
        ? { gas_local_time_parameters: input.gasLocalTime }
        : {}),
      // v4 electric bill sections — the SAME absence rule, for the pair that
      // predates the gas feature: no bills to carry ⇒ no key at all, never an
      // empty array a restore could read as "delete the bills".
      ...(electricSummaries.length > 0 ? { usage_summaries: electricSummaries } : {}),
      ...(input.electricLocalTime && isReadableLocalTime(input.electricLocalTime)
        ? { local_time_parameters: input.electricLocalTime }
        : {}),
    },
  };
}

export function serializeBackup(doc: BackupDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** `energy-backup_2026-10-02.json` — ISO date keeps names sort-ordered. */
export function backupFilename(when: Date = new Date()): string {
  const iso = when.toISOString().slice(0, 10);
  return `energy-backup_${iso}.json`;
}

function normalizeBillingDay(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) return 1;
  return n;
}

/** Copy ONLY the four known charge fields, as strings. Everything else is dropped. */
function whitelistCharges(raw: unknown): ExtraCharges {
  const out: ExtraCharges = { ...EMPTY_EXTRA_CHARGES };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  // The four editable fields, by name — deliberately NOT `xmlSource`: an
  // imported file must never be able to claim provenance it did not earn,
  // and unknown keys never reach app state (prototype-pollution rule above).
  for (const key of EXTRA_CHARGE_FIELDS) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/**
 * Validate + normalize an imported file.
 *
 * Accepts only documents this build knows how to read end-to-end; every
 * rejection returns a message a first-time user can act on (what was wrong,
 * what was expected) rather than "invalid file".
 */
export function parseBackup(text: string): ParseResult<BackupDocument> {
  if (text.trim() === '') {
    return { ok: false, error: t('backup.errEmpty') };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: t('backup.errBadJson', { reason: e instanceof Error ? e.message : String(e) }),
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: t('backup.errNotBackup') };
  }

  const doc = raw as Record<string, unknown>;

  const schema = doc.schema;
  if (schema === undefined || schema === null) {
    return {
      ok: false,
      error: t('backup.errNoSchema', { expected: BACKUP_SCHEMA }),
    };
  }
  if (schema !== BACKUP_SCHEMA) {
    return {
      ok: false,
      error: t('backup.errWrongSchema', { schema: String(schema), expected: BACKUP_SCHEMA }),
    };
  }

  const version = doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: t('backup.errBadVersion', { got: JSON.stringify(version) }) };
  }
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      error: t('backup.errNewer', { version, max: BACKUP_VERSION }),
    };
  }
  if (!SUPPORTED_BACKUP_VERSIONS.has(version)) {
    // Explicit allow-list rather than "anything <= current": the file's own
    // rule is "additive/optional change → also accept the PREVIOUS version",
    // which means exactly {1, 2, 3, 4} for this build, not an open range. A hole
    // below v1 (corrupt, or a schema this repo never shipped) is rejected
    // with the same loudness as everything else here.
    return {
      ok: false,
      error: t('backup.errUnsupportedSchema', { version, max: BACKUP_VERSION }),
    };
  }

  const payload = doc.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: t('backup.errNoPayload') };
  }
  const p = payload as Record<string, unknown>;

  // Bill sections, parsed FIRST because they decide whether an empty
  // `energy_data` is a legitimate gas-only (or bills-only) export or the
  // empty-restore trap. Absent ⇒ absent: a v1/v2/v3 file simply has no
  // opinion about that half, and this reader must not invent one.
  const gasData = parseGasData(p.gas_data);
  if (!gasData.ok) return gasData;
  const gasSummaries = parseBillSummaries(p.gas_usage_summaries, 'gas');
  if (!gasSummaries.ok) return gasSummaries;
  const gasLocalTime = parseBillClock(p.gas_local_time_parameters, 'gas');
  if (!gasLocalTime.ok) return gasLocalTime;
  const hasGasSection = gasData.value !== undefined || (gasSummaries.value?.length ?? 0) > 0;
  const electricSummaries = parseBillSummaries(p.usage_summaries, 'electric');
  if (!electricSummaries.ok) return electricSummaries;
  const electricLocalTime = parseBillClock(p.local_time_parameters, 'electric');
  if (!electricLocalTime.ok) return electricLocalTime;
  const hasElectricBillSection = (electricSummaries.value?.length ?? 0) > 0;

  // Either commodity's section proves the document holds data — an electric
  // bills-only export has no `DataPoint`s at all, exactly like a gas-only one.
  const energyData = parseEnergyData(p.energy_data, hasGasSection || hasElectricBillSection);
  if (!energyData.ok) return energyData;

  let billingDay = 1;
  if (p.billing_day !== undefined && p.billing_day !== null) {
    const n = p.billing_day;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 31) {
      return { ok: false, error: t('backup.errBillingDay', { got: JSON.stringify(p.billing_day) }) };
    }
    billingDay = n;
  }

  const extraCharges = whitelistCharges(p.extra_charges);

  // plan_timeline is optional (Wave P) but STRICT when present: a restore is
  // not the place to silently drop the periods the user typed in. Absence
  // stays absence, so documents from before Wave P round-trip unchanged.
  let planTimeline: PlanTimelineEntry[] | undefined;
  if (p.plan_timeline !== undefined && p.plan_timeline !== null) {
    if (!Array.isArray(p.plan_timeline)) {
      return {
        ok: false,
        error: t('backup.errPlanTimeline', { got: describe(p.plan_timeline) }),
      };
    }
    planTimeline = [];
    for (let i = 0; i < p.plan_timeline.length; i++) {
      const candidate = p.plan_timeline[i];
      if (!isValidPlanTimelineEntry(candidate)) {
        return {
          ok: false,
          error:
            t('backup.errPlanEntry', { n: i + 1, got: JSON.stringify(candidate) }),
        };
      }
      planTimeline.push(candidate);
    }
  }

  // v2 fields: present ⇒ validated, absent ⇒ left absent (a v1 document
  // legitimately has no opinion about the selected plan).
  let selectedPlan: string | undefined;
  if (p.selected_plan !== undefined && p.selected_plan !== null) {
    if (!isPlanId(p.selected_plan)) {
      return {
        ok: false,
        error: t('backup.errSelectedPlan', {
          got: JSON.stringify(p.selected_plan),
          plans: PLAN_IDS_FOR_ERROR,
        }),
      };
    }
    selectedPlan = p.selected_plan;
  }

  let isExample: boolean | undefined;
  if (p.energy_data_is_example !== undefined && p.energy_data_is_example !== null) {
    if (typeof p.energy_data_is_example !== 'boolean') {
      return {
        ok: false,
        error: t('backup.errExampleFlag', { got: JSON.stringify(p.energy_data_is_example) }),
      };
    }
    isExample = p.energy_data_is_example;
  }

  return {
    ok: true,
    value: {
      schema: BACKUP_SCHEMA,
      version,
      exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : '',
      payload: {
        energy_data: energyData.value,
        billing_day: billingDay,
        extra_charges: extraCharges,
        ...(planTimeline ? { plan_timeline: planTimeline } : {}),
        ...(selectedPlan !== undefined ? { selected_plan: selectedPlan } : {}),
        ...(isExample !== undefined ? { energy_data_is_example: isExample } : {}),
        ...(gasData.value !== undefined ? { gas_data: gasData.value } : {}),
        ...(gasSummaries.value !== undefined && gasSummaries.value.length > 0
          ? { gas_usage_summaries: gasSummaries.value }
          : {}),
        ...(gasLocalTime.value !== undefined ? { gas_local_time_parameters: gasLocalTime.value } : {}),
        ...(electricSummaries.value !== undefined && electricSummaries.value.length > 0
          ? { usage_summaries: electricSummaries.value }
          : {}),
        ...(electricLocalTime.value !== undefined ? { local_time_parameters: electricLocalTime.value } : {}),
      },
    },
  };
}

/**
 * Strict row validation: every row must be a finite, non-negative reading.
 *
 * `allowEmpty` is true ONLY when the document already proved it carries data
 * — a non-empty gas section (t_578268b7, a gas-only export). Without one, an
 * empty array is still the trap it always was: an empty restore wipes data.
 */
function parseEnergyData(raw: unknown, allowEmpty: boolean): ParseResult<DataPoint[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: t('backup.errEnergyNotArray', { got: describe(raw) }) };
  }
  if (raw.length === 0) {
    if (allowEmpty) return { ok: true, value: [] };
    return { ok: false, error: t('backup.errNoReadings') };
  }
  const out: DataPoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: t('backup.errRowNotReading', { n: i + 1, got: describe(row) }) };
    }
    const { timestamp, usage_kwh } = row as Record<string, unknown>;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return { ok: false, error: t('backup.errRowTimestamp', { n: i + 1, got: JSON.stringify(timestamp) }) };
    }
    if (typeof usage_kwh !== 'number' || !Number.isFinite(usage_kwh) || usage_kwh < 0) {
      return { ok: false, error: t('backup.errRowUsage', { n: i + 1, got: JSON.stringify(usage_kwh) }) };
    }
    out.push({ timestamp, usage_kwh });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return { ok: true, value: out };
}

/**
 * The gas readings section: present ⇒ a full, valid `energy_gas_v2` payload
 * with at least one point; absent ⇒ `undefined` (no gas opinion).
 *
 * The payload is re-emitted field by field — the whitelist rule again: a
 * hostile file cannot smuggle extra fields into localStorage through this
 * import, and a valid payload keeps the canonical key order a byte-for-byte
 * restore depends on. An EMPTY gas payload is refused loudly rather than
 * treated as absence: a build that means "clear the gas data" must be argued
 * with, not guessed at by this reader.
 */
function parseGasData(raw: unknown): ParseResult<GasStoredPayload | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isGasStoredPayload(raw)) {
    return { ok: false, error: t('backup.errGasShape', { got: describe(raw) }) };
  }
  if (raw.points.length === 0) {
    return { ok: false, error: t('backup.errNoGasReadings') };
  }
  return {
    ok: true,
    value: {
      version: raw.version,
      uploadedAt: raw.uploadedAt,
      source: raw.source,
      points: raw.points.map((p) => ({
        timestamp: p.timestamp,
        duration_s: p.duration_s,
        volume_m3: p.volume_m3,
      })),
    },
  };
}

/**
 * A bill period list (gas or electric). Absent/null/empty all mean the same
 * thing — this document has no periods of THAT commodity to carry — because
 * an explicit empty array from a hand-edited file must not be readable as
 * "delete the bills on restore". Rows are checked with the SAME predicate
 * the exporter filters with, so anything a build of ours writes is
 * restorable by this reader and nothing the app's own reader would drop can
 * ride in.
 *
 * `commodity` only selects which FIELD NAME the error names: a message that
 * blames `gas_usage_summaries` for a malformed `usage_summaries` would send
 * the user looking at the wrong key.
 */
function parseBillSummaries(raw: unknown, commodity: 'gas' | 'electric'): ParseResult<UsageSummary[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        commodity === 'gas'
          ? t('backup.errGasSummaries', { got: describe(raw) })
          : t('backup.errElectricSummaries', { got: describe(raw) }),
    };
  }
  if (raw.length === 0) return { ok: true, value: undefined };
  const out: UsageSummary[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!isReadableGasSummary(raw[i])) {
      return {
        ok: false,
        error:
          commodity === 'gas'
            ? t('backup.errGasSummaryEntry', { n: i + 1, got: describe(raw[i]) })
            : t('backup.errElectricSummaryEntry', { n: i + 1, got: describe(raw[i]) }),
      };
    }
    // Passed through as stored: the row's own fields are the data, and a
    // restore must reproduce them exactly.
    out.push(raw[i] as UsageSummary);
  }
  return { ok: true, value: out };
}

/** A feed's clock rules (gas or electric). Absent stays absent; present must be readable. */
function parseBillClock(raw: unknown, commodity: 'gas' | 'electric'): ParseResult<LocalTimeParams | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isReadableLocalTime(raw)) {
    return {
      ok: false,
      error:
        commodity === 'gas'
          ? t('backup.errGasClock', { got: describe(raw) })
          : t('backup.errElectricClock', { got: describe(raw) }),
    };
  }
  return { ok: true, value: raw };
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/**
 * The exact localStorage writes an import performs — the same keys the app
 * already reads on boot, so a restore is indistinguishable from a re-upload.
 *
 * Every section follows one rule: ABSENT SECTION ⇒ NO OPINION (t_578268b7,
 * t_92755069). The electric profile is written only when the document
 * carries electric rows; the gas dataset only when it carries gas; the
 * electric bill feed only when it carries bill periods. A gas-only document
 * holds nothing but parseBackup's defaults for the electric fields
 * (billing_day and extra_charges are ALWAYS present in a parsed payload),
 * so writing them would reconfigure a configured browser's electric profile
 * while the readings — deliberately untouched — stayed put.
 */
export function storageValuesFromBackup(doc: BackupDocument): Record<string, string> {
  const values: Record<string, string> = {};
  if (doc.payload.energy_data.length > 0) {
    values.energy_data = JSON.stringify(doc.payload.energy_data);
    values.billing_day = String(doc.payload.billing_day);
    values.extra_charges = JSON.stringify(doc.payload.extra_charges);
    values.plan_timeline = JSON.stringify(doc.payload.plan_timeline ?? []);
    // The v2 key keeps its own rule INSIDE the gate: the plan is written only
    // when the document recorded one — a v1 backup has no opinion, so
    // restoring one must not silently re-plan the user's dashboard.
    if (doc.payload.selected_plan !== undefined) values[PLAN_STORAGE_KEY] = doc.payload.selected_plan;
    // The example flag is ALWAYS written for a document that carries rows,
    // even a v1 one that never recorded it: that restore replaces the
    // readings, and leaving a stale "these are demo numbers" banner over the
    // user's real restored readings would be a lie the app cannot detect
    // afterwards. The gate is what keeps a GAS-only restore from touching it
    // — that restore replaces nothing, so clearing the banner over surviving
    // demo rows would be the same lie in reverse.
    values[EXAMPLE_DATA_KEY] = doc.payload.energy_data_is_example === true ? '1' : '';
  }
  // v3 gas keys — the OPPOSITE rule from the flag above, and deliberately so:
  // written only when the document carries the section, never as a clear.
  // A v1/v2 backup (or an electricity-only export) has no gas opinion, so a
  // restore must leave whatever gas data this browser holds byte-identical.
  // `gas_usage_summaries: []` cannot reach here — parseBackup normalises an
  // empty array to absence — so there is no path from a document to an
  // accidental wipe of the bill periods.
  if (doc.payload.gas_data !== undefined) values[ENERGY_GAS_KEY] = JSON.stringify(doc.payload.gas_data);
  if (doc.payload.gas_usage_summaries !== undefined && doc.payload.gas_usage_summaries.length > 0) {
    values[GAS_USAGE_SUMMARIES_KEY] = JSON.stringify(doc.payload.gas_usage_summaries);
  }
  if (doc.payload.gas_local_time_parameters !== undefined) {
    values[GAS_LOCAL_TIME_KEY] = JSON.stringify(doc.payload.gas_local_time_parameters);
  }
  // v4 electric bill keys (t_92755069) — the same rule as the gas pair
  // above, for the feed that predates it: written ONLY when the document
  // carries the section. A v1/v2/v3 document (or a gas-only export) has no
  // electric-bill opinion, so restoring one must leave this browser's bill
  // periods and clock byte-identical. `usage_summaries: []` cannot reach
  // here — parseBackup normalises an empty array to absence — so no path
  // from a document to an accidental wipe of the bills exists.
  if (doc.payload.usage_summaries !== undefined && doc.payload.usage_summaries.length > 0) {
    values[USAGE_SUMMARIES_KEY] = JSON.stringify(doc.payload.usage_summaries);
  }
  if (doc.payload.local_time_parameters !== undefined) {
    values[LOCAL_TIME_KEY] = JSON.stringify(doc.payload.local_time_parameters);
  }
  return values;
}
