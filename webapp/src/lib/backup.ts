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

import { EMPTY_EXTRA_CHARGES, EXTRA_CHARGE_FIELDS, type DataPoint, type ExtraCharges } from './energy';
import { PLAN_STORAGE_KEY, PLAN_IDS, isPlanId } from '@/hooks/useSelectedPlan';

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
 */
export const BACKUP_VERSION = 2;

/**
 * Schema versions THIS build reads. An explicit set, not `<= BACKUP_VERSION`,
 * so the compatibility promise is testable in one place: v1 predates
 * `selected_plan` / `energy_data_is_example` and still restores (the file's
 * own rule: "additive/optional change → also accept the previous version").
 */
export const SUPPORTED_BACKUP_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

const PLAN_IDS_FOR_ERROR = PLAN_IDS.map((id) => `"${id}"`).join(', ');

export type BackupPayload = {
  /** The parsed Green Button rows (same shape localStorage.energy_data holds). */
  energy_data: DataPoint[];
  /** Billing anchor day of month, 1..31. */
  billing_day: number;
  /** Local bill add-ons typed by the user (delivery / regulatory / HST). */
  extra_charges: ExtraCharges;
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
  /** Wave N: restore must also restore the plan, not just the readings. */
  selectedPlan?: string;
  isExample?: boolean;
  exportedAt?: Date;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Build the document an Export click writes to disk. */
export function buildBackupDocument(input: BackupInput): BackupDocument {
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    payload: {
      energy_data: input.energyData.map((d) => ({ timestamp: d.timestamp, usage_kwh: d.usage_kwh })),
      billing_day: normalizeBillingDay(input.billingDay),
      extra_charges: whitelistCharges(input.extraCharges),
      // Only written when known: a caller that has no plan must not stamp
      // "TOU" onto a document that means "nothing was recorded".
      ...(isPlanId(input.selectedPlan) ? { selected_plan: input.selectedPlan } : {}),
      ...(typeof input.isExample === 'boolean' ? { energy_data_is_example: input.isExample } : {}),
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
    return { ok: false, error: 'That file is empty. Choose a file produced by “Export JSON”.' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: `That file is not valid JSON (${e instanceof Error ? e.message : String(e)}). Choose a file produced by “Export JSON”.`,
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'That file is not an energy-dashboard backup (expected a JSON object).' };
  }

  const doc = raw as Record<string, unknown>;

  const schema = doc.schema;
  if (schema === undefined || schema === null) {
    return {
      ok: false,
      error: `That file has no "schema" marker, so it is not an energy-dashboard backup. Expected "${BACKUP_SCHEMA}".`,
    };
  }
  if (schema !== BACKUP_SCHEMA) {
    return {
      ok: false,
      error: `That file belongs to a different app: its schema is "${String(schema)}", expected "${BACKUP_SCHEMA}".`,
    };
  }

  const version = doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: `That backup has a missing or invalid "version" (got ${JSON.stringify(version)}).` };
  }
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      error:
        `This backup was created by a newer version of the app (schema v${version}; this build understands up to v${BACKUP_VERSION}). ` +
        'Update the app, then try the import again.',
    };
  }
  if (!SUPPORTED_BACKUP_VERSIONS.has(version)) {
    // Explicit allow-list rather than "anything <= current": the file's own
    // rule is "additive/optional change → also accept the PREVIOUS version",
    // which means exactly {1, 2} for this build, not an open range. A hole
    // below v1 (corrupt, or a schema this repo never shipped) is rejected
    // with the same loudness as everything else here.
    return {
      ok: false,
      error: `That backup uses schema v${version}, which this build does not support (it reads v${[...SUPPORTED_BACKUP_VERSIONS].join(' and v')}).`,
    };
  }

  const payload = doc.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'That backup has no "payload" object — nothing to restore.' };
  }
  const p = payload as Record<string, unknown>;

  const energyData = parseEnergyData(p.energy_data);
  if (!energyData.ok) return energyData;

  let billingDay = 1;
  if (p.billing_day !== undefined && p.billing_day !== null) {
    const n = p.billing_day;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 31) {
      return { ok: false, error: `That backup has an invalid billing_day (got ${JSON.stringify(p.billing_day)}, expected an integer 1–31).` };
    }
    billingDay = n;
  }

  const extraCharges = whitelistCharges(p.extra_charges);

  // v2 fields: present ⇒ validated, absent ⇒ left absent (a v1 document
  // legitimately has no opinion about the selected plan).
  let selectedPlan: string | undefined;
  if (p.selected_plan !== undefined && p.selected_plan !== null) {
    if (!isPlanId(p.selected_plan)) {
      return {
        ok: false,
        error: `That backup has an invalid selected_plan (${JSON.stringify(p.selected_plan)}), expected one of ${PLAN_IDS_FOR_ERROR}.`,
      };
    }
    selectedPlan = p.selected_plan;
  }

  let isExample: boolean | undefined;
  if (p.energy_data_is_example !== undefined && p.energy_data_is_example !== null) {
    if (typeof p.energy_data_is_example !== 'boolean') {
      return {
        ok: false,
        error: `That backup has an invalid energy_data_is_example (got ${JSON.stringify(p.energy_data_is_example)}, expected true or false).`,
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
        ...(selectedPlan !== undefined ? { selected_plan: selectedPlan } : {}),
        ...(isExample !== undefined ? { energy_data_is_example: isExample } : {}),
      },
    },
  };
}

/** Strict row validation: every row must be a finite, non-negative reading. */
function parseEnergyData(raw: unknown): ParseResult<DataPoint[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `That backup's energy_data is not an array (got ${describe(raw)}).` };
  }
  if (raw.length === 0) {
    return { ok: false, error: 'That backup contains no readings — restoring it would wipe your data.' };
  }
  const out: DataPoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: `Row ${i + 1} of the backup is not a reading object (got ${describe(row)}).` };
    }
    const { timestamp, usage_kwh } = row as Record<string, unknown>;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return { ok: false, error: `Row ${i + 1} has an invalid timestamp (got ${JSON.stringify(timestamp)}).` };
    }
    if (typeof usage_kwh !== 'number' || !Number.isFinite(usage_kwh) || usage_kwh < 0) {
      return { ok: false, error: `Row ${i + 1} has an invalid usage_kwh (got ${JSON.stringify(usage_kwh)}).` };
    }
    out.push({ timestamp, usage_kwh });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return { ok: true, value: out };
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/**
 * The exact localStorage writes an import performs — same three keys the app
 * already reads on boot, so a restore is indistinguishable from a re-upload.
 */
export function storageValuesFromBackup(doc: BackupDocument): Record<string, string> {
  const values: Record<string, string> = {
    energy_data: JSON.stringify(doc.payload.energy_data),
    billing_day: String(doc.payload.billing_day),
    extra_charges: JSON.stringify(doc.payload.extra_charges),
  };
  // The two v2 keys are written ONLY when the document carries them: a v1
  // backup has no opinion, so restoring one must not silently re-plan the
  // user's dashboard or clear the example-data banner.
  if (doc.payload.selected_plan !== undefined) values[PLAN_STORAGE_KEY] = doc.payload.selected_plan;
  // The example flag is ALWAYS written, even for a v1 document that never
  // recorded one: a restore replaces the whole profile, and leaving a stale
  // "these are demo numbers" banner over the user's real restored readings
  // would be a lie the app has no way to detect afterwards.
  values[EXAMPLE_DATA_KEY] = doc.payload.energy_data_is_example === true ? '1' : '';
  return values;
}
