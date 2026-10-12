/**
 * ReadingType-aware ingestion against the OWNER's real Oakville Hydro exports.
 *
 * The exports themselves never enter the repo (tests/fixtures/README.md); this
 * file is inert unless you point it at them yourself:
 *
 *   GREENBUTTON_REAL_XML="/path/a.xml,/path/b.xml" \
 *     npx vitest run src/lib/greenbutton/realdata.series.test.ts
 *
 * WHY IT EXISTS — a round-trip regression net for the series rewrite. Two of
 * the numbers pinned below were computed INDEPENDENTLY of this codebase, with
 * Python's ElementTree over the raw XML (walk `<entry>/<link rel=self>` to find
 * each MeterReading → its related ReadingType → its IntervalBlocks, then
 * `value * 10**powerOfTenMultiplier / 1000` for uom 72). A parser agreeing with
 * itself proves nothing; these agree with a second implementation.
 *
 * Independently computed for
 * oakvillehydro_Electricity_60_Minute_01-07-2026_02-10-2026.xml:
 *   2184 readings / 91 IntervalBlocks, first start 1782968400,
 *   last start 1790827200, every duration 3600, total 8063.822 kWh.
 * and for
 * oakvillehydro_Electricity_60_Minute_30-04-2024_06-10-2026.xml:
 *   17539 readings, first start 1728190800, last 1791327600,
 *   every duration 3600, total 38738.695 kWh.
 *
 * ESPI reference for the unit codes: NAESB namespace schema
 * https://naesb.org/espi.xsd, whose rendering reports schema version
 * 3.3.20190408 (uom 72 = Wh, powerOfTenMultiplier 0 = x1, so Wh ÷ 1000 = kWh).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { parseGreenButtonFeed } from '@/lib/energy';

const FILES = (process.env.GREENBUTTON_REAL_XML ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** `[basename-ish match, readings, firstStart, lastStart, totalKwh]`. */
const PINNED: [string, number, number, number, number][] = [
  ['01-07-2026_02-10-2026', 2184, 1782968400, 1790827200, 8063.822],
  ['30-04-2024_06-10-2026', 17539, 1728190800, 1791327600, 38738.695],
];

const describeReal = FILES.length > 0 ? describe : describe.skip;

describeReal('real Oakville Hydro exports — series ingestion round trip', () => {
  for (const file of FILES) {
    const pinned = PINNED.find(([needle]) => file.includes(needle));

    describe(path.basename(file), () => {
      const xml = fs.readFileSync(file, 'utf8');
      const feed = parseGreenButtonFeed(xml);
      const group = feed.groups[0];
      const series = group.series.filter((s) => s.status === 'supported');

      it('produces exactly one billable consumption series for one UsagePoint', () => {
        expect(feed.groups).toHaveLength(1);
        expect(series).toHaveLength(1);
        expect(series[0].meta.uom).toBe(72);
        expect(series[0].meta.assumed).toBe(false);
        expect(series[0].meta.unresolved).toBe(false);
      });

      it('keeps every reading at its stated 1-hour duration', () => {
        const durations = new Set(series[0].readings.map((r) => r.duration_s));
        expect([...durations]).toEqual([3600]);
      });

      it('prices no gas, water, reactive or register series as consumption', () => {
        for (const s of group.series) {
          if (s.status === 'supported' || s.status === 'power-converted') continue;
          expect(s.readings.every((r) => r.kwh === null), s.label).toBe(true);
        }
      });

      if (pinned) {
        const [, readings, firstStart, lastStart, totalKwh] = pinned;

        it(`matches the independent ElementTree count and total (${readings} readings, ${totalKwh} kWh)`, () => {
          expect(group.readings).toHaveLength(readings);
          const total = group.readings.reduce((a, r) => a + r.usage_kwh, 0);
          expect(total).toBeCloseTo(totalKwh, 3);
        });

        it('keeps the exact UTC span the file publishes', () => {
          expect(group.readings[0].timestamp).toBe(firstStart);
          expect(group.readings[group.readings.length - 1].timestamp).toBe(lastStart);
        });

        it('rebuilds each kWh from the raw value and the ReadingType multiplier', () => {
          const r = series[0].readings[0];
          const factor = 10 ** (series[0].meta.powerOfTenMultiplier ?? 0);
          expect(r.kwh).toBeCloseTo((r.raw * factor) / 1000, 6);
        });
      }
    });
  }
});
