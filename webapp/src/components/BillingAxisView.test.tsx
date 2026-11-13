/**
 * The billing axis as the APP'S timeline (not just the money panels): which
 * window the view opens on, and where prev/next step.
 *
 * Before this wave the BillingPeriod scope was cut on the `billing_day`
 * setting — synthetic calendar months. Now a file that states its own
 * `UsageSummary` periods opens on the period its readings are actually in,
 * and the arrows walk THOSE periods: one real bill at a time, then the open
 * tail, then a stop instead of a wrap.
 *
 * The readings below are daily rows from 2026-05-01 to 2026-10-06, and the
 * bills are the committed synthetic fixture (May 25 / Jun 23 / Jul 22, all
 * ending Aug 20) — so the tail after Aug 20 is unbilled, exactly like the
 * real export this feature was built for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { saveEnergyData, saveBillingDay } from '@/lib/storage';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Dashboard from './Dashboard';
import { parseUsageSummaries, type RateSet } from '@/lib/energy';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
const summaries = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

const mockRates = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
    } satisfies RateSet,
  ],
};

/** Daily noon readings between two dates (inclusive). */
function dailyReadings(fromIso: string, toIso: string) {
  const out: { timestamp: number; usage_kwh: number }[] = [];
  for (let d = new Date(`${fromIso}T12:00:00Z`); d <= new Date(`${toIso}T12:00:00Z`); ) {
    out.push({ timestamp: Math.floor(d.getTime() / 1000), usage_kwh: 1.5 });
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

const windows = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')].map((i) => i.value);

async function renderLoaded() {
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument();
  });
  // Wave R: the prev/next period controls live with Usage inside Overview. The
  // window itself (the date inputs and the scope buttons) stays global, so
  // every assertion below holds whichever tab is open.
  await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  await waitFor(() => expect(windows()[0]).not.toBe(''));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: () => Promise.resolve(mockRates) }),
  );
  localStorage.clear();
  saveEnergyData(dailyReadings('2026-05-01', '2026-10-06'));
  localStorage.setItem('usage_summaries', JSON.stringify(summaries));
  saveBillingDay(1);
});

describe('the view’s timeline is the file’s own', () => {
  it('opens on the period the newest readings are in — not a calendar month', async () => {
    await renderLoaded();
    // Readings end 2026-10-06; the last bill was read 2026-08-20. The anchor
    // therefore lands in the OPEN period, and the window is that period.
    expect(windows()).toEqual(['2026-08-20', '2026-10-06']);
    expect(screen.getByRole('button', { name: 'Billing Period' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // billing_day=1 would have opened October 1–31: 6 of 31 days of data.
    expect(windows()[1]).not.toBe('2026-10-31');
  });

  it('steps back one real bill at a time, then stops', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const prev = screen.getByRole('button', { name: 'Previous period' });
    const next = screen.getByRole('button', { name: 'Next period' });

    await user.click(prev); // the open tail → the bill it follows
    expect(windows()).toEqual(['2026-07-22', '2026-08-20']);

    await user.click(prev); // Jul 22 → Jun 23
    expect(windows()).toEqual(['2026-06-23', '2026-07-22']);

    await user.click(next); // and back again
    expect(windows()).toEqual(['2026-07-22', '2026-08-20']);

    await user.click(next); // …into the open tail
    expect(windows()).toEqual(['2026-08-20', '2026-10-06']);

    // Clamped: there is no period after the open one, so the window must not
    // silently jump to the oldest bill instead.
    await user.click(next);
    expect(windows()).toEqual(['2026-08-20', '2026-10-06']);
  });

  it('lands on the file’s period when the BillingPeriod scope is clicked', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Month' }));
    expect(windows()).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Billing Period' }));
    await waitFor(() => expect(windows()).toEqual(['2026-08-20', '2026-10-06']));
  });

  it('keeps the billing-day setting as the fallback for a file with no bills', async () => {
    // Same readings, no UsageSummary at all: the timeline must still exist,
    // and it must be cut on billing_day exactly as it was before this wave.
    localStorage.removeItem('usage_summaries');
    await renderLoaded();

    // billing_day = 1, readings end 2026-10-06 → the trailing window
    // selectInitialWindow falls back to (the bill-period candidate is 6/31
    // covered), so the app opens on data, not on an empty month.
    const [start, end] = windows();
    expect(end).toBe('2026-10-06');
    expect(start > '2026-09-01').toBe(true);

    // Prev/next still work: without file periods they re-anchor on the
    // billing day (the pre-axis behavior), never on nothing.
    await userEvent.click(screen.getByRole('button', { name: 'Previous period' }));
    const [prevStart, prevEnd] = windows();
    expect(prevEnd < end).toBe(true);
    expect(prevStart).toMatch(/-01$/); // a billing_day=1 period starts on the 1st
  });
});
