/**
 * The ingestion rewrite needed no storage migration — this file is the proof.
 *
 * `DataPoint` is still exactly `{ timestamp, usage_kwh }` (SECONDS, kWh): the
 * per-series unit, multiplier, interval duration, direction, quality and source
 * identity live on `ReadingSeries` / `UsagePointGroup.series`, NOT on the stored
 * rows. So a payload written by the previous build and one written by this
 * build have the same shape by construction, and v2 storage version, billing
 * summaries and meter selection are untouched.
 *
 * These tests exist so that "we did not need a migration" is a verified claim
 * rather than a recollection: if a future change ever adds a field to the
 * stored row, the first test fails and whoever made it has to say how old data
 * is migrated.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { parseGreenButtonFeed } from '@/lib/energy';
import {
  ENERGY_KEY_V2,
  LEGACY_ENERGY_KEY,
  SCHEMA_VERSION,
  loadEnergyData,
  saveEnergyData,
  buildPayload,
} from '@/lib/storage';
import { buildBackupDocument, parseBackup, BACKUP_SCHEMA } from '@/lib/backup';

const XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry><link rel="self" href="/ReadingType/1"/><link rel="related" href="/UsagePoint/up/MeterReading/mr"/><content><espi:ReadingType><espi:accumulationBehaviour>4</espi:accumulationBehaviour><espi:commodity>1</espi:commodity><espi:flowDirection>1</espi:flowDirection><espi:intervalLength>3600</espi:intervalLength><espi:kind>12</espi:kind><espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:uom>72</espi:uom></espi:ReadingType></content></entry>
  <entry><link rel="self" href="/UsagePoint/up/MeterReading/mr"/><link rel="related" href="/ReadingType/1"/><content><espi:MeterReading/></content></entry>
  <entry><link rel="self" href="/UsagePoint/up/MeterReading/mr/IntervalBlock/ib"/><content><espi:IntervalBlock>
    <espi:interval><espi:duration>3600</espi:duration><espi:start>1704067200</espi:start></espi:interval>
    <espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1704067200</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading>
  </espi:IntervalBlock></content></entry>
</feed>`;

function points(): { timestamp: number; usage_kwh: number }[] {
  return parseGreenButtonFeed(XML).groups[0].readings;
}

beforeEach(() => localStorage.clear());

describe('stored-row shape is unchanged by the series rewrite', () => {
  it('writes rows with exactly timestamp + usage_kwh, nothing else', () => {
    const rows = points();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['timestamp', 'usage_kwh']);
    expect(rows[0]).toEqual({ timestamp: 1704067200, usage_kwh: 1.5 });
  });

  it('keeps the v2 schema version, so no version bump (and no migration) is implied', () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(ENERGY_KEY_V2).toBe('energy_data_v2');
  });
});

describe('data written before the rewrite still loads unchanged', () => {
  it('loads a pre-existing v2 payload (plain two-key rows) with no rewrite', () => {
    const stored = buildPayload(
      [
        { timestamp: 1704067200, usage_kwh: 1.5 },
        { timestamp: 1704070800, usage_kwh: 2.25 },
      ],
      'Oakville Hydro (60-minute)',
      '2026-10-01T00:00:00.000Z',
    );
    localStorage.setItem(ENERGY_KEY_V2, JSON.stringify(stored));

    const loaded = loadEnergyData();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.points).toEqual(stored.points);
    expect(loaded.value?.source).toBe('Oakville Hydro (60-minute)');
    expect(loaded.value?.uploadedAt).toBe('2026-10-01T00:00:00.000Z');
    // Nothing was rewritten behind the user's back.
    expect(JSON.parse(localStorage.getItem(ENERGY_KEY_V2) as string)).toEqual(stored);
  });

  it('still migrates the v1 bare-array key into v2', () => {
    const legacy = [{ timestamp: 1704067200, usage_kwh: 1.5 }];
    localStorage.setItem(LEGACY_ENERGY_KEY, JSON.stringify(legacy));

    const loaded = loadEnergyData();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.points).toEqual(legacy);
    expect(localStorage.getItem(LEGACY_ENERGY_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(ENERGY_KEY_V2) as string).points).toEqual(legacy);
  });

  it('round-trips the new parser’s rows through save → load', () => {
    const rows = points();
    const saved = saveEnergyData(rows, { source: 'Green Button feed' });
    expect(saved.ok).toBe(true);

    const loaded = loadEnergyData();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value?.points).toEqual(rows);
    expect(loaded.value?.version).toBe(SCHEMA_VERSION);
  });

  it('round-trips the new parser’s rows through a backup export and import', () => {
    const rows = points();
    const doc = buildBackupDocument({ energyData: rows, billingDay: 1 });
    expect(doc.schema).toBe(BACKUP_SCHEMA);

    const parsed = parseBackup(JSON.stringify(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.payload.energy_data).toEqual(rows);
    expect(parsed.value.payload.billing_day).toBe(1);
  });
});
