/**
 * Generate `tests/fixtures/enbridge-gas-synthetic.xml` — the Enbridge Gas (EGD)
 * Extract shape the parser is pinned against (t_fb80429a, AC3 of t_e2898d1b).
 *
 * The real XML from a customer's manual Extract download is NEVER committed.
 * What is committed instead, beside this script:
 *
 *   - `enbridge-fixture-data/usage-summaries.json` — the 10 UsageSummary
 *     blocks: every scalar field and all 37 `costAdditionalDetailLastPeriod`
 *     lines per period (note text, amount, measurement uom/potm, itemKind),
 *     with the audited per-period figures from t_e2898d1b's acceptance
 *     criteria (Amount Due 175.76 … 72.47, volumes 427 … 112 m³, etc.);
 *   - `enbridge-fixture-data/feed-structure.json` — the 27 entries (titles,
 *     links, IntervalBlock/ReadingType/LocalTimeParameters/UsagePoint
 *     payloads) with every uuid rewritten to a deterministic synthetic
 *     `a……-0000-4000-8000-……` and the subscription segment
 *     the real subscription segment → `Subscription/SYNTHETIC-SUB`.
 *
 * The emitted file reproduces the real string patterns exactly: default-atom +
 * `espi:`-prefixed elements, the greenbuttondata.org atom 3.3 /
 * naesb.org espi.xsd `xsi:schemaLocation`, `api.enbridgegas.com/espi/1_1/…`
 * hrefs, commodity 7 / uom 42 / powerOfTenMultiplier −3 reading types, and the
 * 37-line bill-note set with its exact labels (including the `¢/m3` rate lines
 * that are rates, never amounts).
 *
 * Regenerate: `node webapp/scripts/generate-enbridge-gas-fixture.mjs`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'enbridge-fixture-data');
const SUMS = JSON.parse(readFileSync(join(dataDir, 'usage-summaries.json'), 'utf8'));
const FEED = JSON.parse(readFileSync(join(dataDir, 'feed-structure.json'), 'utf8'));

const pad = (n) => '  '.repeat(n);
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One extracted element: scalar text, nested object, or null (empty tag). */
function espi(name, value, ind) {
  const p = pad(ind);
  if (value === null || value === undefined) return `${p}<espi:${name} />`;
  if (typeof value !== 'object') return `${p}<espi:${name}>${esc(value)}</espi:${name}>`;
  const kids = Object.entries(value)
    .map(([k, v]) => espi(k, v, ind + 1))
    .join('\n');
  return `${p}<espi:${name}>\n${kids}\n${p}</espi:${name}>`;
}

/** A bill-note line, in the real child order: amount?, note, measurement?, itemKind?. */
function billLine(l, ind) {
  const p = pad(ind);
  const rows = [`${p}<espi:costAdditionalDetailLastPeriod>`];
  if (l.amount !== null && l.amount !== undefined) {
    rows.push(`${p}  <espi:amount>${l.amount}</espi:amount>`);
  }
  rows.push(`${p}  <espi:note>${esc(l.note)}</espi:note>`);
  if (l.measurement) {
    const m = l.measurement;
    rows.push(`${p}  <espi:measurement>`);
    if (m.potm !== null && m.potm !== undefined) {
      rows.push(`${p}    <espi:powerOfTenMultiplier>${m.potm}</espi:powerOfTenMultiplier>`);
    }
    if (m.uom !== null && m.uom !== undefined) rows.push(`${p}    <espi:uom>${m.uom}</espi:uom>`);
    if (m.value !== null && m.value !== undefined) {
      rows.push(`${p}    <espi:value>${m.value}</espi:value>`);
    }
    rows.push(`${p}  </espi:measurement>`);
  }
  if (l.itemKind !== null && l.itemKind !== undefined) {
    rows.push(`${p}  <espi:itemKind>${l.itemKind}</espi:itemKind>`);
  }
  rows.push(`${p}</espi:costAdditionalDetailLastPeriod>`);
  return rows.join('\n');
}

function usageSummary(s, ind) {
  const p = pad(ind);
  const rows = [`${p}<espi:UsageSummary>`];
  for (const [k, v] of Object.entries(s.fields)) {
    if (k === 'billingPeriod') {
      // Extracted as "start/duration"; Enbridge serialises duration first.
      const [start, duration] = String(v).split('/');
      rows.push(`${p}  <espi:billingPeriod>`);
      rows.push(`${p}    <espi:duration>${duration}</espi:duration>`);
      rows.push(`${p}    <espi:start>${start}</espi:start>`);
      rows.push(`${p}  </espi:billingPeriod>`);
    } else {
      rows.push(espi(k, v, ind + 1));
    }
  }
  for (const l of s.lines) rows.push(billLine(l, ind + 1));
  rows.push(`${p}</espi:UsageSummary>`);
  return rows.join('\n');
}

function intervalBlock(b, ind) {
  const p = pad(ind);
  const rows = [`${p}<espi:IntervalBlock>`];
  rows.push(`${p}  <espi:interval>`);
  rows.push(`${p}    <espi:duration>${b.duration}</espi:duration>`);
  rows.push(`${p}    <espi:start>${b.start}</espi:start>`);
  rows.push(`${p}  </espi:interval>`);
  rows.push(`${p}  <espi:IntervalReading>`);
  rows.push(`${p}    <espi:timePeriod>`);
  rows.push(`${p}      <espi:duration>${b.r_duration}</espi:duration>`);
  rows.push(`${p}      <espi:start>${b.r_start}</espi:start>`);
  rows.push(`${p}    </espi:timePeriod>`);
  rows.push(`${p}    <espi:value>${b.value}</espi:value>`);
  if (b.qual) {
    rows.push(`${p}    <espi:ReadingQuality>`);
    rows.push(`${p}      <espi:quality>${b.qual}</espi:quality>`);
    rows.push(`${p}    </espi:ReadingQuality>`);
  }
  rows.push(`${p}  </espi:IntervalReading>`);
  rows.push(`${p}</espi:IntervalBlock>`);
  return rows.join('\n');
}

function contentOf(e, kind, ind) {
  const p = pad(ind);
  if (kind === 'UsageSummary') return usageSummary(SUMS[usageIndex++], ind);
  if (kind === 'IntervalBlock') return intervalBlock(e.block, ind);
  if (kind === 'MeterReading') return `${p}<espi:MeterReading />`;
  if (kind === 'ReadingType') return espi('ReadingType', e.rt, ind);
  if (kind === 'LocalTimeParameters') return espi('LocalTimeParameters', e.lt, ind);
  if (kind === 'UsagePoint') return espi('UsagePoint', e.up, ind);
  throw new Error(`unknown content kind: ${kind}`);
}

let usageIndex = 0;
const rows = [];
rows.push('<?xml version="1.0" encoding="UTF-8"?>');
rows.push('<feed xmlns="http://www.w3.org/2005/Atom"');
rows.push('      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
rows.push('      xmlns:espi="http://naesb.org/espi"');
rows.push(
  '      xsi:schemaLocation="http://www.w3.org/2005/Atom https://greenbuttondata.org/xsd/3_3/atom.xsd http://naesb.org/espi https://www.naesb.org/espi.xsd">',
);
rows.push('  <id>urn:uuid:1a2b3c4d-feed-5abc-8def-261107020207</id>');
rows.push('  <title>Energy Usage</title>');
rows.push('  <updated>2026-11-07T02:02:07Z</updated>');
rows.push(
  '  <link rel="related" href="https://cert.greenbuttonalliance.org/certificate/a0000000-0000-4000-8000-000000000001" type="text/html" />',
);

for (const e of FEED.entries) {
  rows.push('  <entry>');
  rows.push(`    <id>${e.id}</id>`);
  rows.push(`    <title>${esc(e.title)}</title>`);
  if (e.updated) rows.push(`    <updated>${e.updated}</updated>`);
  for (const l of e.links) {
    rows.push(`    <link rel="${l.rel}" type="${l.type}" href="${l.href}" />`);
  }
  rows.push('    <content>');
  rows.push(contentOf(e, e.kind, 3));
  rows.push('    </content>');
  rows.push('  </entry>');
}
rows.push('</feed>');

const target = join(here, '..', 'tests', 'fixtures', 'enbridge-gas-synthetic.xml');
writeFileSync(target, `${rows.join('\n')}\n`);
console.log(`wrote ${target} (${rows.join('\n').length} bytes, ${FEED.entries.length} entries, ${SUMS.length} summaries)`);
