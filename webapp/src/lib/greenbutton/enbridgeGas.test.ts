/**
 * Enbridge Gas (EGD) Extract import, commodity 7 — the parser half of the
 * acceptance criteria (t_fb80429a / AC1–AC16 of t_e2898d1b).
 *
 * The fixture is GENERATED from the extracted string patterns and audited
 * figures (`scripts/generate-enbridge-gas-fixture.mjs`); the real customer
 * download is never committed (AC3). Every figure asserted here was
 * re-derived from the raw files by the acceptance pass and matches tables
 * A–C of `enbridge-gas-import-acceptance-criteria.md`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  meterReadVolume,
  parseGreenButtonFeed,
  usageUnadjusted,
  type BillLineItem,
  type UsageSummary,
} from '../energy';

const USAGE_XML = readFileSync(
  join(__dirname, '../../../tests/fixtures/enbridge-gas-synthetic.xml'),
  'utf8',
);

const feed = parseGreenButtonFeed(USAGE_XML);

const line = (s: UsageSummary, note: string): BillLineItem => {
  const hit = s.items.find((i) => i.note === note);
  if (!hit) throw new Error(`no line ${JSON.stringify(note)} in ${s.startDate}`);
  return hit;
};
const amountOf = (s: UsageSummary, note: string): number => {
  const a = line(s, note).amount;
  if (a === null) throw new Error(`line ${JSON.stringify(note)} has no amount`);
  return a;
};
const rawOf = (s: UsageSummary, note: string): number => {
  const a = line(s, note).rawAmount;
  if (a === null) throw new Error(`line ${JSON.stringify(note)} has no raw amount`);
  return a;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** AC5: the ten billing periods, exact UTC starts from the file. */
const STARTS = [
  '2025-12-25', '2026-01-27', '2026-02-26', '2026-03-26', '2026-04-28',
  '2026-05-27', '2026-06-24', '2026-07-27', '2026-08-27', '2026-09-25',
];
const DAYS = [32, 29, 27, 32, 28, 27, 32, 30, 28, 31];
/** AC6/AC7: Amount Due and Total Gas Charges per period (dollars). */
const DUE = [175.76, 153.06, 117.35, 84.75, 65.45, 132.06, 85.37, 119.04, 93.33, 72.47];
const TOTALS = [161.89, 153.06, 117.35, 84.75, 65.45, 132.06, 80.07, 119.04, 93.33, 66.29];
/** AC13: `Usage (unadjusted)` per period (m³, uom 167). */
const UNADJUSTED = [
  426.569, 385.801, 268.47, 175.997, 112.36, 347.022, 161.082, 295.317, 205.827, 112.36,
];
/** AC13: Current − Previous meter read per period (m³, uom 114). */
const READ_DELTA = [427, 386, 268, 176, 112, 347, 161, 295, 206, 112];
/** AC12: currentBillingPeriodOverAllConsumption = round(unadjusted × 1.0057). */
const BILLED_VOLUME = [429, 388, 270, 177, 113, 349, 162, 297, 207, 113];
/** AC14: the five IntervalBlocks — one reading each, in file order. */
const BLOCK_VALUES = [427, 386, 268, 174, 2];
const BLOCK_DURATIONS = [2851200, 2592000, 2419200, 2764800, 86400];
const BLOCK_STARTS = [
  '2025-12-25', '2026-01-27', '2026-02-26', '2026-03-26', '2026-04-27',
];
const iso = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

describe('Enbridge gas feed: shape it must accept (requirement 1)', () => {
  it('carries the atom 3.3 + naesb espi.xsd schemaLocation and espi: prefixes', () => {
    expect(USAGE_XML).toContain('xmlns:espi="http://naesb.org/espi"');
    expect(USAGE_XML).toContain(
      'xsi:schemaLocation="http://www.w3.org/2005/Atom https://greenbuttondata.org/xsd/3_3/atom.xsd http://naesb.org/espi https://www.naesb.org/espi.xsd"',
    );
    expect(USAGE_XML).toContain('<espi:IntervalBlock>');
    expect(USAGE_XML).toContain('https://api.enbridgegas.com/espi/1_1/resource/');
    // The parse itself is the acceptance: no throw, complete output.
    expect(feed.summaries).toHaveLength(10);
    expect(feed.groups).toHaveLength(1);
  });

  it('drops the feed clock instead of believing an 18-second Ontario', () => {
    // Enbridge stamps `tzOffset: -18` (Oakville: -18000 seconds) and two unix
    // instants where DstRuleType bitmaps belong — neither is a clock the app
    // may date anything with, so the block is dropped and the file's exact
    // UTC midnight stamps stand as the dates they literally are (AC5).
    expect(feed.localTime).toBeNull();
  });
});

describe('AC5 — the ten billing periods', () => {
  it('has exactly 10 periods on the file’s UTC dates, days = duration', () => {
    expect(feed.summaries).toHaveLength(10);
    expect(feed.summaries.map((s) => s.startDate)).toEqual(STARTS);
    expect(feed.summaries[9].endDate).toBe('2026-10-26');
    expect(feed.summaries.map((s) => s.days)).toEqual(DAYS);
    // dayKey (the UTC date) is the raw stamp: no −18 s or DST rule shifts it.
    for (const s of feed.summaries) {
      expect(iso(s.start)).toBe(s.startDate);
    }
  });
});

describe('AC6/AC7/AC10 — money, scaled from each line’s own measurement', () => {
  it('reads Amount Due per period and sums to $1,098.64', () => {
    const dues = feed.summaries.map((s) => amountOf(s, 'Amount Due'));
    expect(dues.map(round2)).toEqual(DUE);
    expect(round2(dues.reduce((a, b) => a + b, 0))).toBe(1098.64);
  });

  it('reads Total Gas Charges per period and sums to $1,073.29', () => {
    const totals = feed.summaries.map((s) => amountOf(s, 'Total Gas Charges ($)'));
    expect(totals.map(round2)).toEqual(TOTALS);
    expect(round2(totals.reduce((a, b) => a + b, 0))).toBe(1073.29);
  });

  it('Amount Due == billLastPeriod == billToDate, 10/10', () => {
    for (const s of feed.summaries) {
      const due = amountOf(s, 'Amount Due');
      expect(s.billLastPeriod).toBe(due);
      expect(s.billToDate).toBe(due);
    }
  });
});

describe('AC8/AC9 — the corrected 5-term identity and HST', () => {
  it('supply + delivery + GCA + customer + HST == Total Gas Charges, raw-for-raw 10/10', () => {
    for (const s of feed.summaries) {
      const sum =
        rawOf(s, 'Gas Supply Charge') +
        rawOf(s, 'Gas Delivery Variable Charge') +
        rawOf(s, 'Gas Cost Adjustment ($)') +
        rawOf(s, 'Customer charge') +
        rawOf(s, 'HST ($)');
      expect(sum).toBe(rawOf(s, 'Total Gas Charges ($)'));
    }
  });

  it('never uses the 6-term form: provider-supply == supply (the double count)', () => {
    for (const s of feed.summaries) {
      expect(rawOf(s, 'Gas Service Provider Supply Charge ($)')).toBe(
        rawOf(s, 'Gas Supply Charge'),
      );
    }
  });

  it('HST = 13.00% of the four pre-tax lines within ±$0.01, 10/10', () => {
    for (const s of feed.summaries) {
      const pretax =
        amountOf(s, 'Gas Supply Charge') +
        amountOf(s, 'Gas Delivery Variable Charge') +
        amountOf(s, 'Gas Cost Adjustment ($)') +
        amountOf(s, 'Customer charge');
      expect(Math.abs(amountOf(s, 'HST ($)') - 0.13 * pretax)).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('AC11 — the ¢/m³ rate-line trap', () => {
  const RATES = [
    'Gas Supply Rate ¢/m3',
    'Gas Cost Adjustment ¢/m3',
    'Total Gas Supply Rate ¢/m3 (net)',
  ];

  it('keeps rate lines apart from money lines, notes matched exactly', () => {
    for (const s of feed.summaries) {
      for (const note of RATES) {
        const l = line(s, note);
        expect(l.amount).not.toBeNull();
        // A rate, not a dollar figure: 20.4037 ¢/m³ in period 1, never $204,037.
        expect(Math.abs(l.amount as number)).toBeLessThan(100);
      }
      expect(line(s, 'Gas Cost Adjustment ($)').amount).not.toBeNull();
    }
    // Period 1's supply rate is the published ¢/m³ figure.
    expect(amountOf(feed.summaries[0], 'Gas Supply Rate ¢/m3')).toBeCloseTo(20.4037, 4);
  });

  it('a sum that mixes rates into amounts fails both bill totals', () => {
    for (const [i, s] of feed.summaries.entries()) {
      const mixed = s.items.reduce((acc, l) => acc + (l.amount ?? 0), 0);
      expect(round2(mixed)).not.toBe(DUE[i]);
      expect(round2(mixed)).not.toBe(TOTALS[i]);
    }
  });
});

describe('AC12/AC13 — bill volume vs meter reads vs unadjusted usage', () => {
  it('volume = currentBillingPeriodOverAllConsumption = round(unadjusted × 1.0057)', () => {
    for (const [i, s] of feed.summaries.entries()) {
      expect(s.volume).not.toBeNull();
      expect(s.volume?.scaled).toBe(BILLED_VOLUME[i]);
      expect(s.volume?.uom).toBe(42);
      expect(usageUnadjusted(s)).toBeCloseTo(UNADJUSTED[i], 3);
      expect(s.volume?.scaled).toBe(Math.round(UNADJUSTED[i] * 1.0057));
      // The field the parser used to read is 0 in every Enbridge period —
      // it must never be what a gas period shows.
      expect(s.consumption?.scaled).toBe(0);
    }
  });

  it('meter reads give the unadjusted delta, distinct from the billed volume', () => {
    for (const [i, s] of feed.summaries.entries()) {
      const reads = meterReadVolume(s);
      expect(reads).not.toBeNull();
      expect(reads?.delta).toBe(READ_DELTA[i]);
      // AC: meter-read delta matches Usage (unadjusted) within 1.0057 (≤0.47 m³).
      // Rounded to milli-metres first: 268 − 268.47 is 0.4699999999999893 in
      // binary floats, and the bound is about the figures, not the noise.
      const gap = Math.round(Math.abs((reads?.delta ?? 0) - UNADJUSTED[i]) * 1000) / 1000;
      expect(gap).toBeLessThanOrEqual(0.47);
      // Never conflated: period 1 is three different, all-legitimate numbers.
      expect(s.volume?.scaled).not.toBe(reads?.delta);
      expect(reads?.delta).not.toBe(UNADJUSTED[i]);
    }
    const first = meterReadVolume(feed.summaries[0]);
    expect(first).toEqual({ current: 1175, previous: 748, delta: 427 });
  });
});

describe('AC14/AC16 — the five IntervalBlocks', () => {
  const series = feed.groups.flatMap((g) => g.series);
  const readings = series.flatMap((s) => s.readings);

  it('parses exactly five one-reading blocks with the published m³ values', () => {
    expect(readings).toHaveLength(5);
    expect(readings.map((r) => r.m3)).toEqual(BLOCK_VALUES);
    expect(readings.map((r) => r.duration_s)).toEqual(BLOCK_DURATIONS);
    expect(readings.map((r) => iso(r.timestamp))).toEqual(BLOCK_STARTS);
    // Volume is never energy: kwh stays null everywhere.
    expect(readings.every((r) => r.kwh === null)).toBe(true);
  });

  it('recognises commodity 7 / uom 42 / powerOfTenMultiplier −3 as volume', () => {
    expect(series.length).toBeGreaterThanOrEqual(1);
    for (const s of series) {
      expect(s.status).toBe('volume');
      expect(s.meta.commodity).toBe(7);
      expect(s.meta.uom).toBe(42);
      expect(s.meta.powerOfTenMultiplier).toBe(-3);
      expect(s.dropped).toEqual({ negative: 0, unparsable: 0, magnitude: 0 });
    }
    const notes = [...feed.notes, ...feed.groups.flatMap((g) => g.notes)];
    expect(notes.some((n) => n.code === 'volume-series')).toBe(true);
    // Gas is no longer refused, and nothing here is priced as electricity.
    expect(notes.some((n) => n.code === 'unsupported-series')).toBe(false);
    expect(feed.groups.every((g) => g.readings.length === 0)).toBe(true);
  });

  it('covers periods 1–4 monthly plus the 1-day stub; periods 6–10 have no block', () => {
    // Period 5 carries only the 1-day block (2026-04-27, 86400 s) — that is
    // not a monthly reading, and no reading exists on or after 2026-05-27.
    expect(readings[4].duration_s).toBe(86400);
    const period6Start = Date.parse('2026-05-27T00:00:00Z') / 1000;
    expect(readings.every((r) => r.timestamp < period6Start)).toBe(true);
  });
});

/**
 * AC2/AC4/requirement 5 — the account file: labels only, and never silent.
 * Synthetic identifiers throughout; the real download's customer, account and
 * meter values are never committed (AC3).
 */
const ACCOUNT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xmlns:cust="http://naesb.org/espi/customer"
      xsi:schemaLocation="http://www.w3.org/2005/Atom https://greenbuttondata.org/xsd/3_3/atom.xsd http://naesb.org/espi/customer https://naesb.org/copyright/customer.xsd">
  <id>urn:uuid:1a2b3c4d-aeaa-5abc-8def-000000002026</id>
  <title>Customer Feed</title>
  <updated>2026-11-07T02:02:05Z</updated>
  <entry>
    <content>
      <LocalTimeParameters>
        <dstEndRule>6AE6E370</dstEndRule>
        <dstOffset>3600</dstOffset>
        <dstStartRule>69AD1E70</dstStartRule>
        <tzOffset>-18</tzOffset>
      </LocalTimeParameters>
    </content>
    <id>urn:uuid:a0000001-0000-4000-8000-000000000001</id>
    <title>DST For North America</title>
    <updated>2026-11-07T02:02:05Z</updated>
    <link rel="self" href="https://api.enbridgegas.com/espi/1_1/resource/LocalTimeParameters/002026" type="cust-entry/LocalTimeParameters"/>
    <link rel="up" href="https://api.enbridgegas.com/espi/1_1/resource/LocalTimeParameters" type="cust-feed/LocalTimeParameters"/>
  </entry>
  <entry>
    <content>
      <Customer>
        <kind>Residential Customer</kind>
        <customerName>TEST CUSTOMER</customerName>
      </Customer>
    </content>
    <id>urn:uuid:a0000002-0000-4000-8000-000000000002</id>
    <title>Customer</title>
    <updated>2026-11-07T02:02:05Z</updated>
    <link rel="self" href="https://api.enbridgegas.com/espi/1_1/resource/RetailCustomer/SYNTHETIC-SUB/Customer" type="cust-entry/Customer"/>
  </entry>
  <entry>
    <content>
      <CustomerAccount>
        <accountId>000000000000</accountId>
      </CustomerAccount>
    </content>
    <id>urn:uuid:a0000003-0000-4000-8000-000000000003</id>
    <title>Customer Account</title>
    <updated>2026-11-07T02:02:05Z</updated>
    <link rel="self" href="https://api.enbridgegas.com/espi/1_1/resource/RetailCustomer/SYNTHETIC-SUB/Customer/a0000002-0000-4000-8000-000000000002/CustomerAccount/a0000003-0000-4000-8000-000000000003" type="cust-entry/CustomerAccount"/>
  </entry>
  <entry>
    <content>
      <CustomerAgreement>
        <agreementId>0000000001</agreementId>
      </CustomerAgreement>
    </content>
    <id>urn:uuid:a0000004-0000-4000-8000-000000000004</id>
    <title>Customer Agreement</title>
    <updated>2026-11-07T02:02:05Z</updated>
    <link rel="self" href="https://api.enbridgegas.com/espi/1_1/resource/RetailCustomer/SYNTHETIC-SUB/Customer/a0000002-0000-4000-8000-000000000002/CustomerAccount/a0000003-0000-4000-8000-000000000003/CustomerAgreement/a0000004-0000-4000-8000-000000000004" type="cust-entry/CustomerAgreement"/>
  </entry>
  <entry>
    <content>
      <ServiceLocation>
        <mainAddress>
          <streetDetail>
            <addressGeneral>1 SYNTHETIC STREET</addressGeneral>
          </streetDetail>
          <townDetail>
            <name>SYNTHETOWN</name>
            <stateOrProvince>ON</stateOrProvince>
            <country>CA</country>
          </townDetail>
          <postalCode>A1A 1A1</postalCode>
        </mainAddress>
      </ServiceLocation>
    </content>
    <id>urn:uuid:a0000005-0000-4000-8000-000000000005</id>
    <title>Service Location</title>
    <updated>2026-11-07T02:02:05Z</updated>
    <link rel="self" href="https://api.enbridgegas.com/espi/1_1/resource/RetailCustomer/SYNTHETIC-SUB/Customer/a0000002-0000-4000-8000-000000000002/CustomerAccount/a0000003-0000-4000-8000-000000000003/CustomerAgreement/a0000004-0000-4000-8000-000000000004/ServiceLocation/a0000005-0000-4000-8000-000000000005" type="cust-entry/ServiceLocation"/>
  </entry>
  <entry>
    <content>
      <ServiceSupplier>
        <Organisation>
          <organisationName>Synthetic Gas Co</organisationName>
        </Organisation>
      </ServiceSupplier>
    </content>
    <id>urn:uuid:a0000006-0000-4000-8000-000000000006</id>
    <title>Service Supplier</title>
    <updated>2026-11-07T02:02:05Z</updated>
    <link rel="self" href="https://api.enbridgegas.com/espi/1_1/resource/ServiceSupplier/a0000006-0000-4000-8000-000000000006" type="cust-entry/ServiceSupplier"/>
  </entry>
  <entry>
    <content>
      <Meter>
        <serialNumber>SYNTH-0001</serialNumber>
        <intervalLength>2592000</intervalLength>
      </Meter>
    </content>
    <id>urn:uuid:a0000007-0000-4000-8000-000000000007</id>
    <title>Meter</title>
    <updated>2026-11-07T02:02:05Z</updated>
    <link rel="self" href="https://api.enbridgegas.com/espi/1_1/resource/RetailCustomer/SYNTHETIC-SUB/Customer/a0000002-0000-4000-8000-000000000002/CustomerAccount/a0000003-0000-4000-8000-000000000003/CustomerAgreement/a0000004-0000-4000-8000-000000000004/ServiceLocation/a0000005-0000-4000-8000-000000000005/Meter/a0000007-0000-4000-8000-000000000007" type="cust-entry/Meter"/>
  </entry>
</feed>`;

const accountFeed = parseGreenButtonFeed(ACCOUNT_XML);

describe('AC2/AC4/requirement 5 — the account file is enrichment, never silence', () => {
  it('parses the labels and carries no bill or usage numbers of its own', () => {
    expect(accountFeed.summaries).toHaveLength(0);
    expect(accountFeed.groups).toHaveLength(0);
    expect(accountFeed.account).toEqual({
      customerName: 'TEST CUSTOMER',
      customerKind: 'Residential Customer',
      accountId: '000000000000',
      agreementId: '0000000001',
      supplier: 'Synthetic Gas Co',
      meterSerial: 'SYNTH-0001',
      meterIntervalLength: 2592000,
      serviceAddress: '1 SYNTHETIC STREET, SYNTHETOWN, ON A1A 1A1',
    });
    // Same clock quirk as the usage file: `tzOffset: -18` + unix-instant
    // rules describe no zone, so the account file's clock is dropped too.
    expect(accountFeed.localTime).toBeNull();
  });

  it('raises an explicit account-details note instead of parsing to silence', () => {
    expect(accountFeed.notes).toHaveLength(1);
    expect(accountFeed.notes[0]).toMatchObject({
      code: 'account-details',
      params: {
        supplier: 'Synthetic Gas Co',
        accountId: '000000000000',
        serial: 'SYNTH-0001',
      },
    });
    expect(accountFeed.notes[0].detail).toContain('labels only');
  });

  it('the usage file itself carries no account labels (account stays null)', () => {
    expect(feed.account).toBeNull();
    expect(feed.notes.some((n) => n.code === 'account-details')).toBe(false);
  });
});
