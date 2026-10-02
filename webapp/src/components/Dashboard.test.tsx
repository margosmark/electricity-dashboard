import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

describe('Dashboard storage surfacing', () => {
  it('shows a visible notice when stored data is corrupt instead of pretending to be empty', async () => {
    (Storage.prototype.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'energy_data_v2') return '{"version":2,"points":[';
      if (key === 'billing_day') return '1';
      return null;
    });

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    const notice = screen.getByTestId('storage-notice');
    expect(notice).toBeInTheDocument();
    expect(within(notice).getByText(/saved data could not be read/i)).toBeInTheDocument();
    expect(within(notice).getByText(/energy_data_v2/)).toBeInTheDocument();
    // data state is not silently claimed: the upload modal is up
    expect(screen.getByText(/Link Data/i)).toBeInTheDocument();
  });

  it('asks for explicit confirmation and only removes this app’s keys on reset', async () => {
    const store = new Map<string, string>();
    store.set('energy_data', JSON.stringify(mockRawData));
    store.set('billing_day', '1');
    store.set('some_other_app', 'keep-me');
    store.set('theme', 'dark');
    Storage.prototype.getItem = vi.fn((key: string) => (store.has(key) ? store.get(key)! : null));
    Storage.prototype.setItem = vi.fn((key: string, value: string) => { store.set(key, String(value)); });
    Storage.prototype.removeItem = vi.fn((key: string) => { store.delete(key); });

    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    // step 1: the trash button only opens a confirm dialog
    await user.click(screen.getByTitle('Reset Data'));
    expect(screen.getByTestId('reset-confirm')).toBeInTheDocument();
    expect(screen.getByText(/other site data is untouched/i)).toBeInTheDocument();
    expect(screen.getByText(/energy_data_v2/)).toBeInTheDocument();
    // init migrated legacy → v2, and opening the dialog removed nothing
    expect(store.has('energy_data_v2')).toBe(true);
    expect(store.has('billing_day')).toBe(true);

    // cancel keeps everything
    await user.click(screen.getByTitle('Cancel Reset'));
    expect(screen.queryByTestId('reset-confirm')).not.toBeInTheDocument();
    expect(store.has('energy_data_v2')).toBe(true);

    // step 2: confirm removes only our keys
    await user.click(screen.getByTitle('Reset Data'));
    await user.click(screen.getByTitle('Confirm Reset'));
    expect(store.has('energy_data')).toBe(false);
    expect(store.has('energy_data_v2')).toBe(false);
    expect(store.has('billing_day')).toBe(false);
    expect(store.get('some_other_app')).toBe('keep-me');
    expect(store.get('theme')).toBe('dark');
    // confirmReset then reloads; jsdom only logs its usual "not implemented" notice
  });
});
