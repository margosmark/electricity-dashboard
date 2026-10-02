import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('renders chart view after loading', async () => {
    await renderLoaded();
    expect(screen.getByText(/CHART/i)).toBeInTheDocument();
    expect(screen.getByText(/INSIGHTS/i)).toBeInTheDocument();
  });

  it('renders plan selection buttons', async () => {
    await renderLoaded();
    expect(screen.getByText('Tiered')).toBeInTheDocument();
    expect(screen.getByText('TOU')).toBeInTheDocument();
    expect(screen.getByText('ULO')).toBeInTheDocument();
  });

  it('renders zoom level buttons', async () => {
    await renderLoaded();
    expect(screen.getByText('monthly')).toBeInTheDocument();
    expect(screen.getByText('weekly')).toBeInTheDocument();
    expect(screen.getByText('daily')).toBeInTheDocument();
  });

  it('renders vampire load section', async () => {
    await renderLoaded();
    expect(screen.getByText(/Vampire Load/i)).toBeInTheDocument();
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

  it('switches to Insights view', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByText('INSIGHTS'));
    expect(screen.getByText(/Usage Anomalies/i)).toBeInTheDocument();
    expect(screen.getByText(/Weekly Routine Heatmap/i)).toBeInTheDocument();
  });

  it('shows vampire load help modal', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByText(/Vampire Load/i));
    await waitFor(() => {
      expect(screen.getByText(/What is Vampire Load/i)).toBeInTheDocument();
    });
  });

  it('renders plan cards with costs', async () => {
    await renderLoaded();
    expect(screen.getByText('Time-of-Use')).toBeInTheDocument();
    expect(screen.getByText('Tiered Pricing')).toBeInTheDocument();
    expect(screen.getByText('Ultra-Low Over')).toBeInTheDocument();
  });

  // --- Behavior (not shape): rate chips must come from the active RateSet ---

  it('displays plan-card rate chips from the active RateSet, not hardcoded values', async () => {
    await renderLoaded();
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
    expect(screen.getByText(/CHART/i)).toBeInTheDocument();
  });
});
