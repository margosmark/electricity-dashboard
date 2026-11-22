/**
 * A stored payload already holding an undateable instant must not hang init
 * (F1's availability claim, t_bcc1b9c6). The payload is persisted first,
 * so before the ingest bound EVERY later load ran
 * `init → applyInitialWindow → selectInitialWindow` over the hostile row:
 * a synchronous infinite loop, a frozen tab, no error boundary and no
 * in-app recovery — the card's own reproducer.
 *
 * With the bound in `isDataPoint`, `loadEnergyData` reads such a payload as
 * corrupt: init says so (storage notice) and opens the upload prompt — the
 * recovery path the hang used to make unreachable.
 *
 * RED control (measured at QA gate t_b7d99f51): revert the ingest bound
 * ALONE and this file fails as an ASSERTION — the payload loads and boots
 * with data, so no corrupt notice appears (selectInitialWindow's
 * dateable-row filter, item 2, catches the regression and init does not
 * hang). Revert the bound + the filter while the `coverage()` belt stays
 * intact: 5 failed / 1 passed, rc=1, 7.2 s, NO hang — the belt catches.
 * Only reverting the bound + ALL of item 2 (filter AND belt), i.e. the full
 * `selectInitialWindow` hunk, lets init reach the coverage loop and this
 * file HANGS — run it as
 * `timeout 90 npx vitest run src/components/Dashboard.undateableStorage.test.tsx`
 * and assert the killed exit (124) rather than letting the suite spin.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import Dashboard from './Dashboard';
import { ENERGY_KEY_V2 } from '@/lib/storage';

/**
 * The five shapes `GasSection.outOfRangeStart.test.tsx` pins — every one a
 * finite number whose `new Date(ts * 1000)` is Invalid, both signs.
 */
const HOSTILE_STARTS = [
  1_000_000_000_000_000,
  -1_000_000_000_000_000,
  8_640_000_000_001,
  Number.MAX_SAFE_INTEGER,
  1e308,
];

const mockRates = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
    },
  ],
};

/** Seed the stored electric payload exactly where `loadEnergyData` reads it. */
function stubStoredPayload(points: unknown[]) {
  Storage.prototype.getItem = vi.fn((key: string) => {
    if (key === ENERGY_KEY_V2) {
      return JSON.stringify({ version: 2, uploadedAt: 'now', source: 'test', points });
    }
    if (key === 'billing_day') return '1';
    return null;
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: () => Promise.resolve(mockRates) }),
  );
  Storage.prototype.setItem = vi.fn();
  Storage.prototype.clear = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('init over a stored payload holding an undateable instant', () => {
  it.each(HOSTILE_STARTS)('a payload holding %s boots to the recovery prompt instead of hanging', async (ts) => {
    stubStoredPayload([
      { timestamp: ts, usage_kwh: 1 },
      { timestamp: 1704067200, usage_kwh: 1.5 },
    ]);
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    // Unreadable storage: said so, and the upload prompt opens — never a
    // claim of emptiness, and never the frozen init the hang produced.
    expect(screen.getByTestId('storage-notice')).toBeInTheDocument();
    expect(screen.getByTestId('upload-modal')).toBeInTheDocument();
  });

  it('control: a healthy stored payload boots with data and no notice', async () => {
    stubStoredPayload([{ timestamp: 1704067200, usage_kwh: 1.5 }]);
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('storage-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('upload-modal')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
  });
});