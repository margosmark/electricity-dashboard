#!/usr/bin/env node
/**
 * Generate `usage-summary-open-tail.xml`: the three audited bills from
 * `usage-summary-synthetic.xml` PLUS hourly meter readings that run PAST the
 * last bill, which is the shape of a real export taken mid-period and the
 * one thing none of the other committed fixtures have (Wave R's honest
 * limitation: the accrual curve could only ever draw its empty state in the
 * browser check, because no committed fixture had an unbilled tail).
 *
 * The bills are copied VERBATIM from the Wave L fixture — same audited
 * figures, same provenance — so every money panel keeps the numbers the
 * 2026-10-07 data audit published. Only the readings are generated, from a
 * fixed hourly load shape (base load + morning and evening bumps) so the
 * file is byte-stable: regenerate and the diff is empty.
 *
 * Regenerate:  node scripts/generate-open-tail-fixture.mjs
 * Readings are raw Wh with no ReadingType multiplier — the parser's
 * documented fallback is `raw / 1000`, exactly what the committed
 * `example-usage.xml` relies on.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'tests', 'fixtures');

const source = readFileSync(join(fixtures, 'usage-summary-synthetic.xml'), 'utf8');

// Everything up to and including the last </entry> is the feed head: the
// comment, the LocalTimeParameters entry and the three bills.
const headEnd = source.lastIndexOf('</entry>') + '</entry>'.length;
const head = source.slice(0, headEnd).replace(/<\/feed>\s*$/, '').trimEnd();

/** Hourly load in Wh: ~1.0 kWh overnight, bumps at 08:00 and 18:00. */
function hourlyWh(hour) {
  const base = 1000;
  const morning = hour >= 7 && hour <= 9 ? 900 : 0;
  const evening = hour >= 17 && hour <= 21 ? 1600 : 0;
  // A small deterministic wobble so no two days are byte-identical.
  const wobble = ((hour * 37) % 11) * 10;
  return base + morning + evening + wobble;
}

// The bills run 2026-05-25 → 2026-08-20 (three 29-day periods). Readings
// start with them and keep going for a month past the last one.
const START = Date.UTC(2026, 4, 25) / 1000; // 2026-05-25 00:00Z
const END = Date.UTC(2026, 8, 21) / 1000; // 2026-09-21 00:00Z (exclusive)

const readings = [];
for (let ts = START; ts < END; ts += 3600) {
  const hour = new Date(ts * 1000).getUTCHours();
  readings.push(
    `      <IntervalReading><timePeriod><start>${ts}</start></timePeriod><value>${hourlyWh(hour)}</value></IntervalReading>`,
  );
}

const out = `${head}
    <entry>
        <link href="https://utility.example/espi/1_1/resource/UsagePoint/1/MeterReading/1/IntervalBlock/1" rel="self" type="espi-entry"/>
        <title>Interval Block</title>
        <content>
            <IntervalBlock>
${readings.join('\n')}
            </IntervalBlock>
        </content>
    </entry>
</feed>
`;

writeFileSync(join(fixtures, 'usage-summary-open-tail.xml'), out);
console.log(
  `usage-summary-open-tail.xml: ${readings.length} hourly readings, 2026-05-25 → 2026-09-20, over the three audited bills`,
);
