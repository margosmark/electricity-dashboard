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
import { beforeEach, describe, expect, it } from 'vitest';

import { parseGreenButtonFeed, type UsagePointGroup, type UsageSummary } from '@/lib/energy';
import { isGasFeed } from '@/lib/gasBillUi';
import { countUsableRows, readStoredBillFeed, readStoredGasBillFeed, USAGE_SUMMARIES_KEY } from './useDashboard';

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

/* ==========================================================================
 * readStoredBillFeed — summaries stored BEFORE the gas wave (ERR-4887C2)
 * ========================================================================== */

/** The electric fixture as pre-wave storage held it: every field but `volume`. */
const storedWithoutVolume = (): UsageSummary[] =>
  parseGreenButtonFeed(read('usage-summary-synthetic.xml')).summaries.map((s) => {
    const legacy: Record<string, unknown> = { ...s };
    delete legacy.volume;
    return legacy as unknown as UsageSummary;
  });

describe('readStoredBillFeed — legacy summaries with no `volume` key', () => {
  beforeEach(() => localStorage.clear());

  it('honours the type on read: a missing key comes back null, not undefined', () => {
    const stored = storedWithoutVolume();
    expect(stored.length).toBeGreaterThan(0);
    expect('volume' in stored[0]).toBe(false); // the shape storage really holds
    localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(stored));

    const feed = readStoredBillFeed();
    expect(feed.summaries).toHaveLength(stored.length);
    expect(feed.summaries.every((s) => s.volume === null)).toBe(true);
    expect(feed.summaries.some((s) => s.volume === undefined)).toBe(false);
  });

  it('the summary itself survives the read (only the type is repaired)', () => {
    const stored = storedWithoutVolume();
    localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(stored));

    const feed = readStoredBillFeed();
    expect(feed.summaries.map((s) => s.start)).toEqual(stored.map((s) => s.start));
    expect(feed.summaries.map((s) => s.items.length)).toEqual(
      stored.map((s) => s.items.length),
    );
    // Recognition over what storage returned must not throw — this is the
    // crash path (summaries.some(isGasSummary)) that took the dashboard down.
    expect(() => isGasFeed(feed.summaries)).not.toThrow();
    expect(isGasFeed(feed.summaries)).toBe(false);
  });

  it('a stored gas feed (parser-written, volume present) is unchanged', () => {
    // A browser written BEFORE the commodity split holds gas periods in the
    // legacy `usage_summaries` key. The read-side partition must surface them
    // on the gas side untouched — nothing dropped, nothing re-typed.
    const gas = parseGreenButtonFeed(read('enbridge-gas-synthetic.xml')).summaries;
    localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(gas));

    const gasFeed = readStoredGasBillFeed();
    expect(gasFeed.summaries).toHaveLength(gas.length);
    expect(gasFeed.summaries.every((s) => s.volume !== null)).toBe(true);
    expect(isGasFeed(gasFeed.summaries)).toBe(true);

    // The electric view reads the same bytes as EMPTY, not as a gas feed:
    // `volume != null` is not the discriminator, and no m³ may surface where
    // kWh is priced.
    const electric = readStoredBillFeed();
    expect(electric.summaries).toHaveLength(0);
    expect(isGasFeed(electric.summaries)).toBe(false);
  });
});
