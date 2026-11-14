/**
 * Generate `tests/fixtures/enbridge-gas-twoyear-synthetic.xml` — a
 * SYNTHETIC two-year Enbridge-shaped Extract for the gas monthly /
 * year-over-year / money-per-period smoke (t_a2343a2f).
 *
 * The real XML from a customer's manual Extract download is NEVER committed.
 * This script synthesises 24 monthly UsageSummary blocks (2025-01-25 →
 * 2026-12-25 starts, the Enbridge ~25th cycle) in the exact string patterns
 * `generate-enbridge-gas-fixture.mjs` reproduces from the audited data:
 * default-atom + `espi:`-prefixed elements, the greenbuttondata.org atom 3.3
 * / naesb.org espi.xsd schemaLocation, commodity 7 / uom 42 / potm −3, and
 * the same 37-line bill-note set with its exact labels.
 *
 * It also carries ONE MeterReading + ReadingType + IntervalBlock per period
 * (the audited fixture's shape, href-graph linked the same way): the import
 * gate refuses any feed with zero `<IntervalReading>` elements
 * (parseDiagnostic.ts), and a real Enbridge extract with interval-enabled
 * metering carries exactly this — one metered volume per billing period,
 * equal to that period's meter-read delta.
 *
 * What the figures are:
 *  - volumes: a deterministic seasonal table (winter high, summer low),
 *    2026 at 97 % of 2025 — stated as `Usage (unadjusted)` +
 *    `currentBillingPeriodOverAllConsumption` (unadjusted × 1.0057, the
 *    feed's own Adjustment Factor), with meter reads kept cumulative;
 *  - money: a deterministic seasonal table in integer cents, 2026 at 103 %,
 *    with HST = 13 % of the pre-tax sum and `Total Gas Charges` =
 *    supply + delivery + carbon + GCA + customer + HST, `Amount Due` =
 *    Total (balance lines zero) — a self-consistent 5-term identity, so the
 *    app never has to invent anything to render it;
 *  - ¢/m3 rate lines: the audited constants (display-only, never summed).
 *
 * No `Date.now()`, no randomness: re-running leaves `git status` clean.
 *
 * Regenerate: `node webapp/scripts/generate-enbridge-gas-twoyear-fixture.mjs`
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const pad = (n) => '  '.repeat(n);
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cents = (dollars) => Math.round(dollars * 100);
/** Money lines are potm −3 milli-dollars: 175.76 → "175760". */
const milli = (centAmount) => String(centAmount * 10);

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

function usageSummary(fields, lines, ind) {
  const p = pad(ind);
  const rows = [`${p}<espi:UsageSummary>`];
  for (const [k, v] of Object.entries(fields)) {
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
  for (const l of lines) rows.push(billLine(l, ind + 1));
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
  rows.push(`${p}  </espi:IntervalReading>`);
  rows.push(`${p}</espi:IntervalBlock>`);
  return rows.join('\n');
}

/* ------------------------------------------------------------------ *
 * Deterministic seasonal tables (dollars / m³), Jan..Dec.
 * ------------------------------------------------------------------ */
const SUPPLY = [71.2, 66.4, 59.8, 44.1, 28.6, 16.4, 12.9, 13.5, 22.3, 38.7, 57.9, 69.8];
const DELIVERY = [38.4, 36.1, 33.2, 25.8, 18.9, 13.1, 11.4, 11.7, 16.2, 26.4, 35.6, 37.9];
const CARBON = [3.05, 2.85, 2.4, 1.6, 0.95, 0.55, 0.45, 0.45, 0.8, 1.5, 2.45, 3.0];
const GCA = [-2.15, -2.05, -1.9, -1.45, -0.95, -0.55, -0.45, -0.45, -0.8, -1.4, -1.95, -2.1];
const CUSTOMER = 28.7;
/** Unadjusted usage m³ (3 decimals), Jan..Dec. */
const UNADJ = [
  518.436, 476.512, 414.388, 297.654, 186.22, 108.975, 84.612, 89.34, 148.77, 257.418,
  396.852, 504.29,
];
/** The feed's own atmospheric factor (potm −6), stated as 1.0057. */
const ADJ_FACTOR = 1005700;

/** Money tables rise 3 % in 2026 (cents, integer). */
const moneyC = (v, year) => cents(year === 2025 ? v : Math.round(v * 1.03 * 100) / 100);
/** Volumes fall 3 % in 2026 (milli-m³, integer). */
const volM = (v, year) =>
  Math.round((year === 2025 ? v : Math.round(v * 0.97 * 1000) / 1000) * 1000);

const PERIODS = [];
let meterReadM = 748000; // cumulative previous read, milli-m³ (audited P1 start)
for (let i = 0; i < 24; i++) {
  const year = 2025 + Math.floor(i / 12);
  const month = (i % 12) + 1; // 1..12
  const start = Date.UTC(year, month - 1, 25) / 1000;
  const nextStart =
    i < 23 ? Date.UTC(year + Math.floor((month) / 12), (month % 12), 25) / 1000 : null;
  const duration = nextStart !== null ? nextStart - start - 86400 : 30 * 86400;
  const end = start + duration;
  const days = duration / 86400;
  const billDate = end + 86400;
  const dueDate = billDate + 21 * 86400;
  const prevRead = start - 86400;
  const currRead = end - 86400;

  const unadjM = volM(UNADJ[month - 1], year);
  const billedM = Math.round(unadjM * (ADJ_FACTOR / 1_000_000));
  const readDeltaM = Math.round(unadjM / 1000) * 1000;
  const prevReadM = meterReadM;
  const currReadM = meterReadM + readDeltaM;
  meterReadM = currReadM;

  const supplyC = moneyC(SUPPLY[month - 1], year);
  const deliveryC = moneyC(DELIVERY[month - 1], year);
  const carbonC = moneyC(CARBON[month - 1], year);
  const gcaC = moneyC(GCA[month - 1], year);
  const customerC = moneyC(CUSTOMER, year);
  const preTaxC = supplyC + deliveryC + carbonC + gcaC + customerC;
  const hstC = Math.round(preTaxC * 0.13);
  const totalC = preTaxC + hstC;
  const dueC = totalC; // balance lines all zero → Amount Due == Total

  PERIODS.push({
    year,
    month,
    start,
    duration,
    end,
    days,
    billDate,
    dueDate,
    prevRead,
    currRead,
    unadjM,
    billedM,
    prevReadM,
    currReadM,
    supplyC,
    deliveryC,
    carbonC,
    gcaC,
    customerC,
    hstC,
    totalC,
    dueC,
  });
}

const money = (note, amountC, kind) => ({
  note,
  amount: milli(amountC),
  measurement: { uom: 80, potm: -3, value: null },
  itemKind: kind,
});
const stamp = (note, epoch, kind) => ({
  note,
  amount: null,
  measurement: { uom: 27, potm: 0, value: String(epoch) },
  itemKind: kind,
});
const zero = (note, kind) => money(note, 0, kind);

function linesFor(p) {
  return [
    money('Amount Due', p.dueC, 10),
    stamp('Due Date', p.dueDate, 10),
    stamp('Bill Date', p.billDate, 10),
    money('HST ($)', p.hstC, 5),
    money('Gas Supply Charge', p.supplyC, 3),
    money('Gas Delivery Variable Charge', p.deliveryC, 2),
    money('Gas Federal Carbon Charge', p.carbonC, 5),
    stamp('Billing Period - Current Read Date', p.currRead, 10),
    stamp('Billing Period - Previous Read Date', p.prevRead, 10),
    {
      note: 'Current Meter Read',
      amount: null,
      measurement: { uom: 114, potm: -3, value: String(p.currReadM) },
      itemKind: 10,
    },
    {
      note: 'Previous Meter Read',
      amount: null,
      measurement: { uom: 114, potm: -3, value: String(p.prevReadM) },
      itemKind: 10,
    },
    {
      note: 'Usage (unadjusted)',
      amount: null,
      measurement: { uom: 167, potm: -3, value: String(p.unadjM) },
      itemKind: 10,
    },
    zero('Previous Balance ($)', 10),
    zero('Payments Received ($)', 9),
    zero('Balance Forward ($)', 10),
    zero('Gas Transportation Charge ($)', 2),
    money('Gas Cost Adjustment ($)', p.gcaC, 4),
    zero('Charges from Other Companies ($)', 10),
    zero('Gas Service Provider Admin Fee ($)', 4),
    money('Gas Service Provider Supply Charge ($)', p.supplyC, 2),
    money('Total Gas Charges ($)', p.totalC, 10),
    zero('Other Gas Charges ($)', 10),
    {
      note: 'Adjustment Factor (atmospheric)',
      amount: null,
      measurement: { uom: 114, potm: -6, value: String(ADJ_FACTOR) },
      itemKind: 10,
    },
    zero('Reversal of Previously billed charges', 10),
    {
      note: 'Gas Supply Rate ¢/m3',
      amount: '204037',
      measurement: { uom: 80, potm: -4, value: null },
      itemKind: 10,
    },
    {
      note: 'Gas Cost Adjustment ¢/m3',
      amount: '-11703',
      measurement: { uom: 80, potm: -4, value: null },
      itemKind: 10,
    },
    {
      note: 'Total Gas Supply Rate ¢/m3 (net)',
      amount: '192334',
      measurement: { uom: 80, potm: -4, value: null },
      itemKind: 10,
    },
    money('Customer charge', p.customerC, 10),
    zero('Hydrogen Blended credit', 10),
    zero('Direct Purchase Admin Charge', 4),
    zero('Expansion Surcharge', 10),
    {
      note: 'Pressure factor',
      amount: null,
      measurement: { uom: 114, potm: -14, value: '0' },
      itemKind: 10,
    },
    {
      note: 'Previous Usage consumption',
      amount: null,
      measurement: { uom: 167, potm: -3, value: '0' },
      itemKind: 10,
    },
    {
      note: 'Number of days in bill period',
      amount: null,
      measurement: { uom: 114, potm: 0, value: String(p.days) },
      itemKind: 10,
    },
    zero('Contract Demand charge', 10),
    zero('Load Balancing Charge', 10),
    zero('Transportation to Enbridge (LVB)', 2),
  ];
}

function fieldsFor(p) {
  const quality = p.month % 2 === 0 ? '19' : '12';
  return {
    billingPeriod: `${p.start}/${p.duration}`,
    billLastPeriod: milli(p.dueC),
    billToDate: milli(p.dueC),
    costAdditionalLastPeriod: '0',
    currency: '124',
    overallConsumptionLastPeriod: {
      powerOfTenMultiplier: '-3',
      timeStamp: String(p.billDate),
      uom: '42',
      value: '0',
    },
    currentBillingPeriodOverAllConsumption: {
      powerOfTenMultiplier: '-3',
      timeStamp: String(p.billDate),
      uom: '42',
      value: String(p.billedM),
    },
    qualityOfReading: quality,
    statusTimeStamp: String(p.billDate),
  };
}

/* ------------------------------------------------------------------ *
 * Entries: LocalTimeParameters + UsagePoint + 24 UsageSummary blocks.
 * ------------------------------------------------------------------ */
const UPDATED = '2026-11-07T02:02:07Z';
const uuid = (n) =>
  `urn:uuid:a${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UP_ID = uuid(2);

const entries = [];
entries.push({
  id: uuid(1),
  title: 'DST For North America',
  links: [
    { rel: 'self', type: 'espi-entry/LocalTimeParameters', href: 'https://api.enbridgegas.com/espi/1_1/resource/LocalTimeParameters/002026' },
    { rel: 'up', type: 'espi-feed/LocalTimeParameters', href: 'https://api.enbridgegas.com/espi/1_1/resource/LocalTimeParameters' },
  ],
  kind: 'LocalTimeParameters',
  lt: {
    dstEndRule: '6AE6E370',
    dstOffset: '3600',
    dstStartRule: '69AD1E70',
    tzOffset: '-18',
  },
});
entries.push({
  id: UP_ID,
  title: 'Usage Point',
  links: [
    { rel: 'self', type: 'espi-entry/UsagePoint', href: `https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint/${UP_ID.slice('urn:uuid:'.length)}` },
    { rel: 'up', type: 'espi-feed/UsagePoint', href: 'https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint' },
    { rel: 'related', type: 'espi-entry/LocalTimeParameters', href: 'https://api.enbridgegas.com/espi/1_1/resource/LocalTimeParameters/002026' },
    { rel: 'related', type: 'espi-feed/MeterReading', href: `https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint/${UP_ID.slice('urn:uuid:'.length)}/MeterReading` },
    { rel: 'related', type: 'espi-feed/UsageSummary', href: `https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint/${UP_ID.slice('urn:uuid:'.length)}/UsageSummary` },
  ],
  kind: 'UsagePoint',
  up: { ServiceCategory: { kind: '1' } },
});
// One MeterReading + ReadingType + IntervalBlock per period — the audited
// fixture's shape, href-graph linked the same way (UsagePoint → MeterReading
// → ReadingType → IntervalBlock), because the import gate refuses a feed with
// zero <IntervalReading> elements (parseDiagnostic.ts) and a real
// interval-enabled Enbridge extract carries one metered volume per period.
const UP_PATH = `https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint/${UP_ID.slice('urn:uuid:'.length)}`;
const meterEntries = [];
const rtEntries = [];
const ibEntries = [];
PERIODS.forEach((p, i) => {
  const mr = uuid(0x200 + i);
  const rt = uuid(0x300 + i);
  const ib = uuid(0x400 + i);
  const mrPath = `${UP_PATH}/MeterReading/${mr.slice('urn:uuid:'.length)}`;
  meterEntries.push({
    id: mr,
    title: 'Meter Reading',
    links: [
      { rel: 'self', type: 'espi-entry/MeterReading', href: mrPath },
      { rel: 'up', type: 'espi-feed/MeterReading', href: `${UP_PATH}/MeterReading` },
      { rel: 'related', type: 'espi-feed/IntervalBlock', href: `${mrPath}/IntervalBlock` },
      { rel: 'related', type: 'espi-entry/ReadingType', href: `https://api.enbridgegas.com/espi/1_1/resource/ReadingType/${rt.slice('urn:uuid:'.length)}` },
    ],
    kind: 'MeterReading',
  });
  rtEntries.push({
    id: rt,
    title: 'Reading Type',
    links: [
      { rel: 'self', type: 'espi-entry/ReadingType', href: `https://api.enbridgegas.com/espi/1_1/resource/ReadingType/${rt.slice('urn:uuid:'.length)}` },
      { rel: 'up', type: 'espi-feed/ReadingType', href: 'https://api.enbridgegas.com/espi/1_1/resource/ReadingType' },
    ],
    kind: 'ReadingType',
    rt: {
      accumulationBehaviour: '4',
      commodity: '7',
      currency: '124',
      dataQualifier: '12',
      flowDirection: '1',
      intervalLength: String(p.duration),
      kind: '58',
      powerOfTenMultiplier: '-3',
      uom: '42',
    },
  });
  ibEntries.push({
    id: ib,
    title: 'Meter data',
    links: [
      { rel: 'self', type: 'espi-entry/IntervalBlock', href: `${mrPath}/IntervalBlock/${ib.slice('urn:uuid:'.length)}` },
      { rel: 'up', type: 'espi-feed/IntervalBlock', href: `${mrPath}/IntervalBlock` },
      { rel: 'related', type: 'espi-entry/MeterReading', href: mrPath },
    ],
    kind: 'IntervalBlock',
    block: {
      start: String(p.start),
      duration: String(p.duration),
      r_start: String(p.start),
      r_duration: String(p.duration),
      value: String(p.currReadM - p.prevReadM),
      qual: null,
    },
  });
});
entries.push(...meterEntries, ...rtEntries, ...ibEntries);

PERIODS.forEach((p, i) => {
  const id = uuid(0x100 + i);
  entries.push({
    id,
    title: 'Usage Summary',
    links: [
      { rel: 'self', type: 'espi-entry/UsageSummary', href: `https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint/${UP_ID.slice('urn:uuid:'.length)}/UsageSummary/${id.slice('urn:uuid:'.length)}` },
      { rel: 'up', type: 'espi-feed/UsageSummary', href: `https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint/${UP_ID.slice('urn:uuid:'.length)}/UsageSummary` },
      { rel: 'related', type: 'espi-entry/UsagePoint', href: `https://api.enbridgegas.com/espi/1_1/resource/Subscription/SYNTHETIC-SUB/UsagePoint/${UP_ID.slice('urn:uuid:'.length)}` },
    ],
    kind: 'UsageSummary',
    fields: fieldsFor(p),
    lines: linesFor(p),
  });
});

function contentOf(e, ind) {
  const p = pad(ind);
  if (e.kind === 'UsageSummary') return usageSummary(e.fields, e.lines, ind);
  if (e.kind === 'LocalTimeParameters') return espi('LocalTimeParameters', e.lt, ind);
  if (e.kind === 'UsagePoint') return espi('UsagePoint', e.up, ind);
  if (e.kind === 'MeterReading') return `${p}<espi:MeterReading />`;
  if (e.kind === 'ReadingType') return espi('ReadingType', e.rt, ind);
  if (e.kind === 'IntervalBlock') return intervalBlock(e.block, ind);
  throw new Error(`unknown content kind: ${e.kind}`);
}

const rows = [];
rows.push('<?xml version="1.0" encoding="UTF-8"?>');
rows.push('<feed xmlns="http://www.w3.org/2005/Atom"');
rows.push('      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
rows.push('      xmlns:espi="http://naesb.org/espi"');
rows.push(
  '      xsi:schemaLocation="http://www.w3.org/2005/Atom https://greenbuttondata.org/xsd/3_3/atom.xsd http://naesb.org/espi https://www.naesb.org/espi.xsd">',
);
rows.push('  <id>urn:uuid:1a2b3c4d-feed-5abc-8def-261107020211</id>');
rows.push('  <title>Energy Usage</title>');
rows.push(`  <updated>${UPDATED}</updated>`);
rows.push(
  '  <link rel="related" href="https://cert.greenbuttonalliance.org/certificate/a0000000-0000-4000-8000-000000000001" type="text/html" />',
);

for (const e of entries) {
  rows.push('  <entry>');
  rows.push(`    <id>${e.id}</id>`);
  rows.push(`    <title>${esc(e.title)}</title>`);
  rows.push(`    <updated>${UPDATED}</updated>`);
  for (const l of e.links) {
    rows.push(`    <link rel="${l.rel}" type="${l.type}" href="${l.href}" />`);
  }
  rows.push('    <content>');
  rows.push(contentOf(e, 3));
  rows.push('    </content>');
  rows.push('  </entry>');
}
rows.push('</feed>');

const target = join(here, '..', 'tests', 'fixtures', 'enbridge-gas-twoyear-synthetic.xml');
writeFileSync(target, `${rows.join('\n')}\n`);
console.log(
  `wrote ${target} (${rows.join('\n').length} bytes, ${entries.length} entries, ${PERIODS.length} summaries)`,
);
