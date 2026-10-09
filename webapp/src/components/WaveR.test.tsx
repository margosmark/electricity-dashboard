/**
 * Wave R — the IA rework: tabs, the unburied verdict, and the three new
 * graphs.
 *
 * Covered here, in the order the slices were specified:
 *   1. tab navigation — ARIA roles, roving tabindex, arrow/Home/End keys,
 *      click, localStorage, `#tab=` deep link, and the back button;
 *   2. best-choice unburying — banner first on Overview, the persistent chip
 *      in the toolbar (and its click-to-jump), the one-line verdict;
 *   3. toolbar declutter — rate staleness lives on Usage, file status on
 *      Overview, and neither is in the global toolbar any more;
 *   4. the three new graphs — dual heatmap, bill accrual curve, and the
 *      plan-switch timeline (whose pure logic lives in its own lib tests).
 *
 * The tab-hash reset in src/test/setup.ts is what lets every test here start
 * from the default tab regardless of what the previous one clicked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import TabNav from './TabNav';
import Dashboard from './Dashboard';
import DualHeatmap from './DualHeatmap';
import BillAccrualCurve from './BillAccrualCurve';
import PlanSwitchTimeline from './PlanSwitchTimeline';
import BestChoiceChip from './BestChoiceChip';
import VerdictLine from './VerdictLine';
import { TAB_STORAGE_KEY } from '@/lib/tabs';
import { buildHeatmapData, parseUsageSummaries, processRawData, type RateSet } from '@/lib/energy';
import { projectMonthBill } from '@/lib/billProjection';

const OEB_FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/oebRates.fixture.html'),
  'utf8',
);

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

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve(mockRates) }));
}

async function renderLoaded() {
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
  });
}

beforeEach(() => {
  stubFetch();
  localStorage.clear();
  window.history.replaceState(null, '', window.location.pathname);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/* ========================================================================== *
 * 1. Tab navigation
 * ========================================================================== */

describe('Wave R 1 — the tab strip', () => {
  it('exposes the ARIA tabs pattern: tablist, tab roles, controls/labelledby', () => {
    render(<TabNav active="overview" onChange={() => {}} />);
    const list = screen.getByRole('tablist', { name: 'Dashboard sections' });
    expect(list).toHaveAttribute('aria-orientation', 'horizontal');

    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.id)).toEqual(['tab-overview', 'tab-usage', 'tab-plans', 'tab-money']);
    for (const tab of tabs) {
      expect(tab).toHaveAttribute('aria-controls', `panel-${tab.id.replace('tab-', '')}`);
      expect(tab).toHaveAttribute('type', 'button');
      // Every tab is a real, reachable control with a 44 px touch target.
      expect(tab.className).toContain('min-h-11');
    }
  });

  it('uses roving tabindex: one stop for the whole strip', () => {
    render(<TabNav active="plans" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('tabindex', '0');
    for (const name of ['Overview', 'Usage', 'Money']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('tabindex', '-1');
    }
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'false');
  });

  it('moves focus AND selection with the arrow keys, wrapping at both ends', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<TabNav active="overview" onChange={onChange} />);

    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('usage');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Usage' }));

    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('overview');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Overview' }));

    // Wraps backwards off the first tab…
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('money');
    // …and forwards off the last.
    onChange.mockClear();
    rerender(<TabNav active="money" onChange={onChange} />);
    screen.getByRole('tab', { name: 'Money' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('overview');
  });

  it('jumps to the ends with Home and End, and ignores other keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TabNav active="plans" onChange={onChange} />);

    screen.getByRole('tab', { name: 'Plans' }).focus();
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('overview');
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('money');

    onChange.mockClear();
    await user.keyboard('{ArrowDown}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects on click and only the active tab renders its panel', async () => {
    const user = userEvent.setup();
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByTestId('tab-panel-money')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-panel-overview')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Money' })).toHaveAttribute('aria-selected', 'true');
  });

  it('remembers the choice in storage AND writes it into the address bar', async () => {
    const user = userEvent.setup();
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    await waitFor(() => {
      expect(localStorage.getItem(TAB_STORAGE_KEY)).toBe('money');
      expect(window.location.hash).toBe('#tab=money');
    });
  });

  it('opens on the tab the URL names, even when storage says otherwise', async () => {
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    window.location.hash = '#tab=plans';
    localStorage.setItem(TAB_STORAGE_KEY, 'money');

    await renderLoaded();
    expect(screen.getByTestId('tab-panel-plans')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('aria-selected', 'true');
  });

  it('follows the back button back to the tab that entry opened on', async () => {
    const user = userEvent.setup();
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    await user.click(screen.getByRole('tab', { name: 'Usage' }));
    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByTestId('tab-panel-money')).toBeInTheDocument();

    // What the browser fires on back/forward between hash-only entries.
    window.location.hash = '#tab=usage';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() => {
      expect(screen.getByTestId('tab-panel-usage')).toBeInTheDocument();
      expect(screen.queryByTestId('tab-panel-money')).not.toBeInTheDocument();
    });
  });

  it('degrades to Overview for an unreadable or hostile hash', async () => {
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    window.location.hash = '#tab=not-a-tab';

    await renderLoaded();
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
    // …and the URL is corrected so the address bar never lies.
    expect(window.location.hash).toBe('#tab=overview');
  });

  it('keeps the strip out of the printed report', async () => {
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();
    expect(screen.getByTestId('tab-nav').className).toContain('no-print');
  });
});

/* ========================================================================== *
 * 2. Best-choice unburying
 * ========================================================================== */

describe('Wave R 2 — the answer is never buried', () => {
  it('puts the banner first on Overview and the chip in the toolbar', async () => {
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    const overview = screen.getByTestId('tab-panel-overview');
    expect(overview.firstElementChild).toBe(screen.getByTestId('best-choice-banner'));
    expect(screen.getByTestId('best-choice-chip')).toBeInTheDocument();
  });

  it('keeps the chip on EVERY tab, with the same verdict as the banner', async () => {
    const user = userEvent.setup();
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    const banner = screen.getByTestId('best-choice-banner');
    const chip = screen.getByTestId('best-choice-chip');
    expect(chip).toHaveAttribute('data-best-plan', banner.getAttribute('data-best-plan'));

    for (const name of ['Usage', 'Plans', 'Money'] as const) {
      await user.click(screen.getByRole('tab', { name }));
      expect(screen.getByTestId('best-choice-chip')).toBeInTheDocument();
      expect(screen.queryByTestId('best-choice-banner')).not.toBeInTheDocument();
    }
  });

  it('jumps from the chip to the banner when another tab is active', async () => {
    const user = userEvent.setup();
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    await user.click(screen.getByTestId('best-choice-chip'));

    await waitFor(() => {
      expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
      expect(screen.getByTestId('best-choice-banner')).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('recomputes the verdict as one line where the evidence lives', async () => {
    const user = userEvent.setup();
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    // The banner is an Overview element — read its verdict BEFORE leaving.
    const bannerPlan = screen.getByTestId('best-choice-banner').getAttribute('data-best-plan');

    await user.click(screen.getByRole('tab', { name: 'Plans' }));
    const line = screen.getByTestId('verdict-line');
    expect(line).toHaveAttribute('data-best-plan', bannerPlan);
    expect(line).toHaveTextContent(/window verdict/i);
  });

  it('says "already the cheapest" instead of inventing a saving', () => {
    render(<VerdictLine comparison={{ TOU: 90, Tiered: 40, ULO: 70 }} userPlan="Tiered" days={30} />);
    const line = screen.getByTestId('verdict-line');
    expect(line).toHaveAttribute('data-already-best', 'true');
    expect(line).toHaveTextContent(/Tiered is the cheapest of the three/);
    expect(line).not.toHaveTextContent(/\$0\.00 less/);
  });

  it('quotes a per-month figure and the window it was scaled from', () => {
    render(<BestChoiceChip comparison={{ TOU: 120, Tiered: 100, ULO: 140 }} userPlan="TOU" days={30} onJump={() => {}} active={false} />);
    const chip = screen.getByTestId('best-choice-chip');
    expect(chip).toHaveAttribute('data-best-plan', 'Tiered');
    expect(chip.textContent).toContain('Best: Tiered');
    expect(chip.textContent).toMatch(/-\$\d+\/mo/);
    expect(chip).toHaveAttribute('data-window-days', '30');
    // The tooltip says what the monthly number was scaled from.
    expect(chip.getAttribute('title')).toContain('30-day window');
  });

  it('renders nothing at all when there is no window to judge', () => {
    const { container } = render(
      <BestChoiceChip comparison={null} userPlan="TOU" days={0} onJump={() => {}} active={false} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('best-choice-chip')).not.toBeInTheDocument();
  });
});

/* ========================================================================== *
 * 3. Toolbar declutter
 * ========================================================================== */

describe('Wave R 3 — global chrome carries only global things', () => {
  it('moves rate staleness onto Usage and file status onto Overview', async () => {
    const user = userEvent.setup();
    sessionStorage.clear();
    // Serve the real OEB page so the staleness check finds a newer set and
    // the banner actually renders — otherwise this would only prove that an
    // element nobody drew is missing from the toolbar.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: unknown) => {
        if (String(url).includes('oeb-rates-page')) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve(OEB_FIXTURE) });
        }
        return Promise.resolve({ json: () => Promise.resolve(mockRates) });
      }),
    );
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    // Neither is global chrome any more: the file status lives inside the
    // Overview panel, and the toolbar (the card holding the plan switcher)
    // contains neither.
    const toolbar = screen.getByTestId('plan-switcher').closest('.no-print')!;
    expect(toolbar).not.toContainElement(screen.queryByTestId('overview-file-status'));
    expect(toolbar).not.toContainElement(screen.queryByTestId('rate-staleness-banner'));

    expect(
      within(screen.getByTestId('tab-panel-overview')).getByTestId('overview-file-status'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('rate-staleness-banner')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Usage' }));
    const banner = await screen.findByTestId('rate-staleness-banner');
    expect(
      within(screen.getByTestId('tab-panel-usage')).getByTestId('rate-staleness-banner'),
    ).toBe(banner);
    expect(screen.queryByTestId('overview-file-status')).not.toBeInTheDocument();
  });

  it('keeps one toolbar — with the plan switcher and upload — across every tab', async () => {
    const user = userEvent.setup();
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();

    const toolbar = screen.getByTestId('plan-switcher').closest('.no-print')!;
    const switcher = screen.getByTestId('plan-switcher');
    const upload = screen.getByRole('button', { name: 'Upload XML' });
    expect(toolbar).toContainElement(upload);
    // The alerts slot: rendered only once a feed is connected, so assert the
    // SLOT survives rather than a bell this browser does not have yet.
    expect(screen.queryByTestId('notification-toggle')).not.toBeInTheDocument();

    for (const name of ['Usage', 'Plans', 'Money', 'Overview'] as const) {
      await user.click(screen.getByRole('tab', { name }));
      // Same nodes, not a remount: global chrome does not follow the tab.
      expect(screen.getByTestId('plan-switcher')).toBe(switcher);
      expect(screen.getByRole('button', { name: 'Upload XML' })).toBe(upload);
      expect(screen.getByTestId('plan-switcher').closest('.no-print')).toBe(toolbar);
    }
  });

  it('drops the CHART/INSIGHTS toggle — the tabs replaced it', async () => {
    localStorage.setItem('energy_data', JSON.stringify(mockRawData));
    await renderLoaded();
    expect(screen.queryByRole('button', { name: 'CHART' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'INSIGHTS' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });
});

/* ========================================================================== *
 * 4a. Weekday vs weekend dual heatmap
 * ========================================================================== */

const RATES: RateSet = rateSet;

/** Two weeks of hourly readings with a weekday-only 19:00 EV block. */
function evWeekdays(from: Date, weeks: number) {
  const raw: { timestamp: number; usage_kwh: number }[] = [];
  for (let w = 0; w < weeks * 7; w++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + w);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    for (let h = 0; h < 24; h++) {
      raw.push({
        timestamp: Math.floor(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime() / 1000),
        usage_kwh: !weekend && h === 19 ? 2.0 : 0.5,
      });
    }
  }
  return raw;
}

describe('Wave R 4a — the dual heatmap', () => {
  // 2026-10-05 is a Monday.
  const grid = buildHeatmapData(processRawData(evWeekdays(new Date(2026, 9, 5), 2), [RATES]));

  it('draws a 5×24 weekday grid and a 2×24 weekend grid side by side', () => {
    render(<DualHeatmap heatmapData={grid} />);
    const weekdays = within(screen.getByTestId('heatmap-grid-weekday'));
    const weekend = within(screen.getByTestId('heatmap-grid-weekend'));

    // One columnheader row + the day rows.
    expect(weekdays.getAllByRole('row')).toHaveLength(6);
    expect(weekend.getAllByRole('row')).toHaveLength(3);
    expect(weekdays.getAllByRole('rowheader').map((c) => c.textContent)).toEqual([
      'Mon', 'Tue', 'Wed', 'Thu', 'Fri',
    ]);
    expect(weekend.getAllByRole('rowheader').map((c) => c.textContent)).toEqual(['Sat', 'Sun']);
  });

  it('keeps the old heading and says why the grids were split', () => {
    render(<DualHeatmap heatmapData={grid} />);
    expect(screen.getByText('Weekly Routine Heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('dual-heatmap')).toHaveTextContent(/SAME scale/i);
  });

  it('gives every cell a full accessible name (no hover-only numbers)', () => {
    render(<DualHeatmap heatmapData={grid} />);
    const cell = screen.getByTestId('heat-cell-weekday-Mon-19');
    expect(cell).toHaveAttribute('role', 'gridcell');
    expect(cell.getAttribute('aria-label')).toMatch(/^Mon 19:00 — \d\.\d\d kWh average over \d days/);
    expect(cell.getAttribute('title')).toBe(cell.getAttribute('aria-label'));
  });

  it('shows the weekday charger loudly and the weekend without it', () => {
    render(<DualHeatmap heatmapData={grid} />);
    const weekday = screen.getByTestId('heat-cell-weekday-Mon-19');
    const weekend = screen.getByTestId('heat-cell-weekend-Sat-19');
    const quiet = screen.getByTestId('heat-cell-weekday-Mon-10');
    expect(weekday.className).not.toBe(quiet.className);
    expect(weekday.className).not.toBe(weekend.className);
  });
});

/* ========================================================================== *
 * 4b. Bill accrual curve
 * ========================================================================== */

describe('Wave R 4b — the bill accrual curve', () => {
  /** Hourly readings at `kwh` per hour over `days` from `from` (local). */
  function hourly(from: Date, days: number, kwh = 1) {
    const raw: { timestamp: number; usage_kwh: number }[] = [];
    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        raw.push({
          timestamp: Math.floor(new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h).getTime() / 1000),
          usage_kwh: kwh,
        });
      }
    }
    return processRawData(raw, [RATES]);
  }

  const oct = (day: number) => new Date(2026, 9, day);
  const OCTOBER = { start: new Date(2026, 9, 1).getTime() / 1000, end: new Date(2026, 10, 1).getTime() / 1000 };

  it('says what is missing instead of drawing an empty chart', () => {
    render(
      <BillAccrualCurve rows={[]} plan="Tiered" period={null} projection={projectMonthBill([], 'Tiered', oct(10))} today={oct(10)} />,
    );
    expect(screen.getByTestId('accrual-empty')).toHaveTextContent(/No open billing period/);
    expect(screen.queryByTestId('accrual-chart')).not.toBeInTheDocument();
  });

  it('accrues the open period and prints every number the chart draws', () => {
    const rows = hourly(oct(1), 10);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={OCTOBER}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        today={oct(10)}
      />,
    );

    const card = screen.getByTestId('bill-accrual');
    expect(card).toHaveAttribute('data-days-elapsed', '10');
    expect(card).toHaveAttribute('data-days-in-period', '31');
    expect(card).toHaveAttribute('data-pace-source', 'projection');

    // 10 days × 24 kWh × 12¢ = $28.80 accrued, on the line to $89.28.
    expect(screen.getByTestId('accrual-total')).toHaveTextContent('$28.80');
    expect(screen.getByTestId('accrual-projected')).toHaveTextContent('$89.28');
    expect(screen.getByTestId('accrual-verdict')).toHaveTextContent(/on the line/i);
    expect(screen.getByTestId('accrual-note')).toHaveTextContent(/Wave F/i);

    // The SVG is decorative; the same figures exist as text above.
    expect(screen.getByTestId('accrual-chart')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('accrual-pace-line')).toBeInTheDocument();
    expect(screen.getByTestId('accrual-actual-line')).toBeInTheDocument();
  });

  it('flags a front-loaded period as running ahead of the line', () => {
    // Five heavy days, then five light ones: the accrual runs hot early and
    // the run-rate (which the pace line is built from) cools underneath it.
    const rows = [...hourly(oct(1), 5, 3), ...hourly(oct(6), 5)];
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={OCTOBER}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        today={oct(10)}
      />,
    );
    expect(screen.getByTestId('bill-accrual')).toHaveAttribute('data-pace-source', 'projection');
    expect(screen.getByTestId('accrual-verdict')).toHaveTextContent(/Ahead of the line by/);
  });
});

/* ========================================================================== *
 * 4c. Plan-switch decision timeline
 * ========================================================================== */

describe('Wave R 4c — the plan-switch decision timeline', () => {
  const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
  const summaries = parseUsageSummaries(
    fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
  );

  it('says what is missing when there are no bills yet', () => {
    render(<PlanSwitchTimeline summaries={[]} allData={[]} />);
    expect(screen.getByTestId('switch-timeline-empty')).toHaveTextContent(/No billing periods yet/);
    expect(screen.queryByTestId('switch-timeline-bar')).not.toBeInTheDocument();
  });

  it('draws one segment per billing period, coloured by its detected plan', () => {
    expect(summaries.length).toBeGreaterThan(1);
    render(<PlanSwitchTimeline summaries={summaries} allData={[]} />);

    const card = screen.getByTestId('plan-switch-timeline');
    expect(card).toHaveAttribute('data-periods', String(summaries.length));

    for (const summary of summaries) {
      const segment = screen.getByTestId(`switch-segment-${summary.startDate}`);
      expect(segment).toHaveAttribute('data-plan', 'TOU'); // the fixture is TOU
      expect(segment).toHaveAttribute('data-counted', 'false'); // no readings supplied
    }

    expect(screen.getByTestId('switch-timeline-note')).toHaveTextContent(/table below/i);
    expect(screen.getByRole('heading', { name: 'Plan-switch decision timeline' })).toBeInTheDocument();
  });

  it('claims no bubbles when nothing could be modeled', () => {
    render(<PlanSwitchTimeline summaries={summaries} allData={[]} />);
    expect(screen.queryAllByTestId(/^switch-bubble-/)).toHaveLength(0);
    expect(screen.getByTestId('plan-switch-timeline')).toHaveAttribute('data-switches', '0');
  });
});
