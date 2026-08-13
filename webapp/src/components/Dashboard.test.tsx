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

describe('Dashboard', () => {
  it('renders loading state initially', () => {
    render(<Dashboard />);
    expect(screen.getByText(/preparing optimizer/i)).toBeInTheDocument();
  });

  it('renders chart view after loading', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/CHART/i)).toBeInTheDocument();
    expect(screen.getByText(/INSIGHTS/i)).toBeInTheDocument();
  });

  it('renders plan selection buttons', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText('Tiered')).toBeInTheDocument();
    expect(screen.getByText('TOU')).toBeInTheDocument();
    expect(screen.getByText('ULO')).toBeInTheDocument();
  });

  it('renders zoom level buttons', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText('monthly')).toBeInTheDocument();
    expect(screen.getByText('weekly')).toBeInTheDocument();
    expect(screen.getByText('daily')).toBeInTheDocument();
  });

  it('renders vampire load section', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Vampire Load/i)).toBeInTheDocument();
  });

  it('renders billing day input', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    const billingInput = screen.getByRole('spinbutton');
    expect(billingInput).toBeInTheDocument();
  });

  it('renders date inputs', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBeGreaterThanOrEqual(2);
  });

  it('renders upload button', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('Upload XML')).toBeInTheDocument();
  });

  it('renders reset button', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('Reset Data')).toBeInTheDocument();
  });

  it('switches to Insights view', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByText('INSIGHTS'));
    expect(screen.getByText(/Usage Anomalies/i)).toBeInTheDocument();
    expect(screen.getByText(/Weekly Routine Heatmap/i)).toBeInTheDocument();
  });

  it('shows vampire load help modal', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByText(/Vampire Load/i));
    await waitFor(() => {
      expect(screen.getByText(/What is Vampire Load/i)).toBeInTheDocument();
    });
  });

  it('renders plan cards with costs', async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText('Time-of-Use')).toBeInTheDocument();
    expect(screen.getByText('Tiered Pricing')).toBeInTheDocument();
    expect(screen.getByText('Ultra-Low Over')).toBeInTheDocument();
  });
});
