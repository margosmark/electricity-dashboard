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
import PlanSwitchTimeline, { savingDescription } from './PlanSwitchTimeline';
import { saveEnergyData } from '@/lib/storage';
import BestChoiceChip from './BestChoiceChip';
import VerdictLine from './VerdictLine';
import { TAB_STORAGE_KEY } from '@/lib/tabs';
import { buildHeatmapData, parseUsageSummaries, processRawData, type RateSet } from '@/lib/energy';
import { buildSwitchReport } from '@/lib/planTimeline';
import { projectMonthBill } from '@/lib/billProjection';
import { setLocale, t } from '@/i18n';

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
    expect(tabs.map((t) => t.id)).toEqual(['tab-overview', 'tab-plans', 'tab-money']);
    // Only the SELECTED tab carries aria-controls: the other three panels are
    // not in the DOM, and an aria-controls naming an id nothing renders is the
    // dangling reference axe dings as aria-valid-attr-value (t_d5cc9a2d —
    // Lighthouse a11y 0.87). Every reference that IS present must resolve.
    const selectedTabs = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selectedTabs).toHaveLength(1);
    expect(within(list).getAllByRole('tab', { current: 'page' })).toEqual(selectedTabs);
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(1);
    for (const tab of tabs) {
      const controls = tab.getAttribute('aria-controls');
      if (tab === selectedTabs[0]) {
        // Only the selected tab may name a panel. Whether that id actually
        // resolves to a rendered tabpanel is asserted against the whole
        // Dashboard in the next test — TabNav on its own renders no panel.
        expect(controls).toBe(`panel-${tab.id.replace('tab-', '')}`);
      } else {
        expect(controls).toBeNull();
      }
      expect(tab).toHaveAttribute('type', 'button');
      expect(tab).toHaveAttribute('data-go');
      // Every tab is a real, reachable control with a 44 px touch target.
      expect(tab.className).toContain('min-h-11');
    }
  });

  it('renders the selected tab\'s panel as a labelled tabpanel the tab actually points at', async () => {
    saveEnergyData(mockRawData);
    stubFetch();
    await renderLoaded();

    const tab = screen.getByRole('tab', { name: 'Overview' });
    const panelId = tab.getAttribute('aria-controls') as string;
    // The id the tab names must be a real element in the document — this is
    // the assertion that failed before the fix (aria-controls="panel-overview"
    // pointed at nothing: the panel had only a data-testid).
    const panel = document.getElementById(panelId);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('role', 'tabpanel');
    // …and the panel points back at the tab that opened it.
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(document.getElementById(panel?.getAttribute('aria-labelledby') as string)).toBe(tab);
  });

  it('uses roving tabindex: one stop for the whole strip', () => {
    render(<TabNav active="plans" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('tabindex', '0');
    for (const name of ['Overview', 'Money']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('tabindex', '-1');
    }
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('aria-selected', 'true');

  });

  it('moves focus AND selection with the arrow keys, wrapping at both ends', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<TabNav active="overview" onChange={onChange} />);

    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('plans');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Plans' }));

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
    saveEnergyData(mockRawData);
    await renderLoaded();

    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByTestId('tab-panel-money')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-panel-overview')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Money' })).toHaveAttribute('aria-selected', 'true');
  });

  it('remembers the choice in storage AND writes it into the address bar', async () => {
    const user = userEvent.setup();
    saveEnergyData(mockRawData);
    await renderLoaded();

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    await waitFor(() => {
      expect(localStorage.getItem(TAB_STORAGE_KEY)).toBe('money');
      expect(window.location.hash).toBe('#tab=money');
    });
  });

  it('opens on the tab the URL names, even when storage says otherwise', async () => {
    saveEnergyData(mockRawData);
    window.location.hash = '#tab=plans';
    localStorage.setItem(TAB_STORAGE_KEY, 'money');

    await renderLoaded();
    expect(screen.getByTestId('tab-panel-plans')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('aria-selected', 'true');
  });

  it('follows the back button back to the tab that entry opened on', async () => {
    const user = userEvent.setup();
    saveEnergyData(mockRawData);
    await renderLoaded();

    await user.click(screen.getByRole('tab', { name: 'Plans' }));
    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByTestId('tab-panel-money')).toBeInTheDocument();

    // What the browser fires on back/forward between hash-only entries.
    window.location.hash = '#tab=plans';
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() => {
      expect(screen.getByTestId('tab-panel-plans')).toBeInTheDocument();
      expect(screen.queryByTestId('tab-panel-money')).not.toBeInTheDocument();
    });
  });

  it('degrades to Overview for an unreadable or hostile hash', async () => {
    saveEnergyData(mockRawData);
    window.location.hash = '#tab=not-a-tab';

    await renderLoaded();
    expect(screen.getByTestId('tab-panel-overview')).toBeInTheDocument();
    // …and the URL is corrected so the address bar never lies.
    expect(window.location.hash).toBe('#tab=overview');
  });

  it('keeps the strip out of the printed report', async () => {
    saveEnergyData(mockRawData);
    await renderLoaded();
    expect(screen.getByTestId('tab-nav').className).toContain('no-print');
  });
});

/* ========================================================================== *
 * 2. Best-choice unburying
 * ========================================================================== */

describe('Wave R 2 — the answer is never buried', () => {
  it('leads Overview with its period and source-derived key figures while keeping the answer and chip', async () => {
    saveEnergyData(mockRawData);
    await renderLoaded();

    const overview = screen.getByTestId('tab-panel-overview');
    expect(overview.firstElementChild).toBe(screen.getByTestId('overview-period-heading'));
    expect(screen.getByTestId('overview-key-figures').querySelectorAll(':scope > div')).toHaveLength(4);
    expect(screen.getByTestId('best-choice-banner')).toBeInTheDocument();
    expect(screen.getByTestId('best-choice-chip')).toBeInTheDocument();
  });

  it('keeps the chip on EVERY tab, with the same verdict as the banner', async () => {
    const user = userEvent.setup();
    saveEnergyData(mockRawData);
    await renderLoaded();

    const banner = screen.getByTestId('best-choice-banner');
    const chip = screen.getByTestId('best-choice-chip');
    expect(chip).toHaveAttribute('data-best-plan', banner.getAttribute('data-best-plan'));

    for (const name of ['Plans', 'Money'] as const) {
      await user.click(screen.getByRole('tab', { name }));
      expect(screen.getByTestId('best-choice-chip')).toBeInTheDocument();
      expect(screen.queryByTestId('best-choice-banner')).not.toBeInTheDocument();
    }
  });

  it('jumps from the chip to the banner when another tab is active', async () => {
    const user = userEvent.setup();
    saveEnergyData(mockRawData);
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
    saveEnergyData(mockRawData);
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
    expect(line).toHaveTextContent('Current plan $40 vs $40 (Tiered, cheapest) $0 more');
    expect(screen.getByTestId('verdict-delta')).toHaveTextContent('$0');
    expect(line).not.toHaveTextContent(/\$0\.00 less/);
  });

  it('names both source costs before reporting a derived saving', () => {
    render(<VerdictLine comparison={{ TOU: 120, Tiered: 100, ULO: 140 }} userPlan="TOU" days={30} />);
    const line = screen.getByTestId('verdict-line');
    expect(line).toHaveTextContent('Current plan $120 vs $100 (Tiered, cheapest) ▲$20 more');
    expect(screen.getByTestId('verdict-delta')).toHaveTextContent('▲$20');
  });

  it('quotes a per-month figure and the window it was scaled from', () => {
    render(<BestChoiceChip comparison={{ TOU: 120, Tiered: 100, ULO: 140 }} userPlan="TOU" days={30} onJump={() => {}} active={false} />);
    const chip = screen.getByTestId('best-choice-chip');
    expect(chip.tagName.toLowerCase()).toBe('button');
    expect(chip).toHaveAttribute('data-go', 'overview');
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
  it('keeps usage insights and file status in Overview, outside global chrome', async () => {
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
    saveEnergyData(mockRawData);
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
    const usage = within(screen.getByTestId('tab-panel-overview')).getByTestId('overview-usage');
    expect(within(usage).getByTestId('dual-heatmap')).toBeInTheDocument();
    expect(within(screen.getByTestId('tab-panel-overview')).getByText('Usage and insights are in Overview.')).toBeInTheDocument();
  });

  it('keeps one toolbar — with the plan switcher and upload — across every tab', async () => {
    const user = userEvent.setup();
    saveEnergyData(mockRawData);
    await renderLoaded();

    const toolbar = screen.getByTestId('plan-switcher').closest('.no-print')!;
    const switcher = screen.getByTestId('plan-switcher');
    const upload = screen.getByRole('button', { name: 'Upload XML' });
    expect(toolbar).toContainElement(upload);
    // The alerts slot: rendered only once a feed is connected, so assert the
    // SLOT survives rather than a bell this browser does not have yet.
    expect(screen.queryByTestId('notification-toggle')).not.toBeInTheDocument();

    for (const name of ['Plans', 'Money', 'Overview'] as const) {
      await user.click(screen.getByRole('tab', { name }));
      // Same nodes, not a remount: global chrome does not follow the tab.
      expect(screen.getByTestId('plan-switcher')).toBe(switcher);
      expect(screen.getByRole('button', { name: 'Upload XML' })).toBe(upload);
      expect(screen.getByTestId('plan-switcher').closest('.no-print')).toBe(toolbar);
    }
  });

  it('drops the CHART/INSIGHTS toggle — the tabs replaced it', async () => {
    saveEnergyData(mockRawData);
    await renderLoaded();
    expect(screen.queryByRole('button', { name: 'CHART' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'INSIGHTS' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
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

    // 10 days × 24 kWh priced by the month-scoped tier rule = $29.74
    // accrued, on the line to $92.19. (Tier-1-only said $28.80 / $89.28 —
    // the accrual footed that way while its pace line priced the window.)
    expect(screen.getByTestId('accrual-total')).toHaveTextContent('$29.74');
    expect(screen.getByTestId('accrual-projected')).toHaveTextContent('$92.19');
    expect(screen.getByTestId('accrual-verdict')).toHaveTextContent(/on the line/i);
    expect(screen.getByTestId('accrual-note')).toHaveTextContent(/Wave F/i);

    // The SVG is decorative; the same figures exist as text above.
    expect(screen.getByTestId('accrual-chart')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('accrual-pace-line')).toBeInTheDocument();
    expect(screen.getByTestId('accrual-actual-line')).toBeInTheDocument();
  });

  it('places the rate alert directly before the Pace to date metric', () => {
    const rows = hourly(oct(1), 10);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={OCTOBER}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        today={oct(10)}
        rateNotice={<div role="alert" data-testid="money-rate-alert">Fix rate schedule</div>}
      />,
    );
    const notice = screen.getByTestId('money-rate-alert-slot');
    const paceCard = screen.getByTestId('accrual-pace-card');
    expect(notice.nextElementSibling).toBe(paceCard);
    expect(paceCard).toHaveTextContent('Pace to date');
  });

  it('draws real geometry — finite coordinates, a rising line, a pace that ends high', () => {
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

    // A NaN anywhere in a path is a chart that renders as nothing, and no
    // amount of text assertions would catch it.
    const points = screen
      .getByTestId('accrual-actual-line')
      .getAttribute('points')!
      .trim()
      .split(/\s+/)
      .flatMap((pair) => pair.split(',').map(Number));
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points.every((n) => Number.isFinite(n))).toBe(true);

    // The accrual only ever goes up (energy costs money)…
    const ys = points.filter((_, i) => i % 2 === 1);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);

    // …and the pace line runs from the origin to a HIGHER point at the end
    // of the period than where it starts.
    const pace = screen.getByTestId('accrual-pace-line');
    const x1 = Number(pace.getAttribute('x1'));
    const y1 = Number(pace.getAttribute('y1'));
    const x2 = Number(pace.getAttribute('x2'));
    const y2 = Number(pace.getAttribute('y2'));
    expect([x1, y1, x2, y2].every(Number.isFinite)).toBe(true);
    expect(x2).toBeGreaterThan(x1);
    expect(y2).toBeLessThan(y1); // svg y grows downward
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
 * 4d. Slice 7 — the "am I on pace?" rework: headline, benchmark, phone shape
 * ========================================================================== */

describe('Wave R 4d — the card answers its own question', () => {
  /**
   * One bill per commodity figure: a single priced commodity line is all
   * `billTotals` needs to produce that number, and the benchmark only reads
   * the commodity line — never the amount due, which would put all-in bills
   * against a commodity-only accrual.
   */
  function billSummaries(commodity: number[]) {
    const MONTH = 2_592_000; // 30 days
    return commodity.map((amount, i) => ({
      source: 'UsageSummary' as const,
      start: new Date(2026, 4 + i, 25).getTime() / 1000,
      duration: MONTH,
      startDate: '2026-05-25',
      endDate: '2026-06-24',
      days: 30,
      billLastPeriod: null,
      billToDate: null,
      costAdditionalLastPeriod: null,
      currency: 124,
      consumption: null,
      items: [
        { note: 'Off Peak-Summer', amount, rawAmount: null, itemKind: null, unitCost: null, measurement: null },
      ],
    }));
  }

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
  /** Wave Q's shape: the open window ENDS at the newest reading. */
  const tail = { start: new Date(2026, 9, 1).getTime() / 1000, end: new Date(2026, 9, 11).getTime() / 1000 };
  const billThrough = { at: new Date(2026, 9, 25).getTime() / 1000, source: 'file-cadence' as const };

  it('leads with the projected landing, not a period label', () => {
    const rows = hourly(oct(1), 10);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        today={oct(10)}
      />,
    );

    // 25 days to the bill date at $2.97/day of Wave F pace: the headline IS
    // the answer, and it names the date it lands on.
    const headline = screen.getByTestId('accrual-headline');
    expect(headline).toHaveTextContent(/\$74\.34 by Oct 25/);
    expect(headline).toHaveAttribute('data-projected-total', '74.34');
    expect(screen.getByTestId('bill-accrual')).toHaveAttribute('data-bill-date', '2026-10-25');
  });

  it('carries the fixed explainer that names every line', () => {
    const rows = hourly(oct(1), 10);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        today={oct(10)}
      />,
    );
    const explainer = screen.getByTestId('accrual-explainer');
    expect(explainer).toHaveTextContent(/Grey line = spent so far/);
    expect(explainer).toHaveTextContent(/Yellow dashed = where you’re on pace to land by the bill date/);
    expect(explainer).toHaveTextContent(/Dotted = your average of the last 3 bills/);
    // The card is described by it, so a screen reader hears it before the SVG.
    expect(screen.getByTestId('bill-accrual')).toHaveAttribute('aria-describedby');
  });

  it('judges the landing against the last 3 bills as a colour, not arithmetic', () => {
    const rows = hourly(oct(1), 10); // $2.97/day → $74.34 landing
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        // Three bills whose commodity averaged $42 — the $74 landing is $32 over.
        summaries={billSummaries([30, 42, 54])}
        today={oct(10)}
      />,
    );
    const chip = screen.getByTestId('accrual-pace-chip');
    expect(chip).toHaveAttribute('data-direction', 'above');
    expect(chip).toHaveTextContent(/pacing \$32\.34 ABOVE/);
    expect(chip.className).toContain('bg-bad-slab');
    // The dotted line is drawn at that same average.
    expect(screen.getByTestId('accrual-benchmark-line')).toBeInTheDocument();
    expect(screen.getByTestId('bill-accrual')).toHaveAttribute('data-avg-prior-bills', '42.00');
  });

  it('goes green when the landing sits under the benchmark', () => {
    const rows = hourly(oct(1), 10, 0.2); // $0.576/day → ~$14.40 landing
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        summaries={billSummaries([40, 42, 44])}
        today={oct(10)}
      />,
    );
    const chip = screen.getByTestId('accrual-pace-chip');
    expect(chip).toHaveAttribute('data-direction', 'below');
    expect(chip.className).toContain('bg-good-slab-soft');
    expect(chip).toHaveTextContent(/pacing BELOW by/);
  });

  it('says it has nothing to compare against rather than faking a verdict', () => {
    const rows = hourly(oct(1), 10);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        today={oct(10)}
      />,
    );
    const chip = screen.getByTestId('accrual-pace-chip');
    expect(chip).toHaveAttribute('data-direction', 'none');
    expect(chip).toHaveTextContent(/no bills to compare/);
    expect(screen.queryByTestId('accrual-benchmark-line')).not.toBeInTheDocument();
  });

  it('marks the day tier 1 runs out on a Tiered period', () => {
    // 3 kWh/hour = 72 kWh/day; the prorated summer allowance for 25 days is
    // 600 × 25/30.4 ≈ 493 kWh, which day 7 spends.
    const rows = hourly(oct(1), 10, 3);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        today={oct(10)}
      />,
    );
    expect(screen.getByTestId('accrual-tier-marker')).toBeInTheDocument();
    expect(screen.getByTestId('accrual-note')).toHaveTextContent(/tier-2 rate/);
  });

  it('places a PROJECTED tier crossing past the data, not on the left axis', () => {
    // 1.5 kWh/h = 36 kWh/day: 10 drawn days book 360 kWh, short of the
    // prorated 473 kWh allowance, so the crossing falls on Oct 14 — beyond
    // every point in `points`. findIndex() there returns -1, and x(-1 + 1)
    // painted "tier 2" on the left axis, i.e. claiming the period starts
    // already over the allowance while the note named Oct 14. The marker
    // must land where the note says: after the last drawn point.
    const rows = hourly(oct(1), 10, 1.5);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        today={oct(10)}
      />,
    );

    const note = screen.getByTestId('accrual-note').textContent ?? '';
    const crossing = note.match(/runs out (\d{4}-\d{2}-\d{2})/);
    expect(crossing, `note: ${note}`).not.toBeNull();
    // The crossing is ahead of the data — that is the case under test.
    expect(crossing![1] > '2026-10-10').toBe(true);

    const markerX = Number(screen.getByTestId('accrual-tier-marker').getAttribute('x1'));
    const chart = screen.getByTestId('accrual-chart');
    const actual = chart.querySelector('polyline')!.getAttribute('points')!.trim().split(/\s+/);
    const lastAccrualX = Number(actual[actual.length - 1].split(',')[0]);
    const firstAccrualX = Number(actual[0].split(',')[0]);

    expect(Number.isFinite(markerX)).toBe(true);
    // Right of the whole accrual — never at/before the first point, which is
    // what the -1 fallback drew.
    expect(markerX).toBeGreaterThan(lastAccrualX);
    expect(markerX).toBeGreaterThan(firstAccrualX);
    // ...and still inside the plot.
    const leftAxis = Number(
      chart.querySelector('line')!.getAttribute('x1'),
    );
    expect(markerX).toBeGreaterThan(leftAxis);
  });

  it('draws no tier marker off-Tiered — TOU has no tier-1 allowance', () => {
    const rows = hourly(oct(1), 10, 3);
    render(
      <BillAccrualCurve
        rows={rows}
        plan="TOU"
        period={tail}
        projection={projectMonthBill(rows, 'TOU', oct(10))}
        billDate={billThrough}
        today={oct(10)}
      />,
    );
    expect(screen.queryByTestId('accrual-tier-marker')).not.toBeInTheDocument();
  });

  it('on a phone: headline + chip + sparkline, full chart one tap away', async () => {
    const rows = hourly(oct(1), 10);
    const user = userEvent.setup();
    render(
      <BillAccrualCurve
        rows={rows}
        plan="Tiered"
        period={tail}
        projection={projectMonthBill(rows, 'Tiered', oct(10))}
        billDate={billThrough}
        today={oct(10)}
      />,
    );

    // The answer (headline + chip) is ABOVE the shape, in every layout —
    // a phone never has to scroll past a chart to learn the verdict.
    expect(screen.getByTestId('accrual-headline')).toBeInTheDocument();
    expect(screen.getByTestId('accrual-pace-chip')).toBeInTheDocument();

    // Both shapes are always in the DOM — CSS picks which one PAINTS, so
    // there is one chart node per shape (never two) and no layout thrash on
    // toggle. Collapsed: sparkline visible-ish (md:hidden), chart hidden.
    const spark = screen.getByTestId('accrual-sparkline').parentElement!;
    const full = screen.getByTestId('accrual-chart').parentElement!;
    const toggle = screen.getByTestId('accrual-chart-toggle');
    expect(spark.className).toContain('md:hidden');
    expect(full.className).toContain('hidden');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent(/Show the full chart/);

    // Expanding flips which shape the phone paints; the toggle itself is
    // md:hidden, so a desktop never sees a control that does nothing.
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent(/Hide the full chart/);
    expect(spark.className).not.toContain('md:hidden');
    expect(spark.className).toContain('hidden');
    expect(full.className).not.toContain('hidden');

    await user.click(toggle);
    expect(spark.className).toContain('md:hidden');
    expect(full.className).toContain('hidden');
  });
});

/* ========================================================================== *
 * 4c. Plan-switch decision timeline
 * ========================================================================== */

describe('Wave R 4c — the plan-switch decision timeline', () => {
  it('gives positive and negative signed callouts distinct, directionally correct meanings', () => {
    const translate = (key: string, params?: Record<string, string | number>) => `${key}:${params?.amount}`;
    expect(savingDescription(5.55, translate)).toBe('switchTimeline.potentialSaving:$5.55');
    expect(savingDescription(-5.55, translate)).toBe('switchTimeline.actualCheaper:$5.55');
    expect(savingDescription(0, translate)).toBe('switchTimeline.potentialSaving:$0.00');
  });

  it('localizes positive and negative meanings in English and French', () => {
    setLocale('en');
    expect(savingDescription(5.55, t)).toContain('Potential amount saved by switching');
    expect(savingDescription(-5.55, t)).toContain('actual plan was cheaper');
    setLocale('fr');
    expect(savingDescription(5.55, t)).toContain('potentiellement économisé');
    expect(savingDescription(-5.55, t)).toContain('était moins chère');
    setLocale('en');
  });

  const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
  const summaries = parseUsageSummaries(
    fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
  );

  it('renders signed callouts from a populated report, including an untrusted model', () => {
    const withTotal = (summary: (typeof summaries)[number], amount: number, plan?: 'TOU' | 'Tiered') => ({
      ...summary,
      items: summary.items.map((item) => {
        if (item.note === 'Total Electricity Charges') return { ...item, amount };
        if (plan === 'Tiered' && /peak/i.test(item.note)) return { ...item, note: 'Tiered' };
        return item;
      }),
    });
    const fixtureSummaries = [
      withTotal(summaries[0], 10_000),
      withTotal(summaries[1], 0, 'Tiered'),
      withTotal(summaries[2], 10_000),
    ];
    const readings = fixtureSummaries.flatMap((summary, index) => {
      const periodRaw: { timestamp: number; usage_kwh: number }[] = [];
      for (let day = 0; day < summary.days; day++) {
        const date = new Date(`${summary.startDate}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + day);
        for (let hour = 0; hour < 24; hour++) {
          date.setUTCHours(hour);
          periodRaw.push({ timestamp: Math.floor(date.getTime() / 1000), usage_kwh: 1.5 });
        }
      }
      const tieredWins: RateSet = index === 1
        ? {
            ...RATES,
            tou: { offPeak: 100, midPeak: 100, onPeak: 100 },
            tiered: { ...RATES.tiered, tier1: 0.1, tier2: 0.1 },
            ulo: { overnight: 100, weekendOffPeak: 100, midPeak: 100, onPeak: 100 },
          }
        : RATES;
      return processRawData(periodRaw, [tieredWins]);
    });
    const report = buildSwitchReport(fixtureSummaries, readings, []);
    expect(report.rows[1].plan).toBe('Tiered');
    expect(report.rows[1].saving).toBeLessThan(0);
    expect(report.rows[2].saving).toBeGreaterThan(0);
    expect(report.rows[2].counted).toBe(false);

    render(<PlanSwitchTimeline summaries={fixtureSummaries} allData={readings} />);
    const negative = screen.getByTestId(`switch-bubble-${fixtureSummaries[1].startDate}`);
    const untrustedPositive = screen.getByTestId(`switch-bubble-${fixtureSummaries[2].startDate}`);
    expect(negative).toHaveTextContent(new RegExp(`\\$${Math.abs(report.rows[1].saving!).toFixed(2)}`));
    expect(negative).toHaveAttribute('aria-label', expect.stringContaining('actual plan was cheaper'));
    expect(untrustedPositive).toHaveTextContent(new RegExp(`\\$${Math.abs(report.rows[2].saving!).toFixed(2)}`));
    expect(untrustedPositive).toHaveAttribute('data-counted', 'false');
    expect(untrustedPositive).toHaveTextContent(/untrusted/i);
    expect(untrustedPositive).toHaveAttribute('aria-label', expect.stringContaining('Potential amount saved'));

    // Focus must reveal the full label when it extends past either edge of
    // the scrollport, regardless of which signed callout receives focus.
    const viewport = screen.getByTestId('switch-timeline-bar');
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 349 });
    Object.defineProperty(viewport, 'clientLeft', { configurable: true, value: 0 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      left: 100, right: 449, top: 0, bottom: 100, width: 349, height: 100, x: 100, y: 0,
      toJSON: () => ({}),
    });
    for (const bubble of [negative, untrustedPositive]) {
      const rect = vi.spyOn(bubble, 'getBoundingClientRect');
      viewport.scrollLeft = 100;
      rect.mockReturnValue({
        left: 90, right: 180, top: 0, bottom: 20, width: 90, height: 20, x: 90, y: 0,
        toJSON: () => ({}),
      });
      bubble.focus();
      expect(viewport.scrollLeft).toBe(90);
      expect(document.activeElement).toBe(bubble);
      expect(bubble.className).toContain('focus-visible:outline');

      bubble.blur();
      viewport.scrollLeft = 0;
      rect.mockReturnValue({
        left: 400, right: 460, top: 0, bottom: 20, width: 60, height: 20, x: 400, y: 0,
        toJSON: () => ({}),
      });
      bubble.focus();
      expect(viewport.scrollLeft).toBe(11);
      expect(document.activeElement).toBe(bubble);
      rect.mockRestore();
    }
  });

  it('says what is missing when there are no bills yet', () => {
    render(<PlanSwitchTimeline summaries={[]} allData={[]} />);
    expect(screen.getByTestId('switch-timeline-empty')).toHaveTextContent(/Usage-only analysis already works/);
    expect(screen.getByTestId('switch-timeline-empty')).toHaveTextContent(/export that contains bills/);
    expect(screen.queryByTestId('switch-timeline-bar')).not.toBeInTheDocument();
  });

  it('explains the usage-only and bill-export distinction in French', () => {
    setLocale('fr');
    render(<PlanSwitchTimeline summaries={[]} allData={[]} />);
    const empty = screen.getByTestId('switch-timeline-empty');
    expect(empty).toHaveTextContent(/L’analyse de la consommation fonctionne déjà/);
    expect(empty).toHaveTextContent(/export contenant des factures/);
    expect(screen.queryByTestId('switch-timeline-bar')).not.toBeInTheDocument();
  });

  it('draws one segment per billing period, coloured by its detected plan', async () => {
    expect(summaries.length).toBeGreaterThan(1);
    render(<PlanSwitchTimeline summaries={summaries} allData={[]} />);

    const card = screen.getByTestId('plan-switch-timeline');
    expect(card).toHaveAttribute('data-periods', String(summaries.length));

    for (const summary of summaries) {
      const segment = screen.getByTestId(`switch-segment-${summary.startDate}`);
      expect(segment).toHaveAttribute('data-plan', 'TOU'); // the fixture is TOU
      expect(segment).toHaveAttribute('data-counted', 'false'); // no readings supplied
      expect(segment).toHaveAttribute('aria-label', expect.stringContaining(summary.startDate));
      expect(segment).toHaveAttribute('aria-label', expect.stringContaining(summary.endDate));
      expect(segment).toHaveAttribute('tabindex', '0');
    }

    const anchors = screen.getAllByTestId('switch-month-anchor');
    expect(anchors.length).toBeGreaterThan(1);
    expect(anchors.every((anchor) => /\d{4}/.test(anchor.textContent ?? ''))).toBe(true);
    expect(screen.getAllByTestId('switch-period-detail')).toHaveLength(summaries.length);
    const details = screen.getByText('View full billing-period dates').closest('details');
    expect(details).not.toHaveAttribute('open');
    await userEvent.setup().click(screen.getByText('View full billing-period dates'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByTestId('switch-timeline-note')).toHaveTextContent(/positive amount/i);
    expect(screen.getByTestId('switch-timeline-note')).toHaveTextContent(/negative amount/i);
    expect(screen.getByTestId('switch-timeline-note')).toHaveTextContent(/green means/i);
    expect(screen.getByTestId('switch-timeline-note')).toHaveTextContent(/gray means/i);
    expect(screen.getByRole('heading', { name: 'Plan-switch decision timeline' })).toBeInTheDocument();
  });

  it('claims no bubbles when nothing could be modeled', () => {
    render(<PlanSwitchTimeline summaries={summaries} allData={[]} />);
    expect(screen.queryAllByTestId(/^switch-bubble-/)).toHaveLength(0);
    expect(screen.getByTestId('plan-switch-timeline')).toHaveAttribute('data-switches', '0');
  });
});
