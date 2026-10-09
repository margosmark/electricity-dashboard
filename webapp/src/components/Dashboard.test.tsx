import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format } from 'date-fns';
import Dashboard from './Dashboard';

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

const mockRawData = [
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.0 },
  { timestamp: 1704074400, usage_kwh: 0.5 },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve(mockRates),
  }));

  Storage.prototype.getItem = vi.fn((key: string) => {
    if (key === 'energy_data') return JSON.stringify(mockRawData);
    if (key === 'billing_day') return '1';
    return null;
  });

  Storage.prototype.setItem = vi.fn();
  Storage.prototype.clear = vi.fn();
});

async function renderLoaded() {
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
  });
}

describe('Dashboard', () => {
  it('renders loading state initially', () => {
    render(<Dashboard />);
    expect(screen.getByText(/preparing optimizer/i)).toBeInTheDocument();
  });

  it('renders the four-tab strip after loading, Overview selected', async () => {
    await renderLoaded();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Usage', 'Plans', 'Money']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
  });

  it('renders plan selection buttons', async () => {
    await renderLoaded();
    // Scoped to the nav switcher: the totals strip also names the plans.
    const switcher = within(screen.getByTestId('plan-switcher'));
    expect(switcher.getByText('Tiered')).toBeInTheDocument();
    expect(switcher.getByText('TOU')).toBeInTheDocument();
    expect(switcher.getByText('ULO')).toBeInTheDocument();
  });

  it('renders zoom level buttons', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    // Wave R: the chart (and its zoom control) lives on the Usage tab.
    await user.click(screen.getByRole('tab', { name: 'Usage' }));
    expect(screen.getByText('monthly')).toBeInTheDocument();
    expect(screen.getByText('weekly')).toBeInTheDocument();
    expect(screen.getByText('daily')).toBeInTheDocument();
  });

  it('renders always-on floor section', async () => {
    await renderLoaded();
    expect(screen.getByText(/Always-on floor/i)).toBeInTheDocument();
  });

  it('renders billing day input', async () => {
    await renderLoaded();
    const billingInput = screen.getByRole('spinbutton');
    expect(billingInput).toBeInTheDocument();
  });

  it('renders date inputs', async () => {
    await renderLoaded();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBeGreaterThanOrEqual(2);
  });

  it('renders upload button', async () => {
    await renderLoaded();
    expect(screen.getByTitle('Upload XML')).toBeInTheDocument();
  });

  it('renders reset button', async () => {
    await renderLoaded();
    expect(screen.getByTitle('Reset Data')).toBeInTheDocument();
  });

  it('shows the usage analysis on the Usage tab', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Usage' }));
    expect(screen.getByTestId('chart-view')).toBeInTheDocument();
    expect(screen.getByText(/Usage Anomalies/i)).toBeInTheDocument();
    expect(screen.getByText(/Weekly Routine Heatmap/i)).toBeInTheDocument();
    // ...and the Overview panel is gone rather than hidden underneath.
    expect(screen.queryByTestId('tab-panel-overview')).not.toBeInTheDocument();
  });

  it('shows always-on floor help modal', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByText(/Always-on floor/i));
    await waitFor(() => {
      expect(screen.getByText(/What is the always-on floor/i)).toBeInTheDocument();
    });
  });

  it('renders plan cards with costs', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    // Scoped to the Plans panel: the totals strip also names the plans.
    await user.click(screen.getByRole('tab', { name: 'Plans' }));
    const plans = within(screen.getByTestId('tab-panel-plans'));
    expect(plans.getByText('Time-of-Use')).toBeInTheDocument();
    expect(plans.getByText('Tiered Pricing')).toBeInTheDocument();
    expect(plans.getByRole('heading', { name: 'Ultra-Low Overnight' })).toBeInTheDocument();
  });

  // --- Behavior (not shape): rate chips must come from the active RateSet ---

  it('displays plan-card rate chips from the active RateSet, not hardcoded values', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Plans' }));
    // mockRates uses offPeak 9.8 / midPeak 15.7 / onPeak 20.3 — the chips MUST
    // reflect those; a stale hardcoded 8.7/12.2/18.2 would be a regression.
    expect(screen.getAllByText('9.8¢').length).toBeGreaterThanOrEqual(2); // TOU Off-Peak + ULO Weekend Off
    expect(screen.getAllByText('20.3¢').length).toBeGreaterThanOrEqual(1); // TOU On-Peak
    expect(screen.getAllByText('39.1¢').length).toBeGreaterThanOrEqual(1); // ULO On-Peak
    expect(screen.getAllByText('12.0¢').length).toBeGreaterThanOrEqual(1); // Tiered T1
    // The old hardcoded chips MUST NOT appear:
    expect(screen.queryByText('18.2¢')).not.toBeInTheDocument();
    expect(screen.queryByText('8.7¢')).not.toBeInTheDocument();
  });

  it('persists billing-day edits to localStorage', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const billingInput = screen.getByRole('spinbutton');
    await user.clear(billingInput);
    await user.type(billingInput, '15');
    await waitFor(() => {
      expect(Storage.prototype.setItem).toHaveBeenCalledWith('billing_day', '15');
    });
  });

  it('empty localStorage opens the upload modal instead of the chart', async () => {
    Storage.prototype.getItem = vi.fn(() => null);
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Link Data/i)).toBeInTheDocument();
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();
  });

  it('rate fetch failure still renders the app (degrades, no crash)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    Storage.prototype.getItem = vi.fn(() => null);
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    // Upload modal is shown (no data), app did not crash.
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();
  });

  it('corrupt localStorage is treated as fresh (no crash)', async () => {
    Storage.prototype.getItem = vi.fn((key: string) => {
      if (key === 'energy_data') return '{not valid json';
      return null;
    });
    render(<Dashboard />);
    // The corrupt-JSON branch hits the catch before setShowUploadModal runs,
    // so the modal never opens — the contract here is only "must not crash
    // and must finish loading" (fixing the modal-open miss would be a
    // behavior change, not cleanup; flagged in the review notes).
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
  });

  // --- First-load window (Wave A slice 1) ---

  it('first load: the default window ends on a day with data and is at least half covered', async () => {
    await renderLoaded();
    const [startInput, endInput] = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
    const days = new Set(mockRawData.map((d) => format(new Date(d.timestamp * 1000), 'yyyy-MM-dd')));
    // The window must end on a day that actually has readings (no future tail).
    expect(days.has(endInput.value)).toBe(true);
    // ...and at least half of its days must carry data (the old billing-period
    // anchor opened Jan 1-31 for 1-2 days of data = 3-6% coverage).
    let covered = 0;
    let total = 0;
    for (let d = new Date(`${startInput.value}T12:00:00`); d <= new Date(`${endInput.value}T12:00:00`); d = new Date(d.getTime() + 86400000)) {
      total += 1;
      if (days.has(format(d, 'yyyy-MM-dd'))) covered += 1;
    }
    expect(total).toBeGreaterThan(0);
    expect(covered / total).toBeGreaterThanOrEqual(0.5);
  });

  it('E2E regression: data ending mid-January with billing_day=1 opens the data-full window, not Jan 1-31', async () => {
    const dailyNoon = (from: string, to: string) => {
      const out: { timestamp: number; usage_kwh: number }[] = [];
      let d = new Date(`${from}T12:00:00`);
      const end = new Date(`${to}T12:00:00`);
      while (d.getTime() <= end.getTime()) {
        out.push({ timestamp: Math.floor(d.getTime() / 1000), usage_kwh: 1 });
        d = new Date(d.getTime() + 86400000);
      }
      return out;
    };
    Storage.prototype.getItem = vi.fn((key: string) => {
      if (key === 'energy_data') return JSON.stringify(dailyNoon('2024-12-01', '2025-01-15'));
      if (key === 'billing_day') return '1';
      return null;
    });
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    const [startInput, endInput] = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
    // Old behavior: getBillingPeriod(last data day) = Jan 1-31 2025 (15/31 days
    // of data). New: trailing data-anchored window Dec 16 - Jan 15 (31/31).
    expect(startInput.value).toBe('2024-12-16');
    expect(endInput.value).toBe('2025-01-15');
  });

  // --- Full-data totals strip (Wave A slice 2) ---

  it('renders the full-data totals strip: since-date, kWh, per-plan costs and plan delta', async () => {
    await renderLoaded();
    const strip = screen.getByTestId('totals-strip');
    const text = strip.textContent || '';
    expect(text).toMatch(/Since [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    expect(text).toContain('4 kWh'); // 1.5 + 2.0 + 0.5 over the whole dataset
    expect(text).toContain('Time-of-Use');
    expect(text).toContain('Tiered');
    expect(text).toContain('Ultra-Low Overnight');
    expect(text).toContain('Best vs worst plan');
    expect(text).toContain('variable charges only');
    // Costs are real money figures, not placeholders
    expect(text).toMatch(/\$\d+\.\d{2}/);
  });

  it('totals strip covers the WHOLE dataset, not the visible window', async () => {
    await renderLoaded();
    const strip = screen.getByTestId('totals-strip');
    // The default window for this fixture is ~1 day, but the strip must still
    // report all three readings (4 kWh), i.e. it ignores startDate/endDate.
    expect(strip.textContent).toContain('4 kWh');
    expect(strip.textContent).toMatch(new RegExp(format(new Date(mockRawData[0].timestamp * 1000), 'MMM d, yyyy')));
  });

  // --- Section split (Wave A slice 3, reworked in Wave R) ---

  it('renders exactly one tab panel at a time', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    // Overview is the default and the only panel on screen.
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-panel-usage')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Usage' }));
    expect(screen.getByTestId('chart-view')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-panel-overview')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByTestId('tab-panel-money')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
  });

  it('puts the best-choice banner first on Overview — the answer is not buried', async () => {
    await renderLoaded();
    const overview = screen.getByTestId('tab-panel-overview');
    expect(overview.firstElementChild).toBe(screen.getByTestId('best-choice-banner'));
  });
});
