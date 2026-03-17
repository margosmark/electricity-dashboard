import { NextResponse } from 'next/server';

// Official Ontario rates effective November 1, 2025
// Source: https://www.oeb.ca/consumer-information-and-protection/electricity-rates
const historicalRates = [
  {
    effectiveDate: '2023-11-01',
    tou: { offPeak: 8.7, midPeak: 12.2, onPeak: 18.2 },
    tiered: { tier1: 10.3, tier2: 12.5, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 2.4, weekendOffPeak: 8.7, midPeak: 12.2, onPeak: 24.0 }
  },
  {
    effectiveDate: '2024-11-01',
    tou: { offPeak: 8.7, midPeak: 12.2, onPeak: 18.2 },
    tiered: { tier1: 10.3, tier2: 12.5, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 2.8, weekendOffPeak: 8.7, midPeak: 12.2, onPeak: 28.6 }
  },
  {
    effectiveDate: '2025-11-01',
    tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 }
  }
];

export async function GET() {
  return NextResponse.json({
    historicalRates,
    updatedAt: new Date().toISOString()
  });
}
