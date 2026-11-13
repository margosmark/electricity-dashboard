/**
 * A refused import is a NO-OP on everything this browser has persisted.
 *
 * The hardening wave (t_941b3ceb, t_e33fc656, t_1fca89fa, c3a89cb) taught the
 * parser to REFUSE what it cannot read honestly: an unsupported unit, an
 * exported/register series, a magnitude no meter can publish, a truncated
 * document. This file pins the other half of that promise — that a refusal
 * moves NOTHING in the profile.
 *
 * The assertion is a whole-store snapshot, not "the rows are unchanged". The
 * failure mode worth catching is the SECOND write of an import (the example
 * flag being cleared, the bill list being replaced, the feed clock being
 * written) landing after the first one was refused, which a rows-only check
 * cannot see. The seeded profile therefore deliberately holds every key an
 * import can touch — readings, bills, the feed's own clock, the provenance
 * flag and Wave N's account revision/key — and a control case proves a GOOD
 * file does change that snapshot, so a green run cannot be the degenerate
 * "nothing ever writes" green.
 *
 * Run: npx vitest run src/components/FailedImportAtomicity.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Dashboard from './Dashboard';
import { parseGreenButtonFeed, parseUsageSummaries } from '@/lib/energy';
import { ENERGY_KEY_V2, BILLING_DAY_KEY } from '@/lib/storage';
import {
  EXAMPLE_DATA_KEY,
  LOCAL_TIME_KEY,
  USAGE_SUMMARIES_KEY,
} from '@/hooks/useDashboard';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(HERE, '../..');
const FIXTURES = path.join(WEBAPP, 'tests/fixtures');

const RATES = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
    },
  ],
};

/* ==========================================================================
 * The seeded profile — every key an import can reach
 * ========================================================================== */

/** 2024-01-01T00:00Z and +1h, so the fixture is TZ-independent. */
const EXISTING = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.0 },
];

const SUMMARY_XML = fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8');
const SEED_SUMMARIES = parseUsageSummaries(SUMMARY_XML);
const SEED_CLOCK = parseGreenButtonFeed(SUMMARY_XML).localTime;

function seedProfile(): void {
  localStorage.setItem(
    ENERGY_KEY_V2,
    JSON.stringify({
      version: 2,
      uploadedAt: '2024-01-01T00:00:00.000Z',
      source: 'seed',
      points: EXISTING,
    }),
  );
  localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(SEED_SUMMARIES));
  localStorage.setItem(LOCAL_TIME_KEY, JSON.stringify(SEED_CLOCK));
  localStorage.setItem(BILLING_DAY_KEY, '1');
  // The provenance flag is the sharpest key here: the commit writes the rows
  // and the flag as one unit, so a refusal that flips the flag lies about the
  // rows that ARE persisted.
  localStorage.setItem(EXAMPLE_DATA_KEY, '1');
  // Wave N: the account layer's own state, which no import may touch.
  localStorage.setItem('account_sync_rev', '7');
  localStorage.setItem('account_blob_key', 'AAAAAAAAAAAAAAAAAAAAAA==');
}

function snapshot(): string {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i) as string);
  return keys
    .sort()
    .map((k) => `${k} = ${localStorage.getItem(k)}`)
    .join('\n');
}

/* ==========================================================================
 * Documents — one ESPI variation each
 * ========================================================================== */

function espiFeed(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${entries}</feed>`;
}

type RtSpec = {
  uom?: number | string;
  mult?: number | string;
  ab?: number;
  commodity?: number;
  fd?: number;
  kind?: number;
};

function readingTypeEl(o: RtSpec): string {
  const el = (n: string, v: number | string | undefined) =>
    v === undefined ? '' : `<espi:${n}>${v}</espi:${n}>`;
  return `<espi:ReadingType>${el('uom', o.uom)}${el('powerOfTenMultiplier', o.mult)}${el(
    'accumulationBehaviour',
    o.ab,
  )}${el('commodity', o.commodity)}${el('flowDirection', o.fd)}${el('kind', o.kind)}</espi:ReadingType>`;
}

/** One UsagePoint, one ReadingType, one IntervalBlock. */
function simpleDoc(rt: RtSpec, readings: [start: number, value: number | string][]): string {
  const rs = readings
    .map(
      ([start, value]) =>
        `<espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading>`,
    )
    .join('');
  return espiFeed(
    [
      '<entry><link rel="self" href="/ReadingType/rt-1"/><content>' + readingTypeEl(rt) + '</content></entry>',
      '<entry><link rel="self" href="/UsagePoint/up-1/MeterReading/mr-1"/><link rel="related" href="/ReadingType/rt-1"/><content><espi:MeterReading/></content></entry>',
      `<entry><link rel="self" href="/UsagePoint/up-1/MeterReading/mr-1/IntervalBlock/ib-1"/><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${readings[0][0]}</espi:start></espi:interval>${rs}</espi:IntervalBlock></content></entry>`,
    ].join('\n'),
  );
}

/** Active energy in Wh, delivered — the one shape that is always billable. */
const SUPPORTED_RT: RtSpec = { uom: 72, mult: 0, ab: 4, commodity: 1, fd: 1, kind: 12 };

/** 2024-01-02T00:00Z — deliberately NOT a timestamp the seed already holds. */
const GOOD_FEED = simpleDoc(SUPPORTED_RT, [[1704153600, 1500]]);

const REFUSED: Array<[string, string]> = [
  ['not XML at all', 'this is not xml at all, and it never will be'],
  ['a saved login page', '<!DOCTYPE html><html><body>Please sign in to continue</body></html>'],
  ['a truncated document', '<?xml version="1.0"?>\n<feed>\n  <entry>\n</feed>'],
  [
    'a feed whose entries carry no readings',
    '<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>UsagePoint</title></entry><entry><title>MeterReading</title></entry></feed>',
  ],
  ['natural gas (commodity 7)', simpleDoc({ ...SUPPORTED_RT, commodity: 7 }, [[1704153600, 1500]])],
  ['exported energy (flowDirection 19)', simpleDoc({ ...SUPPORTED_RT, fd: 19 }, [[1704153600, 1500]])],
  ['a register (accumulationBehaviour 1)', simpleDoc({ ...SUPPORTED_RT, ab: 1 }, [[1704153600, 1500]])],
  ['a money series (uom 80)', simpleDoc({ ...SUPPORTED_RT, uom: 80 }, [[1704153600, 1500]])],
  ['an undefined unit (uom 999)', simpleDoc({ ...SUPPORTED_RT, uom: 999 }, [[1704153600, 1500]])],
  ['a value no interval can hold (1e308)', simpleDoc(SUPPORTED_RT, [[1704153600, '1e308']])],
  ['negative consumption', simpleDoc(SUPPORTED_RT, [[1704153600, -1500]])],
];

/* ==========================================================================
 * Harness
 * ========================================================================== */

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function textResponse(body: string) {
  return { ok: true, status: 200, json: async () => ({}), text: async () => body };
}

function stubFetch(handler?: (url: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const custom = handler?.(url);
      if (custom) return custom;
      if (url.includes('/api/rates')) return jsonResponse(RATES);
      return jsonResponse({});
    }),
  );
}

/** Seed the profile, render the dashboard onto it and open the upload modal. */
async function bootWithProfile(): Promise<HTMLInputElement> {
  seedProfile();
  render(<Dashboard />);
  await waitFor(() =>
    expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument(),
  );
  await userEvent.setup().click(screen.getByTitle('Upload XML'));
  const input = document.querySelector(
    'input[type="file"][accept=".xml"]',
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  return input;
}

/** Pick file(s) and wait for the modal's parse verdict to land. */
async function pick(input: HTMLInputElement, files: Array<[string, string]>): Promise<void> {
  const user = userEvent.setup();
  await user.upload(
    input,
    files.map(([name, body]) => new File([body], name, { type: 'text/xml' })),
  );
  await screen.findByTestId('parse-diagnostic');
  // `disabled={parsing}` on the input is the end of handleFileUpload's chain:
  // once it is back, every write the attempt was going to make has happened.
  await waitFor(() => expect(input).not.toBeDisabled());
}

function storedRows(): Array<{ timestamp: number; usage_kwh: number }> {
  const raw = localStorage.getItem(ENERGY_KEY_V2);
  return raw ? (JSON.parse(raw).points as Array<{ timestamp: number; usage_kwh: number }>) : [];
}

beforeEach(() => {
  localStorage.clear();
  stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/* ==========================================================================
 * Tests
 * ========================================================================== */

describe('a refused document never moves the persisted profile', () => {
  it.each(REFUSED)('%s', async (name, xml) => {
    const input = await bootWithProfile();
    const before = snapshot();

    await pick(input, [[`${name.replace(/[^a-z0-9]+/gi, '-')}.xml`, xml]]);

    expect(snapshot(), 'a refused import changed persisted state').toBe(before);
    expect(storedRows()).toEqual(EXISTING);
    expect(
      localStorage.getItem(EXAMPLE_DATA_KEY),
      'the example flag must still describe the rows on disk',
    ).toBe('1');
  });

  it('a batch holding an unreadable file writes nothing until the review is confirmed', async () => {
    const input = await bootWithProfile();
    const before = snapshot();

    const user = userEvent.setup();
    await user.upload(input, [
      new File([GOOD_FEED], 'good.xml', { type: 'text/xml' }),
      new File(['<!DOCTYPE html><html><body>Please sign in</body></html>'], 'login-page.xml', {
        type: 'text/xml',
      }),
    ]);

    // A batch goes to the merge review, refused file and all — and the review
    // is a real gate: nothing is written while it is on screen.
    const review = await screen.findByTestId('merge-review');
    expect(review).toHaveTextContent('login-page.xml');
    expect(snapshot(), 'the review screen wrote to storage').toBe(before);
    expect(storedRows()).toEqual(EXISTING);
  });

  it('CONTROL: the same document, unrefused, does change it', async () => {
    const input = await bootWithProfile();
    const before = snapshot();

    const user = userEvent.setup();
    await user.upload(input, new File([GOOD_FEED], 'good.xml', { type: 'text/xml' }));
    await waitFor(() => expect(storedRows()).toHaveLength(1));

    expect(storedRows()).toEqual([{ timestamp: 1704153600, usage_kwh: 1.5 }]);
    expect(snapshot()).not.toBe(before);
    // The file carries no bills, so the upload REPLACES the bill feed: both
    // bill keys go, and the provenance flag goes with the rows that landed.
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).toBeNull();
    expect(localStorage.getItem(LOCAL_TIME_KEY)).toBeNull();
    expect(localStorage.getItem(EXAMPLE_DATA_KEY)).toBeNull();
  });

  /**
   * The boundary, stated rather than implied: a refused READING SERIES never
   * contributes a row — and a document's bills are a separate stream that a
   * confirmed merge still takes, which is how a bill-only export gets in
   * (`tests/fixtures/usage-summary-synthetic.xml` is exactly that shape). The
   * review screen says per file how many readings each one contributed, so the
   * bill half is disclosed, never smuggled.
   */
  it('a refused series contributes no rows, while a confirmed merge still takes the bills', async () => {
    const REFUSED_WITH_BILLS = SUMMARY_XML.replace(
      '</feed>',
      `<entry><link rel="self" href="/ReadingType/rt-gas"/><content><espi:ReadingType><espi:uom>72</espi:uom><espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:accumulationBehaviour>4</espi:accumulationBehaviour><espi:commodity>7</espi:commodity><espi:flowDirection>1</espi:flowDirection><espi:kind>12</espi:kind></espi:ReadingType></content></entry>
<entry><link rel="self" href="/UsagePoint/up-gas/MeterReading/mr-1"/><link rel="related" href="/ReadingType/rt-gas"/><content><espi:MeterReading/></content></entry>
<entry><link rel="self" href="/UsagePoint/up-gas/MeterReading/mr-1/IntervalBlock/ib-1"/><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>1704240000</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1704240000</espi:start></espi:timePeriod><espi:value>1500</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry>
</feed>`,
    );

    const input = await bootWithProfile();
    const user = userEvent.setup();
    await user.upload(input, [
      new File([GOOD_FEED], 'good.xml', { type: 'text/xml' }),
      new File([REFUSED_WITH_BILLS], 'gas.xml', { type: 'text/xml' }),
    ]);

    const review = await screen.findByTestId('merge-review');
    // The refused file is named as carrying no readings, and only the good
    // file's row is on offer.
    expect(review).toHaveTextContent('gas.xml');
    expect(screen.getByTestId('merge-rows')).toHaveTextContent('1');

    await user.click(screen.getByTestId('merge-confirm'));
    await waitFor(() => expect(storedRows()).toHaveLength(1));

    expect(storedRows()).toEqual([{ timestamp: 1704153600, usage_kwh: 1.5 }]);
    expect(
      storedRows().some((r) => r.timestamp === 1704240000),
      'the refused gas series contributed a row',
    ).toBe(false);
    // …and the bills the same refused document carried DID land, by design:
    // they are the file's other stream, the review screen disclosed them, and
    // filtering them out here would break the bill-only export above.
    const persistedSummaries = JSON.parse(
      localStorage.getItem(USAGE_SUMMARIES_KEY) as string,
    ) as unknown[];
    expect(persistedSummaries).toHaveLength(SEED_SUMMARIES.length);
  });
});

describe('a write that fails to land leaves the profile consistent', () => {
  it('quota: a refused readings write does not clear the flag that describes the stored rows', async () => {
    const input = await bootWithProfile();
    const rowsBefore = localStorage.getItem(ENERGY_KEY_V2);

    // Only the readings write fails — a full disk, not blocked storage.
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === ENERGY_KEY_V2) throw new DOMException('quota reached', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });

    const user = userEvent.setup();
    await user.upload(input, new File([GOOD_FEED], 'good.xml', { type: 'text/xml' }));
    // The modal closes when the import reaches its end: that (not the input's
    // `disabled` flag, which belongs to a node React replaces) is the end of
    // the attempt.
    await waitFor(() =>
      expect(document.querySelector('[data-testid="upload-modal"]')).toBeNull(),
    );

    expect(
      localStorage.getItem(ENERGY_KEY_V2),
      'the refused write must not alter the payload',
    ).toBe(rowsBefore);
    // commitReadings documents the flag as "written or cleared atomically with
    // the readings themselves": the rows on disk are still the example set, so
    // the flag must still say so.
    expect(localStorage.getItem(EXAMPLE_DATA_KEY)).toBe('1');
    // The user IS told; the failure is surfaced, never silent.
    expect(screen.getByTestId('storage-notice')).toHaveTextContent(/browser storage/i);
    // Nothing here belongs to the account layer.
    expect(localStorage.getItem('account_sync_rev')).toBe('7');
    expect(localStorage.getItem('account_blob_key')).toBe('AAAAAAAAAAAAAAAAAAAAAA==');
    // NOT asserted as unchanged, deliberately: the bill half follows the
    // upload's documented replace semantics (the axis is a separate stream
    // from the readings), so a file with no bills clears them even when its
    // readings write was refused. That asymmetry is reported to the owner
    // rather than silently pinned here.
  });
});

describe('a feed the shim pipes but the app cannot parse', () => {
  const GB_STATUS = {
    configured: true,
    unconfiguredReason: null,
    connected: true,
    tokenPersistence: 'file',
    tokenExpiresAt: null,
    lastSyncAt: null,
    lastSyncBytes: null,
    dataAvailableSince: null,
    redirectUri: 'https://energy.example/greenbutton/callback',
  };

  it('leaves storage alone instead of importing half of it', async () => {
    const MALFORMED_FEED = espiFeed(
      '<entry><link rel="self" href="/UsagePoint/up-1/MeterReading/mr-1/IntervalBlock/ib-1"/><content><espi:IntervalBlock>',
    );
    stubFetch((url) => {
      if (url.includes('/greenbutton/status')) return jsonResponse(GB_STATUS);
      if (url.includes('/greenbutton/usage')) return textResponse(MALFORMED_FEED);
      return undefined;
    });

    await bootWithProfile();
    const before = snapshot();
    // The sync is a boot-time effect: wait until the shim was actually asked.
    await waitFor(() =>
      expect(
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes('/greenbutton/usage'),
        ),
      ).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(snapshot(), 'an unparseable live feed was persisted').toBe(before);
    expect(storedRows()).toEqual(EXISTING);
  });
});
