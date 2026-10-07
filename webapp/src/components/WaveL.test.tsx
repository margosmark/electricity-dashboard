/**
 * Wave L — the two panels: "Your actual bill" and the auto-populated
 * True Bill inputs.
 *
 * Numbers come off the committed Oakville fixture (three real 29-day periods)
 * and the readings are built to be a *realistic* stand-in for period 3: the
 * same 2,641.66 kWh the bill charged for, priced by our own rates so the
 * commodity check should PASS. Making the synthetic period deliberately wrong
 * is how the red-banner case is exercised instead.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ActualBillPanel } from './ActualBillPanel';
import { TrueBillEstimate } from './TrueBillEstimate';
import { EXTRA_CHARGES_KEY } from '@/hooks/useDashboard';
import {
  billTotals,
  billWindow,
  billedKwh,
  parseUsageSummaries,
  type ProcessedPoint,
  type RateSet,
} from '@/lib/energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const summaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

/** The component prints money as `$1,234.56`; assertions match it. */
const money = (n: number) => `$${n.toFixed(2)}`;

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/**
 * One reading a day across a period, totalling `totalKwh` of usage and
 * `totalCost` of plan cost — i.e. a period we priced the way Oakville billed
 * it (or deliberately did not).
 */
function rowsFor(
  summaryIndex: number,
  opts: { totalKwh?: number; totalCost?: number } = {},
): ProcessedPoint[] {
  const s = summaries[summaryIndex];
  const billed = billedKwh(s) ?? 0;
  const commodity = billTotals(s).commodity;
  const totalKwh = opts.totalKwh ?? billed;
  const totalCost = opts.totalCost ?? commodity;
  const { start } = billWindow(s);
  const out: ProcessedPoint[] = [];
  for (let i = 0; i < 29; i += 1) {
    const timestamp = start + i * 86400 + 3600;
    out.push({
      timestamp,
      usage_kwh: totalKwh / 29,
      dateObj: new Date(timestamp * 1000),
      dayStr: new Date(timestamp * 1000).toISOString().slice(0, 10),
      hourStr: '01:00',
      touCategory: 'Off-Peak',
      uloCategory: 'Overnight',
      isWinter: false,
      costTOU: totalCost / 29,
      costTiered: 0,
      costULO: 0,
      activeRateSet: rateSet,
    });
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
});

/* ======================================================== actual bill ==== */

describe('Your actual bill panel', () => {
  it('renders nothing when the file carried no bill', () => {
    const { container } = render(
      <ActualBillPanel summaries={[]} allData={[]} plan="TOU" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows all three periods with the utility’s own wording, by default', () => {
    render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    expect(screen.getByTestId('actual-bill')).toBeInTheDocument();
    expect(screen.getAllByTestId('actual-bill-period')).toHaveLength(3);

    // the audited headline: what was actually paid across the file
    expect(screen.getByTestId('actual-bill').textContent).toContain('Your actual bill');
    expect(screen.getAllByTestId('actual-payable').map((n) => n.textContent)).toEqual([
      '$445.22',
      '$361.21',
      '$415.28',
    ]);

    // verbatim notes, including the wording we must never normalise
    expect(screen.getAllByText('Ontario Electricity Rebate').length).toBe(3);
    expect(screen.getAllByText('H.S.T. # 123456789').length).toBe(3);
    expect(screen.getAllByText('Total Electricity Charges').length).toBe(3);
    expect(screen.getAllByText('Off Peak-Summer').length).toBe(3);
    // raw itemKind codes stay visible instead of being guessed at
    expect(screen.getAllByText('kind 5').length).toBe(3);
    expect(screen.getAllByText('kind 8').length).toBe(3);
    // the money scale, applied — the rebate appears as its line item and
    // again in that period's totals (− is U+2212, the app's minus sign)
    const firstPeriod = screen.getAllByTestId('actual-bill-period')[0];
    expect(within(firstPeriod).queryAllByText('-$116.90')).toHaveLength(0);
    expect(within(firstPeriod).getAllByText('−$116.90')).toHaveLength(2);
  });

  it('lets the user pick a period', async () => {
    const user = userEvent.setup();
    render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    expect(screen.getAllByTestId('actual-bill-period')).toHaveLength(3);

    await user.click(screen.getByTestId('actual-bill-pick-2026-07-22'));
    const shown = screen.getAllByTestId('actual-bill-period');
    expect(shown).toHaveLength(1);
    expect(shown[0].getAttribute('data-period-start')).toBe('2026-07-22');

    await user.click(screen.getByTestId('actual-bill-all'));
    expect(screen.getAllByTestId('actual-bill-period')).toHaveLength(3);
  });

  it('passes the commodity check when our rates price the period like the bill does', () => {
    render(<ActualBillPanel summaries={[summaries[2]]} allData={rowsFor(2)} plan="TOU" />);
    const card = within(screen.getByTestId('actual-bill-period'));
    const check = card.getByTestId('commodity-check');
    expect(check.textContent).toContain('Commodity check');
    expect(check.textContent).toContain(money(billTotals(summaries[2]).commodity)); // billed
    expect(screen.queryByTestId('commodity-mismatch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rate-assumptions-banner')).not.toBeInTheDocument();
    // billed vs metered agrees, because the readings really do total it
    expect(card.getByTestId('kwh-crosscheck').textContent).toContain('2,640');
  });

  it('raises a red banner when our rates are a dollar off', () => {
    const billed = billTotals(summaries[2]).commodity;
    render(
      <ActualBillPanel
        summaries={[summaries[2]]}
        allData={rowsFor(2, { totalCost: billed + 15 })}
        plan="TOU"
      />,
    );
    expect(screen.getByTestId('commodity-mismatch')).toBeInTheDocument();
    expect(screen.getByTestId('commodity-mismatch').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('rate-assumptions-banner')).toBeInTheDocument();
    expect(screen.getByTestId('commodity-mismatch').textContent).toContain(money(billed));
    expect(screen.getByTestId('commodity-mismatch').textContent).toContain(money(billed + 15));
  });

  it('refuses to compare a period it has no readings for', () => {
    render(<ActualBillPanel summaries={[summaries[0]]} allData={[]} plan="TOU" />);
    expect(screen.getByTestId('commodity-skip').textContent).toContain(
      'this browser holds no readings',
    );
    expect(screen.queryByTestId('commodity-mismatch')).not.toBeInTheDocument();
  });

  it('shows the amortized fixed-vs-variable split of delivery when it is derivable', () => {
    render(<ActualBillPanel summaries={summaries} allData={[]} plan="TOU" />);
    const deliveryLines = screen.getAllByTestId('bill-line-delivery');
    expect(deliveryLines).toHaveLength(3);
    expect(deliveryLines[0].textContent).toContain('$35.88 fixed per period');
    expect(deliveryLines[0].textContent).toContain('2.52¢/kWh');
    expect(deliveryLines[0].textContent).toContain('fitted across 3 periods');
    // a commodity line states the rate it varies with
    expect(screen.getAllByTestId('bill-line-commodity')[0].textContent).toContain('¢/kWh');
    // …and the tax states the base it scales from
    expect(screen.getAllByTestId('bill-line-tax')[0].textContent).toContain('% of the subtotal');
  });
});

/* ==================================================== true bill prefill == */

describe('True Bill inputs auto-populated from the file', () => {
  it('fills all four fields with no typing, and says where they came from', () => {
    render(
      <TrueBillEstimate
        plan="TOU"
        startDate="2026-07-22"
        endDate="2026-08-20"
        windowData={rowsFor(2)}
        summaries={summaries}
        allData={rowsFor(2)}
      />,
    );

    expect((screen.getByTestId('charge-delivery-per-kwh') as HTMLInputElement).value).toBe('0.0252');
    expect((screen.getByTestId('charge-delivery-flat') as HTMLInputElement).value).toBe('35.88');
    expect((screen.getByTestId('charge-regulatory-per-kwh') as HTMLInputElement).value).toBe(
      '0.0054',
    );
    expect((screen.getByTestId('charge-hst-pct') as HTMLInputElement).value).toBe('13');

    const source = screen.getByTestId('xml-charge-source').textContent || '';
    expect(source).toContain('Jul 22, 2026');
    expect(source).toContain('$102.52 delivery');
    expect(source).toContain('override');

    // the True Bill exists without the user touching anything
    expect(screen.getByTestId('true-bill')).toBeInTheDocument();
  });

  it('shows the estimate-vs-actual delta for the sourced period', () => {
    render(
      <TrueBillEstimate
        plan="TOU"
        startDate="2026-07-22"
        endDate="2026-08-20"
        windowData={rowsFor(2)}
        summaries={summaries}
        allData={rowsFor(2)}
      />,
    );
    const box = screen.getByTestId('true-bill-vs-actual');
    expect(box.textContent).toContain('Jul 22, 2026 – Aug 20');
    // the bill was $524.32 before the rebate for that period
    expect(box.textContent).toContain('$524.32');
    // our estimate, built from the same rates + the pre-filled add-ons,
    // lands within a dollar of it
    const estimate = Number(
      (box.textContent || '').match(/Your estimate\$([\d.]+)/)?.[1] ?? 'NaN',
    );
    expect(Math.abs(estimate - 524.32)).toBeLessThan(1);
    expect(box.textContent).toContain('$415.28'); // what was actually payable
    expect(box.textContent).toContain('−$109.04'); // the rebate, reported not hidden
  });

  it('lets a typed value win for good — clearing does not resurrect the file’s number', async () => {
    const user = userEvent.setup();
    render(
      <TrueBillEstimate
        plan="TOU"
        startDate="2026-07-22"
        endDate="2026-08-20"
        windowData={rowsFor(2)}
        summaries={summaries}
        allData={rowsFor(2)}
      />,
    );

    const hst = screen.getByTestId('charge-hst-pct') as HTMLInputElement;
    expect(hst.value).toBe('13');

    await user.clear(hst);
    await user.type(hst, '14');
    expect(hst.value).toBe('14');
    const saved = JSON.parse(localStorage.getItem(EXTRA_CHARGES_KEY) || '{}');
    expect(saved.hstPct).toBe('14');
    expect(screen.getByTestId('xml-charge-source').textContent).toContain('edited');

    // an empty field now means empty: that charge simply drops out of the
    // breakdown (delivery + regulatory are still set, so the card stays)
    await user.clear(hst);
    expect((screen.getByTestId('charge-hst-pct') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('true-bill')).toBeInTheDocument();
    expect(screen.getByTestId('estimate-caption').textContent).not.toContain('HST (');
  });

  it('refreshes the pre-fill from a newer bill only while the values are untouched', async () => {
    const user = userEvent.setup();
    const view = (list: ReturnType<typeof parseUsageSummaries>) =>
      render(
        <TrueBillEstimate
          plan="TOU"
          startDate="2026-07-22"
          endDate="2026-08-20"
          windowData={rowsFor(2)}
          summaries={list}
          allData={rowsFor(2)}
        />,
      );

    const { rerender } = view(summaries);
    expect((screen.getByTestId('charge-hst-pct') as HTMLInputElement).value).toBe('13');

    // A newer file: same shape, but the newest period's tax line changed, so
    // the derived HST rate changes with it.
    const newer = summaries.map((s, i) =>
      i === summaries.length - 1
        ? {
            ...s,
            items: s.items.map((it) =>
              it.note.startsWith('H.S.T.') ? { ...it, amount: 8.842 } : it,
            ),
          }
        : s,
    );
    rerender(
      <TrueBillEstimate
        plan="TOU"
        startDate="2026-07-22"
        endDate="2026-08-20"
        windowData={rowsFor(2)}
        summaries={newer}
        allData={rowsFor(2)}
      />,
    );
    // 8.842 / 464.00 = 1.91% — the file's numbers followed the file
    expect((screen.getByTestId('charge-hst-pct') as HTMLInputElement).value).toBe('1.91');

    // …but once the user has typed something, a newer bill may not take it back
    const hst = screen.getByTestId('charge-hst-pct') as HTMLInputElement;
    await user.clear(hst);
    await user.type(hst, '7');
    expect((screen.getByTestId('charge-hst-pct') as HTMLInputElement).value).toBe('7');

    const untouched = summaries.map((s, i) =>
      i === summaries.length - 1
        ? { ...s, items: s.items.map((it) => (it.note.startsWith('H.S.T.') ? { ...it, amount: 2210500 } : it)) }
        : s,
    );
    rerender(
      <TrueBillEstimate
        plan="TOU"
        startDate="2026-07-22"
        endDate="2026-08-20"
        windowData={rowsFor(2)}
        summaries={untouched}
        allData={rowsFor(2)}
      />,
    );
    expect((screen.getByTestId('charge-hst-pct') as HTMLInputElement).value).toBe('7');
  });

  it('keeps the pre-Wave-L behaviour when the file carried no bill', () => {
    render(
      <TrueBillEstimate
        plan="TOU"
        startDate="2024-01-01"
        endDate="2024-01-02"
        windowData={rowsFor(2)}
        summaries={[]}
        allData={rowsFor(2)}
      />,
    );
    expect(screen.queryByTestId('xml-charge-source')).not.toBeInTheDocument();
    expect((screen.getByTestId('charge-hst-pct') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('true-bill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('true-bill-vs-actual')).not.toBeInTheDocument();
  });
});
