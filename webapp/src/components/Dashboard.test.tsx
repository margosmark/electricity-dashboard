import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format } from 'date-fns';
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
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Analytics', 'Plans', 'Money']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
  });

  it('classic variant restores the four historical destinations and Usage panel', async () => {
    render(<Dashboard variant="classic" />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    expect(screen.getByTestId('classic-tab-nav')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Overview', 'Usage', 'Plans', 'Money',
    ]);
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-usage')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('classic-tab-usage'));
    expect(screen.getByTestId('tab-panel-usage')).toBeInTheDocument();
    expect(screen.getByTestId('chart-view')).toBeInTheDocument();
  });

  it('classic shell date and scope controls change the classic analytics window', async () => {
    const user = userEvent.setup();
    render(<Dashboard variant="classic" />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    const shell = screen.getByTestId('classic-tab-nav');
    const context = within(shell).getByTestId('dashboard-context');
    const [startInput, endInput] = context.querySelectorAll<HTMLInputElement>('input[type="date"]');
    const initialDate = format(new Date(mockRawData[0].timestamp * 1000), 'yyyy-MM-dd');
    expect(startInput).toHaveValue(initialDate);
    expect(endInput).toHaveValue(initialDate);

    await user.click(within(context).getByRole('button', { name: 'Month' }));
    expect(within(context).getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    expect(startInput.value).not.toBe(initialDate);
    expect(endInput.value).not.toBe(initialDate);

    fireEvent.change(startInput, { target: { value: initialDate } });
    expect(within(context).getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'false');
    expect(startInput).toHaveValue(initialDate);
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
    // Usage analysis (and its zoom control) is retained inside Overview.
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
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

  it('labels plan verdict and cards with the same visible date span', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByRole('tab', { name: 'Plans' }));
    const plans = within(screen.getByTestId('tab-panel-plans'));
    const scopes = plans.getAllByTestId('plan-card-scope');
    expect(scopes).toHaveLength(3);
    for (const scope of scopes) expect(scope).toHaveTextContent('Dec 31 – Dec 31 on screen');
    expect(plans.getByTestId('verdict-line')).toHaveTextContent(/1 day on screen/i);
  });

  it('renders date inputs', async () => {
    await renderLoaded();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs).toHaveLength(2);
  });

  it('keeps the date range and scope pills in the persistent shell, not the legacy toolbar', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const shell = screen.getByTestId('tab-nav');
    const context = screen.getByTestId('dashboard-context');
    const toolbar = screen.getByTestId('dashboard-toolbar');
    expect(shell).toContainElement(context);
    expect(context.querySelectorAll('input[type="date"]')).toHaveLength(2);
    expect(toolbar.querySelectorAll('input[type="date"]')).toHaveLength(0);
    expect(within(context).getByRole('button', { name: 'Billing Period' })).toBeInTheDocument();

    await user.click(within(context).getByRole('button', { name: 'Month' }));
    expect(within(context).getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders upload button', async () => {
    await renderLoaded();
    expect(screen.getByTitle('Upload XML')).toBeInTheDocument();
  });

  it('renders reset button', async () => {
    await renderLoaded();
    expect(screen.getByTitle('Reset Data')).toBeInTheDocument();
  });

  it('shows the usage analysis inside Overview', async () => {
    await renderLoaded();
    expect(screen.getByTestId('chart-view')).toBeInTheDocument();
    // Each analysis group is framed by the question it answers — in the
    // Overview embed as well as the Analytics destination.
    expect(screen.getByText('When do you use power?')).toBeInTheDocument();
    expect(screen.getByText('How does weather relate to usage?')).toBeInTheDocument();
    expect(screen.getByText('Which days were unusual?')).toBeInTheDocument();
    expect(screen.getByText(/Usage Anomalies/i)).toBeInTheDocument();
    expect(screen.getByText(/Weekly Routine Heatmap/i)).toBeInTheDocument();
    // The chart is embedded, not exposed as a fourth tab panel.
    expect(screen.getByTestId('tab-panel-overview')).toContainElement(screen.getByTestId('overview-usage'));
    expect(screen.queryByTestId('tab-panel-analytics')).not.toBeInTheDocument();
  });

  it('routes the overview analytics call to the real Analytics panel', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(screen.getByTestId('overview-analytics-cta'));
    expect(screen.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('tab-panel-analytics')).toBeInTheDocument();
    // The analytics destination keeps the full analysis reachable.
    expect(screen.getByTestId('chart-view')).toBeInTheDocument();
    expect(screen.getByText(/Usage Anomalies/i)).toBeInTheDocument();
  });

  it('empty Analytics explains how to add data without rendering empty visualizations', async () => {
    Storage.prototype.getItem = vi.fn(() => null);
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument());
    // Dismiss the Link Data screen: what remains must be calm and specific.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    // Fresh Overview: a next action and the Analytics door, and NOTHING
    // empty-chart shaped — no embed, no heatmap, no zero grids.
    expect(screen.getByTestId('overview-analytics-cta')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-usage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Analytics' }));
    expect(screen.getByTestId('analytics-empty-state')).toBeInTheDocument();
    expect(screen.getByText(/Import or try sample data/i)).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
    expect(screen.queryByText(/Usage Anomalies/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Weekly Routine Heatmap/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('temp-band-card')).not.toBeInTheDocument();
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
    // Tiered T1 is 12.0 and the chips print source precision (fmtCentsAuto),
    // so it reads "12¢" — not a forced "12.0¢".
    expect(screen.getAllByText('12¢').length).toBeGreaterThanOrEqual(1);
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
    expect(screen.queryByTestId('tab-panel-analytics')).not.toBeInTheDocument();

    expect(screen.getByTestId('chart-view')).toBeInTheDocument();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: 'Plans' }));
    expect(screen.getByTestId('tab-panel-plans')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByTestId('tab-panel-money')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('leads Overview with its period heading and retains the decision banner', async () => {
    await renderLoaded();
    const overview = screen.getByTestId('tab-panel-overview');
    expect(overview.firstElementChild).toBe(screen.getByTestId('overview-period-heading'));
    expect(screen.getByTestId('best-choice-banner')).toBeInTheDocument();
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
    // Wave R: the cards moved out of Dashboard into PlanCards (Plans tab) and
    // became real buttons with an accessible name — query by that instead of
    // by position in the DOM.
    screen.getByRole('button', { name: `Use the ${title} plan` });
  const cardRates = (title: string): string[] =>
    within(planCard(title)).getAllByText(/¢$/).map((n) => n.textContent as string);
  const cardCost = (title: string): string | null =>
    within(planCard(title)).getByText(/^\$/).textContent;

  it('plan cards render every rate from the active RateSet, not literals', async () => {
    stubSsot();
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('tab', { name: 'Plans' }));

    expect(cardRates('Tiered Pricing')).toEqual(['12.34¢', '14.56¢']);
    expect(cardRates('Time-of-Use')).toEqual(['9.75¢', '15.25¢', '20.5¢']);
    expect(cardRates('Ultra-Low Overnight')).toEqual(['3.21¢', '9.75¢', '15.25¢', '39.99¢']);

    // the old hard-coded Nov-2025 card copy is gone from the rendered dashboard
    const text = document.body.textContent || '';
    for (const literal of ['9.8¢', '15.7¢', '20.3¢', '3.9¢', '12.0¢', '14.2¢', '39.1¢']) {
      expect(text).not.toContain(literal);
    }
  });

  it('plan-card displayed cents are exactly the rates that priced the displayed cost', async () => {
    stubSsot();
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('tab', { name: 'Plans' }));

    const touRates = cardRates('Time-of-Use').map((s) => parseFloat(s));   // Off/Mid/On-Peak
    const tierRates = cardRates('Tiered Pricing').map((s) => parseFloat(s)); // Tier 1 / Tier 2
    const uloRates = cardRates('Ultra-Low Overnight').map((s) => parseFloat(s)); // Overnight..On-Peak

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
    expect(cardCost('Ultra-Low Overnight')).toBe(`$${uloCost.toFixed(2)}`);
    expect(cardCost('Tiered Pricing')).toBe(`$${tierCost.toFixed(2)}`);
    expect(touRates[0]).toBe(9.75); // display value came from the RateSet, not '9.8¢'
  });

  it('no RateSet in view: the cards show no rate rows at all, never a stale copy', async () => {
    // Readings loaded but the rate schedule did not — the one state where the
    // old card copy printed November-2025 numbers as if they were current.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ historicalRates: [] }),
    }));
    Storage.prototype.getItem = vi.fn((key: string) => {
      if (key === 'energy_data') return JSON.stringify(ssotRawData);
      if (key === 'billing_day') return '1';
      return null;
    });
    const user = userEvent.setup();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('tab', { name: 'Plans' }));

    expect(screen.queryAllByText(/¢$/)).toHaveLength(0);
    const text = document.body.textContent || '';
    for (const literal of ['9.8¢', '15.7¢', '20.3¢', '3.9¢', '12.0¢', '14.2¢', '39.1¢']) {
      expect(text).not.toContain(literal);
    }
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

/* ========================================================================== *
 * Link Data — the fresh / no-data modal (card t_69a51490)
 *
 * These lock the Quiet Meter surface contract of the first-run dialog only:
 * one labelled dialog, the semantic token ladder, a hairline edge with no
 * hard-offset shadow, and the exact file inputs the handlers are wired to.
 * They deliberately assert tokens and semantics, never a full class string.
 * ========================================================================== */

describe('Link Data fresh modal', () => {
  async function renderFreshModal() {
    Storage.prototype.getItem = vi.fn(() => null);
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    return screen.getByTestId('upload-modal');
  }

  it('auto-opens as a single labelled modal dialog over a quiet scrim', async () => {
    const modal = await renderFreshModal();
    expect(modal).toHaveAttribute('role', 'dialog');
    expect(modal).toHaveAttribute('aria-modal', 'true');
    expect(modal).toHaveAccessibleName('Link your Green Button data');
    // scrim stays, but it is a plain tint — no blur layer, no second overlay
    expect(modal.className).toContain('bg-inv/70');
    expect(modal.className).not.toContain('backdrop-blur');
    // and the fresh state carries no storage notice to explain
    expect(screen.queryByTestId('storage-notice')).not.toBeInTheDocument();
  });

  it('the dialog card uses the quiet ladder: hairline edge, rounded-lg, no shadow', async () => {
    const modal = await renderFreshModal();
    const card = modal.firstElementChild as HTMLElement;
    for (const token of ['bg-card', 'text-ink', 'border-edge', 'rounded-lg', 'shadow-none', 'max-w-2xl']) {
      expect(card.classList.contains(token)).toBe(true);
    }
    // the legacy surface is gone: no thick border, no deep radius, no hard shadow
    expect(card.className).not.toMatch(/border-[248]\b|rounded-\[|shadow-hard/);
    expect(screen.getByRole('heading', { name: 'Link Data' })).toBeInTheDocument();
    expect(screen.getByText(/privacy-first/i)).toBeInTheDocument();
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();
  });

  it('keeps the XML and JSON file inputs exactly as wired', async () => {
    const modal = await renderFreshModal();
    const xml = screen.getByLabelText('Upload Green Button XML') as HTMLInputElement;
    expect(xml.closest('[data-testid="upload-modal"]')).toBe(modal);
    expect(xml).toHaveAttribute('type', 'file');
    expect(xml).toHaveAttribute('accept', '.xml');
    expect(xml).toHaveAttribute('multiple');
    expect(xml).not.toBeDisabled();

    const json = screen.getByLabelText('Import JSON backup') as HTMLInputElement;
    expect(json.closest('[data-testid="upload-modal"]')).toBe(modal);
    expect(json).toHaveAttribute('type', 'file');
    expect(json).toHaveAttribute('accept', 'application/json,.json');
  });

  it('offers example data as the primary CTA and Cancel as the quiet secondary', async () => {
    const modal = await renderFreshModal();
    const example = screen.getByTestId('try-example-data');
    expect(example).toBeEnabled();
    expect(example.className).toContain('bg-accent');
    expect(example.className).toContain('text-accent-ink');

    const cancel = within(modal).getByRole('button', { name: 'Cancel' });
    expect(cancel.className).toContain('quiet-action');
    // Cancel really is the way out of the first-run dialog
    await userEvent.setup().click(cancel);
    expect(screen.queryByTestId('upload-modal')).not.toBeInTheDocument();
  });

  it('reads in hierarchy order: title, privacy, drop zone, JSON, Green Button, CTAs', async () => {
    const modal = await renderFreshModal();
    const card = modal.firstElementChild as HTMLElement;
    const beats = (earlier: Element, later: Element) =>
      Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

    const title = screen.getByRole('heading', { name: 'Link Data' });
    const privacy = screen.getByText(/privacy-first/i);
    const dropzone = screen.getByText(/Drop XML Here/i);
    const json = screen.getByLabelText('Import JSON backup');
    // Fresh browser, no live-shim secret in jsdom: the block after the import
    // choices is the Green Button card when configured, its quiet placeholder
    // when the deployment has not switched the feature on. Both are this
    // dialog's Green Button area and both must sit in the same slot.
    const greenButtonSlot = card.querySelector<HTMLElement>(
      '[data-testid="gb-connect-card"], [data-testid="gb-unconfigured"]',
    );
    expect(greenButtonSlot).not.toBeNull();
    const greenButton = greenButtonSlot as HTMLElement;
    expect(greenButton.className).toMatch(/rounded-lg/);
    expect(greenButton.className).not.toMatch(/shadow-hard|border-[248]\b/);
    const example = screen.getByTestId('try-example-data');
    const cancel = within(modal).getByRole('button', { name: 'Cancel' });

    for (const node of [title, privacy, dropzone, json, greenButton, example, cancel]) {
      expect(card).toContainElement(node as HTMLElement);
    }
    expect(beats(title, privacy)).toBe(true);
    expect(beats(privacy, dropzone)).toBe(true);
    expect(beats(dropzone, json)).toBe(true);
    expect(beats(json, greenButton)).toBe(true);
    expect(beats(greenButton, example)).toBe(true);
    expect(beats(example, cancel)).toBe(true);
  });
});

/* ==========================================================================
 * Defect R1 (QA t_13978aee): the Enbridge gas import commits BILL SUMMARIES
 * and ZERO electric DataPoints — `energy_data_v2.points = 0`,
 * `usage_summaries = 10`. The init gate used to ask only "are there points?",
 * so every reload concluded "nothing to show" and reopened the first-run
 * modal over data that was already in storage, on quiet AND classic.
 *
 * The whole point of these tests is the SECOND mount: storage has to PERSIST
 * between two renders, which is why this block puts the real Storage methods
 * back (the file-wide beforeEach swaps them for spies) instead of stubbing
 * localStorage. Fixture: SYNTHETIC only (tests/fixtures/).
 * ========================================================================== */
describe('summary-only reload (defect R1)', () => {
  const USAGE_XML = readFileSync(
    join(__dirname, '../../tests/fixtures/enbridge-gas-synthetic.xml'),
    'utf8',
  );

  // Captured at collection time, before any beforeEach/test body has had the
  // chance to replace the prototypes with spies.
  const realStorage = {
    get: Storage.prototype.getItem,
    set: Storage.prototype.setItem,
    remove: Storage.prototype.removeItem,
    clear: Storage.prototype.clear,
  };

  beforeEach(() => {
    Storage.prototype.getItem = realStorage.get;
    Storage.prototype.setItem = realStorage.set;
    Storage.prototype.removeItem = realStorage.remove;
    Storage.prototype.clear = realStorage.clear;
    localStorage.clear();
    window.history.replaceState(null, '', window.location.pathname);
  });

  /** Fresh browser → first-run modal → import the gas fixture → unmount. */
  const importGasFixture = async (variant: 'quiet' | 'classic') => {
    const view = render(<Dashboard variant={variant} />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    // Genuinely empty storage still gets the first-run dialog (criterion 2).
    expect(screen.getByTestId('upload-modal')).toBeInTheDocument();

    const input = screen.getByLabelText('Upload Green Button XML') as HTMLInputElement;
    await userEvent.upload(
      input,
      new File([USAGE_XML], 'enbridge-gas-synthetic.xml', { type: 'text/xml' }),
    );

    // The import landed: modal gone, ten GAS summaries stored — under the
    // gas key (t_8a9038d6). The electric key is not addressed by a gas
    // upload at all, which is what keeps both imports alive in one browser.
    await waitFor(() => {
      const raw = localStorage.getItem('gas_usage_summaries');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toHaveLength(10);
    });
    expect(screen.queryByTestId('upload-modal')).toBeNull();
    // The exact precondition QA accepted, in the split key space: gas bills
    // + gas intervals stored, NO electric points written.
    const gas = localStorage.getItem('energy_gas_v2');
    expect(gas).not.toBeNull();
    expect(JSON.parse(gas as string).points).toHaveLength(5);
    const energy = localStorage.getItem('energy_data_v2');
    expect(energy).toBeNull(); // a gas upload never writes the electric key

    view.unmount();
  };

  /** Reload (a fresh mount over the same storage) and see what the user sees. */
  const reloadAndExpectData = async (variant: 'quiet' | 'classic') => {
    render(<Dashboard variant={variant} />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    // R1: the data IS in storage, so the first-run modal must NOT come back.
    expect(screen.queryByTestId('upload-modal')).toBeNull();
    // ...and the data itself is on screen: ten gas periods, feed-exact money.
    await userEvent.click(screen.getByRole('tab', { name: 'Plans' }));
    const cards = await screen.findAllByTestId('gas-period');
    expect(cards).toHaveLength(10);
    expect(within(cards[0]).getByTestId('gas-amount-due').textContent).toContain('$175.76');
    expect(within(cards[9]).getByTestId('gas-amount-due').textContent).toContain('$72.47');
  };

  it('quiet: reload opens the dashboard, not the modal, with all ten gas periods', async () => {
    await importGasFixture('quiet');
    await reloadAndExpectData('quiet');
  });

  it('classic: reload opens the dashboard, not the modal, with all ten gas periods', async () => {
    await importGasFixture('classic');
    await reloadAndExpectData('classic');
  });

  it('quiet: reload on a #tab deep link behaves the same (hash or not)', async () => {
    await importGasFixture('quiet');
    window.history.replaceState(null, '', `${window.location.pathname}#tab=plans`);
    await reloadAndExpectData('quiet');
  });

  it('classic: reload on a #tab deep link behaves the same (hash or not)', async () => {
    await importGasFixture('classic');
    window.history.replaceState(null, '', `${window.location.pathname}#tab=plans`);
    await reloadAndExpectData('classic');
  });

  it('genuinely empty storage still opens the modal after the same reload (control)', async () => {
    // No import at all: two mounts over storage that never held anything.
    const view = render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('upload-modal')).toBeInTheDocument();
    view.unmount();

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('upload-modal')).toBeInTheDocument();
  });
});
