/**
 * The import gate for commodity-7 documents (DoD 1: the Enbridge usage file
 * alone must import). `countUsableRows` is the acceptance: a gas extract has
 * ZERO electric DataPoints — its data is the volume series + the billing
 * summaries — so gating on `g.readings` alone rejected every gas file with
 * "produced no readable rows" after a successful parse.
 *
 * FIXTURE POLICY: SYNTHETIC only (tests/fixtures/ — see README there).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseGreenButtonFeed, type UsagePointGroup } from '@/lib/energy';
import { countUsableRows } from './useDashboard';

const read = (name: string): string =>
  readFileSync(join(__dirname, '../../tests/fixtures', name), 'utf8');

const electricReadings = (gs: UsagePointGroup[]): number =>
  gs.reduce((n, g) => n + g.readings.length, 0);

describe('countUsableRows — what the import gate may count', () => {
  it('accepts the Enbridge gas extract: 5 volume rows, 0 electric rows', () => {
    const feed = parseGreenButtonFeed(read('enbridge-gas-synthetic.xml'));
    expect(electricReadings(feed.groups)).toBe(0); // why the old gate refused
    expect(countUsableRows(feed.groups)).toBe(5); // the five IntervalBlocks
  });

  it('counts exactly what it always counted for an electric export', () => {
    const feed = parseGreenButtonFeed(read('green-button-alliance-sample.xml'));
    expect(electricReadings(feed.groups)).toBeGreaterThan(0);
    expect(countUsableRows(feed.groups)).toBe(electricReadings(feed.groups));
  });

  it('a document with nothing usable still reads 0 (refusal path intact)', () => {
    expect(countUsableRows([])).toBe(0);
    const feed = parseGreenButtonFeed(read('enbridge-gas-synthetic.xml'));
    // Stripping the series leaves only summaries — no rows to chart.
    const stripped = feed.groups.map((g) => ({ ...g, series: [] }));
    expect(countUsableRows(stripped)).toBe(0);
  });
});
