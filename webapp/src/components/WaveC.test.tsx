import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Dashboard from './Dashboard';
import RateStalenessBanner, { RATES_FILE_EDIT_URL } from './RateStalenessBanner';
import YearOverYearPanel from './YearOverYearPanel';
import type { StalenessResult } from '@/hooks/useRateStaleness';
import { processRawData, type DataPoint, type RateSet } from '@/lib/energy';

const FIXTURE = readFileSync(join(__dirname, '../lib/oebRates.fixture.html'), 'utf8');

const shippedSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

const futureSet: RateSet = {
  ...shippedSet,
  effectiveDate: '2026-11-01',
  tou: { offPeak: 10.5, midPeak: 16.5, onPeak: 22.0 },
};

const staleResult: StalenessResult = {
  checked: true,
  stale: {
    oebEffectiveDate: '2026-11-01',
    shippedEffectiveDate: '2025-11-01',
    newSet: futureSet,
    deltas: [
      { plan: 'TOU', label: 'Off-Peak', current: 9.8, next: 10.5 },
      { plan: 'TOU', label: 'On-Peak', current: 20.3, next: 22.0 },
    ],
    impact: null,
  },
};

const cleanResult: StalenessResult = { checked: true, stale: null };

function daysOfReadings(days: number, kwhPerDay = 10): DataPoint[] {
  const out: DataPoint[] = [];
  for (let d = 0; d < days; d++) {
    const base = new Date(2026, 0, 1 + d, 12, 0, 0);
    for (const hour of [3, 9, 14, 19, 23]) {
      out.push({
        timestamp: Math.floor(new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour).getTime() / 1000),
        usage_kwh: kwhPerDay / 5,
      });
    }
  }
  return out;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () =>
      Promise.resolve({
        historicalRates: [shippedSet],
      }),
  }));
  Storage.prototype.getItem = vi.fn((key: string) => {
    if (key === 'energy_data') return JSON.stringify(daysOfReadings(10));
    if (key === 'billing_day') return '1';
    return null;
  });
  Storage.prototype.setItem = vi.fn();
  Storage.prototype.clear = vi.fn();
});

describe('RateStalenessBanner', () => {
  it('renders nothing when the check found no newer set', () => {
    const { container } = render(<RateStalenessBanner result={cleanResult} />);
    expect(container.querySelector('[data-testid="rate-staleness-banner"]')).toBeNull();
  });

  it('renders nothing while the check has not run', () => {
    const { container } = render(
      <RateStalenessBanner result={{ checked: false, stale: null }} />,
    );
    expect(container.querySelector('[data-testid="rate-staleness-banner"]')).toBeNull();
  });

  it('shows both effective dates and the required headline', () => {
    render(<RateStalenessBanner result={staleResult} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Ontario rates changed/i)).toBeInTheDocument();
    const dates = screen.getByTestId('banner-dates');
    expect(dates).toHaveTextContent('2026-11-01');
    expect(dates).toHaveTextContent('2025-11-01');
  });

  it('lists the per-period rate deltas', () => {
    render(<RateStalenessBanner result={staleResult} />);
    const deltas = screen.getByTestId('banner-deltas');
    expect(deltas).toHaveTextContent('Off-Peak 9.8¢→10.5¢');
    expect(deltas).toHaveTextContent('On-Peak 20.3¢→22¢');
  });

  it('deep-links to the GitHub editor for the rates file', () => {
    render(<RateStalenessBanner result={staleResult} />);
    const link = screen.getByTestId('banner-edit-link');
    expect(link).toHaveAccessibleName('Fix rate schedule');
    expect(link).toHaveAttribute('href', RATES_FILE_EDIT_URL);
    expect(RATES_FILE_EDIT_URL).toContain('webapp/src/app/api/rates/route.ts');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows the computed sample impact when available', () => {
    const withImpact: StalenessResult = {
      checked: true,
      stale: {
        ...staleResult.stale!,
        impact: {
          windowDays: 30,
          kwh: 300,
          costCurrent: 42.0,
          costNew: 46.2,
          delta: 4.2,
          perPlan: [
            { plan: 'TOU', current: 14, next: 15.4, delta: 1.4 },
            { plan: 'Tiered', current: 14, next: 15.4, delta: 1.4 },
            { plan: 'ULO', current: 14, next: 15.4, delta: 1.4 },
          ],
        },
      },
    };
    render(<RateStalenessBanner result={withImpact} />);
    const impact = screen.getByTestId('banner-impact');
    expect(impact).toHaveTextContent('$42.00 → $46.20');
    expect(impact).toHaveTextContent('+$4.20');
    expect(impact).toHaveTextContent('TOU +$1.40');
  });

  it('warns when only the date parsed (no rate tables)', () => {
    const dateOnly: StalenessResult = {
      checked: true,
      stale: { ...staleResult.stale!, newSet: null, deltas: [] },
    };
    render(<RateStalenessBanner result={dateOnly} />);
    expect(screen.getByTestId('banner-partial')).toBeInTheDocument();
    expect(screen.queryByTestId('banner-deltas')).not.toBeInTheDocument();
  });
});

describe('YearOverYearPanel', () => {
  it('shows the honest empty state for the current 4-month dataset', () => {
    // Jul–Oct 2026: exactly the real loaded dataset shape.
    const data = processRawData(
      [
        ...Array.from({ length: 4 }, (_, m) => ({
          timestamp: Math.floor(new Date(2026, 6 + m, 10, 12).getTime() / 1000),
          usage_kwh: 300,
        })),
      ],
      [shippedSet],
    );
    render(<YearOverYearPanel processedData={data} />);
    const empty = screen.getByTestId('trend-empty');
    expect(empty).toHaveTextContent(/Need 12\+ months of data/i);
    expect(empty).toHaveTextContent(/4 months/);
    expect(screen.queryByTestId('trend-chart')).not.toBeInTheDocument();
  });

  it('shows an honest message with no data at all', () => {
    render(<YearOverYearPanel processedData={[]} />);
    expect(screen.getByTestId('trend-empty')).toHaveTextContent(/upload your green button xml/i);
  });

  it('renders the chart + deltas once >12 months of data exist', () => {
    // 14 calendar months: Jan 2025 → Feb 2026.
    const raw: DataPoint[] = [];
    for (let m = 0; m < 14; m++) {
      for (const day of [5, 15, 25]) {
        raw.push({
          timestamp: Math.floor(new Date(2025, m, day, 12).getTime() / 1000),
          usage_kwh: 40,
        });
      }
    }
    const data = processRawData(raw, [shippedSet]);
    render(<YearOverYearPanel processedData={data} />);
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('trend-deltas')).toBeInTheDocument();
    // 2026 vs 2025 deltas rendered per month (Jan/Feb have both years).
    expect(screen.getByTestId('trend-deltas')).toHaveTextContent('2026 vs 2025');
    expect(screen.getByTestId('trend-boundaries')).toBeInTheDocument();
  });

  it('annotates rate-set boundaries inside the data span', () => {
    // Oct 2024 → Jan 2026 crosses the 2024-11-01 and 2025-11-01 changes.
    const raw: DataPoint[] = [];
    for (let m = 0; m < 16; m++) {
      raw.push({
        timestamp: Math.floor(new Date(2024, 9 + m, 10, 12).getTime() / 1000),
        usage_kwh: 50,
      });
    }
    const oldA: RateSet = { ...shippedSet, effectiveDate: '2023-11-01' };
    const oldB: RateSet = { ...shippedSet, effectiveDate: '2024-11-01' };
    const data = processRawData(raw, [oldA, oldB, shippedSet]);
    render(<YearOverYearPanel processedData={data} />);
    const boundaries = screen.getByTestId('trend-boundaries');
    expect(boundaries).toHaveTextContent('2024-11-01');
    expect(boundaries).toHaveTextContent('2025-11-01');
    expect(boundaries).toHaveTextContent(/2 rate-set changes/);
  });

  it('reports no delta row when only one calendar year exists', () => {
    const data = processRawData(daysOfReadings(100), [shippedSet]);
    render(<YearOverYearPanel processedData={data} />);
    // 100 days of 2026 only → gated anyway (<12 months), so empty state.
    expect(screen.getByTestId('trend-empty')).toBeInTheDocument();
  });
});

describe('Dashboard integration', () => {
  it('boots without the banner when the OEB check finds nothing newer', async () => {
    // fetch mock returns historicalRates-shaped JSON for EVERY url (including
    // /oeb-rates-page) — res.text is missing, so the hook fails silently.
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('rate-staleness-banner')).not.toBeInTheDocument();
    });
  });

  it('renders the banner when the OEB page carries a newer set', async () => {
    const futureFixture = FIXTURE.replace('November 1, 2025', 'November 1, 2026')
      .replace('>20.3<', '>22.0<');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('oeb-rates-page')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(futureFixture),
          });
        }
        return Promise.resolve({ json: () => Promise.resolve({ historicalRates: [shippedSet] }) });
      }),
    );
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    // Usage and insights, including rate health, stay in Overview.
    const banner = await screen.findByTestId('rate-staleness-banner', {}, { timeout: 5000 });
    expect(banner).toHaveTextContent('2026-11-01');
    expect(banner).toHaveTextContent('2025-11-01');
    expect(screen.getByTestId('banner-edit-link')).toHaveAttribute('href', RATES_FILE_EDIT_URL);
    expect(screen.getByTestId('banner-edit-link')).toHaveAccessibleName('Fix rate schedule');
    // Sample impact computed from the 10 loaded days.
    await waitFor(() => {
      expect(screen.getByTestId('banner-impact')).toBeInTheDocument();
    });
    const overview = screen.getByTestId('tab-panel-overview');
    const usage = within(overview).getByTestId('overview-usage');
    expect(usage).toContainElement(banner);
    fireEvent.click(screen.getByRole('tab', { name: 'Money' }));
    const moneyPanel = await screen.findByTestId('tab-panel-money');
    expect(within(moneyPanel).queryByTestId('rate-staleness-banner')).not.toBeInTheDocument();
  });

  it('renders the trend empty state in the relocated Overview usage section', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    const usage = await screen.findByTestId('overview-usage');
    expect(usage).toBeInTheDocument();
    const trend = screen.getByTestId('trend-panel');
    expect(trend).toBeInTheDocument();
    expect(screen.getByTestId('trend-empty')).toHaveTextContent(/Need 12\+ months/i);
  });
});
