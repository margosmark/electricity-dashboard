/**
 * Wave L — the OEB's TOU/ULO holiday schedule.
 *
 * The dates for 2026 are copied from the OEB's own published table
 * (oeb.ca → electricity rates → "Holiday schedule - Time-of-Use and Ultra-Low
 * Overnight"), because that table is the rule this app must follow: on those
 * days the lowest price is in effect ALL DAY.
 *
 * Why it matters here: Oakville's meter really does apply it — Mark's bill
 * counts every hour of Mon 2026-08-03 (Civic Holiday) as off-peak, and our
 * classifier did not. One holiday was worth $4.06 on a single period, which is
 * the entire estimate-vs-actual miss this wave had before the fix.
 */

import { describe, it, expect } from 'vitest';
import { isOntarioHoliday, ontarioHolidays } from './ontarioHolidays';

const label = (h: { month: number; day: number; label: string }) => h.label;

describe('2026 — the OEB’s published table, exactly', () => {
  it('lists the ten days the OEB lists, on the OEB’s dates', () => {
    const holidays = ontarioHolidays(2026).map((h) => `${h.month}/${h.day} ${label(h)}`);
    expect(holidays).toEqual([
      '1/1 New Year’s Day',
      '2/16 Family Day',
      '4/3 Good Friday',
      '5/18 Victoria Day',
      '7/1 Canada Day',
      '8/3 Civic Holiday',
      '9/7 Labour Day',
      '10/12 Thanksgiving Day',
      '12/25 Christmas Day',
      '12/28 Boxing Day',
    ]);
  });

  it('every one of them falls on the weekday the OEB names', () => {
    // OEB: Thursday Jan 1, Monday Feb 16, Friday Apr 3, Monday May 18,
    // Wednesday Jul 1, Monday Aug 3, Monday Sep 7, Monday Oct 12,
    // Friday Dec 25, Monday Dec 28.
    const expectedDow: Record<string, number> = {
      '1-1': 4, '2-16': 1, '4-3': 5, '5-18': 1, '7-1': 3,
      '8-3': 1, '9-7': 1, '10-12': 1, '12-25': 5, '12-28': 1,
    };
    for (const h of ontarioHolidays(2026)) {
      const dow = new Date(Date.UTC(2026, h.month - 1, h.day)).getUTCDay();
      expect(dow, `${h.month}/${h.day}`).toBe(expectedDow[`${h.month}-${h.day}`]);
    }
  });

  it('is answerable day by day', () => {
    expect(isOntarioHoliday(2026, 8, 3)).toBe(true);
    expect(isOntarioHoliday(2026, 7, 1)).toBe(true);
    expect(isOntarioHoliday(2026, 1, 1)).toBe(true);
    expect(isOntarioHoliday(2026, 8, 10)).toBe(false); // an ordinary Monday
    expect(isOntarioHoliday(2026, 8, 2)).toBe(false); // Sunday is a weekend, not a holiday
    expect(isOntarioHoliday(2026, 12, 27)).toBe(false); // Sunday, not the observed Boxing Day
  });
});

describe('the observation rule', () => {
  it('slides a weekend holiday to the next weekday that is not already a holiday', () => {
    // 2022: Jan 1 was a Saturday; Dec 25 fell on a Sunday and Dec 26 (Boxing
    // Day) on the Monday after it. Either reading of "the next weekday that is
    // not also a holiday" prices the same two days — Dec 26 and Dec 27 — which
    // is the only thing that reaches the classifier.
    const y2022 = ontarioHolidays(2022);
    expect(y2022.find((h) => h.label === 'New Year’s Day')).toMatchObject({ month: 1, day: 3 });
    expect(y2022.filter((h) => h.month === 12).map((h) => h.day)).toEqual([26, 27]);
    // 2021: Dec 25 Saturday, Dec 26 Sunday.
    const y2021 = ontarioHolidays(2021);
    expect(y2021.find((h) => h.label === 'Christmas Day')).toMatchObject({ month: 12, day: 27 });
    expect(y2021.find((h) => h.label === 'Boxing Day')).toMatchObject({ month: 12, day: 28 });
    // …and leaves a weekday holiday alone.
    expect(ontarioHolidays(2023).find((h) => h.label === 'Christmas Day')).toMatchObject({
      month: 12,
      day: 25,
    });
  });

  it('computes Good Friday from Easter for any year', () => {
    // Easter 2026 = Apr 5; Easter 2027 = Mar 28; Easter 2024 = Mar 31.
    expect(ontarioHolidays(2026).find((h) => h.label === 'Good Friday')).toMatchObject({
      month: 4,
      day: 3,
    });
    expect(ontarioHolidays(2027).find((h) => h.label === 'Good Friday')).toMatchObject({
      month: 3,
      day: 26,
    });
    expect(ontarioHolidays(2024).find((h) => h.label === 'Good Friday')).toMatchObject({
      month: 3,
      day: 29,
    });
  });

  it('keeps the movable holidays on the right weekday', () => {
    // Family Day = 3rd Monday of February; Labour Day = 1st Monday of
    // September; Thanksgiving = 2nd Monday of October; Civic = 1st Monday of
    // August; Victoria Day = the Monday preceding May 25.
    for (const year of [2025, 2026, 2027, 2028]) {
      const byLabel = new Map(ontarioHolidays(year).map((h) => [h.label, h]));
      const dowOf = (h: { month: number; day: number }) =>
        new Date(Date.UTC(year, h.month - 1, h.day)).getUTCDay();
      expect(dowOf(byLabel.get('Family Day')!),  `Family Day ${year}`).toBe(1);
      expect(dowOf(byLabel.get('Labour Day')!),  `Labour Day ${year}`).toBe(1);
      expect(dowOf(byLabel.get('Thanksgiving Day')!), `Thanksgiving ${year}`).toBe(1);
      expect(dowOf(byLabel.get('Civic Holiday')!), `Civic ${year}`).toBe(1);
      expect(dowOf(byLabel.get('Victoria Day')!), `Victoria ${year}`).toBe(1);
      const victoria = byLabel.get('Victoria Day')!;
      expect(victoria.day).toBeLessThan(25);
      expect(victoria.month).toBe(5);
    }
  });
});
