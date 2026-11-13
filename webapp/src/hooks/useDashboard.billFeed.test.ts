/**
 * The bill half's storage contract (sec F2, t_3fc4c902).
 *
 * `writeStoredBillFeed` used to swallow every failure in an empty catch: no
 * return value, no notice, nothing to distinguish "saved" from "quota hit".
 * That was survivable while a gas import ALSO committed electric DataPoints —
 * but commodity 7 commits ZERO of them (countUsableRows counts volume rows,
 * commitReadings receives `groups[0].readings`, which is empty), so
 * `usage_summaries` is the ONLY persisted copy of a gas user's data. Silent
 * there means: import looks successful, reload finds 0 periods.
 *
 * Both halves are pinned here — the verdict the writer returns, and the
 * notice row the hook raises from it — because a returned failure nobody
 * renders would be the same bug with better types.
 *
 * FIXTURE POLICY: SYNTHETIC only (tests/fixtures/enbridge-gas-synthetic.xml).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ChangeEvent } from 'react';

import {
  useEnergyData,
  ensureBillPartition,
  writeStoredBillFeed,
  readStoredBillFeed,
  readStoredGasBillFeed,
  USAGE_SUMMARIES_KEY,
  LOCAL_TIME_KEY,
  GAS_USAGE_SUMMARIES_KEY,
  GAS_LOCAL_TIME_KEY,
} from './useDashboard';
import { parseGreenButtonFeed } from '@/lib/energy';
import { isGasSummary } from '@/lib/gasBillUi';

const GAS_XML = readFileSync(
  join(__dirname, '../../tests/fixtures/enbridge-gas-synthetic.xml'),
  'utf8',
);
const ELEC_XML = readFileSync(
  join(__dirname, '../../tests/fixtures/green-button-alliance-sample.xml'),
  'utf8',
);
const FEED = parseGreenButtonFeed(GAS_XML);
/** The electric half's writer works on electricity — see the split below. */
const ELEC_FEED = parseGreenButtonFeed(ELEC_XML);
/** The synthetic feed declares no clock (the Enbridge clock block is dropped
 *  by the feed-quirks fix), so the clock write is exercised with one. */
const CLOCK = { tzOffset: -18000, dstOffset: 3600, dstStartRule: null, dstEndRule: null };

function quotaError(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

const originalSetItem = Storage.prototype.setItem;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ historicalRates: [] }) }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('writeStoredBillFeed — the verdict the caller renders', () => {
  it('writes both keys and reports a clean result when storage cooperates', () => {
    const result = writeStoredBillFeed({
      summaries: ELEC_FEED.summaries,
      localTime: CLOCK,
      source: 'test',
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(localStorage.getItem(USAGE_SUMMARIES_KEY)!)).toHaveLength(
      ELEC_FEED.summaries.length,
    );
    expect(localStorage.getItem(LOCAL_TIME_KEY)).not.toBeNull();
  });

  it('routes a GAS feed handed to the electric writer into the gas keys', () => {
    // Legacy callers (a pre-split read, the /import page) may still hand gas
    // periods to this function. They must be parked on the gas side — never
    // written to `usage_summaries`, never dropped.
    const result = writeStoredBillFeed({
      summaries: FEED.summaries,
      localTime: CLOCK,
      source: 'test',
    });

    expect(result.ok).toBe(true);
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY)!)).toHaveLength(10);
    expect(localStorage.getItem(GAS_LOCAL_TIME_KEY)).not.toBeNull();
    expect(readStoredBillFeed().summaries).toHaveLength(0);
    expect(readStoredGasBillFeed().summaries).toHaveLength(10);
  });

  it('returns a QUOTA failure naming the key, instead of swallowing it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key === USAGE_SUMMARIES_KEY) throw quotaError();
      return undefined;
    });

    const result = writeStoredBillFeed({
      summaries: ELEC_FEED.summaries,
      localTime: ELEC_FEED.localTime,
      source: 'test',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('quota');
    expect(result.detail).toContain(USAGE_SUMMARIES_KEY);
    expect(result.detail).toMatch(/quota/i);
    // Nothing was persisted under the failed key: no half-written bill list.
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).toBeNull();
  });

  it('removes an empty feed through the same verdict path', () => {
    localStorage.setItem(USAGE_SUMMARIES_KEY, '["stale"]');
    expect(
      writeStoredBillFeed({ summaries: [], localTime: null, source: null }).ok,
    ).toBe(true);
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).toBeNull();
  });
});

describe('a gas import whose bill write fails is VISIBLE, not silent', () => {
  it('raises the storage notice row (same copy as the readings quota notice)', async () => {
    // Only the gas bill key fails — the readings write below must succeed, so
    // the notice that appears can only have come from the bill half. A gas
    // upload never writes `usage_summaries` any more (that is the split), so
    // the key under test is the gas one.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === GAS_USAGE_SUMMARIES_KEY) throw quotaError();
      return originalSetItem.call(this, key, value);
    });

    const { result } = renderHook(() => useEnergyData());

    const file = new File([GAS_XML], 'enbridge-gas.xml', { type: 'application/xml' });
    act(() => {
      result.current.handleFileUpload({
        target: { files: [file] },
      } as unknown as ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => expect(result.current.storageNotice).not.toBeNull(), {
      timeout: 15_000,
    });
    const notice = result.current.storageNotice!;
    expect(notice.kind).toBe('quota');
    expect(notice.detail).toContain(GAS_USAGE_SUMMARIES_KEY);
    expect(notice.detail).toMatch(/quota/i);

    // The in-memory bills still exist (a full disk must not throw the upload
    // away) — they are just honestly labelled as NOT persisted.
    expect(result.current.gasBillFeed.summaries).toHaveLength(10);
    expect(result.current.billFeed.summaries).toHaveLength(0);
    expect(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY)).toBeNull();
  }, 30_000);

  it('CONTROL: the same upload persists the bills when storage works', async () => {
    const { result } = renderHook(() => useEnergyData());

    const file = new File([GAS_XML], 'enbridge-gas.xml', { type: 'application/xml' });
    act(() => {
      result.current.handleFileUpload({
        target: { files: [file] },
      } as unknown as ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() => expect(result.current.gasBillFeed.summaries).toHaveLength(10), {
      timeout: 15_000,
    });
    await waitFor(() => expect(result.current.storageNotice).toBeNull(), {
      timeout: 15_000,
    });
    // Gas bills live under the gas key; the electric key is not addressed by
    // a gas upload at all.
    expect(JSON.parse(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY)!)).toHaveLength(10);
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).toBeNull();
    expect(result.current.billFeed.summaries).toHaveLength(0);
  }, 30_000);
});

/* ==========================================================================
 * The migration itself (t_8a9038d6): a pre-split browser holds BOTH
 * commodities in ONE array. The split must move gas across without losing a
 * single period, and a FAILED gas write must leave the original bytes alone.
 * ========================================================================== */

describe('ensureBillPartition — non-destructive split of a legacy mixed array', () => {
  it('parks every gas period in the gas key and keeps every electric period', () => {
    const electric = ELEC_FEED.summaries;
    const gas = FEED.summaries;
    expect(electric.length).toBeGreaterThan(0);
    expect(gas).toHaveLength(10);
    // The pre-split shape: both commodities, one array.
    localStorage.setItem(USAGE_SUMMARIES_KEY, JSON.stringify([...electric, ...gas]));

    const res = ensureBillPartition();
    expect(res.ok).toBe(true);

    // Nothing dropped: 10 gas periods moved, electric periods stayed.
    expect(JSON.parse(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY)!)).toHaveLength(10);
    expect(JSON.parse(localStorage.getItem(USAGE_SUMMARIES_KEY)!)).toHaveLength(
      electric.length,
    );
    // And both READS see their own side — on-read partition included.
    expect(readStoredGasBillFeed().summaries).toHaveLength(10);
    expect(readStoredBillFeed().summaries).toHaveLength(electric.length);
    expect(readStoredBillFeed().summaries.every((s) => !isGasSummary(s))).toBe(true);
  });

  it('idempotent: a second run changes nothing', () => {
    localStorage.setItem(
      USAGE_SUMMARIES_KEY,
      JSON.stringify([...ELEC_FEED.summaries, ...FEED.summaries]),
    );
    expect(ensureBillPartition().ok).toBe(true);
    const afterFirst = [
      localStorage.getItem(USAGE_SUMMARIES_KEY),
      localStorage.getItem(GAS_USAGE_SUMMARIES_KEY),
    ];
    expect(ensureBillPartition().ok).toBe(true);
    expect([
      localStorage.getItem(USAGE_SUMMARIES_KEY),
      localStorage.getItem(GAS_USAGE_SUMMARIES_KEY),
    ]).toEqual(afterFirst);
  });

  it('a FAILED gas write leaves the legacy array byte-for-byte untouched', () => {
    const mixed = JSON.stringify([...ELEC_FEED.summaries, ...FEED.summaries]);
    localStorage.setItem(USAGE_SUMMARIES_KEY, mixed);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key === GAS_USAGE_SUMMARIES_KEY) throw quotaError();
      return undefined;
    });

    const res = ensureBillPartition();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('quota');

    // The safety property: the gas copy is written FIRST, so a failure means
    // the original is still exactly where it was — no half-migrated store.
    expect(localStorage.getItem(GAS_USAGE_SUMMARIES_KEY)).toBeNull();
    expect(localStorage.getItem(USAGE_SUMMARIES_KEY)).toBe(mixed);
  });
});
