import { NextResponse } from 'next/server';
import { hashRateSets, OEB_RATES_URL } from '@/lib/oebRates';

// The current set: official Ontario rates effective November 1, 2025.
// Source: https://www.oeb.ca/consumer-information-and-protection/electricity-rates
//
// The two OLDER sets are transcribed from the OEB's own price-change
// announcements and were re-verified against them (and line-for-line against
// the owner's Oakville Hydro bills) on 2026-10-07, when Wave P's per-period
// modeling exposed that the 2024-11-01 set had been carrying the 2023-11-01
// prices — every commodity line in the 2024-2026 export divides out to the
// ¢/kWh values below (7.6 / 12.2 / 15.8 TOU, 9.3 / 11.0 tiered from
// 2024-11-01; 8.7 / 12.2 / 18.2, 10.3 / 12.5, ULO 2.8 / 8.7 / 12.2 / 28.6
// from 2023-11-01):
//   • 2023-10-19: oeb.ca/newsroom/2023/ontario-energy-board-announces-changes-electricity-prices-households-small-business
//   • 2024-10-18: oeb.ca/newsroom/2024/ontario-energy-board-announces-changes-electricity-prices-households-small-businesses
export const historicalRates = [
  {
    effectiveDate: '2023-11-01',
    tou: { offPeak: 8.7, midPeak: 12.2, onPeak: 18.2 },
    tiered: { tier1: 10.3, tier2: 12.5, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 2.8, weekendOffPeak: 8.7, midPeak: 12.2, onPeak: 28.6 }
  },
  {
    effectiveDate: '2024-11-01',
    tou: { offPeak: 7.6, midPeak: 12.2, onPeak: 15.8 },
    tiered: { tier1: 9.3, tier2: 11.0, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 2.8, weekendOffPeak: 7.6, midPeak: 12.2, onPeak: 28.4 }
  },
  {
    effectiveDate: '2025-11-01',
    tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 }
  }
];

// Zero-server-state metadata: `ratesSourceVersion` is derived from the data
// itself (changes iff a rate value/set changes), and `lastChecked` is a build
// constant — the date the shipped sets were last verified line-for-line
// against the live OEB page. Bump it whenever you re-verify or append a set.
// The weekly staleness cron (see OPERATIONS.md) catches drift between this
// date and what OEB actually publishes.
// Exported because /oeb-rates-page's honest unavailable-page copy names the
// same date — one source, so a bump can never leave the error page silently
// lying (PM fold, t_9991d1f2; pinned by route.test.ts).
export const RATES_LAST_CHECKED = '2026-10-02';

export async function GET() {
  return NextResponse.json({
    historicalRates,
    updatedAt: new Date().toISOString(),
    ratesSourceVersion: hashRateSets(historicalRates),
    lastChecked: RATES_LAST_CHECKED,
    source: OEB_RATES_URL,
  });
}
