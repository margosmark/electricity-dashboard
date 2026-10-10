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
import { EMPTY_EXTRA_CHARGES, EXTRA_CHARGE_FIELDS, type DataPoint, type ExtraCharges } from './energy';
import { isValidPlanTimelineEntry, type PlanTimelineEntry } from './planTimeline';

/** Marker written into every export; Import refuses files without it. */
export const BACKUP_SCHEMA = 'ontario-energy-optimizer.backup';

/**
 * Schema version of THIS build. Bump when the payload shape changes:
 *   - additive/optional change → also accept the previous version explicitly.
 *   - breaking change          → readers reject older/newer versions loudly.
 */
export const BACKUP_VERSION = 1;

export type BackupPayload = {
  /** The parsed Green Button rows (same shape localStorage.energy_data holds). */
  energy_data: DataPoint[];
  /** Billing anchor day of month, 1..31. */
  billing_day: number;
  /** Local bill add-ons typed by the user (delivery / regulatory / HST). */
  extra_charges: ExtraCharges;
  /** The user's plan-type timeline (Wave P), when they have one. Optional:
   *  documents built before Wave P (or without entries) simply lack the key,
   *  and the reader treats its absence as an empty timeline. */
  plan_timeline?: PlanTimelineEntry[];
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
  exportedAt?: Date;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Build the document an Export click writes to disk. */
export function buildBackupDocument(input: BackupInput): BackupDocument {
  // Filter, don't trust: storage is an external source as far as this
  // function is concerned, and a document with an invalid entry could never
  // be parsed back by its own importer.
  const planTimeline = (input.planTimeline ?? []).filter(isValidPlanTimelineEntry);
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    payload: {
      energy_data: input.energyData.map((d) => ({ timestamp: d.timestamp, usage_kwh: d.usage_kwh })),
      billing_day: normalizeBillingDay(input.billingDay),
      extra_charges: whitelistCharges(input.extraCharges),
      ...(planTimeline.length > 0 ? { plan_timeline: planTimeline } : {}),
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
  if (version < BACKUP_VERSION) {
    // v1 is the first schema; anything older cannot exist. Kept explicit so a
    // future v2 build has an obvious place to add the migration shim.
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

  const energyData = parseEnergyData(p.energy_data);
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
      },
    },
  };
}

/** Strict row validation: every row must be a finite, non-negative reading. */
function parseEnergyData(raw: unknown): ParseResult<DataPoint[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: t('backup.errEnergyNotArray', { got: describe(raw) }) };
  }
  if (raw.length === 0) {
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

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

/**
 * The exact localStorage writes an import performs — the same keys the app
 * already reads on boot (readings, billing day, bill add-ons, and the Wave P
 * plan timeline), so a restore is indistinguishable from a re-upload.
 */
export function storageValuesFromBackup(doc: BackupDocument): Record<string, string> {
  return {
    energy_data: JSON.stringify(doc.payload.energy_data),
    billing_day: String(doc.payload.billing_day),
    extra_charges: JSON.stringify(doc.payload.extra_charges),
    plan_timeline: JSON.stringify(doc.payload.plan_timeline ?? []),
  };
}
