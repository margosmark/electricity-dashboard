/**
 * Reproduction probe (t_8a9038d6): what does each commodity's parse and each
 * upload ORDER actually leave in browser storage on today's main?
 *
 * SYNTHETIC FIXTURES ONLY — tests/fixtures/ (never real utility documents).
 * Run: npx vitest run src/hooks/commodityProbe.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { parseGreenButtonFeed } from '@/lib/energy';
import { enrichGasSummaries, isGasFeed } from '@/lib/gasBillUi';
import { loadEnergyData, saveEnergyData } from '@/lib/storage';
import {
  readStoredBillFeed,
  writeStoredBillFeed,
  USAGE_SUMMARIES_KEY,
} from '@/hooks/useDashboard';

const read = (name: string): string =>
  readFileSync(join(__dirname, '../../tests/fixtures', name), 'utf8');

const countRows = (gs: { readings: unknown[] }[]): number =>
  gs.reduce((n, g) => n + g.readings.length, 0);

describe('commodity probe — synthetic fixtures only', () => {
  beforeEach(() => localStorage.clear());

  it('reports the shapes both fixtures parse to', () => {
    const gas = parseGreenButtonFeed(read('enbridge-gas-synthetic.xml'));
    const elec = parseGreenButtonFeed(read('green-button-alliance-sample.xml'));
    const gasVolumeRows = gas.groups.reduce(
      (n, g) => n + (g.series ?? []).reduce((m, s) => m + (s.status === 'volume' ? s.readings.length : 0), 0),
      0,
    );
    console.log(JSON.stringify({
      gas: {
        groups: gas.groups.length,
        electricRows: countRows(gas.groups),
        volumeRows: gasVolumeRows,
        summaries: gas.summaries.length,
        isGasFeed: isGasFeed(gas.summaries),
        notes: gas.notes.length,
        noteCodes: gas.notes.map((n) => n.code),
      },
      elec: {
        groups: elec.groups.length,
        electricRows: countRows(elec.groups),
        summaries: elec.summaries.length,
        notes: elec.notes.length,
        noteCodes: elec.notes.map((n) => n.code),
      },
    }, null, 2));
    expect(true).toBe(true);
  });

  it('ORDER electric -> gas: does the gas commit erase the electric dataset?', () => {
    const elec = parseGreenButtonFeed(read('green-button-alliance-sample.xml'));
    const gas = parseGreenButtonFeed(read('enbridge-gas-synthetic.xml'));
    const gasSummaries = isGasFeed(gas.summaries) ? enrichGasSummaries(gas) : gas.summaries;

    // What the single-file upload path does for an ELECTRIC file:
    const elecPoints = elec.groups[0].readings;
    expect(elecPoints.length).toBeGreaterThan(0);
    expect(saveEnergyData(elecPoints, { source: 'upload' }).ok).toBe(true);
    expect(
      writeStoredBillFeed({ summaries: elec.summaries, localTime: elec.localTime, source: 'a.xml' }).ok,
    ).toBe(true);

    // What the single-file upload path does for the GAS file afterwards:
    // commitReadings(groups[0].readings = ZERO electric rows) + replace feed.
    const gasRows = gas.groups[0].readings; // today: []
    expect(gasRows).toHaveLength(0); // <- the reproduction: gas contributes no points
    expect(saveEnergyData(gasRows, { source: 'upload' }).ok).toBe(true);
    expect(
      writeStoredBillFeed({ summaries: gasSummaries, localTime: gas.localTime, source: 'b.xml' }).ok,
    ).toBe(true);

    const points = loadEnergyData();
    const feed = readStoredBillFeed();
    const report = {
      storedPoints: points.ok && points.value ? points.value.points.length : 'none',
      storedSummaries: feed.summaries.length,
      storedGasSummaries: feed.summaries.filter((s) => s.volume != null).length,
    };
    console.log('ORDER electric->gas after both commits:', JSON.stringify(report));
    // The reproduction, asserted as the CURRENT lossy behaviour:
    expect(report.storedPoints).toBe(0); // electric readings wiped by the gas upload
    expect(report.storedSummaries).toBe(gasSummaries.length); // electric bills replaced
    expect(USAGE_SUMMARIES_KEY).toBe('usage_summaries');
  });

  it('ORDER gas -> electric: does the electric commit erase the gas dataset?', () => {
    const elec = parseGreenButtonFeed(read('green-button-alliance-sample.xml'));
    const gas = parseGreenButtonFeed(read('enbridge-gas-synthetic.xml'));
    const gasSummaries = isGasFeed(gas.summaries) ? enrichGasSummaries(gas) : gas.summaries;

    // gas upload first (zero electric rows committed — only the bill feed lands)
    expect(saveEnergyData([], { source: 'upload' }).ok).toBe(true);
    expect(
      writeStoredBillFeed({ summaries: gasSummaries, localTime: gas.localTime, source: 'b.xml' }).ok,
    ).toBe(true);
    // electric upload second: replaces the feed and writes its points
    expect(
      saveEnergyData(elec.groups[0].readings, { source: 'upload' }).ok,
    ).toBe(true);
    expect(
      writeStoredBillFeed({ summaries: elec.summaries, localTime: elec.localTime, source: 'a.xml' }).ok,
    ).toBe(true);

    const feed = readStoredBillFeed();
    const report = {
      storedPoints: (loadEnergyData().value?.points ?? []).length,
      storedSummaries: feed.summaries.length,
      storedGasSummaries: feed.summaries.filter((s) => s.volume != null).length,
    };
    console.log('ORDER gas->electric after both commits:', JSON.stringify(report));
    // The reproduction, asserted as the CURRENT lossy behaviour: the electric
    // upload replaced the whole bill feed, so no gas period survives.
    // (`volume != null` alone is NOT the gas discriminator — the electric
    // fixture carries a volume field too; isGasSummary is the real one.)
    expect(isGasFeed(feed.summaries)).toBe(false);
    expect(feed.summaries).toHaveLength(elec.summaries.length);
    expect(report.storedPoints).toBe(elec.groups[0].readings.length);
  });
});
