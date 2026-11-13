#!/usr/bin/env node
/**
 * Generate `mixed-commodity-synthetic.xml`: ONE document that carries BOTH
 * commodities, and — deliberately — the bills-only-half shape that broke in
 * t_cb0cf70f: electric INTERVAL rows plus gas BILLING PERIODS with ZERO gas
 * interval rows. That asymmetry is the point: a commit gated on interval
 * rows silently drops the gas half, and a disclosure gated on document
 * presence then lies about it.
 *
 * Composition (both inputs are already-committed synthetic fixtures, no
 * real utility data, no PII — see the fixtures README):
 *   - `synthetic.xml`             → the whole electric feed (IntervalBlock, 68 readings)
 *   - `enbridge-gas-synthetic.xml`→ its `UsagePoint` + `UsageSummary` entries ONLY
 *     (no MeterReading/IntervalBlock/ReadingType entries → no gas volume
 *     series → the parser sees gas periods but no gas intervals)
 *
 * The entries keep the `espi:` prefix and ride under synthetic.xml's feed
 * header — exactly the shape the security gate itself built by hand for its
 * F2 probe (12 entries: 1 electric + 1 UsagePoint + 10 UsageSummary), so the
 * committed fixture pins what that probe found.
 *
 * Regenerate:  node scripts/generate-mixed-fixture.mjs   (byte-stable: diff stays empty)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'tests', 'fixtures');

const electric = readFileSync(join(fixtures, 'synthetic.xml'), 'utf8');
const gas = readFileSync(join(fixtures, 'enbridge-gas-synthetic.xml'), 'utf8');

// Everything up to (but not including) the electric feed's closing tag —
// header comment, namespaces and the IntervalBlock entry in one piece.
const head = electric.replace(/<\/feed>\s*$/, '').trimEnd();

/**
 * Gas entries worth keeping: the UsagePoint (association context the parser
 * reads for the periods) and every UsageSummary. Entries are matched by the
 * elements they CONTAIN, so the link hrefs that merely mention
 * "UsageSummary" in a MeterReading entry cannot pull an IntervalBlock in.
 */
const gasEntries = [...gas.matchAll(/<entry>[\s\S]*?<\/entry>/g)]
  .map((m) => m[0])
  .filter((e) => e.includes('<espi:UsageSummary>') || e.includes('<espi:UsagePoint>'));

if (gasEntries.length !== 11) {
  console.error(`expected 11 gas entries (1 UsagePoint + 10 UsageSummary), got ${gasEntries.length}`);
  process.exit(1);
}

const out = `${head}\n${gasEntries.join('\n')}\n</feed>\n`;
writeFileSync(join(fixtures, 'mixed-commodity-synthetic.xml'), out);
console.log(`mixed-commodity-synthetic.xml written: 1 electric entry + ${gasEntries.length} gas entries`);
