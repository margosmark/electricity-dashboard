/**
 * Wave G item 4 — the upload modal tells you WHY nothing loaded.
 *
 * Regression guard for the old behaviour: a bad file either threw a bare
 * `alert("Parse Error")` or failed silently with the modal left open and no
 * explanation at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const GOOD_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link href="https://u.example/UsagePoint/up-1/MeterReading/m/IntervalBlock/b" rel="self"/>
    <content><IntervalBlock>
      <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading>
    </IntervalBlock></content>
  </entry>
</feed>`;

const METADATA_ONLY_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>UsagePoint</title></entry>
  <entry><title>MeterReading</title></entry>
</feed>`;

async function upload(fileName: string, contents: string, type = 'text/xml') {
  const input = document.querySelector('input[type="file"][accept=".xml"]') as HTMLInputElement;
  const user = userEvent.setup();
  await user.upload(input, new File([contents], fileName, { type }));
}

beforeEach(() => {
  // Real localStorage: these tests assert what actually gets written.
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve(mockRates) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function renderEmptyDashboard() {
  render(<Dashboard />);
  await waitFor(() => expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument());
}

describe('first-run upload diagnostics', () => {
  it('opens on the upload modal when there is no data', async () => {
    await renderEmptyDashboard();
    expect(screen.getByText(/drop xml here/i)).toBeInTheDocument();
    expect(screen.queryByTestId('parse-diagnostic')).not.toBeInTheDocument();
  });

  it('explains a saved web page instead of saying "invalid XML"', async () => {
    await renderEmptyDashboard();
    await upload('export.xml', '<!DOCTYPE html><html><body>Please sign in to continue</body></html>', 'text/html');

    const panel = await screen.findByTestId('parse-diagnostic');
    expect(panel).toHaveTextContent(/web page, not an export/i);
    expect(panel).toHaveTextContent(/login or error page/i);
    expect(panel).toHaveTextContent(/Download My Data/i);
    expect(panel.textContent).not.toMatch(/^invalid xml$/i);
    // The modal is still up so the user can pick the right file.
    expect(screen.getByText(/drop xml here/i)).toBeInTheDocument();
  });

  it('explains a feed whose entries carry no readings', async () => {
    await renderEmptyDashboard();
    await upload('metadata.xml', METADATA_ONLY_FEED);

    const panel = await screen.findByTestId('parse-diagnostic');
    expect(panel).toHaveTextContent(/2 entries, but no interval readings/i);
    expect(panel).toHaveTextContent(/IntervalBlock/);
  });

  it('explains a truncated file with a line number', async () => {
    await renderEmptyDashboard();
    await upload('broken.xml', '<?xml version="1.0"?>\n<feed>\n  <entry>\n</feed>');

    const panel = await screen.findByTestId('parse-diagnostic');
    expect(panel).toHaveTextContent(/well-formed/i);
    expect(panel.textContent).toMatch(/line \d+/);
  });

  it('clears the diagnostic as soon as a good file is uploaded', async () => {
    await renderEmptyDashboard();
    await upload('bad.xml', 'this is not xml at all');
    await screen.findByTestId('parse-diagnostic');

    await upload('good.xml', GOOD_FEED);
    await waitFor(() => expect(screen.queryByTestId('parse-diagnostic')).not.toBeInTheDocument());
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('energy_data') || '[]')).toHaveLength(1);
    });
  });

  it('clears the diagnostic when the modal is reopened', async () => {
    await renderEmptyDashboard();
    await upload('bad.xml', 'this is not xml at all');
    await screen.findByTestId('parse-diagnostic');

    // Hitting "Upload XML" again is a fresh start: no stale error carried over.
    await userEvent.setup().click(screen.getByTitle('Upload XML'));
    expect(screen.queryByTestId('parse-diagnostic')).not.toBeInTheDocument();
    expect(screen.getByText(/drop xml here/i)).toBeInTheDocument();
  });
});
