import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dashboard from './Dashboard';
import {
  categorizeTOU, categorizeULO, getTouRateKey, getUloRateKey,
} from '@/lib/energy';

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

  // --- Rate display single-source-of-truth -----------------------------------
  // Distinct rates that differ from the literals the plan cards used to hard-code,
  // so a card falling back to its old copy fails these assertions.
  const ssotRates = {
    historicalRates: [
      {
        effectiveDate: '2023-01-01',
        tou: { offPeak: 9.75, midPeak: 15.25, onPeak: 20.5 },
        tiered: { tier1: 12.34, tier2: 14.56, thresholdWinter: 1000, thresholdSummer: 600 },
        ulo: { overnight: 3.21, weekendOffPeak: 9.75, midPeak: 15.25, onPeak: 39.99 },
      },
    ],
  };
  // 2024-01-15 12:00 / 13:00 / 14:00 UTC: mid-month, so every reading sits inside the
  // billing period whichever timezone the suite runs in.
  const ssotRawData = [
    { timestamp: 1705320000, usage_kwh: 1.5 },
    { timestamp: 1705323600, usage_kwh: 2.0 },
    { timestamp: 1705327200, usage_kwh: 0.5 },
  ];

  const stubSsot = () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve(ssotRates) }));
    Storage.prototype.getItem = vi.fn((key: string) => {
      if (key === 'energy_data') return JSON.stringify(ssotRawData);
      if (key === 'billing_day') return '1';
      return null;
    });
  };

  const planCard = (title: string): HTMLElement =>
    screen.getAllByText(title)[0].closest('div') as HTMLElement;
  const cardRates = (title: string): string[] =>
    within(planCard(title)).getAllByText(/¢$/).map((n) => n.textContent as string);
  const cardCost = (title: string): string | null =>
    within(planCard(title)).getByText(/^\$/).textContent;

  it('plan cards render every rate from the active RateSet, not literals', async () => {
    stubSsot();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    expect(cardRates('Tiered Pricing')).toEqual(['12.34¢', '14.56¢']);
    expect(cardRates('Time-of-Use')).toEqual(['9.75¢', '15.25¢', '20.5¢']);
    expect(cardRates('Ultra-Low Over')).toEqual(['3.21¢', '9.75¢', '15.25¢', '39.99¢']);

    // the old hard-coded Nov-2025 card copy is gone from the rendered dashboard
    const text = document.body.textContent || '';
    for (const literal of ['9.8¢', '15.7¢', '20.3¢', '3.9¢', '12.0¢', '14.2¢', '39.1¢']) {
      expect(text).not.toContain(literal);
    }
  });

  it('plan-card displayed cents are exactly the rates that priced the displayed cost', async () => {
    stubSsot();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    const touRates = cardRates('Time-of-Use').map((s) => parseFloat(s));   // Off/Mid/On-Peak
    const tierRates = cardRates('Tiered Pricing').map((s) => parseFloat(s)); // Tier 1 / Tier 2
    const uloRates = cardRates('Ultra-Low Over').map((s) => parseFloat(s)); // Overnight..On-Peak

    const touKeys = ['offPeak', 'midPeak', 'onPeak'] as const;
    const uloKeys = ['overnight', 'weekendOffPeak', 'midPeak', 'onPeak'] as const;

    // Rebuild each plan's cost using only the numbers shown on its card.
    const touCost = ssotRawData.reduce((sum, p) => {
      const key = getTouRateKey(categorizeTOU(new Date(p.timestamp * 1000)));
      return sum + p.usage_kwh * (touRates[touKeys.indexOf(key)] / 100);
    }, 0);
    const uloCost = ssotRawData.reduce((sum, p) => {
      const key = getUloRateKey(categorizeULO(new Date(p.timestamp * 1000)));
      return sum + p.usage_kwh * (uloRates[uloKeys.indexOf(key)] / 100);
    }, 0);
    const usage = ssotRawData.reduce((sum, p) => sum + p.usage_kwh, 0);
    // The whole view stays under the tier threshold, so Tier 1 prices every reading.
    const tierCost = usage * (tierRates[0] / 100);

    expect(cardCost('Time-of-Use')).toBe(`$${touCost.toFixed(2)}`);
    expect(cardCost('Ultra-Low Over')).toBe(`$${uloCost.toFixed(2)}`);
    expect(cardCost('Tiered Pricing')).toBe(`$${tierCost.toFixed(2)}`);
    expect(touRates[0]).toBe(9.75); // display value came from the RateSet, not '9.8¢'
  });
});
