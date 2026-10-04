import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format } from 'date-fns';

import Dashboard from './Dashboard';
import { ExportCsvButton, downloadCSV } from './ExportCsvButton';
import { UsagePointPicker } from './UsagePointPicker';
import { TrueBillEstimate } from './TrueBillEstimate';
import {
  processRawData,
  parseGreenButtonUsagePoints,
  type RateSet,
} from '@/lib/energy';
import { EXTRA_CHARGES_KEY } from '@/hooks/useDashboard';

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

const rateSet: RateSet = mockRates.historicalRates[0];

const mockRawData = [
  { timestamp: 1704067200, usage_kwh: 10 },
  { timestamp: 1704070800, usage_kwh: 20 },
];

const rows = processRawData(mockRawData, [rateSet]);

/* ---- Green Button fixtures (Atom + ESPI, as utilities emit them) ---- */

function feed(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${entries}</feed>`;
}

function blockEntry(id: string, usagePointId: string | null, values: [number, number][]): string {
  const links = usagePointId
    ? `<link href="https://utility.example/espi/UsagePoint/${usagePointId}/MeterReading/mr-${id}/IntervalBlock/ib-${id}" rel="self" type="espi-entry/IntervalBlock"/>`
    : '';
  const readings = values
    .map(
      ([start, wh]) =>
        `<espi:IntervalReading><espi:timePeriod><espi:start>${start}</espi:start><espi:duration>3600</espi:duration></espi:timePeriod><espi:value>${wh}</espi:value></espi:IntervalReading>`,
    )
    .join('');
  return `<entry><id>urn:uuid:${id}</id>${links}<content><espi:IntervalBlock>${readings}</espi:IntervalBlock></content></entry>`;
}

const TWO_POINT_XML = feed(
  blockEntry('block-a', 'aaaaaaaa-1111-2222-3333-444444444444', [
    [1704067200, 1500],
    [1704070800, 2000],
  ]) +
    blockEntry('block-b', 'bbbbbbbb-1111-2222-3333-444444444444', [
      [1704067200, 9000],
      [1704070800, 4000],
    ]),
);

const SINGLE_POINT_XML = feed(
  blockEntry('block-a', 'aaaaaaaa-1111-2222-3333-444444444444', [
    [1704067200, 1500],
    [1704070800, 2000],
  ]),
);

/* ========================================================================== *
 * CSV export button
 * ========================================================================== */

describe('ExportCsvButton', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let capturedDownload = '';
  let blob: Blob | null = null;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedDownload = '';
    blob = null;
    createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:mock-url';
    });
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download;
    });
  });

  afterEach(() => {
    clickSpy.mockRestore();
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  it('is disabled when there is nothing to export', () => {
    render(<ExportCsvButton rows={[]} />);
    expect(screen.getByTestId('export-csv')).toBeDisabled();
    expect(screen.getByText(/Export CSV/i)).toBeInTheDocument();
  });

  it('downloads the processed table with the energy_export_<start>_<end>.csv name', async () => {
    const user = userEvent.setup();
    render(<ExportCsvButton rows={rows} />);
    await user.click(screen.getByTestId('export-csv'));

    const expectedDay = format(new Date(mockRawData[0].timestamp * 1000), 'yyyy-MM-dd');
    expect(capturedDownload).toBe(`energy_export_${expectedDay}_${expectedDay}.csv`);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(blob).toBeInstanceOf(Blob);
    const text = await (blob as Blob).text();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 readings
    expect(lines[0]).toBe(
      'datetime,usage_kwh,tou_category,ulo_category,costTOU,costTiered,costULO,activeRateSet.effectiveDate',
    );
    expect(lines[1].split(',').slice(1, 3)).toEqual(['10', 'Off-Peak']);
  });

  it('downloadCSV returns the filename it used', () => {
    expect(downloadCSV(rows)).toBe(
      `energy_export_${format(new Date(mockRawData[0].timestamp * 1000), 'yyyy-MM-dd')}_${format(
        new Date(mockRawData[mockRawData.length - 1].timestamp * 1000),
        'yyyy-MM-dd',
      )}.csv`,
    );
  });
});

/* ========================================================================== *
 * UsagePoint picker
 * ========================================================================== */

describe('UsagePointPicker', () => {
  const groups = parseGreenButtonUsagePoints(TWO_POINT_XML);

  it('lists every point with its own totals, plus a combine option', () => {
    render(
      <UsagePointPicker fileName="feed.xml" groups={groups} onChoose={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('usage-point-picker')).toBeInTheDocument();
    expect(screen.getByTestId('usage-point-aaaaaaaa-1111-2222-3333-444444444444')).toBeInTheDocument();
    expect(screen.getByTestId('usage-point-bbbbbbbb-1111-2222-3333-444444444444')).toBeInTheDocument();
    expect(screen.getByText(/Usage Points Found/i)).toBeInTheDocument();
    expect(screen.getByTestId('usage-point-combine')).toBeInTheDocument();
    // 1.5 + 2.0 = 3.5 kWh for point A, 9.0 + 4.0 = 13.0 kWh for point B
    expect(screen.getByText('3.5 kWh')).toBeInTheDocument();
    expect(screen.getByText('13.0 kWh')).toBeInTheDocument();
  });

  it('loading one point hands over only that point rows', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(<UsagePointPicker fileName="feed.xml" groups={groups} onChoose={onChoose} onCancel={vi.fn()} />);
    await user.click(screen.getByTestId('usage-point-aaaaaaaa-1111-2222-3333-444444444444'));
    expect(onChoose).toHaveBeenCalledTimes(1);
    const chosen = onChoose.mock.calls[0][0];
    expect(chosen.map((r: { usage_kwh: number }) => r.usage_kwh)).toEqual([1.5, 2.0]);
  });

  it('combine hands over every row, sorted by time', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(<UsagePointPicker fileName="feed.xml" groups={groups} onChoose={onChoose} onCancel={vi.fn()} />);
    await user.click(screen.getByTestId('usage-point-combine'));
    const chosen = onChoose.mock.calls[0][0];
    expect(chosen).toHaveLength(4);
    expect(chosen.map((r: { timestamp: number }) => r.timestamp)).toEqual([
      1704067200, 1704067200, 1704070800, 1704070800,
    ]);
  });

  it('cancel backs out without choosing anything', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onChoose = vi.fn();
    render(<UsagePointPicker fileName="feed.xml" groups={groups} onChoose={onChoose} onCancel={onCancel} />);
    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });
});

/* ========================================================================== *
 * True-bill estimate card
 * ========================================================================== */

describe('TrueBillEstimate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows only the variable estimate and the untouched caption when every field is empty', () => {
    render(<TrueBillEstimate plan="TOU" startDate="2024-01-01" endDate="2024-01-02" windowData={rows} />);
    expect(screen.getByTestId('variable-estimate').textContent).toBe('$2.94');
    const caption = screen.getByTestId('estimate-caption').textContent || '';
    expect(caption).toContain('does not include fixed delivery charges, regulatory charges, or HST');
    expect(screen.queryByTestId('true-bill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('true-bill-total')).not.toBeInTheDocument();
  });

  it('keeps the HST field empty but hints at the Ontario 13% default', () => {
    render(<TrueBillEstimate plan="TOU" startDate="2024-01-01" endDate="2024-01-02" windowData={rows} />);
    const hst = screen.getByTestId('charge-hst-pct') as HTMLInputElement;
    expect(hst.value).toBe('');
    expect(hst.placeholder).toBe('13');
  });

  it('adds a True Bill Estimate the moment an add-on is typed, and persists it', async () => {
    const user = userEvent.setup();
    render(<TrueBillEstimate plan="TOU" startDate="2024-01-01" endDate="2024-01-02" windowData={rows} />);

    await user.type(screen.getByTestId('charge-delivery-per-kwh'), '0.01');

    // 30 kWh window: variable 2.94 + delivery 0.30 = 3.24 (no HST supplied)
    expect(screen.getByTestId('true-bill-total').textContent).toBe('$3.24');
    const caption = screen.getByTestId('estimate-caption').textContent || '';
    expect(caption).toContain('variable energy charges');
    expect(caption).toContain('delivery ($0.0100/kWh)');

    const saved = JSON.parse(localStorage.getItem(EXTRA_CHARGES_KEY) || '{}');
    expect(saved.deliveryPerKwh).toBe('0.01');
  });

  it('applies HST on top of variable + add-ons', async () => {
    const user = userEvent.setup();
    render(<TrueBillEstimate plan="TOU" startDate="2024-01-01" endDate="2024-01-02" windowData={rows} />);

    await user.type(screen.getByTestId('charge-delivery-per-kwh'), '0.01');
    await user.type(screen.getByTestId('charge-hst-pct'), '13');

    // (2.94 + 0.30) * 1.13 = 3.6612
    expect(screen.getByTestId('true-bill-total').textContent).toBe('$3.66');
    expect(screen.getByTestId('estimate-caption').textContent).toContain('HST (13%)');
  });

  it('restores saved add-ons on a fresh mount (persistence across sessions)', () => {
    localStorage.setItem(
      EXTRA_CHARGES_KEY,
      JSON.stringify({ deliveryPerKwh: '0.01', deliveryFlat: '', regulatoryPerKwh: '', hstPct: '' }),
    );
    render(<TrueBillEstimate plan="TOU" startDate="2024-01-01" endDate="2024-01-02" windowData={rows} />);
    expect((screen.getByTestId('charge-delivery-per-kwh') as HTMLInputElement).value).toBe('0.01');
    expect(screen.getByTestId('true-bill-total').textContent).toBe('$3.24');
  });

  it('renders nothing when the window has no rows', () => {
    const { container } = render(
      <TrueBillEstimate plan="TOU" startDate="2024-01-01" endDate="2024-01-02" windowData={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/* ========================================================================== *
 * Dashboard integration: upload → picker → only the chosen meter loads
 * ========================================================================== */

async function renderDashboard() {
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
  });
}

async function uploadXml(fileName: string, xml: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([xml], fileName, { type: 'text/xml' });
  const user = userEvent.setup();
  await user.upload(input, file);
}

describe('Dashboard upload with multiple UsagePoints', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve(mockRates) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('single-UsagePoint file loads immediately, exactly as before (no picker)', async () => {
    await renderDashboard();
    await uploadXml('single.xml', SINGLE_POINT_XML);

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('energy_data') || '[]');
      expect(saved).toHaveLength(2);
    });
    expect(screen.queryByTestId('usage-point-picker')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('energy_data') || '[]').map((r: { usage_kwh: number }) => r.usage_kwh)).toEqual([
      1.5, 2.0,
    ]);
  });

  it('multi-UsagePoint file asks first, then loads only the chosen point', async () => {
    await renderDashboard();
    await uploadXml('two-meters.xml', TWO_POINT_XML);

    await waitFor(() => {
      expect(screen.getByTestId('usage-point-picker')).toBeInTheDocument();
    });
    // Nothing imported while the picker is up.
    expect(localStorage.getItem('energy_data')).toBeNull();

    await userEvent.click(screen.getByTestId('usage-point-bbbbbbbb-1111-2222-3333-444444444444'));

    await waitFor(() => {
      expect(screen.queryByTestId('usage-point-picker')).not.toBeInTheDocument();
    });
    const saved = JSON.parse(localStorage.getItem('energy_data') || '[]');
    expect(saved.map((r: { usage_kwh: number }) => r.usage_kwh)).toEqual([9.0, 4.0]);
  });

  it('multi-UsagePoint file can be combined on request', async () => {
    await renderDashboard();
    await uploadXml('two-meters.xml', TWO_POINT_XML);

    await waitFor(() => {
      expect(screen.getByTestId('usage-point-picker')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('usage-point-combine'));

    await waitFor(() => {
      expect(screen.queryByTestId('usage-point-picker')).not.toBeInTheDocument();
    });
    const saved = JSON.parse(localStorage.getItem('energy_data') || '[]');
    expect(saved.map((r: { usage_kwh: number }) => r.usage_kwh)).toEqual([1.5, 9.0, 2.0, 4.0]);
  });

  it('cancelling the picker imports nothing and returns to the upload screen', async () => {
    await renderDashboard();
    await uploadXml('two-meters.xml', TWO_POINT_XML);

    await waitFor(() => {
      expect(screen.getByTestId('usage-point-picker')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('usage-point-picker')).not.toBeInTheDocument();
    });
    expect(localStorage.getItem('energy_data')).toBeNull();
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();
  });
});
