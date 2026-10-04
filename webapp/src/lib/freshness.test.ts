/**
 * Wave H item 5 — data-freshness chip. The boundary and the wording are the
 * product here: past 7 days the chip has to admit the export is stale.
 */

import { describe, it, expect } from 'vitest';
import { dataFreshness, relativeAge, STALE_AFTER_DAYS } from './freshness';

const NOW = new Date(2026, 9, 3); // 2026-10-03 local

const daysAgo = (n: number) => {
  const d = new Date(2026, 9, 3);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
};

describe('dataFreshness', () => {
  it('reads a same-day export as today, not stale', () => {
    const f = dataFreshness('2026-10-03', NOW);
    expect(f.ageDays).toBe(0);
    expect(f.relative).toBe('today');
    expect(f.stale).toBe(false);
  });

  it('counts whole days between the last reading and today', () => {
    expect(dataFreshness(daysAgo(3), NOW).ageDays).toBe(3);
    expect(dataFreshness(daysAgo(3), NOW).relative).toBe('3 days ago');
    expect(dataFreshness(daysAgo(1), NOW).relative).toBe('1 day ago');
  });

  it('is not stale until the gap exceeds the threshold', () => {
    const justInside = dataFreshness(daysAgo(STALE_AFTER_DAYS), NOW);
    expect(justInside.stale).toBe(false);
    const justOutside = dataFreshness(daysAgo(STALE_AFTER_DAYS + 1), NOW);
    expect(justOutside.stale).toBe(true);
    expect(justOutside.relative).toBe('8 days ago');
  });

  it('never reports a negative age when a clock runs ahead of the export', () => {
    const f = dataFreshness('2026-10-10', NOW);
    expect(f.ageDays).toBe(0);
    expect(f.stale).toBe(false);
    expect(f.relative).toBe('today');
  });

  it('rolls days up to months and years', () => {
    expect(dataFreshness(daysAgo(45), NOW).relative).toBe('2 months ago');
    expect(dataFreshness(daysAgo(400), NOW).relative).toBe('1 year ago');
    expect(dataFreshness(daysAgo(800), NOW).relative).toBe('2 years ago');
  });

  it('degrades to "unknown" instead of throwing on a malformed date', () => {
    const f = dataFreshness('not-a-date', NOW);
    expect(f.relative).toBe('unknown');
    expect(f.stale).toBe(false);
  });

  it('crosses midnight on the last reading without an off-by-one', () => {
    // Reading on Oct 1, "now" Oct 3 23:59 — still exactly 2 days, because
    // both ends are compared at local midnight.
    const lateNight = new Date(2026, 9, 3, 23, 59);
    expect(dataFreshness('2026-10-01', lateNight).ageDays).toBe(2);
  });
});

describe('relativeAge', () => {
  it('says 1 month for anything in a single month band', () => {
    expect(relativeAge(30)).toBe('1 month ago');
    expect(relativeAge(34)).toBe('1 month ago');
    expect(relativeAge(60)).toBe('2 months ago');
  });
});
