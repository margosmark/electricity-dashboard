/**
 * Wave H — the QoL pass, behaviour-tested end to end in the DOM.
 *
 * Slices covered here:
 *   1. sample-data button (fetch → same parse path → commit → banner → exit)
 *   2. persisted plan + header chip agreement
 *   3. a11y: Escape on every overlay, dialog semantics, labelled controls,
 *      keyboard-operable plan cards, and the standing CSS gates
 *   4. chart skeleton on the 0 → N rows transition
 *   5. "Data as of" freshness chip (date, age, stale flag)
 *   7. $/yr ↔ $/day cost reframe
 *
 * Item 8 (crash state) has its own file: AppErrorBoundary.test.tsx.
 * Item 6 (print) is CSS + browser evidence; the CSS contract is asserted here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format } from 'date-fns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Dashboard from './Dashboard';
import ChartView from './ChartView';
import ActivePlanChip from './ActivePlanChip';
import { EXAMPLE_DATA_URL } from '@/lib/exampleData';
import { PLAN_STORAGE_KEY, resetPlanStore } from '@/hooks/useSelectedPlan';
import { EXAMPLE_DATA_KEY } from '@/hooks/useDashboard';
import {
  processRawData,
  buildActiveChartData,
  type RateSet,
} from '@/lib/energy';
import { projectMonthBill } from '@/lib/billProjection';
import { loadEnergyData, saveEnergyData } from '@/lib/storage';

// The readings live under the versioned key now; read them the way the app
// does (storage.ts migrates the legacy `energy_data` key on the way in).
function storedRows() {
  const res = loadEnergyData();
  return res.ok && res.value ? res.value.points : [];
}


const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(HERE, '../..');

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
  { timestamp: 1704067200, usage_kwh: 1.5 },
  { timestamp: 1704070800, usage_kwh: 2.0 },
  { timestamp: 1704074400, usage_kwh: 0.5 },
];
const rows = processRawData(mockRawData, [rateSet]);

/** A tiny valid single-meter feed — the sample button's happy path. */
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://schemas.opengroup.org/espi/1.0">
  <entry><IntervalBlock>
    <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading>
    <IntervalReading><timePeriod><start>1704070800</start></timePeriod><value>2000</value></IntervalReading>
  </IntervalBlock></entry>
</feed>`;

/** Two UsagePoints in one file — forces the picker (for the Escape test). */
const TWO_METER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://schemas.opengroup.org/espi/1.0">
  <entry>
    <link href="https://utility.example/espi/UsagePoint/aaaaaaaa-1111-2222-3333-444444444444/MeterReading/mr-1/IntervalBlock/ib-1" rel="self"/>
    <content><IntervalBlock><IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading></IntervalBlock></content>
  </entry>
  <entry>
    <link href="https://utility.example/espi/UsagePoint/bbbbbbbb-1111-2222-3333-444444444444/MeterReading/mr-2/IntervalBlock/ib-2" rel="self"/>
    <content><IntervalBlock><IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>9000</value></IntervalReading></IntervalBlock></content>
  </entry>
</feed>`;

type FetchImpl = (input: RequestInfo | URL) => Promise<unknown>;

/** `/api/rates` for the shell, the sample URL for the button, else fail loud. */
function stubFetch(extra: Partial<Record<string, () => Promise<unknown>>> = {}) {
  const impl: FetchImpl = async (input) => {
    const url = String(input);
    if (url === '/api/rates') return { json: async () => mockRates };
    if (extra[url]) return extra[url]!();
    throw new Error(`unexpected fetch: ${url}`);
  };
  vi.stubGlobal('fetch', vi.fn(impl));
  return impl;
}

async function renderLoaded(data: unknown[] | null = mockRawData) {
  if (data) saveEnergyData(data as Parameters<typeof saveEnergyData>[0]);
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
  });
}

beforeEach(() => {
  localStorage.clear();
  // The plan store caches its snapshot in module scope — re-seed it so every
  // test starts from storage instead of the previous test's choice.
  resetPlanStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  resetPlanStore();
});

/* ========================================================================== *
 * 1. Sample / demo data button
 * ========================================================================== */

describe('Wave H 1 — Try with example data', () => {
  it('offers itself on the empty upload screen, labelled as not real usage', async () => {
    stubFetch();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    const button = screen.getByTestId('try-example-data');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent(/try with example data/i);
    // The promise is on screen BEFORE the click, not just after.
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(/a synthetic year modelled on an Ontario home/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/nothing is uploaded anywhere/i)).toBeInTheDocument();
  });

  it('fetches the bundled sample through the normal parse path and commits it', async () => {
    stubFetch({ [EXAMPLE_DATA_URL]: async () => ({ ok: true, text: async () => SAMPLE_XML }) });
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('try-example-data'));

    await waitFor(() => {
      expect(storedRows()).toHaveLength(2);
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(EXAMPLE_DATA_URL);

    // The readings are marked as example data, and the banner says so.
    expect(localStorage.getItem(EXAMPLE_DATA_KEY)).toBe('1');
    expect(screen.getByTestId('example-data-banner')).toBeInTheDocument();
    expect(screen.getByText(/example data — not real usage/i)).toBeInTheDocument();
    // Modal closed: the dashboard is showing, not still asking for a file.
    expect(screen.queryByText(/Drop XML Here/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('totals-strip')).toBeInTheDocument();

    // Wave H: the demo opens on EVERY reading it just loaded, not on one
    // lonely bar (selectInitialWindow would otherwise anchor on the current
    // billing period — correct for a real upload, useless for a demo).
    // Dates are computed with the same clock the app used, because the test
    // runner's timezone is not the browser's.
    const [startInput, endInput] = document.querySelectorAll<HTMLInputElement>(
      'input[type="date"]',
    );
    expect(startInput.value).toBe(format(new Date(1704067200 * 1000), 'yyyy-MM-dd'));
    expect(endInput.value).toBe(format(new Date(1704070800 * 1000), 'yyyy-MM-dd'));
  });

  it('explains a failed download instead of opening an empty dashboard', async () => {
    stubFetch({ [EXAMPLE_DATA_URL]: async () => { throw new Error('offline'); } });
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('try-example-data'));

    const issue = await screen.findByTestId('parse-diagnostic');
    expect(issue).toHaveTextContent(/example data unavailable/i);
    expect(issue).toHaveTextContent(/could not be downloaded/i);
    // Still on the upload screen, with nothing written to storage.
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();
    expect(localStorage.getItem('energy_data')).toBeNull();
    expect(localStorage.getItem(EXAMPLE_DATA_KEY)).toBeNull();
    expect(screen.queryByTestId('example-data-banner')).not.toBeInTheDocument();
  });

  it('lets the user swap the example set for their own file', async () => {
    stubFetch({ [EXAMPLE_DATA_URL]: async () => ({ ok: true, text: async () => SAMPLE_XML }) });
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('try-example-data'));
    await waitFor(() => {
      expect(screen.getByTestId('example-data-banner')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('replace-example-data'));

    // Example data gone, upload prompt back, no half-state left behind.
    expect(localStorage.getItem('energy_data')).toBeNull();
    expect(localStorage.getItem(EXAMPLE_DATA_KEY)).toBeNull();
    expect(screen.queryByTestId('example-data-banner')).not.toBeInTheDocument();
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();
    expect(screen.queryByTestId('totals-strip')).not.toBeInTheDocument();
  });
});

/* ========================================================================== *
 * 2. Persisted plan
 * ========================================================================== */

describe('Wave H 2 — persisted plan', () => {
  it('stores the choice and shows it in the header chip', async () => {
    stubFetch();
    render(
      <>
        <ActivePlanChip />
        <Dashboard />
      </>,
    );
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    const chip = screen.getByTestId('active-plan-chip');
    expect(chip).toHaveAttribute('data-plan', 'TOU');
    expect(chip).toHaveTextContent(/Plan: Time-of-Use/i);

    await userEvent.click(within(screen.getByTestId('plan-switcher')).getByRole('button', { name: 'ULO' }));

    await waitFor(() => {
      expect(localStorage.getItem(PLAN_STORAGE_KEY)).toBe('ULO');
    });
    expect(chip).toHaveAttribute('data-plan', 'ULO');
    expect(chip).toHaveTextContent(/Plan: Ultra-Low Overnight/i);
  });

  it('restores a stored plan on a cold start instead of re-picking', async () => {
    stubFetch();
    localStorage.setItem(PLAN_STORAGE_KEY, 'Tiered');
    render(<ActivePlanChip />);
    expect(screen.getByTestId('active-plan-chip')).toHaveAttribute('data-plan', 'Tiered');
  });
});

/* ========================================================================== *
 * 3. Keyboard + a11y
 * ========================================================================== */

describe('Wave H 3 — Escape closes every overlay', () => {
  it('closes the upload modal', async () => {
    stubFetch();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByText(/Drop XML Here/i)).not.toBeInTheDocument();
    });
    // The dashboard underneath is the four-tab strip, not the old 2-way toggle.
    expect(screen.getByTestId('tab-nav')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
  });

  it('closes the always-on floor help', async () => {
    stubFetch();
    await renderLoaded();
    await userEvent.click(screen.getByRole('button', { name: /always-on floor/i }));
    expect(screen.getByTestId('floor-help-modal')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('floor-help-modal')).not.toBeInTheDocument();
    });
  });

  it('closes the backup drawer', async () => {
    stubFetch();
    await renderLoaded();
    await userEvent.click(screen.getByTestId('backup-toggle'));
    expect(screen.getByTestId('backup-drawer')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('backup-drawer')).not.toBeInTheDocument();
    });
    // The toggle's expanded state must not lie about the drawer.
    expect(screen.getByTestId('backup-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the UsagePoint picker without importing anything', async () => {
    stubFetch();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File([TWO_METER_XML], 'two-meters.xml', { type: 'text/xml' }));

    const picker = await screen.findByTestId('usage-point-picker');
    expect(picker).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('usage-point-picker')).not.toBeInTheDocument();
    });
    expect(localStorage.getItem('energy_data')).toBeNull();
    expect(screen.getByText(/Drop XML Here/i)).toBeInTheDocument();
  });
});

describe('Wave H 3 — semantics and labels', () => {
  it('marks every overlay as a modal dialog', async () => {
    stubFetch();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
  });

  it('gives every icon-only control an accessible name', async () => {
    stubFetch();
    await renderLoaded();
    const upload = screen.getByRole('button', { name: 'Upload XML' });
    expect(upload).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset all data/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Backup and restore' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Billing day of month' })).toBeInTheDocument();
    // Date inputs are not exposed as `textbox` in jsdom — label lookup is
    // also the stronger assertion (it fails if aria-label is dropped).
    expect(screen.getByLabelText('Window start date')).toBeInTheDocument();
    expect(screen.getByLabelText('Window end date')).toBeInTheDocument();
  });

  it('exposes pressed state on every toggle group', async () => {
    stubFetch();
    await renderLoaded();
    // Wave R: the CHART/INSIGHTS toggle is now an ARIA tab strip — selected
    // state replaces pressed state, and exactly one tab is selected.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(screen.getByRole('tab', { name: 'Overview' }));
    // Roving tabindex: the strip is ONE tab stop, not four.
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('tabindex', '-1');

    // The scope buttons are mutually exclusive: never more than one pressed.
    // (First load here anchors on a Custom trailing window, so none is pressed
    // until the user picks a scope.)
    const pressedScopes = () =>
      ['Billing Period', 'Month', 'YTD']
        .map((name) => screen.getByRole('button', { name }))
        .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressedScopes().length).toBeLessThanOrEqual(1);

    await userEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(pressedScopes()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');

    // The switcher's accessible name IS the visible text (see Wave H 3b):
    // "Select Time-of-Use plan" hid "TOU" from it.
    const tou = screen.getByRole('button', { name: 'TOU' });
    expect(tou).toHaveAttribute('aria-pressed', 'true');
  });

  it('makes the clickable plan cards reachable and operable from the keyboard', async () => {
    stubFetch();
    await renderLoaded();
    // Wave R: the cards moved to Plans & Track Record.
    await userEvent.click(screen.getByRole('tab', { name: 'Plans' }));
    const card = screen.getByRole('button', { name: 'Use the Tiered Pricing plan' });
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card).toHaveAttribute('aria-pressed', 'false');

    card.focus();
    expect(document.activeElement).toBe(card);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Tiered' })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the standing focus/print gates in globals.css', () => {
    const css = fs.readFileSync(path.join(WEBAPP, 'src/app/globals.css'), 'utf8');
    // One ring that reads on white, yellow AND black chips.
    expect(css).toMatch(/:focus-visible\s*{[^}]*outline:\s*3px solid #ffffff/);
    expect(css).toMatch(/box-shadow:\s*0 0 0 6px #2563eb/);
    expect(css).toMatch(/\.seg\s*{[^}]*min-height:\s*44px/);
    // Print contract for InsightsView.
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/@page\s*{[^}]*size:\s*portrait/);
    expect(css).toMatch(/\.no-print\s*{\s*display:\s*none\s*!important/);
    expect(css).toMatch(/\.print-compact/);
    // Reduced motion: the skeleton must not be a prerequisite for reading.
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

/* ========================================================================== *
 * 3b. The four Lighthouse a11y findings (t_d5cc9a2d)
 * ========================================================================== */

describe('Wave H 3b — Lighthouse accessibility findings', () => {
  /** WCAG 2.x relative luminance, the same math the color-contrast audit runs. */
  const luminance = (hex: string): number => {
    const channel = (v: number): number => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  /**
   * WCAG 2.1 contrast between two hex colours. `1.05 / (L + 0.05)` — the form
   * the old separator test used — is this with a hardcoded white background
   * (L=1.0), which is exactly the assumption dark mode breaks.
   */
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  /**
   * Resolve a semantic token to its painted hex for a theme, straight from
   * globals.css — the test reads the SAME declarations the browser does, so
   * it cannot drift from the token layer the way a hardcoded hex could.
   * Spec §2 #3: the old test hardcoded `1.05 / (L + 0.05)`, i.e. it assumed a
   * white background for every theme. The separator is `text-ink-2` on the
   * toolbar's card, so the background is `--card` and it differs by theme.
   */
  const tokenHex = (token: string, theme: 'light' | 'dark'): string => {
    const css = fs.readFileSync(path.join(WEBAPP, 'src/app/globals.css'), 'utf8');
    const block =
      theme === 'dark'
        ? css.slice(css.indexOf("[data-theme='dark']"))
        : css.slice(css.indexOf(':root {'), css.indexOf("[data-theme='dark']"));
    const m = block.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`));
    return m?.[1] ?? '';
  };

  it('paints the "TO" window separator at ≥4.5:1 in BOTH themes', async () => {
    stubFetch();
    await renderLoaded();

    const separator = screen.getByTestId('window-separator');
    expect(separator).toHaveTextContent('TO');
    // opacity-40 black on white is #999999 = 2.84:1 — the colour has to carry
    // the ratio itself, not an opacity fraction of black.
    expect(separator.className).not.toMatch(/opacity-/);
    // The separator is semantic now, so the gate checks the TOKEN resolves,
    // not that one arbitrary hex literal happens to be dark enough.
    expect(separator.className).toMatch(/text-ink-2/);

    for (const theme of ['light', 'dark'] as const) {
      const ink = tokenHex('ink-2', theme);
      const bg = tokenHex('card', theme);
      expect(ink, `--ink-2 must be a hex literal in ${theme}`).toBeTruthy();
      expect(bg, `--card must be a hex literal in ${theme}`).toBeTruthy();
      const ratio = contrast(ink, bg);
      expect(ratio, `separator ${ink} on ${bg} (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives the plan-switcher buttons the accessible name they visibly show', async () => {
    stubFetch();
    await renderLoaded();

    const switcher = screen.getByTestId('plan-switcher');
    for (const visible of ['Tiered', 'TOU', 'ULO']) {
      const button = within(switcher).getByRole('button', { name: visible });
      // "Select Time-of-Use plan" did not contain the visible "TOU" (axe
      // label-content-name-mismatch). aria-pressed still carries the state.
      expect(button).toHaveTextContent(visible);
      expect(button).not.toHaveAttribute('aria-label');
    }
  });

  it('labels the file input in the upload modal', async () => {
    stubFetch();
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
    });

    const input = screen.getByLabelText('Upload Green Button XML');
    expect(input).toHaveAttribute('type', 'file');
    // …and it is the one inside the modal, not some other input on the page.
    expect(input.closest('[data-testid="upload-modal"]')).not.toBeNull();
  });
});

/* ========================================================================== *
 * 4. Chart skeleton
 * ========================================================================== */

describe('Wave H 4 — chart skeleton', () => {
  const baseProps = {
    zoomLevel: 'monthly' as const,
    zoomTarget: null,
    goBack: vi.fn(),
    navigatePeriod: vi.fn(),
    setZoomLevelAndClear: vi.fn(),
    handleBarClick: vi.fn(),
    selectionCost: 0,
    userPlan: 'TOU' as const,
    setUserPlan: vi.fn(),
    comparison: null,
    activeRateSet: rateSet,
    startDate: '2024-01-01',
    endDate: '2024-01-01',
    projection: projectMonthBill(rows, 'TOU', new Date()),
    wfh: null,
  };

  it('says "no readings" instead of drawing an empty axis frame', () => {
    render(<ChartView {...baseProps} activeChartData={[]} filteredData={[]} />);
    expect(screen.getByTestId('chart-empty-window')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-skeleton')).not.toBeInTheDocument();
  });

  it('shimmers while Recharts grows the bars, then gets out of the way', async () => {
    const chartData = buildActiveChartData(rows, 'monthly', null);
    const { rerender } = render(
      <ChartView {...baseProps} activeChartData={[]} filteredData={[]} />,
    );
    expect(screen.queryByTestId('chart-skeleton')).not.toBeInTheDocument();

    act(() => {
      rerender(<ChartView {...baseProps} activeChartData={chartData} filteredData={rows} />);
    });

    const skeleton = await screen.findByTestId('chart-skeleton');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveAccessibleName(/drawing/i);
    expect(skeleton.querySelectorAll('.skeleton-bar').length).toBeGreaterThan(0);

    // It must clear itself once the bars have had time to animate in.
    await waitFor(
      () => expect(screen.queryByTestId('chart-skeleton')).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
    expect(screen.getByTestId('chart-area')).toBeInTheDocument();
    const dataTable = await screen.findByTestId('chart-data-table');
    expect(dataTable.querySelectorAll('tbody tr')).toHaveLength(chartData.length);
    expect(dataTable).toHaveTextContent(chartData[0].label);

  });
});

/* ========================================================================== *
 * 5 + 7. Freshness chip and the $/yr ↔ $/day reframe
 * ========================================================================== */

describe('Wave H 5 + 7 — totals strip', () => {
  it('reports how old the data is, and flags a stale export', async () => {
    stubFetch();
    await renderLoaded();
    const chip = screen.getByTestId('data-freshness-chip');
    // Same clock the app used: date-fns formats in the RUNNING timezone.
    const expectedLast = format(new Date(mockRawData[2].timestamp * 1000), 'yyyy-MM-dd');
    const expectedLabel = format(new Date(mockRawData[2].timestamp * 1000), 'MMM d, yyyy');
    expect(chip).toHaveAttribute('data-last-reading', expectedLast);
    expect(chip).toHaveAttribute('data-stale', 'true');
    expect(chip).toHaveTextContent(new RegExp(`Data as of ${expectedLabel}`, 'i'));
    // Relative age is computed, not hardcoded — assert the shape.
    expect(chip.textContent).toMatch(/\d+ (day|month|year)s ago/);
    expect(chip.textContent).toMatch(/upload a newer export/i);
  });

  it('switches the same numbers between $/yr and $/day', async () => {
    stubFetch();
    await renderLoaded();

    const tou = screen.getByTestId('plan-cost-TOU');
    expect(tou).toHaveAttribute('data-unit', 'yr');
    expect(tou.textContent).toMatch(/\/yr/);
    expect(screen.getByTestId('cost-reframe').textContent).toMatch(/\/day/);

    const yearly = tou.textContent || '';

    await userEvent.click(within(screen.getByTestId('cost-toggle')).getByRole('button', { name: '$/day' }));

    expect(tou).toHaveAttribute('data-unit', 'day');
    expect(tou.textContent).toMatch(/\/day/);
    expect(tou.textContent).not.toBe(yearly);
    // The other unit stays visible as the conversion sentence.
    expect(screen.getByTestId('cost-reframe').textContent).toMatch(/\/yr/);
    expect(screen.getByTestId('cost-reframe').textContent).toMatch(/is \$\d/);
    expect(screen.getByRole('button', { name: '$/day' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '$/yr' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('scales every money figure on the strip, not just one card', async () => {
    stubFetch();
    await renderLoaded();
    const strip = screen.getByTestId('totals-strip');
    for (const id of ['TOU', 'Tiered', 'ULO']) {
      expect(within(strip).getByTestId(`plan-cost-${id}`)).toHaveAttribute('data-unit', 'yr');
    }
    await userEvent.click(
      within(within(strip).getByTestId('cost-toggle')).getByRole('button', { name: '$/day' }),
    );
    for (const id of ['TOU', 'Tiered', 'ULO']) {
      expect(within(strip).getByTestId(`plan-cost-${id}`)).toHaveAttribute('data-unit', 'day');
    }
    expect(within(strip).getByText('Best vs worst plan').parentElement).toHaveTextContent('/day');
  });
});
