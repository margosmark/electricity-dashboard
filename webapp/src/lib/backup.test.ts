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
  SUPPORTED_BACKUP_VERSIONS,
  buildBackupDocument,
  serializeBackup,
  parseBackup,
  backupFilename,
  storageValuesFromBackup,
  type BackupDocument,
} from './backup';
import { EMPTY_EXTRA_CHARGES, type DataPoint, type LocalTimeParams, type UsageSummary } from './energy';
import { type PlanTimelineEntry } from './planTimeline';

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
  it('writes exactly the localStorage keys the app reads, and no others', () => {
    const doc: BackupDocument = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      extraCharges: { deliveryPerKwh: '0.05', deliveryFlat: '', regulatoryPerKwh: '', hstPct: '13' },
      selectedPlan: 'ULO',
      isExample: true,
    });
    const values = storageValuesFromBackup(doc);
    expect(Object.keys(values).sort()).toEqual([
      'billing_day',
      'energy_data',
      'energy_data_is_example',
      'extra_charges',
      'plan_timeline',
      'selected_plan',
    ]);
    expect(JSON.parse(values.energy_data)).toEqual(rows);
    expect(values.billing_day).toBe('7');
    expect(JSON.parse(values.extra_charges).deliveryPerKwh).toBe('0.05');
    expect(JSON.parse(values.plan_timeline)).toEqual([]);
    expect(values.selected_plan).toBe('ULO');
    expect(values.energy_data_is_example).toBe('1');
  });

  it('clears the example flag when the document says these are not demo numbers', () => {
    const doc = buildBackupDocument({ energyData: rows, billingDay: 1, isExample: false });
    const values = storageValuesFromBackup(doc);
    // Empty string = "remove this key" for the writer in useDashboard and in
    // lib/account/sync — a restored profile must not keep a stale banner.
    expect(values.energy_data_is_example).toBe('');
    expect(values.selected_plan).toBeUndefined();
  });
});

/* ------------------------------------------- plan timeline (Wave P) ------ */

describe('plan_timeline in the backup', () => {
  const timelineEntry: PlanTimelineEntry = {
    id: 'a1',
    plan: 'Tiered',
    from: '2024-11-25',
    to: '2025-03-24',
  };

  it('is carried through export → parse → localStorage writes', () => {
    const doc = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      planTimeline: [timelineEntry],
      exportedAt: new Date(0),
    });
    expect(doc.payload.plan_timeline).toEqual([timelineEntry]);

    const round = parseBackup(serializeBackup(doc));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.value.payload.plan_timeline).toEqual([timelineEntry]);

    const values = storageValuesFromBackup(round.value);
    expect(JSON.parse(values.plan_timeline)).toEqual([timelineEntry]);
  });

  it('is absent — not empty — in documents that predate the feature', () => {
    const doc = buildBackupDocument({ energyData: rows, billingDay: 7 });
    expect(doc.payload.plan_timeline).toBeUndefined();
    const round = parseBackup(serializeBackup(doc));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.value.payload.plan_timeline).toBeUndefined();
  });

  it('is dropped from the export when an entry is invalid (never unparseable)', () => {
    const doc = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      planTimeline: [timelineEntry, { id: 'bad', plan: 'Solar', from: '2024-01-01', to: '2024-02-01' }] as never,
    });
    expect(doc.payload.plan_timeline).toEqual([timelineEntry]);
    expect(parseBackup(serializeBackup(doc)).ok).toBe(true);
  });

  it('is rejected loudly — entry by entry — when an import is malformed', () => {
    const withBadEntry = valid({
      payload: {
        energy_data: rows,
        billing_day: 1,
        plan_timeline: [{ id: 'x', plan: 'Solar', from: '2024-01-01', to: '2024-02-01' }],
      },
    });
    const res = parseBackup(withBadEntry);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/plan_timeline entry 1/);

    const notArray = valid({
      payload: { energy_data: rows, billing_day: 1, plan_timeline: { a: 1 } },
    });
    const res2 = parseBackup(notArray);
    expect(res2.ok).toBe(false);
    if (res2.ok) return;
    expect(res2.error).toMatch(/invalid plan_timeline/);
  });

  it('round-trips a valid imported timeline unchanged', () => {
    const doc = valid({
      payload: { energy_data: rows, billing_day: 1, plan_timeline: [timelineEntry] },
    });
    const res = parseBackup(doc);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.plan_timeline).toEqual([timelineEntry]);
  });
});

/* ==========================================================================
 * Wave N — schema v2: additive fields, previous version still accepted
 * ========================================================================== */

describe('backup schema v2 (Wave N multi-device sync)', () => {
  it('stamps the current version and carries the selected plan + example flag', () => {
    const doc = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      selectedPlan: 'Tiered',
      isExample: true,
      exportedAt: new Date('2026-10-07T12:00:00Z'),
    });
    expect(doc.version).toBe(BACKUP_VERSION);
    expect(doc.payload.selected_plan).toBe('Tiered');
    expect(doc.payload.energy_data_is_example).toBe(true);
    const round = parseBackup(serializeBackup(doc));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.value.payload.selected_plan).toBe('Tiered');
    expect(round.value.payload.energy_data_is_example).toBe(true);
  });

  it('accepts a v1 document — the file\'s own additive rule', () => {
    const v1 = JSON.stringify({
      schema: BACKUP_SCHEMA,
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      payload: { energy_data: rows, billing_day: 3, extra_charges: EMPTY_EXTRA_CHARGES },
    });
    const res = parseBackup(v1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.version).toBe(1);
    // Absent means absent — a v1 file has no opinion, so it must not invent one.
    expect(res.value.payload.selected_plan).toBeUndefined();
    expect(res.value.payload.energy_data_is_example).toBeUndefined();
  });

  it('still refuses a newer schema version with an upgrade hint', () => {
    const res = parseBackup(valid({ version: BACKUP_VERSION + 1 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/newer version/i);
  });

  it('refuses a schema this repo never shipped', () => {
    const res = parseBackup(valid({ version: 0 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/version/i);
  });

  it('the allow-list is exactly what the reader promises — and covers THIS version', () => {
    // The guard that matters: bumping BACKUP_VERSION without adding the
    // version we just stopped writing would silently reject our own files,
    // so the reader's promise and the writer's stamp are asserted together.
    expect([...SUPPORTED_BACKUP_VERSIONS].sort()).toEqual([1, 2, 3, 4]);
    expect(SUPPORTED_BACKUP_VERSIONS.has(BACKUP_VERSION)).toBe(true);
    expect(SUPPORTED_BACKUP_VERSIONS.has(BACKUP_VERSION + 1)).toBe(false);
  });

  it('rejects a selected_plan that is not a plan id, instead of silently re-pricing', () => {
    const res = parseBackup(valid({ payload: { energy_data: rows, billing_day: 1, selected_plan: 'FREE' } }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/selected_plan/);
  });

  it('rejects a non-boolean example flag', () => {
    const res = parseBackup(
      valid({ payload: { energy_data: rows, billing_day: 1, energy_data_is_example: 'yes' } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/energy_data_is_example/);
  });

  it('still refuses unknown keys and prototype pollution', () => {
    const res = parseBackup(
      valid({
        payload: {
          energy_data: rows,
          billing_day: 1,
          selected_plan: 'TOU',
          __proto__: { polluted: true },
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/* ==========================================================================
 * v3 — the gas dataset rides the backup too (t_578268b7)
 * ========================================================================== */

const GAS_POINTS = [
  { timestamp: 1704067200, duration_s: 3600, volume_m3: 1.5 },
  { timestamp: 1704070800, duration_s: 3600, volume_m3: 0.75 },
];

const GAS_PAYLOAD = {
  version: 1,
  uploadedAt: '2026-11-01T00:00:00.000Z',
  source: 'gas-upload',
  points: GAS_POINTS,
};

const gasSummary = (start: number): UsageSummary => ({
  source: 'UsageSummary',
  start,
  duration: 2592000,
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  days: 31,
  billLastPeriod: null,
  billToDate: null,
  costAdditionalLastPeriod: null,
  currency: 124,
  consumption: null,
  volume: null,
  items: [],
});

const GAS_CLOCK: LocalTimeParams = {
  tzOffset: -18000,
  dstOffset: 3600,
  dstStartRule: '360E2000',
  dstEndRule: '360E2000',
};

describe('v3 gas section — build → parse → localStorage writes (t_578268b7)', () => {
  it('carries gas readings, bills and clock, byte for byte', () => {
    const doc = buildBackupDocument({
      energyData: [],
      billingDay: 7,
      gasData: GAS_PAYLOAD,
      gasSummaries: [gasSummary(1704067200), gasSummary(1704326400)],
      gasLocalTime: GAS_CLOCK,
      exportedAt: new Date('2026-11-12T00:00:00Z'),
    });
    // A gas-only document is legal — energy_data empty, but for a reason the
    // reader can verify rather than a trap it must guess at.
    expect(doc.payload.energy_data).toEqual([]);

    const round = parseBackup(serializeBackup(doc));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.value.payload.gas_data).toEqual(GAS_PAYLOAD);
    expect(round.value.payload.gas_usage_summaries).toHaveLength(2);
    expect(round.value.payload.gas_local_time_parameters).toEqual(GAS_CLOCK);

    const values = storageValuesFromBackup(round.value);
    // The three gas keys, byte-identical to what the export read.
    expect(values.energy_gas_v2).toBe(JSON.stringify(GAS_PAYLOAD));
    expect(values.gas_usage_summaries).toBe(
      JSON.stringify([gasSummary(1704067200), gasSummary(1704326400)]),
    );
    expect(values.gas_local_time_parameters).toBe(JSON.stringify(GAS_CLOCK));
    // A gas-only document has NO electric opinion: the electric writes are
    // absent entirely (not written-then-skipped — absent), so a restore
    // cannot reconfigure billing anchor, add-ons, plan, timeline or the
    // example flag on a browser whose readings it deliberately keeps.
    expect(Object.keys(values).sort()).toEqual([
      'energy_gas_v2',
      'gas_local_time_parameters',
      'gas_usage_summaries',
    ]);
    expect(values.billing_day).toBeUndefined();
    expect(values.extra_charges).toBeUndefined();
    expect(values.plan_timeline).toBeUndefined();
    expect(values.energy_data_is_example).toBeUndefined();
    expect(values.selected_plan).toBeUndefined();
    expect(values.energy_data).toBeUndefined();
  });

  it('accepts empty energy_data ONLY because a gas section proves the document holds data', () => {
    const withGas = parseBackup(
      valid({ payload: { energy_data: [], billing_day: 7, gas_data: GAS_PAYLOAD } }),
    );
    expect(withGas.ok).toBe(true);
    if (withGas.ok) expect(withGas.value.payload.energy_data).toEqual([]);

    const without = parseBackup(valid({ payload: { energy_data: [], billing_day: 1 } }));
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.error).toMatch(/no readings/i);
  });

  it('refuses a gas_data section that is not a valid payload, or one with no points', () => {
    const notPayload = parseBackup(
      valid({ payload: { energy_data: rows, billing_day: 1, gas_data: { points: 'nope' } } }),
    );
    expect(notPayload.ok).toBe(false);
    if (!notPayload.ok) expect(notPayload.error).toMatch(/gas_data/);

    const noPoints = parseBackup(
      valid({
        payload: {
          energy_data: rows,
          billing_day: 1,
          gas_data: { version: 1, uploadedAt: 'x', source: 'y', points: [] },
        },
      }),
    );
    expect(noPoints.ok).toBe(false);
    if (!noPoints.ok) expect(noPoints.error).toMatch(/gas section contains no readings/i);
  });

  it('refuses a gas bill row or clock it cannot read, naming it', () => {
    const badRow = parseBackup(
      valid({
        payload: {
          energy_data: [],
          billing_day: 1,
          gas_data: GAS_PAYLOAD,
          gas_usage_summaries: [gasSummary(1), 'not-a-period'],
        },
      }),
    );
    expect(badRow.ok).toBe(false);
    if (!badRow.ok) expect(badRow.error).toMatch(/entry 2/);

    const notArray = parseBackup(
      valid({
        payload: {
          energy_data: [],
          billing_day: 1,
          gas_data: GAS_PAYLOAD,
          gas_usage_summaries: { a: 1 },
        },
      }),
    );
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toMatch(/not an array/i);

    const badClock = parseBackup(
      valid({
        payload: {
          energy_data: [],
          billing_day: 1,
          gas_data: GAS_PAYLOAD,
          gas_local_time_parameters: { tzOffset: 'EST' },
        },
      }),
    );
    expect(badClock.ok).toBe(false);
    if (!badClock.ok) expect(badClock.error).toMatch(/gas_local_time_parameters/);
  });

  it('reads an explicit empty gas_usage_summaries as ABSENCE, never as "clear the bills"', () => {
    const res = parseBackup(
      valid({ payload: { energy_data: rows, billing_day: 1, gas_usage_summaries: [] } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.gas_usage_summaries).toBeUndefined();
    expect(storageValuesFromBackup(res.value).gas_usage_summaries).toBeUndefined();
  });

  it('writes no gas keys for an old (v2) document — restoring one leaves gas alone', () => {
    const res = parseBackup(valid({ version: 2, payload: { energy_data: rows, billing_day: 7 } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.version).toBe(2);
    const values = storageValuesFromBackup(res.value);
    expect(Object.keys(values)).not.toContain('energy_gas_v2');
    expect(Object.keys(values)).not.toContain('gas_usage_summaries');
    expect(Object.keys(values)).not.toContain('gas_local_time_parameters');
  });

  it('drops unknown fields inside gas_data — the whitelist rule reaches the gas section', () => {
    const hostile = valid({
      payload: { energy_data: rows, billing_day: 1, gas_data: { ...GAS_PAYLOAD, smuggled: 'x' } },
    });
    const res = parseBackup(hostile);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.gas_data).toBeDefined();
    expect(Object.keys(res.value.payload.gas_data!).sort()).toEqual([
      'points',
      'source',
      'uploadedAt',
      'version',
    ]);
  });
});


/* ==========================================================================
 * v4 — the ELECTRIC bill feed rides the backup too (t_92755069)
 * ========================================================================== */

const electricSummary = (start: number): UsageSummary => ({
  source: 'UsageSummary',
  start,
  duration: 2592000,
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  days: 31,
  billLastPeriod: 42.17,
  billToDate: 84.34,
  costAdditionalLastPeriod: null,
  currency: 124,
  consumption: { scaled: 612, value: 612, powerOfTenMultiplier: 0, uom: 53 },
  volume: null,
  items: [
    {
      note: 'Regulatory Fixed Charge',
      amount: 42.17,
      rawAmount: 4217,
      itemKind: 4,
      unitCost: null,
      measurement: null,
    },
  ],
});

const ELECTRIC_ROWS: UsageSummary[] = [electricSummary(1704067200), electricSummary(1704326400)];

const ELECTRIC_CLOCK: LocalTimeParams = {
  tzOffset: -18000,
  dstOffset: 3600,
  dstStartRule: '360E2000',
  dstEndRule: '360E2000',
};

describe('v4 electric bill section — build → parse → localStorage writes (t_92755069)', () => {
  it('carries the electric bill periods + clock byte for byte in a bills-only document', () => {
    const doc = buildBackupDocument({
      energyData: [],
      billingDay: 7,
      electricSummaries: ELECTRIC_ROWS,
      electricLocalTime: ELECTRIC_CLOCK,
      exportedAt: new Date('2026-11-12T00:00:00Z'),
    });
    // A bills-only document is legal — no readings at all, but for a reason
    // the reader can verify (the bill section) rather than a trap it guesses at.
    expect(doc.payload.energy_data).toEqual([]);
    expect(doc.payload.usage_summaries).toEqual(ELECTRIC_ROWS);

    const round = parseBackup(serializeBackup(doc));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.value.payload.usage_summaries).toEqual(ELECTRIC_ROWS);
    expect(round.value.payload.local_time_parameters).toEqual(ELECTRIC_CLOCK);

    const values = storageValuesFromBackup(round.value);
    // The two electric bill keys, byte-identical to what the export read…
    expect(values.usage_summaries).toBe(JSON.stringify(ELECTRIC_ROWS));
    expect(values.local_time_parameters).toBe(JSON.stringify(ELECTRIC_CLOCK));
    // …and NOTHING else: a bills-only document has no opinion about the
    // electric profile (readings, billing anchor, add-ons, plan, timeline,
    // example flag) any more than a gas-only one does.
    expect(Object.keys(values).sort()).toEqual(['local_time_parameters', 'usage_summaries']);
  });

  it('accepts empty energy_data ONLY because a bill section proves the document holds data', () => {
    const withBills = parseBackup(
      valid({ payload: { energy_data: [], billing_day: 7, usage_summaries: ELECTRIC_ROWS } }),
    );
    expect(withBills.ok).toBe(true);
    if (withBills.ok) expect(withBills.value.payload.energy_data).toEqual([]);

    const without = parseBackup(valid({ payload: { energy_data: [], billing_day: 1 } }));
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.error).toMatch(/no readings/i);
  });

  it('reads an explicit empty usage_summaries as ABSENCE, never as "clear the bills"', () => {
    const res = parseBackup(
      valid({ payload: { energy_data: rows, billing_day: 1, usage_summaries: [] } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.usage_summaries).toBeUndefined();
    expect(storageValuesFromBackup(res.value).usage_summaries).toBeUndefined();
  });

  it('writes no electric bill keys for an OLD (v1–v3) document — restoring one leaves bills alone', () => {
    for (const version of [1, 2, 3]) {
      const res = parseBackup(valid({ version, payload: { energy_data: rows, billing_day: 7 } }));
      expect(res.ok, `v${version} must still parse`).toBe(true);
      if (!res.ok) continue;
      const values = storageValuesFromBackup(res.value);
      expect(Object.keys(values), `v${version} must carry no bill opinion`).not.toContain(
        'usage_summaries',
      );
      expect(Object.keys(values)).not.toContain('local_time_parameters');
    }
  });

  it('refuses a bill row or clock it cannot read, naming the ELECTRIC field', () => {
    const badRow = parseBackup(
      valid({
        payload: {
          energy_data: [],
          billing_day: 1,
          usage_summaries: [electricSummary(1), 'not-a-period'],
        },
      }),
    );
    expect(badRow.ok).toBe(false);
    if (!badRow.ok) {
      expect(badRow.error).toMatch(/entry 2/);
      expect(badRow.error).toMatch(/usage_summaries/);
    }

    const notArray = parseBackup(
      valid({ payload: { energy_data: rows, billing_day: 1, usage_summaries: { a: 1 } } }),
    );
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) {
      expect(notArray.error).toMatch(/not an array/i);
      expect(notArray.error).toMatch(/usage_summaries/);
    }

    const badClock = parseBackup(
      valid({
        payload: { energy_data: rows, billing_day: 1, local_time_parameters: { tzOffset: 'EST' } },
      }),
    );
    expect(badClock.ok).toBe(false);
    if (!badClock.ok) expect(badClock.error).toMatch(/local_time_parameters/);
  });

  it('drops unreadable rows at export — what leaves is exactly what reads back', () => {
    const doc = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      electricSummaries: [electricSummary(1704067200), 'bad-row' as unknown as UsageSummary],
    });
    expect(doc.payload.usage_summaries).toEqual([electricSummary(1704067200)]);
    expect(parseBackup(serializeBackup(doc)).ok).toBe(true);
  });

  it('carries BOTH commodity sections in one document, untouched', () => {
    const doc = buildBackupDocument({
      energyData: rows,
      billingDay: 7,
      gasData: GAS_PAYLOAD,
      gasSummaries: [gasSummary(1704067200)],
      gasLocalTime: GAS_CLOCK,
      electricSummaries: ELECTRIC_ROWS,
      electricLocalTime: ELECTRIC_CLOCK,
      exportedAt: new Date('2026-11-12T00:00:00Z'),
    });
    const round = parseBackup(serializeBackup(doc));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    const values = storageValuesFromBackup(round.value);
    expect(values.usage_summaries).toBe(JSON.stringify(ELECTRIC_ROWS));
    expect(values.local_time_parameters).toBe(JSON.stringify(ELECTRIC_CLOCK));
    expect(values.gas_usage_summaries).toBe(JSON.stringify([gasSummary(1704067200)]));
    expect(values.gas_local_time_parameters).toBe(JSON.stringify(GAS_CLOCK));
    expect(values.energy_gas_v2).toBe(JSON.stringify(GAS_PAYLOAD));
    // The electric profile rides too: this document carries electric rows.
    expect(JSON.parse(values.energy_data)).toEqual(rows);
    expect(values.billing_day).toBe('7');
  });
});
