/**
 * t_b9fe7438 — the crash half of the undateable-bill class, in the
 * efficiency/analytics plane.
 *
 * `Dashboard` computes `efficiency` in a `useMemo` from
 * `billFeed.summaries` on EVERY render, and `buildEfficiency` →
 * `efficiencyPeriods` labeled each period with
 * `fmtDate(`${summary.startDate}T00:00:00`, 'MMM yyyy')`. date-fns'
 * `format()` THROWS `RangeError: Invalid time value` on the Invalid Date
 * that string parses to — so ONE stored bill stamped by an out-of-range
 * `<billingPeriod><start>` (start=1e15 s → parser writes day keys
 * `NaN-NaN-NaN`) took the whole dashboard to the error boundary on every
 * load. Not garbage text — a CRASH, which is why it is pinned apart from
 * the display-text cards (t_91fb29f8 owns those; this file asserts ONLY
 * the crash and the numbers, never absence-of-NaN elsewhere).
 *
 * `readStoredBillFeed` is the reachability: it validates only
 * `typeof s.start === 'number' && typeof s.duration === 'number' &&
 * Array.isArray(s.items)` — the hostile bill passes all three.
 *
 * The AC, asserted here end to end: render does not throw, the efficiency
 * card mounts, and the ¢/kWh figures are the fixture's audited numbers —
 * 16.89 all-time ($1,365.03 ÷ 8,080 kWh, pinned by statistics.test.ts),
 * 14.47 first (Jun), 18.77 last (the hostile May bill, unchanged).
 *
 * FIXTURE POLICY: SYNTHETIC only — the repo's own usage-summary fixture
 * re-stamped in memory, plus the same three healthy rows Dashboard.test.tsx
 * seeds; no real EGD export ever enters the repo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Dashboard from './Dashboard';
import { parseUsageSummaries, type UsageSummary } from '@/lib/energy';
import { setLocale } from '@/i18n';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);
const OAKVILLE = fs.readFileSync(
  path.join(FIXTURES, 'usage-summary-synthetic.xml'),
  'utf8',
);

/** The same rates mock Dashboard.test.tsx boots with. */
const mockRates = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    },
  ],
};

/** The same three healthy rows Dashboard.test.tsx boots with. */
const mockRawData = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.0 },
  { timestamp: 1704074400, usage_kwh: 0.5 },
];

/**
 * The synthetic fixture with its May bill re-stamped into the crash class:
 * `start` far outside the Date range → the parser's own day-key stamping
 * would write `NaN-NaN-NaN` (measured, not traced: efficiencyPeriods threw
 * RangeError on exactly this shape).
 */
function hostileFeed(): UsageSummary[] {
  const summaries = parseUsageSummaries(OAKVILLE);
  const i = summaries.findIndex((s) => s.startDate === '2026-05-25');
  if (i < 0) throw new Error('fixture lost its May 2026 bill');
  summaries[i] = {
    ...summaries[i],
    start: 1e15,
    startDate: 'NaN-NaN-NaN',
    endDate: 'NaN-NaN-NaN',
  };
  return summaries;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: () => Promise.resolve(mockRates) }),
  );
  Storage.prototype.getItem = vi.fn((key: string) => {
    if (key === 'energy_data') return JSON.stringify(mockRawData);
    if (key === 'usage_summaries') return JSON.stringify(hostileFeed());
    if (key === 'billing_day') return '1';
    return null;
  });
  Storage.prototype.setItem = vi.fn();
  Storage.prototype.clear = vi.fn();
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale('en');
});

async function renderLoaded() {
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
  });
}

describe('Dashboard with an undateable bill in the stored feed', () => {
  it('renders instead of throwing the efficiency plane to the error boundary', async () => {
    // RED before the fix: RangeError: Invalid time value — thrown inside
    // the buildEfficiency useMemo, i.e. out of render() itself.
    let threw: unknown = null;
    try {
      render(<Dashboard />);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeNull();
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
  });

  it('paints the efficiency card with the audited ¢/kWh intact', async () => {
    await renderLoaded();

    const card = screen.getByTestId('efficiency-card');
    expect(card).toBeInTheDocument();
    // 3 bills survived keep+degrade — the hostile one was NOT dropped
    // (PM ruling t_2a09ca9d: keep the period, degrade the display).
    expect(card).toHaveAttribute('data-bills', '3');

    // All-time = Σcost ÷ ΣkWh over the fixture = $1,365.03 ÷ 8,080 kWh =
    // 16.8939¢ — the same audited figure statistics.test.ts pins directly.
    expect(screen.getByTestId('efficiency-headline')).toHaveAttribute(
      'data-cents',
      '16.89',
    );
    expect(screen.getByTestId('efficiency-all-time')).toHaveAttribute(
      'data-cents',
      '16.89',
    );

    // First = the Jun bill (14.4652¢), last = the hostile May bill whose
    // ¢/kWh must be byte-identical to its healthy twin (18.7717¢).
    const range = screen.getByTestId('efficiency-range');
    expect(range).toHaveAttribute('data-first-cents', '14.47');
    expect(range).toHaveAttribute('data-last-cents', '18.77');
    expect(range).toHaveAttribute('data-first-cents-incl-tax', '16.35');
    expect(range).toHaveAttribute('data-last-cents-incl-tax', '21.21');

    // The label degrades to the app's marker instead of throwing — the
    // hostile bill keeps its seat in the first/last sentence.
    expect(range.textContent).toContain('date unavailable');
    expect(range.textContent).toContain('Jun 2026');
  });

  it('classic variant survives the same feed and shows the same headline', async () => {
    let threw: unknown = null;
    try {
      render(<Dashboard variant="classic" />);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeNull();
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('efficiency-card')).toHaveAttribute(
      'data-bills',
      '3',
    );
    expect(screen.getByTestId('efficiency-headline')).toHaveAttribute(
      'data-cents',
      '16.89',
    );
  });
});
