/**
 * Wave P — the two panels: the plan-type timeline editor and the switch
 * track record.
 *
 * Numbers come from the committed fixture (three TOU periods) for detection,
 * and from inline self-consistent bills + priced readings for the report, so
 * every asserted dollar figure is derived from billTotals/modelPeriod in the
 * test itself rather than retyped.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlanTimelineEditor } from './PlanTimelineEditor';
import { SwitchTrackRecord } from './SwitchTrackRecord';
import { resetPlanTimelineStore, writeStoredTimeline } from '@/hooks/usePlanTimeline';
import {
  buildSwitchReport,
  modelPeriod,
  type PlanTimelineEntry,
} from '@/lib/planTimeline';
import {
  billTotals,
  parseUsageSummaries,
  type BillLineItem,
  type ProcessedPoint,
  type RateSet,
  type UsageSummary,
} from '@/lib/energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const fixtureSummaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

const money = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);

const line = (note: string, dollars: number | null = null, kind: number | null = 10): BillLineItem => ({
  note,
  amount: dollars,
  rawAmount: dollars === null ? null : Math.round(dollars * 100000),
  itemKind: kind,
  unitCost: null,
  measurement: null,
});

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

function makeSummary(startDate: string, days: number, items: BillLineItem[]): UsageSummary {
  const start = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
  const duration = days * 86400;
  return {
    source: 'UsageSummary',
    start,
    duration,
    startDate,
    endDate: new Date((start + duration) * 1000).toISOString().slice(0, 10),
    days,
    billLastPeriod: null,
    billToDate: null,
    costAdditionalLastPeriod: null,
    currency: 124,
    consumption: null,
    items,
  };
}

function makeRows(
  startDay: string,
  days: number,
  opts: { usage?: number; costTOU?: number; costULO?: number } = {},
): ProcessedPoint[] {
  const start = Math.floor(Date.parse(`${startDay}T00:00:00Z`) / 1000);
  const out: ProcessedPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const timestamp = start + i * 86400 + 3600;
    const dateObj = new Date(timestamp * 1000);
    out.push({
      timestamp,
      usage_kwh: opts.usage ?? 0,
      dateObj,
      dayStr: dateObj.toISOString().slice(0, 10),
      hourStr: '01:00',
      touCategory: 'Off-Peak',
      uloCategory: 'Overnight',
      isWinter: false,
      costTOU: opts.costTOU ?? 0,
      costULO: opts.costULO ?? 0,
      costTiered: 0,
      activeRateSet: rateSet,
    });
  }
  return out;
}

/** commodity 325.00 + delivery 75.50 + regulatory 8.60 = 409.10 · HST 13% · rebate −23.5% */
const TOU_SUMMARY = makeSummary('2026-06-01', 29, [
  line('Off Peak-Summer', 177.78),
  line('Mid Peak-Summer', 70.94),
  line('On Peak-Summer', 76.28),
  line('Delivery', 75.5, 4),
  line('Regulatory', 8.6, 4),
  line('H.S.T. # 123456789', 53.18, 5),
  line('Ontario Electricity Rebate', -96.14, 8),
  line('Total Electricity Charges', 409.1),
]);
const UNKNOWN_SUMMARY = makeSummary('2026-07-01', 29, [
  line('Monthly Basic Charge', 10),
  line('Delivery', 20, 4),
  line('Total Electricity Charges', 30),
]);

const touTotals = billTotals(TOU_SUMMARY);
const juneRows = makeRows('2026-06-01', 29, {
  usage: 90,
  costTOU: touTotals.commodity / 29,
  costULO: touTotals.commodity / 29 / 4,
});
const julyRows = makeRows('2026-07-01', 29, { usage: 90, costTOU: 1, costULO: 0.5 });

const entry = (plan: PlanTimelineEntry['plan'], from: string, to: string): PlanTimelineEntry => ({
  id: `${plan}-${from}`,
  plan,
  from,
  to,
});

beforeEach(() => {
  localStorage.clear();
  resetPlanTimelineStore();
});

/* ======================================================= the editor ====== */

describe('PlanTimelineEditor', () => {
  it('renders nothing when there is no bill and no entry', () => {
    const { container } = render(<PlanTimelineEditor summaries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows every fixture period as TOU, detected from the bill’s own lines', () => {
    render(<PlanTimelineEditor summaries={fixtureSummaries} />);
    expect(screen.getByTestId('plan-timeline')).toBeInTheDocument();
    for (const date of ['2026-05-25', '2026-06-23', '2026-07-22']) {
      const period = screen.getByTestId(`plan-timeline-period-${date}`);
      expect(period).toHaveAttribute('data-plan', 'TOU');
      expect(period).toHaveAttribute('data-origin', 'detected');
      expect(within(period).getByTestId('plan-timeline-plan-badge')).toHaveTextContent('Time-of-Use');
      expect(within(period).getByTestId('plan-timeline-origin')).toHaveTextContent(
        'DETECTED FROM BILL LINES',
      );
      expect(within(period).getByTestId('plan-timeline-evidence')).toHaveTextContent('Off Peak-Summer');
    }
    expect(screen.getByTestId('plan-timeline-empty')).toBeInTheDocument();
  });

  it('adds an entry, persists it next to billing_day, and removes it again', async () => {
    const user = userEvent.setup();
    render(<PlanTimelineEditor summaries={fixtureSummaries} />);

    await user.click(screen.getByTestId('plan-timeline-add'));
    expect(screen.getAllByTestId('plan-timeline-entry')).toHaveLength(1);

    const stored = JSON.parse(localStorage.getItem('plan_timeline') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].plan).toBe('TOU');

    await user.selectOptions(screen.getByTestId('plan-timeline-entry-plan'), 'Tiered');
    const afterPlan = JSON.parse(localStorage.getItem('plan_timeline') ?? '[]');
    expect(afterPlan[0].plan).toBe('Tiered');

    fireEvent.change(screen.getByTestId('plan-timeline-entry-from'), {
      target: { value: '2024-11-25' },
    });
    const afterFrom = JSON.parse(localStorage.getItem('plan_timeline') ?? '[]');
    expect(afterFrom[0].from).toBe('2024-11-25');

    await user.click(screen.getByTestId('plan-timeline-entry-remove'));
    expect(screen.queryAllByTestId('plan-timeline-entry')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('plan_timeline') ?? '[]')).toHaveLength(0);
  });

  it('refuses an end date before the start date and says why', () => {
    render(<PlanTimelineEditor summaries={fixtureSummaries} />);
    fireEvent.click(screen.getByTestId('plan-timeline-add'));

    const original = JSON.parse(localStorage.getItem('plan_timeline') ?? '[]')[0];
    fireEvent.change(screen.getByTestId('plan-timeline-entry-to'), {
      target: { value: '2020-01-01' },
    });

    expect(screen.getByTestId('plan-timeline-error')).toHaveTextContent(/start on or before the end/i);
    const stored = JSON.parse(localStorage.getItem('plan_timeline') ?? '[]')[0];
    expect(stored.to).toBe(original.to); // nothing invalid ever reaches storage
  });

  it('surfaces a declaration that contradicts the bill instead of hiding it', () => {
    writeStoredTimeline([entry('Tiered', '2026-05-25', '2026-06-30')]);
    render(<PlanTimelineEditor summaries={fixtureSummaries} />);
    const period = screen.getByTestId('plan-timeline-period-2026-05-25');
    expect(period).toHaveAttribute('data-plan', 'TOU'); // evidence wins
    expect(within(period).getByTestId('plan-timeline-conflict')).toHaveTextContent(/bill wins/i);
  });

  it('falls back to your entry when the lines fingerprint nothing', () => {
    writeStoredTimeline([entry('Tiered', '2026-07-01', '2026-07-30')]);
    render(<PlanTimelineEditor summaries={[UNKNOWN_SUMMARY]} />);
    const period = screen.getByTestId('plan-timeline-period-2026-07-01');
    expect(period).toHaveAttribute('data-plan', 'Tiered');
    expect(period).toHaveAttribute('data-origin', 'declared');
    expect(within(period).getByTestId('plan-timeline-origin')).toHaveTextContent('YOUR ENTRY');
  });

  it('shows honest unknown when neither the bill nor you say anything', () => {
    render(<PlanTimelineEditor summaries={[UNKNOWN_SUMMARY]} />);
    const period = screen.getByTestId('plan-timeline-period-2026-07-01');
    expect(period).toHaveAttribute('data-plan', 'unknown');
    expect(within(period).getByTestId('plan-timeline-plan-badge')).toHaveTextContent('UNKNOWN');
    expect(period).toHaveTextContent(/no recognizable plan lines/i);
    expect(period).toHaveTextContent(/no guess made/i);
  });
});

/* ================================================== the track record ===== */

describe('SwitchTrackRecord', () => {
  it('renders nothing without bills', () => {
    const { container } = render(<SwitchTrackRecord summaries={[]} allData={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the audited row: paid vs modeled alternatives vs best saving', () => {
    const rows = [...juneRows, ...julyRows];
    render(<SwitchTrackRecord summaries={[TOU_SUMMARY, UNKNOWN_SUMMARY]} allData={rows} />);

    expect(screen.getByTestId('switch-track-record')).toBeInTheDocument();

    const touRow = screen.getByTestId('switch-row-2026-06-01');
    expect(touRow).toHaveAttribute('data-plan', 'TOU');
    expect(touRow).toHaveAttribute('data-origin', 'detected');
    expect(within(touRow).getByTestId('switch-plan-badge')).toHaveTextContent('ON TIME-OF-USE');

    const model = modelPeriod(TOU_SUMMARY, juneRows);
    const saving = touTotals.payable - model.payable.ULO;

    expect(within(touRow).getByTestId('switch-actual')).toHaveTextContent(money(touTotals.payable));
    // both non-actual plans, each labelled modeled
    expect(within(touRow).getByTestId('switch-modeled-Tiered')).toHaveTextContent('modeled');
    expect(within(touRow).getByTestId('switch-modeled-Tiered')).toHaveTextContent(
      money(model.payable.Tiered),
    );
    expect(within(touRow).getByTestId('switch-modeled-ULO')).toHaveTextContent(
      money(model.payable.ULO),
    );
    expect(within(touRow).getByTestId('switch-saving')).toHaveTextContent(money(saving));
    // the model's own error bar: re-pricing the billed plan lands on the bill
    expect(within(touRow).getByTestId('switch-model-check')).toHaveTextContent(/Model check ✓/);
  });

  it('aggregates the over-paid total and the per-plan breakdown', () => {
    const report = buildSwitchReport([TOU_SUMMARY], juneRows, []);
    render(<SwitchTrackRecord summaries={[TOU_SUMMARY]} allData={juneRows} />);

    expect(screen.getByTestId('switch-overpaid-total')).toHaveTextContent(money(report.overpaid ?? 0));
    expect(screen.getByTestId('switch-headline-sub')).toHaveTextContent('across 1 modeled period of 1');
    const byPlan = screen.getByTestId('switch-by-plan');
    expect(byPlan).toHaveTextContent('Time-of-Use: 1 period');
    expect(byPlan).toHaveTextContent(money(report.byPlan[0]?.overpaid ?? 0));
    expect(screen.getByTestId('switch-callout-2026-06-01')).toBeInTheDocument();
  });

  it('claims no saving for an unknown plan and excludes it from the total', () => {
    render(<SwitchTrackRecord summaries={[UNKNOWN_SUMMARY]} allData={julyRows} />);
    const row = screen.getByTestId('switch-row-2026-07-01');
    expect(row).toHaveAttribute('data-plan', 'unknown');
    expect(within(row).getByTestId('switch-plan-badge')).toHaveTextContent('PLAN UNKNOWN');
    expect(within(row).getByTestId('switch-saving')).toHaveTextContent('—');
    expect(within(row).getByTestId('switch-modeled-TOU')).toHaveTextContent('modeled');
    expect(row).toHaveTextContent(/no saving is claimed/i);
    // nothing countable yet — the headline says so instead of showing $0.00
    expect(screen.getByTestId('switch-headline-empty')).toHaveTextContent('0 of 1 periods');
    expect(screen.queryByTestId('switch-overpaid-total')).not.toBeInTheDocument();
  });

  it('skips a period the readings do not cover, honestly', () => {
    const uncovered = makeSummary('2026-08-01', 29, [
      line('Off Peak-Summer', 50),
      line('Total Electricity Charges', 50),
    ]);
    render(<SwitchTrackRecord summaries={[uncovered]} allData={[]} />);
    const row = screen.getByTestId('switch-row-2026-08-01');
    expect(within(row).getByTestId('switch-skip')).toHaveTextContent('no readings');
    expect(within(row).getByTestId('switch-skip')).toHaveTextContent('You paid $50.00');
    expect(within(row).queryByTestId('switch-saving')).not.toBeInTheDocument();
    expect(screen.getByTestId('switch-headline-empty')).toHaveTextContent('0 of 1 periods');
  });

  it('keeps a declaration in the row and counts it in the total', () => {
    writeStoredTimeline([entry('Tiered', '2026-07-01', '2026-07-30')]);
    const report = buildSwitchReport([UNKNOWN_SUMMARY], julyRows, [
      entry('Tiered', '2026-07-01', '2026-07-30'),
    ]);
    render(<SwitchTrackRecord summaries={[UNKNOWN_SUMMARY]} allData={julyRows} />);

    const row = screen.getByTestId('switch-row-2026-07-01');
    expect(row).toHaveAttribute('data-plan', 'Tiered');
    expect(row).toHaveAttribute('data-origin', 'declared');
    expect(within(row).getByTestId('switch-saving')).toHaveTextContent(
      money(report.rows[0].saving ?? 0),
    );
    expect(screen.getByTestId('switch-overpaid-total')).toHaveTextContent(money(report.overpaid ?? 0));
  });

  it('flags a declaration that contradicts the bill on the row too', () => {
    writeStoredTimeline([entry('Tiered', '2026-06-01', '2026-06-30')]);
    render(<SwitchTrackRecord summaries={[TOU_SUMMARY]} allData={juneRows} />);
    const row = screen.getByTestId('switch-row-2026-06-01');
    expect(row).toHaveAttribute('data-plan', 'TOU');
    expect(within(row).getByTestId('switch-conflict')).toHaveTextContent(/bill wins/i);
  });
});
