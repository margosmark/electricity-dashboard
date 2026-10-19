import { describe, it, expect } from 'vitest';
import { buildSwitchTimeline, EMPTY_SWITCH_TIMELINE } from './switchTimeline';
import type { SwitchPeriodRow, SwitchReport } from './planTimeline';

const DAY = 86_400;

function ts(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

function row(overrides: Partial<SwitchPeriodRow> & { start: string; days: number }): SwitchPeriodRow {
  const { start: startDay, days, ...fields } = overrides;
  const start = ts(startDay);
  const duration = days * DAY;

  const base: SwitchPeriodRow = {
    summary: {
      start,
      duration,
      startDate: startDay,
      endDate: new Date((start + duration) * 1000).toISOString().slice(0, 10),
    } as SwitchPeriodRow['summary'],
    label: `${startDay} +${days}d`,
    plan: 'TOU',
    origin: 'detected',
    conflict: false,
    detection: { plan: 'TOU', evidence: ['Off-Peak'], candidates: ['TOU'], reason: null },
    actual: 100,
    modeled: null,
    bestPlan: null,
    saving: null,
    modelDelta: 0,
    skipped: null,
    counted: true,
    excluded: null,
  };

  return { ...base, ...fields };
}

function report(rows: SwitchPeriodRow[]): SwitchReport {
  return {
    rows,
    known: rows.filter((r) => r.plan !== 'unknown').length,
    modeled: rows.filter((r) => r.modeled !== null).length,
    counted: rows.filter((r) => r.counted).length,
    untrusted: 0,
    skipped: rows.filter((r) => r.skipped !== null).length,
    overpaid: null,
    byPlan: [],
    callouts: [],
  } as SwitchReport;
}

describe('buildSwitchTimeline — nothing to draw', () => {
  it('says so instead of drawing an empty bar', () => {
    const timeline = buildSwitchTimeline(report([]));
    expect(timeline).toEqual(EMPTY_SWITCH_TIMELINE);
    expect(timeline.note).toContain('Usage-only analysis already works');
    expect(timeline.note).toContain('export that contains bills');
  });
});

describe('buildSwitchTimeline — segments', () => {
  const timeline = buildSwitchTimeline(
    report([
      row({ start: '2026-05-25', days: 29, plan: 'TOU', saving: 12.5, counted: true }),
      row({ start: '2026-06-23', days: 29, plan: 'ULO', saving: -3.25, counted: true }),
      row({ start: '2026-07-22', days: 30, plan: 'ULO', saving: 0, counted: true }),
    ]),
  );

  it('gives every period a segment in date order', () => {
    expect(timeline.segments).toHaveLength(3);
    expect(timeline.segments.map((s) => s.start)).toEqual([
      '2026-05-25',
      '2026-06-23',
      '2026-07-22',
    ]);
    expect(timeline.known).toBe(3);
    expect(timeline.totalDays).toBe(88);
  });

  it('sizes each segment by its own length so the bar reads as real time', () => {
    expect(timeline.segments[0].share).toBeCloseTo(29 / 88, 6);
    expect(timeline.segments[2].share).toBeCloseTo(30 / 88, 6);
    const sum = timeline.segments.reduce((acc, s) => acc + s.share, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('carries the plan, the saving and the trust flag onto the segment', () => {
    const first = timeline.segments[0];
    expect(first.plan).toBe('TOU');
    expect(first.saving).toBe(12.5);
    expect(first.counted).toBe(true);
    expect(first.isSwitch).toBe(false);
    expect(first.previousPlan).toBeNull();
    expect(first.origin).toBe('detected');
  });
});

describe('buildSwitchTimeline — switch points', () => {
  const timeline = buildSwitchTimeline(
    report([
      row({ start: '2026-05-25', days: 29, plan: 'TOU', saving: 12.5, counted: true }),
      row({ start: '2026-06-23', days: 29, plan: 'ULO', saving: 18.75, counted: true }),
      row({ start: '2026-07-22', days: 30, plan: 'ULO', saving: 0, counted: true }),
    ]),
  );

  it('marks exactly one switch — TOU → ULO — and puts the bubble on it', () => {
    expect(timeline.switches).toBe(1);
    expect(timeline.switchPoints).toHaveLength(1);
    const point = timeline.switchPoints[0];
    expect(point.from).toBe('TOU');
    expect(point.to).toBe('ULO');
    expect(point.day).toBe('2026-06-23');
    expect(point.index).toBe(1);
    expect(point.saving).toBe(18.75);
    expect(point.counted).toBe(true);
    expect(timeline.segments[1].isSwitch).toBe(true);
    expect(timeline.segments[2].isSwitch).toBe(false);
  });

  it('does not call staying on the same plan a switch', () => {
    const same = buildSwitchTimeline(
      report([
        row({ start: '2026-05-25', days: 30, plan: 'ULO', saving: 0, counted: true }),
        row({ start: '2026-06-24', days: 30, plan: 'ULO', saving: 0, counted: true }),
      ]),
    );
    expect(same.switches).toBe(0);
    expect(same.note).toContain('all on the same plan');
  });

  it('refuses to call a boundary a switch when either side is unknown', () => {
    const unknown = buildSwitchTimeline(
      report([
        row({ start: '2026-05-25', days: 30, plan: 'TOU', saving: 5, counted: true }),
        row({ start: '2026-06-24', days: 30, plan: 'unknown', saving: null, counted: false }),
        row({ start: '2026-07-24', days: 30, plan: 'ULO', saving: 7, counted: true }),
      ]),
    );
    expect(unknown.switches).toBe(0);
    expect(unknown.switchPoints).toHaveLength(0);
    expect(unknown.known).toBe(2);
    expect(unknown.segments[1].plan).toBe('unknown');
  });

  it('counts several switches across the record', () => {
    const many = buildSwitchTimeline(
      report([
        row({ start: '2026-01-01', days: 30, plan: 'TOU', saving: 1, counted: true }),
        row({ start: '2026-01-31', days: 30, plan: 'ULO', saving: 2, counted: true }),
        row({ start: '2026-03-02', days: 30, plan: 'Tiered', saving: 3, counted: true }),
        row({ start: '2026-04-01', days: 30, plan: 'TOU', saving: 4, counted: true }),
      ]),
    );
    expect(many.switches).toBe(3);
    expect(many.note).toContain('3 plan switches');
  });
});

describe('buildSwitchTimeline — honest holes', () => {
  it('inserts an unknown segment for days no bill covers', () => {
    const timeline = buildSwitchTimeline(
      report([
        row({ start: '2026-05-25', days: 29, plan: 'TOU', saving: 5, counted: true }),
        // 12 days unaccounted for before the next bill.
        row({ start: '2026-07-03', days: 30, plan: 'TOU', saving: 5, counted: true }),
      ]),
    );
    expect(timeline.segments).toHaveLength(3);
    const gap = timeline.segments[1];
    expect(gap.plan).toBe('unknown');
    expect(gap.reason).toContain('No bill we hold');
    expect(gap.days).toBeGreaterThanOrEqual(10);
    // A hole between two identical plans is not a plan switch.
    expect(timeline.switches).toBe(0);
  });

  it('does not manufacture a hole for back-to-back periods', () => {
    const timeline = buildSwitchTimeline(
      report([
        row({ start: '2026-05-25', days: 29, plan: 'TOU', saving: 5, counted: true }),
        row({ start: '2026-06-23', days: 29, plan: 'TOU', saving: 5, counted: true }),
      ]),
    );
    expect(timeline.segments).toHaveLength(2);
  });
});

describe('buildSwitchTimeline — untrusted savings', () => {
  it('keeps the segment but drops the bubble when the model missed the bill', () => {
    const timeline = buildSwitchTimeline(
      report([
        row({ start: '2026-05-25', days: 30, plan: 'TOU', saving: 99, counted: false, excluded: 'model missed this bill by $14' }),
        row({ start: '2026-06-24', days: 30, plan: 'ULO', saving: 99, counted: false, excluded: 'model missed this bill by $14' }),
      ]),
    );
    expect(timeline.segments).toHaveLength(2);
    expect(timeline.segments[1].isSwitch).toBe(true);
    expect(timeline.segments[1].counted).toBe(false);
    expect(timeline.switchPoints[0].counted).toBe(false);
    expect(timeline.segments[1].reason).toContain('model missed');
  });
});
