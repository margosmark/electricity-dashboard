/**
 * `/import` — the same promise as the upload modal, on the page that takes a
 * pasted/dropped export: a payload the parser refuses leaves the profile
 * exactly as it was.
 *
 * `tests/e2e/import.spec.ts` owns this page in a real browser; this file owns
 * the assertion the browser spec cannot make cheaply — a WHOLE-STORE snapshot
 * before and after a refused payload, so the second write of an import (the
 * provenance flag, the bill keys, the feed clock) cannot move silently. The
 * account keys are in the snapshot for the same reason: no import path may
 * touch them.
 *
 * Run: npx vitest run src/app/import/ImportPageAtomicity.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';

import ImportPage from './page';
import { parseGreenButtonFeed, parseUsageSummaries } from '@/lib/energy';
import { ENERGY_KEY_V2, BILLING_DAY_KEY } from '@/lib/storage';
import {
  EXAMPLE_DATA_KEY,
  LOCAL_TIME_KEY,
  USAGE_SUMMARIES_KEY,
} from '@/hooks/useDashboard';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../tests/fixtures');
const SUMMARY_XML = fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8');

const EXISTING = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.0 },
];

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
  localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify(parseUsageSummaries(SUMMARY_XML)));
  localStorage.setItem(LOCAL_TIME_KEY, JSON.stringify(parseGreenButtonFeed(SUMMARY_XML).localTime));
  localStorage.setItem(BILLING_DAY_KEY, '1');
  localStorage.setItem(EXAMPLE_DATA_KEY, '1');
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

function espiFeed(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${entries}</feed>`;
}

/** One UsagePoint, one ReadingType, one IntervalBlock. */
function simpleDoc(rt: string, start: number, value: string): string {
  return espiFeed(
    [
      `<entry><link rel="self" href="/ReadingType/rt-1"/><content><espi:ReadingType>${rt}</espi:ReadingType></content></entry>`,
      '<entry><link rel="self" href="/UsagePoint/up-1/MeterReading/mr-1"/><link rel="related" href="/ReadingType/rt-1"/><content><espi:MeterReading/></content></entry>',
      `<entry><link rel="self" href="/UsagePoint/up-1/MeterReading/mr-1/IntervalBlock/ib-1"/><content><espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading></espi:IntervalBlock></content></entry>`,
    ].join('\n'),
  );
}

const ELECTRIC_WH = '<espi:uom>72</espi:uom><espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:accumulationBehaviour>4</espi:accumulationBehaviour><espi:commodity>1</espi:commodity><espi:flowDirection>1</espi:flowDirection><espi:kind>12</espi:kind>';
const GAS_WH = ELECTRIC_WH.replace('<espi:commodity>1</espi:commodity>', '<espi:commodity>7</espi:commodity>');

/** 2024-01-02T00:00Z — a timestamp the seeded profile does not hold. */
const GOOD_XML = simpleDoc(`${ELECTRIC_WH}`, 1704153600, '1500');

const REFUSED_PAYLOADS: Array<[string, string]> = [
  ['not XML and not base64', 'this is not base64 or xml at all!!'],
  ['base64 that decodes to something that is not XML', Buffer.from('hello there', 'utf8').toString('base64')],
  ['a saved login page', '<!DOCTYPE html><html><body>Please sign in to continue</body></html>'],
  ['a truncated document', '<?xml version="1.0"?>\n<feed>\n  <entry>\n</feed>'],
  ['a feed with entries but no readings', '<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>UsagePoint</title></entry></feed>'],
  ['a document whose only series is refused (gas)', simpleDoc(GAS_WH, 1704153600, '1500')],
  ['a value no interval can hold', simpleDoc(ELECTRIC_WH, 1704153600, '1e308')],
  ['bills but no billable readings', SUMMARY_XML],
];

function storedRows(): Array<{ timestamp: number; usage_kwh: number }> {
  const raw = localStorage.getItem(ENERGY_KEY_V2);
  return raw ? (JSON.parse(raw).points as Array<{ timestamp: number; usage_kwh: number }>) : [];
}

/** Paste a payload into the box and load it — the page's own interaction. */
async function paste(raw: string): Promise<void> {
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByTestId('import-paste'));
  await user.paste(raw);
  await user.click(screen.getByTestId('import-load'));
}

beforeEach(() => {
  localStorage.clear();
  push.mockClear();
  seedProfile();
  render(<ImportPage />);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('/import: a refused payload writes nothing', () => {
  it.each(REFUSED_PAYLOADS)('%s', async (_name, raw) => {
    const before = snapshot();

    await paste(raw);
    await screen.findByTestId('import-error');

    expect(snapshot(), 'a refused payload changed persisted state').toBe(before);
    expect(storedRows()).toEqual(EXISTING);
    expect(push).not.toHaveBeenCalled();
  });

  it('CONTROL: a document that parses DOES write, through the same page', async () => {
    const before = snapshot();

    await paste(GOOD_XML);

    // The seeded profile is not empty, so the review is the gate…
    await screen.findByTestId('import-review');
    expect(snapshot(), 'the review screen wrote to storage').toBe(before);

    // …and confirming it is what commits (Merge: union of both sets).
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId('import-merge'));
    await waitFor(() => expect(storedRows()).toHaveLength(3));
    expect(snapshot()).not.toBe(before);
    expect(localStorage.getItem(EXAMPLE_DATA_KEY)).toBeNull();
    expect(push).toHaveBeenCalledWith('/');
  });

  it('a refused write is refused as a whole: the flag survives an unwritable payload', async () => {
    // The page writes the rows through storage.ts and returns BEFORE touching
    // the provenance flag when that write is refused — the contract
    // commitReadings documents and the reason its own path was fixed to match.
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === ENERGY_KEY_V2) throw new DOMException('quota reached', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });

    await paste(GOOD_XML);
    await screen.findByTestId('import-review');
    await userEvent.setup({ delay: null }).click(screen.getByTestId('import-replace'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(localStorage.getItem(EXAMPLE_DATA_KEY), 'the flag still describes the rows on disk').toBe('1');
    expect(storedRows()).toEqual(EXISTING);
    expect(push).not.toHaveBeenCalled();
  });
});
