/**
 * Wave P — the shipped rate history, pinned to its sources.
 *
 * These are not decorative: every historical period's commodity model (and
 * therefore the switch track record) prices with exactly these sets, and the
 * owner's own Oakville Hydro bills divide out to the ¢/kWh values below —
 * 2024-11-01 had been shipping the 2023-11-01 prices until Wave P's
 * per-period audit caught it (~10% commodity over-model on 14 periods).
 *
 * Sources (OEB's own price-change announcements):
 *  - 2023-11-01: https://www.oeb.ca/newsroom/2023/ontario-energy-board-announces-changes-electricity-prices-households-small-business
 *  - 2024-11-01: https://www.oeb.ca/newsroom/2024/ontario-energy-board-announces-changes-electricity-prices-households-small-businesses
 *  - 2025-11-01: parsed live from the OEB rates page (see oebRates.ts).
 */

import { describe, it, expect } from 'vitest';

import { historicalRates } from './route';

describe('historical OEB rate sets', () => {
  it('has one set per change, in order, with unique effective dates', () => {
    expect(historicalRates.map((r) => r.effectiveDate)).toEqual([
      '2023-11-01',
      '2024-11-01',
      '2025-11-01',
    ]);
  });

  it('pins the 2023-11-01 prices (OEB announcement 2023-10-19)', () => {
    const [r] = historicalRates;
    expect(r.tou).toEqual({ offPeak: 8.7, midPeak: 12.2, onPeak: 18.2 });
    expect(r.tiered).toEqual({
      tier1: 10.3,
      tier2: 12.5,
      thresholdWinter: 1000,
      thresholdSummer: 600,
    });
    expect(r.ulo).toEqual({ overnight: 2.8, weekendOffPeak: 8.7, midPeak: 12.2, onPeak: 28.6 });
  });

  it('pins the 2024-11-01 prices (OEB announcement 2024-10-18) — the set that was wrong', () => {
    const r = historicalRates[1];
    expect(r.tou).toEqual({ offPeak: 7.6, midPeak: 12.2, onPeak: 15.8 });
    expect(r.tiered).toEqual({
      tier1: 9.3,
      tier2: 11.0,
      thresholdWinter: 1000,
      thresholdSummer: 600,
    });
    expect(r.ulo).toEqual({ overnight: 2.8, weekendOffPeak: 7.6, midPeak: 12.2, onPeak: 28.4 });
  });

  it('keeps the 2025-11-01 set the live page parse produced', () => {
    const r = historicalRates[2];
    expect(r.tou).toEqual({ offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 });
    expect(r.tiered.tier1).toBe(12.0);
    expect(r.ulo.overnight).toBe(3.9);
  });
});
