/**
 * Wave G item 1 — localStorage backup/restore, tests first.
 *
 * The browser profile is the ONLY storage this app has (nothing is stored
 * server-side), so a cleared profile = total data loss. The backup document
 * is therefore a versioned, self-describing JSON file that round-trips
 * energy_data + billing_day + extra_charges, and that refuses — loudly —
 * anything it does not fully understand instead of importing half a payload.
 */

import { describe, it, expect } from 'vitest';
import {
  BACKUP_SCHEMA,
  BACKUP_VERSION,
  buildBackupDocument,
  serializeBackup,
  parseBackup,
  backupFilename,
  storageValuesFromBackup,
  type BackupDocument,
} from './backup';
import { EMPTY_EXTRA_CHARGES, type DataPoint } from './energy';

const rows: DataPoint[] = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.25 },
];

const valid = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: '2026-10-02T12:00:00.000Z',
    payload: {
      energy_data: rows,
      billing_day: 7,
      extra_charges: { deliveryPerKwh: '0.05', deliveryFlat: '', regulatoryPerKwh: '', hstPct: '13' },
    },
    ...overrides,
  });

describe('buildBackupDocument / serializeBackup', () => {
  it('stamps schema, version and exportedAt', () => {
    const doc = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      extraCharges: EMPTY_EXTRA_CHARGES,
      exportedAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    expect(doc.schema).toBe(BACKUP_SCHEMA);
    expect(doc.version).toBe(BACKUP_VERSION);
    expect(doc.exportedAt).toBe('2026-10-02T12:00:00.000Z');
    expect(doc.payload.energy_data).toEqual(rows);
    expect(doc.payload.billing_day).toBe(7);
  });

  it('defaults missing billing day / charges instead of writing undefined', () => {
    const doc = buildBackupDocument({ energyData: rows, billingDay: 1 });
    expect(doc.payload.billing_day).toBe(1);
    expect(doc.payload.extra_charges).toEqual(EMPTY_EXTRA_CHARGES);
  });

  it('serializes to parseable JSON (round-trip identity)', () => {
    const doc = buildBackupDocument({ energyData: rows, billingDay: 7, exportedAt: new Date(0) });
    expect(parseBackup(serializeBackup(doc))).toEqual({ ok: true, value: doc });
  });

  it('names the file with the export date, ISO-ordered', () => {
    expect(backupFilename(new Date('2026-10-02T12:00:00.000Z'))).toBe('energy-backup_2026-10-02.json');
  });
});

describe('parseBackup — happy path', () => {
  it('accepts a document this build produced', () => {
    const res = parseBackup(valid());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.energy_data).toEqual(rows);
    expect(res.value.payload.billing_day).toBe(7);
    expect(res.value.payload.extra_charges.hstPct).toBe('13');
  });

  it('defaults extra_charges when the field is absent', () => {
    const res = parseBackup(
      JSON.stringify({ schema: BACKUP_SCHEMA, version: 1, payload: { energy_data: rows, billing_day: 1 } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.extra_charges).toEqual(EMPTY_EXTRA_CHARGES);
  });
});

describe('parseBackup — schema versioning', () => {
  it('rejects a file that is not JSON at all', () => {
    const res = parseBackup('not json at all');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not valid JSON/i);
    expect(res.error).toMatch(/Export JSON/i);
  });

  it('rejects an empty file with a plain-language message', () => {
    const res = parseBackup('   ');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/empty/i);
  });

  it('rejects JSON that is not an object', () => {
    const res = parseBackup('[1,2,3]');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/backup/i);
  });

  it('rejects an object with no schema marker (any random JSON file)', () => {
    const res = parseBackup(JSON.stringify({ energy_data: rows, billing_day: 1 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(BACKUP_SCHEMA);
  });

  it('rejects a document from a different app', () => {
    const res = parseBackup(JSON.stringify({ schema: 'some.other.app', version: 1, payload: {} }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/some\.other\.app/);
    expect(res.error).toContain(BACKUP_SCHEMA);
  });

  it('rejects a NEWER schema version with an upgrade hint', () => {
    const res = parseBackup(valid({ version: BACKUP_VERSION + 1 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/newer version/i);
    expect(res.error).toMatch(String(BACKUP_VERSION));
  });

  it('rejects a non-integer / zero / negative version', () => {
    for (const version of ['1', 0, -1, 1.5, null]) {
      const res = parseBackup(valid({ version }));
      expect(res.ok, `version ${JSON.stringify(version)} must be rejected`).toBe(false);
    }
  });
});

describe('parseBackup — payload validation', () => {
  it('rejects a missing payload', () => {
    const res = parseBackup(JSON.stringify({ schema: BACKUP_SCHEMA, version: 1 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/payload/i);
  });

  it('rejects energy_data that is not an array', () => {
    const res = parseBackup(valid({ payload: { energy_data: { a: 1 }, billing_day: 1 } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/energy_data/i);
  });

  it('rejects empty energy_data (an empty restore is a trap)', () => {
    const res = parseBackup(valid({ payload: { energy_data: [], billing_day: 1 } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no readings/i);
  });

  it('rejects a row with a non-numeric timestamp, naming the row', () => {
    const res = parseBackup(
      valid({ payload: { energy_data: [rows[0], { timestamp: 'yesterday', usage_kwh: 1 }], billing_day: 1 } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/row 2/i);
    expect(res.error).toMatch(/timestamp/i);
  });

  it('rejects a row with a NaN/Infinity usage value', () => {
    const res = parseBackup(
      valid({ payload: { energy_data: [rows[0], { timestamp: 1, usage_kwh: Number.POSITIVE_INFINITY }], billing_day: 1 } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/row 2/i);
  });

  it('rejects a billing_day outside 1..31', () => {
    for (const billing_day of [0, 32, 7.5, '7']) {
      const res = parseBackup(valid({ payload: { energy_data: rows, billing_day } }));
      expect(res.ok, `billing_day ${JSON.stringify(billing_day)} must be rejected`).toBe(false);
    }
  });

  it('defaults billing_day when the field is absent', () => {
    const res = parseBackup(valid({ payload: { energy_data: rows } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.billing_day).toBe(1);
  });
});

describe('parseBackup — prototype pollution & unknown keys', () => {
  it('does not pollute Object.prototype from a hostile payload', () => {
    // Hand-written JSON: an object LITERAL with `__proto__` would set the
    // prototype instead of creating an own key, so it would never round-trip
    // through JSON.stringify. JSON.parse, however, DOES create an own
    // "__proto__" property from raw text — that is the attack surface.
    const hostile =
      `{"schema":"${BACKUP_SCHEMA}","version":1,"__proto__":{"polluted":"yes"},` +
      `"payload":{"energy_data":${JSON.stringify(rows)},"billing_day":1,` +
      `"extra_charges":{"hstPct":"13","__proto__":{"polluted":"yes"}},` +
      `"__proto__":{"polluted":"yes"}}}`;
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(hostile), '__proto__')).toBe(true); // the parse really does create the key
    const res = parseBackup(hostile);
    expect(res.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    if (!res.ok) return;
    // Only whitelisted charge keys survive.
    expect(Object.keys(res.value.payload.extra_charges).sort()).toEqual(
      Object.keys(EMPTY_EXTRA_CHARGES).sort(),
    );
  });

  it('never carries a "constructor.prototype" attack through import', () => {
    const hostile = JSON.stringify({
      schema: BACKUP_SCHEMA,
      version: 1,
      payload: {
        energy_data: rows,
        billing_day: 1,
        extra_charges: { constructor: { prototype: { polluted: 'yes' } }, hstPct: '13' },
      },
    });
    const res = parseBackup(hostile);
    expect(res.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (!res.ok) return;
    expect(Object.prototype.hasOwnProperty.call(res.value.payload.extra_charges, 'constructor')).toBe(false);
  });

  it('drops unknown top-level and payload keys instead of importing them', () => {
    const res = parseBackup(
      valid({
        evilTop: 'x',
        payload: { energy_data: rows, billing_day: 1, evilNested: 'y' },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.value).sort()).toEqual(['exportedAt', 'payload', 'schema', 'version']);
    expect(Object.keys(res.value.payload).sort()).toEqual(['billing_day', 'energy_data', 'extra_charges']);
  });

  it('ignores non-string charge values rather than storing garbage', () => {
    const res = parseBackup(
      valid({ payload: { energy_data: rows, billing_day: 1, extra_charges: { hstPct: 13, deliveryFlat: null } } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.extra_charges).toEqual(EMPTY_EXTRA_CHARGES);
  });
});

describe('storageValuesFromBackup', () => {
  it('writes exactly the three localStorage keys the app reads', () => {
    const doc: BackupDocument = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      extraCharges: { deliveryPerKwh: '0.05', deliveryFlat: '', regulatoryPerKwh: '', hstPct: '13' },
    });
    const values = storageValuesFromBackup(doc);
    expect(Object.keys(values).sort()).toEqual(['billing_day', 'energy_data', 'extra_charges']);
    expect(JSON.parse(values.energy_data)).toEqual(rows);
    expect(values.billing_day).toBe('7');
    expect(JSON.parse(values.extra_charges).deliveryPerKwh).toBe('0.05');
  });
});
