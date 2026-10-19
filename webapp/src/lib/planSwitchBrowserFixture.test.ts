import { describe, expect, it } from 'vitest';
import { makePlanSwitchFixture, planSwitchFixtureRates } from '../../tests/e2e/plan-switch-fixture';
import { processRawData } from './energy';
import { buildSwitchReport } from './planTimeline';
import { buildSwitchTimeline } from './switchTimeline';

describe('synthetic populated Plan-Switch browser fixture', () => {
  it('produces distinct empty and populated-ready states with signed bubbles at both ends', () => {
    const { summaries, points } = makePlanSwitchFixture();
    expect(summaries).toHaveLength(3);
    expect(points).toHaveLength(summaries.reduce((sum, period) => sum + period.days * 24, 0));

    const readings = processRawData(points, planSwitchFixtureRates);
    const report = buildSwitchReport(summaries, readings, []);

    expect(report.rows).toHaveLength(3);
    expect(report.known).toBe(3);
    expect(report.modeled).toBe(3);
    expect(report.counted).toBe(3);
    expect(report.untrusted).toBe(0);
    expect(report.rows.every((row) => Math.abs(row.modelDelta ?? Infinity) <= 1)).toBe(true);
    for (const summary of summaries) {
      const measured = points
        .filter((point) => point.timestamp >= summary.start && point.timestamp < summary.start + summary.duration)
        .reduce((sum, point) => sum + point.usage_kwh, 0);
      expect(measured).toBeCloseTo(summary.consumption?.scaled ?? 0, 6);
    }
    expect(report.rows[1].saving).toBeLessThan(0);
    expect(report.rows[2].saving).toBeGreaterThan(0);
    expect(report.rows[1].counted).toBe(true);
    expect(report.rows[2].counted).toBe(true);
    const timeline = buildSwitchTimeline(report);
    expect(timeline.segments).toHaveLength(3);
    expect(timeline.segments.filter((segment) => segment.saving !== null).length).toBeGreaterThanOrEqual(2);
    expect(timeline.segments[1].saving).toBeLessThan(0);
    expect(timeline.segments[2].saving).toBeGreaterThan(0);
  });
});
