/**
 * Wave J — the numbers behind the "never overwrite without a merge review"
 * promise on /import.
 *
 * These are the assertions that make the prompt trustworthy: whatever the
 * review claims, the write must produce.
 */

import { describe, expect, it } from 'vitest';
import type { DataPoint } from '@/lib/energy';
import {
  decodeImportPayload,
  mergeForWrite,
  planImport,
  readStoredRows,
} from '@/lib/importPlan';

const H = 3600;
const at = (hour: number, kwh: number): DataPoint => ({
  // Fixed instant so the suite never depends on the machine's timezone.
  timestamp: Date.UTC(2026, 8, 1, hour) / 1000,
  usage_kwh: kwh,
});

const XML = '<?xml version="1.0"?><feed><entry><IntervalReading /></entry></feed>';

describe('decodeImportPayload', () => {
  it('passes raw XML straight through', () => {
    const out = decodeImportPayload(`\n  ${XML}\n`);
    expect(out).toEqual({ ok: true, text: XML });
  });

  it('accepts base64 of the same document', () => {
    const b64 = Buffer.from(XML, 'utf8').toString('base64');
    const out = decodeImportPayload(b64);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe(XML);
  });

  it('accepts base64 wrapped in whitespace (a terminal paste)', () => {
    const b64 = Buffer.from(XML, 'utf8').toString('base64');
    const wrapped = b64.replace(/(.{60})/g, '$1\n');
    const out = decodeImportPayload(wrapped);
    expect(out.ok).toBe(true);
  });

  it('rejects an empty payload with an actionable message', () => {
    const out = decodeImportPayload('   ');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Nothing to import/);
  });

  it('rejects text that is neither XML nor base64', () => {
    const out = decodeImportPayload('hello world, not base64!!');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/neither an XML export nor base64/);
  });

  it('rejects base64 that decodes to something that is not XML', () => {
    const out = decodeImportPayload(Buffer.from('just some text', 'utf8').toString('base64'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/not an XML document/);
  });
});

describe('planImport', () => {
  it('reports a plain first import', () => {
    const plan = planImport([], [at(0, 1), at(1, 2)]);
    expect(plan.existingRows).toBe(0);
    expect(plan.incomingRows).toBe(2);
    expect(plan.addedRows).toBe(2);
    expect(plan.overlapRows).toBe(0);
    expect(plan.mergeRows).toBe(2);
    expect(plan.replaceRows).toBe(2);
    expect(plan.identical).toBe(false);
  });

  it('counts overlap and net-new rows', () => {
    const existing = [at(0, 1), at(1, 2), at(2, 3)];
    const incoming = [at(1, 9), at(2, 9), at(3, 4), at(4, 5)];
    const plan = planImport(existing, incoming);
    expect(plan.existingRows).toBe(3);
    expect(plan.incomingRows).toBe(4);
    expect(plan.overlapRows).toBe(2);
    expect(plan.addedRows).toBe(2);
    expect(plan.mergeRows).toBe(5); // 3 stored + 2 genuinely new
    expect(plan.replaceRows).toBe(4);
    expect(plan.identical).toBe(false);
  });

  it('flags an identical re-import (a refresh that changed nothing)', () => {
    const rows = [at(0, 1), at(1, 2)];
    const plan = planImport(rows, rows);
    expect(plan.identical).toBe(true);
    expect(plan.addedRows).toBe(0);
    expect(plan.mergeRows).toBe(2);
    expect(plan.replaceRows).toBe(2);
  });

  it('handles a refresh that only covers part of the stored history', () => {
    // 48 raw rows over 24 distinct hours — storage can hold duplicates from
    // an earlier merge, and the plan reports them honestly.
    const existing = Array.from({ length: 48 }, (_, i) => at(i % 24, i));
    const incoming = [at(10, 1), at(11, 2)];
    const plan = planImport(existing, incoming);
    expect(plan.existingRows).toBe(48);
    expect(plan.addedRows).toBe(0);
    expect(plan.mergeRows).toBe(24); // one row per distinct timestamp
    expect(plan.replaceRows).toBe(2);
    expect(plan.identical).toBe(false);
    expect(plan.existingLast).toBe('2026-09-01');
  });

  it('dedupes rows inside a single source', () => {
    const plan = planImport([], [at(0, 1), at(0, 2), at(1, 3)]);
    expect(plan.incomingRows).toBe(3); // raw
    expect(plan.replaceRows).toBe(2); // unique timestamps
    expect(plan.mergeRows).toBe(2);
  });
});

describe('mergeForWrite', () => {
  it('keeps stored rows the file does not cover', () => {
    const existing = [at(0, 1), at(1, 2)];
    const incoming = [at(1, 99)];
    expect(mergeForWrite(existing, incoming)).toEqual([at(0, 1), at(1, 99)]);
  });

  it('lets the incoming export win an overlapping timestamp', () => {
    // A late utility restatement must land, not be silently dropped.
    const existing = [at(5, 111)];
    const incoming = [at(5, 222)];
    expect(mergeForWrite(existing, incoming)[0].usage_kwh).toBe(222);
  });

  it('returns rows sorted ascending (the documented energy_data order)', () => {
    const merged = mergeForWrite([at(3, 1), at(1, 1)], [at(2, 1), at(0, 1)]);
    expect(merged.map((r) => r.timestamp)).toEqual(
      [0, 1, 2, 3].map((h) => Date.UTC(2026, 8, 1, h) / 1000),
    );
  });

  it('is idempotent — importing the same file twice changes nothing', () => {
    const incoming = [at(0, 1), at(1, 2), at(2, 3)];
    const once = mergeForWrite([], incoming);
    const twice = mergeForWrite(once, incoming);
    expect(twice).toEqual(once);
  });

  it('preserves hour spacing across a day boundary', () => {
    const existing = [at(23, 1)];
    const incoming = [{ ...at(0, 2), timestamp: at(23, 1).timestamp + H }];
    expect(mergeForWrite(existing, incoming).map((r) => r.usage_kwh)).toEqual([1, 2]);
  });
});

describe('readStoredRows', () => {
  it('reads a healthy payload', () => {
    expect(readStoredRows(JSON.stringify([at(0, 1)]))).toEqual([at(0, 1)]);
  });

  it('returns [] for a missing or corrupt value', () => {
    expect(readStoredRows(null)).toEqual([]);
    expect(readStoredRows('{not json')).toEqual([]);
    expect(readStoredRows('"a string"')).toEqual([]);
    expect(readStoredRows('{"0":1}')).toEqual([]);
  });

  it('drops malformed rows instead of trusting the whole array', () => {
    const rows = readStoredRows(
      JSON.stringify([
        at(0, 1),
        { timestamp: 'yesterday', usage_kwh: 1 },
        { timestamp: 5, usage_kwh: -3 },
        { timestamp: 6, usage_kwh: Number.NaN },
        null,
        'row',
        at(1, 2),
      ]),
    );
    expect(rows).toEqual([at(0, 1), at(1, 2)]);
  });
});
