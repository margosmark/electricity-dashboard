/**
 * A Green Button `<billingPeriod><start>` is unbounded in the ESPI schema, so
 * a stored bill can name an instant that is NOT a time: `new Date(ts * 1000)`
 * is Invalid past ±8.64e15 ms (±8.64e12 s), and date-fns `format()` then
 * THROWS `RangeError: Invalid time value`. `gasWindowLabel` formatted that
 * instant inside a `useMemo` of `GasAnalyticsPanel`, so ONE stored bill took
 * the whole gas tab to the AppErrorBoundary — on every load, because
 * `readStoredBillFeed` only validates that `start` is a number.
 *
 * There are two boundaries, and both are pinned here:
 *  - the parser bounds `<start>` at ingest (`limits.ts`,
 *    `assertBillPeriodStart`, t_43c716ad) — but that ceiling is ONE-SIDED
 *    (2100-01-01, no floor: security gate t_1b036736 measured a NEGATIVE eon
 *    start parsing fresh), so the negative direction reaches render even on a
 *    fresh upload;
 *  - this function bounds its OWN input, because the rows it is handed come
 *    from `readStoredBillFeed`, which accepts any finite number — a bill
 *    persisted BEFORE the parse bound existed reaches here on every load.
 *
 * The rule mirrors `UsagePointPicker`'s (its `.outOfRangeStart.test.tsx`
 * states the same reason): an unrenderable instant is SKIPPED, never fatal.
 * The caption then falls back to `spanLabel ?? loadingSpan`, and a mixed set
 * still labels the instants that ARE renderable.
 *
 * FIXTURE POLICY: SYNTHETIC only — in-file summaries, no real EGD export.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { GasAnalyticsPanel, gasWindowLabel } from './GasSection';
import { buildGasChartRows } from './GasChartPanel';
import GasTempBandCard from './GasTempBandCard';
import { buildGasTempBandReport, gasTempSpanRows } from '@/lib/gasTempBands';
import { setLocale } from '@/i18n';
import type { UsageSummary } from '@/lib/energy';

const DAY = 86_400;
// LOCAL noon: `fmtDate` formats in the browser's zone, so a UTC midnight
// would read as the previous day (2026-01-01T00:00Z is Dec 31 in EST).
const JAN1 = new Date(2026, 0, 1, 12).getTime() / 1000;
const FEB1 = new Date(2026, 1, 1, 12).getTime() / 1000;

/** The crash class, both signs — `new Date(ts * 1000)` is Invalid for all. */
const HOSTILE_STARTS = [
  1_000_000_000_000_000, // the card's reproducer: year 33 657 588
  -1_000_000_000_000_000, // the negative direction (security t_1b036736)
  8_640_000_000_001, // one second past the +Date edge (8.64e12 s = 8.64e15 ms)
  Number.MAX_SAFE_INTEGER,
  1e308, // finite, and `* 1000` overflows to Infinity
];

/** `utcDayKey`'s exact output, without throwing on an Invalid Date. */
function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** A stated-volume gas bill at `start`, shaped like the parser's own output. */
function bill(start: number, days = 31, volumeM3 = 300): UsageSummary {
  const duration = days * DAY;
  return {
    source: 'UsageSummary',
    start,
    duration,
    // The parser writes these through `utcDayKey`, which reads `NaN` off an
    // Invalid Date rather than throwing — so a hostile bill stores cleanly
    // and only the RENDER was ever the crash.
    startDate: dayKey(start),
    endDate: dayKey(start + duration),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null,
    volume: { scaled: volumeM3, value: volumeM3, powerOfTenMultiplier: 0, uom: 42 },
    items: [],
  };
}

/** Weather answers "not weather" → the card lands on its honest error. */
const RATES = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, onPeak: 39.1 },
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(RATES) }),
  );
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale('en');
});

/* ================================================================== *
 * 1. The label path — the function that threw
 * ================================================================== */

describe('gasWindowLabel — an instant that is not a date', () => {
  it.each(HOSTILE_STARTS)('returns null for start %s instead of throwing', (start) => {
    // format() on this instant throws RangeError: Invalid time value.
    expect(() => gasWindowLabel([{ timestamp: start }], 'en')).not.toThrow();
    expect(gasWindowLabel([{ timestamp: start }], 'en')).toBeNull();
  });

  it('skips the unrenderable edges and still labels the renderable ones', () => {
    const rows = [
      { timestamp: 1e15 },
      { timestamp: JAN1 },
      { timestamp: -1e15 },
      { timestamp: FEB1 },
    ];
    expect(gasWindowLabel(rows, 'en')).toBe('Jan 1, 2026 – Feb 1, 2026');
  });

  it('returns null when every row is unrenderable, so the caller falls back', () => {
    expect(gasWindowLabel([{ timestamp: 1e15 }, { timestamp: -1e15 }], 'en')).toBeNull();
    expect(gasWindowLabel([], 'en')).toBeNull();
    // A non-finite row was already skipped before this card; it still is.
    expect(gasWindowLabel([{ timestamp: NaN }], 'en')).toBeNull();
  });

  it('leaves a real span formatted exactly as before, in both locales', () => {
    const rows = [{ timestamp: JAN1 }, { timestamp: FEB1 }];
    expect(gasWindowLabel(rows, 'en')).toBe('Jan 1, 2026 – Feb 1, 2026');
    setLocale('fr');
    expect(gasWindowLabel(rows, 'fr')).toBe('1 janv. 2026 – 1 févr. 2026');
  });
});

/* ================================================================== *
 * 2. The panel — the render that crashed to the error boundary
 * ================================================================== */

describe('GasAnalyticsPanel — a stored bill past the Date range', () => {
  it.each(HOSTILE_STARTS)(
    'renders with a stored bill at start %s instead of throwing RangeError',
    async (start) => {
      const bills = [bill(start)];
      let rendered: ReturnType<typeof render>;
      expect(() => {
        rendered = render(<GasAnalyticsPanel points={[]} summaries={bills} />);
      }).not.toThrow();
      expect(screen.getByTestId('gas-analytics-panel')).toBeInTheDocument();
      // Bill-only import: the honest empty chart state, not a crash.
      expect(screen.getByTestId('gas-chart-empty')).toBeInTheDocument();
      // The temp card is a next/dynamic chunk — await it like every other
      // GasSection test does, so "the card renders its normal states" is a
      // measurement of the mounted card, not of the loading placeholder.
      const card = await screen.findByTestId('gas-temp-band-card', undefined, {
        timeout: 8000,
      });
      expect(card).toBeInTheDocument();
      expect(rendered!).toBeDefined();
    },
    15_000,
  );

  it('renders the negative-direction bill a fresh upload can still produce', async () => {
    // t_43c716ad's ceiling has no floor, so `-1e15` parses FRESH and reaches
    // this render without ever touching storage.
    render(<GasAnalyticsPanel points={[]} summaries={[bill(-1e15)]} />);
    expect(screen.getByTestId('gas-analytics-panel')).toBeInTheDocument();
    const card = await screen.findByTestId('gas-temp-band-card', undefined, {
      timeout: 8000,
    });
    expect(card).toBeInTheDocument();
  }, 15_000);

  it('keeps a healthy bill’s caption when a hostile one rides along', () => {
    const rows = gasTempSpanRows([], [bill(1e15), bill(JAN1, 30)]);
    // Only the renderable bill contributes; the caption is a real date range.
    expect(gasWindowLabel(rows, 'en')).toBe('Jan 1, 2026 – Jan 31, 2026');
  });
});

/* ================================================================== *
 * 3. The chart rows — the same class, on a stored POINT
 * ================================================================== */

describe('buildGasChartRows — a point that is not a date', () => {
  it.each(HOSTILE_STARTS)(
    'drops the undateable point %s instead of letting fmtDay throw',
    (start) => {
      // `isGasPoint` accepts any finite timestamp, so a payload written
      // before the parser's interval bound existed carries one to here —
      // where `fmtDay(dayKey)` on its `NaN-NaN-NaN` day THROWS.
      const rows = buildGasChartRows([
        { timestamp: start, duration_s: DAY, volume_m3: 10 },
        { timestamp: JAN1, duration_s: DAY, volume_m3: 12 },
      ]);
      expect(() => buildGasChartRows([{ timestamp: start, duration_s: DAY, volume_m3: 10 }])).not.toThrow();
      // The healthy point survives, the chart keeps one bar per real day.
      expect(rows.map((r) => r.timestamp)).toEqual([JAN1]);
    },
  );

  it('leaves every real point charted exactly as before', () => {
    const rows = buildGasChartRows([
      { timestamp: JAN1, duration_s: DAY, volume_m3: 10 },
      { timestamp: FEB1, duration_s: DAY, volume_m3: 12 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toContain('Jan 1');
    expect(rows[1].label).toContain('Feb 1');
  });
});

/* ================================================================== *
 * 3. The fallback actually reaches the DOM
 * ================================================================== */

describe('GasTempBandCard — the degraded caption', () => {
  it('falls back to the loading span when the label has nothing renderable', () => {
    const bills = [bill(1e15)];
    const report = buildGasTempBandReport([], bills, null);
    const spanLabel = gasWindowLabel(gasTempSpanRows([], bills), 'en');
    expect(spanLabel).toBeNull();
    render(
      <GasTempBandCard
        report={report}
        status="idle"
        loading={true}
        source={null}
        spanLabel={spanLabel}
      />,
    );
    const loading = screen.getByTestId('gas-temp-band-loading');
    expect(loading.textContent).toContain('the dates your readings cover');
    expect(loading.textContent).not.toContain('33657588');
  });
});
