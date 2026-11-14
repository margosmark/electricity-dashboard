/**
 * Generate `tests/fixtures/enbridge-gas-multiseries-synthetic.xml`
 * (t_78f788b3) — the multi-series volume fixture for the gas interval chart.
 *
 * The committed Enbridge-shaped fixture (`enbridge-gas-synthetic.xml`) carries
 * one reading per MeterReading — billing-period granularity. The gas interval
 * chart needs the OTHER shape the real extract family has: SEVERAL volume
 * series (multiple MeterReadings, the real file's `69F1A08B-…` id family)
 * each carrying DAILY IntervalReadings, plus UsageSummary bills, so the
 * chart's multi-series flattening, sorting and unit rendering are pinned
 * against something shaped like the customer's file.
 *
 * The real XML from a customer's manual Extract download is NEVER committed.
 * What is committed beside this script is only the emitted synthetic file:
 * deterministic ids in the real file's `69F1A08B-…` style (first segment
 * pinned to the shape the card names, tails sequential), the subscription
 * segment `Subscription/SYNTHETIC-SUB`, and the first two audited
 * UsageSummary bill blocks from `enbridge-fixture-data/usage-summaries.json`
 * (same source as the monthly fixture — figures stay audited there, not
 * re-typed here).
 *
 * Shape notes:
 *   - Document order is deliberately NOT time order (the February series is
 *     listed first): `extractGasPoints` preserves document order, so the
 *     chart must sort by timestamp — asserted in `GasChart.test.tsx`.
 *   - Each block holds six daily IntervalReadings (start/duration/value per
 *     reading, potm −3 → m³), the shape `parseReadingSeries` flattens into
 *     one volume series per MeterReading.
 *
 * Regenerate: `node webapp/scripts/generate-enbridge-multiseries-fixture.mjs`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'enbridge-fixture-data');
const SUMS = JSON.parse(readFileSync(join(dataDir, 'usage-summaries.json'), 'utf8'));

const ID = '69F1A08B-0000-4000-8000-';
const uuid = (tail) => `${ID}${tail}`;
const SUB = 'Subscription/SYNTHETIC-SUB';
const UP_ID = uuid('000000000002');
const API = 'https://api.enbridgegas.com/espi/1_1/resource';
const UPDATED = '2026-02-07T02:02:07Z';

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

/* ------------------------------------------------------------------ *
 * The four volume series: several MeterReadings, daily readings each.
 * `first` is the series' first interval start (UTC epoch seconds);
 * values are m³ × 1000 (powerOfTenMultiplier −3), like the real extract.
 * Document order (d, a, b, c) is intentionally NOT time order.
 * ------------------------------------------------------------------ */
const SERIES = [
  { mr: '000000000003', rt: '000000000004', ib: '000000000005', first: 1769904000,
    values: [9800, 9300, 8900, 8500, 8200, 7800] }, // 2026-02-01..06
  { mr: '000000000006', rt: '000000000007', ib: '000000000008', first: 1767571200,
    values: [8400, 9100, 7700, 8800, 9500, 10200] }, // 2026-01-05..10
  { mr: '000000000009', rt: '00000000000a', ib: '00000000000b', first: 1768089600,
    values: [11000, 10400, 9900, 9200, 8600, 8100] }, // 2026-01-11..16
  { mr: '00000000000c', rt: '00000000000d', ib: '00000000000e', first: 1768608000,
    values: [7900, 7400, 7000, 6600, 6300, 6000] }, // 2026-01-17..22
];
const DAY = 86400;

const RT = {
  accumulationBehaviour: '4',
  commodity: '7',
  currency: '124',
  dataQualifier: '12',
  flowDirection: '1',
  intervalLength: '  86400',
  kind: '58',
  powerOfTenMultiplier: '-3',
  uom: '42',
};

const LT = { dstEndRule: '6AE6E370', dstOffset: '3600', dstStartRule: '69AD1E70', tzOffset: '-18' };

function entry(id, title, links, contentXml, ind = 1) {
  const p = pad(ind);
  const rows = [`${p}<entry>`];
  rows.push(`${p}  <id>urn:uuid:${id}</id>`);
  rows.push(`${p}  <title>${esc(title)}</title>`);
  rows.push(`${p}  <updated>${UPDATED}</updated>`);
  for (const l of links) {
    rows.push(`${p}  <link rel="${l.rel}" type="${l.type}" href="${l.href}" />`);
  }
  rows.push(`${p}  <content>`);
  rows.push(contentXml);
  rows.push(`${p}  </content>`);
  rows.push(`${p}</entry>`);
  return rows.join('\n');
}

const rows = [];
rows.push('<?xml version="1.0" encoding="UTF-8"?>');
rows.push('<feed xmlns="http://www.w3.org/2005/Atom"');
rows.push('      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
rows.push('      xmlns:espi="http://naesb.org/espi"');
rows.push(
  '      xsi:schemaLocation="http://www.w3.org/2005/Atom https://greenbuttondata.org/xsd/3_3/atom.xsd http://naesb.org/espi https://www.naesb.org/espi.xsd">',
);
rows.push('  <id>urn:uuid:69F1A08B-feed-4000-8000-000000000000</id>');
rows.push('  <title>Energy Usage</title>');
rows.push(`  <updated>${UPDATED}</updated>`);
rows.push(
  '  <link rel="related" href="https://cert.greenbuttonalliance.org/certificate/a0000000-0000-4000-8000-000000000001" type="text/html" />',
);

/* LocalTimeParameters — same DST/tz payload the monthly fixture ships. */
rows.push(
  entry(
    uuid('000000000001'),
    'DST For North America',
    [
      { rel: 'self', type: 'espi-entry/LocalTimeParameters', href: `${API}/LocalTimeParameters/002026` },
      { rel: 'up', type: 'espi-feed/LocalTimeParameters', href: `${API}/LocalTimeParameters` },
    ],
    espi('LocalTimeParameters', LT, 3),
  ),
);

/* UsagePoint — kind 1, links out to the four series and the bills. */
rows.push(
  entry(
    UP_ID,
    'Usage Point',
    [
      { rel: 'self', type: 'espi-entry/UsagePoint', href: `${API}/${SUB}/UsagePoint/${UP_ID}` },
      { rel: 'up', type: 'espi-feed/UsagePoint', href: `${API}/${SUB}/UsagePoint` },
      { rel: 'related', type: 'espi-entry/LocalTimeParameters', href: `${API}/LocalTimeParameters/002026` },
      { rel: 'related', type: 'espi-feed/MeterReading', href: `${API}/${SUB}/UsagePoint/${UP_ID}/MeterReading` },
      { rel: 'related', type: 'espi-feed/UsageSummary', href: `${API}/${SUB}/UsagePoint/${UP_ID}/UsageSummary` },
    ],
    espi('UsagePoint', { ServiceCategory: { kind: '1' } }, 3),
  ),
);

for (const s of SERIES) {
  const mr = uuid(s.mr);
  rows.push(
    entry(
      s.mr,
      'Meter Reading',
      [
        { rel: 'self', type: 'espi-entry/MeterReading', href: `${API}/${SUB}/UsagePoint/${UP_ID}/MeterReading/${mr}` },
        { rel: 'up', type: 'espi-feed/MeterReading', href: `${API}/${SUB}/UsagePoint/${UP_ID}/MeterReading` },
        { rel: 'related', type: 'espi-feed/IntervalBlock', href: `${API}/${SUB}/UsagePoint/${UP_ID}/MeterReading/${mr}/IntervalBlock` },
        { rel: 'related', type: 'espi-entry/ReadingType', href: `${API}/ReadingType/${uuid(s.rt)}` },
      ],
      `${pad(3)}<espi:MeterReading />`,
    ),
  );
}

for (const s of SERIES) {
  rows.push(
    entry(
      s.rt,
      'Reading Type',
      [
        { rel: 'self', type: 'espi-entry/ReadingType', href: `${API}/ReadingType/${uuid(s.rt)}` },
        { rel: 'up', type: 'espi-feed/ReadingType', href: `${API}/ReadingType` },
      ],
      espi('ReadingType', RT, 3),
    ),
  );
}

for (const s of SERIES) {
  const mr = uuid(s.mr);
  const ib = uuid(s.ib);
  const readings = s.values
    .map((value, i) => {
      const start = s.first + i * DAY;
      return [
        `${pad(5)}<espi:IntervalReading>`,
        `${pad(6)}<espi:timePeriod>`,
        `${pad(7)}<espi:duration>${DAY}</espi:duration>`,
        `${pad(7)}<espi:start>${start}</espi:start>`,
        `${pad(6)}</espi:timePeriod>`,
        `${pad(6)}<espi:value>${value}</espi:value>`,
        `${pad(5)}</espi:IntervalReading>`,
      ].join('\n');
    })
    .join('\n');
  const content = [
    `${pad(3)}<espi:IntervalBlock>`,
    `${pad(4)}<espi:interval>`,
    `${pad(5)}<espi:duration>${s.values.length * DAY}</espi:duration>`,
    `${pad(5)}<espi:start>${s.first}</espi:start>`,
    `${pad(4)}</espi:interval>`,
    readings,
    `${pad(3)}</espi:IntervalBlock>`,
  ].join('\n');
  rows.push(
    entry(
      s.ib,
      'Meter data',
      [
        { rel: 'self', type: 'espi-entry/IntervalBlock', href: `${API}/${SUB}/UsagePoint/${UP_ID}/MeterReading/${mr}/IntervalBlock/${ib}` },
        { rel: 'up', type: 'espi-feed/IntervalBlock', href: `${API}/${SUB}/UsagePoint/${UP_ID}/MeterReading/${mr}/IntervalBlock` },
        { rel: 'related', type: 'espi-entry/MeterReading', href: `${API}/${SUB}/UsagePoint/${UP_ID}/MeterReading/${mr}` },
      ],
      content,
    ),
  );
}

/* The bills: first two audited UsageSummary blocks (volume series + bills,
   per the card). Billing periods Dec 25 – Feb 25 bracket the daily series. */
const BILL_TAILS = ['000000000011', '000000000012'];
for (let i = 0; i < BILL_TAILS.length; i++) {
  const id = uuid(BILL_TAILS[i]);
  rows.push(
    entry(
      id,
      'Usage Summary',
      [
        { rel: 'self', type: 'espi-entry/UsageSummary', href: `${API}/${SUB}/UsagePoint/${UP_ID}/UsageSummary/${id}` },
        { rel: 'up', type: 'espi-feed/UsageSummary', href: `${API}/${SUB}/UsagePoint/${UP_ID}/UsageSummary` },
        { rel: 'related', type: 'espi-entry/UsagePoint', href: `${API}/${SUB}/UsagePoint/${UP_ID}` },
      ],
      usageSummary(SUMS[i], 3),
    ),
  );
}

rows.push('</feed>');

const target = join(here, '..', 'tests', 'fixtures', 'enbridge-gas-multiseries-synthetic.xml');
writeFileSync(target, `${rows.join('\n')}\n`);
console.log(
  `wrote ${target} (${rows.join('\n').length} bytes, ${SERIES.length} volume series × ${SERIES[0].values.length} readings, ${BILL_TAILS.length} bills)`,
);
