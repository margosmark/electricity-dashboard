/**
 * Day-span arithmetic — the module that exists because five places had
 * written this out longhand and two of them were a verbatim copy of each
 * other. These pin the two behaviours that copy-paste kept getting wrong.
 */

import { describe, it, expect } from 'vitest';
import { daysBetweenDayKeys, daysInMonth, isDayKey, MS_PER_DAY } from './dateSpan';

describe('isDayKey', () => {
  it('accepts only yyyy-MM-dd', () => {
    expect(isDayKey('2026-08-03')).toBe(true);
    expect(isDayKey('2026-8-3')).toBe(false);
    expect(isDayKey('26-08-03')).toBe(false);
    expect(isDayKey('2026-08-03T00:00:00Z')).toBe(false);
    expect(isDayKey(20260803)).toBe(false);
  });
});

describe('daysBetweenDayKeys', () => {
  it('is INCLUSIVE: the same day is one day, not zero', () => {
    expect(daysBetweenDayKeys('2026-08-03', '2026-08-03')).toBe(1);
    expect(daysBetweenDayKeys('2026-08-03', '2026-08-04')).toBe(2);
  });

  it('counts across a month boundary', () => {
    expect(daysBetweenDayKeys('2026-07-26', '2026-08-25')).toBe(31);
  });

  it('counts a leap day', () => {
    expect(daysBetweenDayKeys('2024-02-28', '2024-03-01')).toBe(3);
    expect(daysBetweenDayKeys('2025-02-28', '2025-03-01')).toBe(2);
  });

  it('is timezone-independent — a DST boundary inside the span must not shift it', () => {
    // 2026-03-08 is the North America DST change. Reading either end through
    // a LOCAL Date would give 23 or 25 hours of real time here and round to a
    // different day count on half the machines in the fleet.
    expect(daysBetweenDayKeys('2026-03-01', '2026-03-31')).toBe(31);
    expect(daysBetweenDayKeys('2026-11-01', '2026-11-30')).toBe(30);
  });

  it('never returns less than 1, so callers can divide by it', () => {
    expect(daysBetweenDayKeys('2026-08-10', '2026-08-01')).toBe(1);
  });

  it('falls back to 1 on a malformed key instead of NaN', () => {
    expect(daysBetweenDayKeys('nope', '2026-08-01')).toBe(1);
    expect(daysBetweenDayKeys('2026-08-01', '')).toBe(1);
  });
});

describe('daysInMonth', () => {
  it('handles February in leap and common years', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28); // century, not divisible by 400
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
  });

  it('takes a 1-indexed month', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('MS_PER_DAY', () => {
  it('is the one literal the module exists to stop duplicating', () => {
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});