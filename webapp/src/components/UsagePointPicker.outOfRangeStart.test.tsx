/**
 * A Green Button `<start>` is unbounded in the ESPI schema, so a document can
 * carry an instant that is not a time at all: `new Date(ts * 1000)` is Invalid
 * and date-fns `format()` then THROWS `RangeError: Invalid time value`. The
 * picker called `format()` on the first and last reading of every point
 * *inside its render*, so one out-of-range start in a multi-meter file took the
 * picker — and the render with it — down before the user could choose anything.
 *
 * There are two boundaries, and both are pinned here:
 *  - the parser bounds `<start>` at ingest (`series.ts`, t_e33fc656), so a
 *    fresh upload cannot produce the crashing shape at all;
 *  - this component bounds its OWN input, because the rows it is handed can
 *    also come from `localStorage` (written before the parser bound existed) or
 *    from any future reader. An unrenderable instant reads as '—' — the
 *    placeholder an empty group already gets — never as an exception.
 *
 * Reproducer: the security gate's multi-meter document (gate t_13acdc3b,
 * finding PRE-EXISTING-1, card t_042b0671) — point A carries
 * `<start>999999999999999</start>` (the year 33 658), point B a real instant.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsagePointPicker, usagePointStats } from './UsagePointPicker';
import { parseGreenButtonUsagePoints, type DataPoint, type UsagePointGroup } from '@/lib/energy';

/** `yyyy-MM-dd` in local time, the app's day key — asserted without date-fns. */
function localDay(ts: number): string {
  const d = new Date(ts * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const REAL_START = 1704067200; // 2023-12-31T19:00 EST
const HOSTILE_STARTS = [
  999999999999999, // the year 33 658 — the gate's reproducer
  8640000000000001, // one ms past the Date range
  1e308, // finite and huge — a number, not a time
  Number.MAX_SAFE_INTEGER,
];

function groupWith(id: string, timestamps: number[]): UsagePointGroup {
  return {
    id,
    label: `UsagePoint ${id}`,
    readings: timestamps.map((timestamp) => ({ timestamp, usage_kwh: 1.5 }) as DataPoint),
    blocks: 1,
    series: [],
    notes: [],
  };
}

function renderPicker(groups: UsagePointGroup[]) {
  return render(
    <UsagePointPicker fileName="feed.xml" groups={groups} onChoose={vi.fn()} onCancel={vi.fn()} />,
  );
}

/** The gate's document: one hostile point, one healthy point. */
const OUT_OF_RANGE_XML = `<?xml version="1.0"?><feed>
  <entry><link rel="self" href="/resource/UsagePoint/A"/><content><IntervalBlock>
    <IntervalReading><timePeriod><start>999999999999999</start></timePeriod><value>1500</value></IntervalReading>
  </IntervalBlock></content></entry>
  <entry><link rel="self" href="/resource/UsagePoint/B"/><content><IntervalBlock>
    <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading>
  </IntervalBlock></content></entry>
</feed>`;

describe('usagePointStats — an instant that is not a date', () => {
  it.each(HOSTILE_STARTS)('reports start %s as unstatable instead of throwing', (start) => {
    // format() on this instant throws RangeError: Invalid time value.
    expect(() => usagePointStats(groupWith('up', [start]))).not.toThrow();
    const stats = usagePointStats(groupWith('up', [start]));
    expect(stats.from).toBe('—');
    expect(stats.to).toBe('—');
    // The row's own numbers are unchanged: the reading still exists.
    expect(stats.count).toBe(1);
    expect(stats.kwh).toBe(1.5);
  });

  it('leaves a real instant formatted exactly as before', () => {
    expect(usagePointStats(groupWith('up', [REAL_START]))).toEqual({
      kwh: 1.5,
      count: 1,
      from: localDay(REAL_START),
      to: localDay(REAL_START),
    });
  });

  it('dates each end of the span on its own', () => {
    const stats = usagePointStats(groupWith('up', [999999999999999, REAL_START]));
    expect(stats.from).toBe('—');
    expect(stats.to).toBe(localDay(REAL_START));
    expect(stats.count).toBe(2);
  });
});

describe('UsagePointPicker — a point whose start is not a date', () => {
  /** Rows a pre-bound import left in localStorage: the picker gets them as props. */
  const stale = [groupWith('A', [999999999999999]), groupWith('B', [REAL_START])];

  it('renders instead of throwing RangeError mid-render', () => {
    expect(() => renderPicker(stale)).not.toThrow();
    expect(screen.getByTestId('usage-point-picker')).toBeInTheDocument();
  });

  it('shows the hostile point the placeholder and the healthy one its real span', () => {
    renderPicker(stale);
    expect(screen.getByTestId('usage-point-A').textContent).toContain('— → —');
    expect(screen.getByTestId('usage-point-B').textContent).toContain(
      `${localDay(REAL_START)} → ${localDay(REAL_START)}`,
    );
    // Every row is still offered, combined, however its start reads.
    expect(screen.getByTestId('usage-point-combine')).toBeInTheDocument();
  });
});

describe('the gate document, against the parser bound', () => {
  const groups = parseGreenButtonUsagePoints(OUT_OF_RANGE_XML);

  it('refuses the out-of-range start at ingest, so a fresh upload cannot reach the picker with it', () => {
    expect(groups).toHaveLength(2);
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.get('A')!.readings).toEqual([]);
    expect(byId.get('B')!.readings[0].timestamp).toBe(REAL_START);
  });

  it('renders the file — the picker still offers both points and combine', () => {
    renderPicker(groups);
    expect(screen.getByTestId('usage-point-picker')).toBeInTheDocument();
    expect(screen.getByTestId('usage-point-A')).toBeInTheDocument();
    expect(screen.getByTestId('usage-point-combine')).toBeInTheDocument();
  });
});
