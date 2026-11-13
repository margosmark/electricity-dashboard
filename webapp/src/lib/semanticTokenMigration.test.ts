import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEBAPP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const INVENTORY = JSON.parse(
  fs.readFileSync(path.join(WEBAPP, 'evidence/semantic-token-inventory.json'), 'utf8'),
) as {
  counts: { tracked_source_occurrences: number; text_white: number };
  occurrences: Array<{ file: string; occurrence: string }>;
  migration_report: {
    status: string;
    baseline_occurrences: number;
    live_baseline_occurrences_remaining: number;
    p4_decision: string;
    p4_mechanical_assertion: string;
    exceptions: string[];
  };
};

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('semantic token migration inventory', () => {
  it('tracks every baseline occurrence and has no live hard-coded source matches', () => {
    expect(INVENTORY.occurrences).toHaveLength(INVENTORY.counts.tracked_source_occurrences);
    expect(INVENTORY.migration_report.status).toBe('migrated');
    expect(INVENTORY.migration_report.baseline_occurrences).toBe(INVENTORY.occurrences.length);
    expect(INVENTORY.migration_report.live_baseline_occurrences_remaining).toBe(0);
    expect(INVENTORY.migration_report.p4_decision).toBe('deferred—not mapped to a safe current chart');
    expect(INVENTORY.migration_report.p4_mechanical_assertion).toBe('not included in this candidate/QA gate');
    expect(INVENTORY.migration_report.exceptions).toEqual([]);

    const files = new Map<string, string>();
    const remaining: string[] = [];
    for (const item of INVENTORY.occurrences) {
      const file = path.join(WEBAPP, item.file.replace(/^webapp\//, ''));
      let source = files.get(file);
      if (source === undefined) {
        source = stripComments(fs.readFileSync(file, 'utf8'));
        files.set(file, source);
      }
      if (source.includes(item.occurrence)) remaining.push(`${item.file}: ${item.occurrence}`);
    }
    expect(remaining).toEqual([]);
  });
});
