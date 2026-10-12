/**
 * The UsagePoint picker must DISTINGUISH reading series, not just meters.
 *
 * A UsagePoint can carry several ReadingTypes: consumption, exported energy, a
 * register, an interval-average power series, or another commodity entirely.
 * Only the consumption ones reach `group.readings`, so a picker that shows a
 * kWh total with no explanation turns a refusal into a quietly smaller number.
 * These tests pin the explanation.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsagePointPicker } from './UsagePointPicker';
import type { DataPoint, UsagePointGroup } from '@/lib/energy';
import type { ReadingSeries, SeriesNote, SeriesStatus } from '@/lib/greenbutton/series';

const at = Math.floor(new Date(2026, 9, 1, 3).getTime() / 1000);

function series(status: SeriesStatus, label: string, kwh: number | null): ReadingSeries {
  return {
    key: `${label}|k`,
    usagePointId: 'up-1',
    meterReadingId: 'mr-1',
    readingTypeId: label,
    status,
    reason: status === 'supported' ? null : 'is exported (received) energy.',
    label,
    detail: 'detail',
    meta: {
      uom: 72,
      powerOfTenMultiplier: 0,
      accumulationBehaviour: 4,
      commodity: 1,
      flowDirection: 1,
      kind: 12,
      dataQualifier: 12,
      defaultQuality: 0,
      intervalLength: 3600,
      assumed: false,
      unresolved: false,
    },
    readings: [{ timestamp: at, duration_s: 3600, raw: 1000, kwh, quality: 0, cost: null }],
    blocks: 1,
    dropped: { negative: 0, unparsable: 0 },
    legacy: false,
    unlinked: false,
  };
}

const NOTE: SeriesNote = {
  code: 'unsupported-series',
  seriesKey: 'out|k',
  detail: 'Series up-1 · mr-1 · Wh was NOT loaded as consumption: it is exported energy.',
};

function group(over: Partial<UsagePointGroup>): UsagePointGroup {
  return {
    id: 'up-1',
    label: 'UsagePoint up-1',
    readings: [{ timestamp: at, usage_kwh: 1.5 }] as DataPoint[],
    blocks: 1,
    series: [],
    notes: [],
    ...over,
  };
}

function renderPicker(groups: UsagePointGroup[]) {
  return render(
    <UsagePointPicker fileName="feed.xml" groups={groups} onChoose={vi.fn()} onCancel={vi.fn()} />,
  );
}

describe('UsagePointPicker — series distinction', () => {
  it('states how many reading series the point carried', () => {
    renderPicker([
      group({ series: [series('supported', 'Wh forward', 1.5), series('reverse-flow', 'Wh reverse', null)] }),
    ]);
    const block = screen.getByTestId('usage-point-series-up-1');
    expect(block.textContent).toContain('2 reading series');
  });

  it('prints the reason a series was left out of the total', () => {
    renderPicker([group({ series: [series('supported', 'Wh forward', 1.5)], notes: [NOTE] })]);
    const block = screen.getByTestId('usage-point-series-up-1');
    expect(block.textContent).toContain('Why some of this point was left out:');
    expect(block.textContent).toContain('NOT loaded as consumption');
  });

  it('never shows a $0.00 total for a point whose every series was refused', () => {
    renderPicker([
      group({
        readings: [],
        series: [series('register', 'register Wh', null)],
        notes: [NOTE],
      }),
    ]);
    expect(screen.getByTestId('usage-point-series-up-1').textContent).toContain(
      'no billable readings',
    );
    expect(screen.queryByText(/0,00|\$0\.00|0 kWh/)).toBeNull();
  });

  it('still renders a plain legacy group with no series metadata', () => {
    renderPicker([group({})]);
    const block = screen.getByTestId('usage-point-series-up-1');
    expect(block.textContent).toContain('0 reading series');
    expect(screen.getByTestId('usage-point-up-1')).toBeDefined();
  });
});
