/**
 * Ontario Time-of-Use / Ultra-Low Overnight holiday pricing.
 *
 * The OEB is explicit: *"No matter which season, on weekends and holidays the
 * cheapest rates are in effect all day"* (oeb.ca → electricity rates), and it
 * publishes the exact days each year ("Holiday schedule - Time-of-Use and
 * Ultra-Low Overnight"): off-peak all day for TOU, weekend-off-peak + overnight
 * for ULO — plus the observation rule: *"If a holiday falls on a weekend, the
 * next weekday (that is not also a holiday) will have the holiday prices in
 * effect all day."*
 *
 * This app's classifier never knew that, so it priced holidays like ordinary
 * weekdays. Mark's own Oakville bill caught it: **2026-08-03 (Civic Holiday)
 * reads as a full off-peak day on the meter** — reclassifying that one day
 * makes the app's TOU split for the Jul 23 – Aug 21 period match Oakville's
 * own Off/Mid/On-Peak-Summer kWh to within 0.07 kWh (and the dollar figure to
 * within a cent).
 *
 * The 2026 dates below are exactly the OEB's published 2026 table; every other
 * year is the same rule computed.
 */

/** A day the OEB prices at the lowest rate all day. */
export type OntarioHoliday = { month: number; day: number; label: string };

/** Day of week, `Date#getDay` order (0 = Sunday). */
function dowOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The `n`th `weekday` (0 = Sunday) of `month`, or null when there is none. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number | null {
  const firstHit = 1 + ((weekday - dowOf(year, month, 1) + 7) % 7);
  const day = firstHit + (n - 1) * 7;
  return day <= daysInMonth(year, month) ? day : null;
}

/** Sunday of Easter (Anonymous Gregorian algorithm). */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Good Friday = Easter Sunday − 2 days. */
function goodFriday(year: number): { month: number; day: number } {
  const easter = easterSunday(year);
  const d = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The OEB's holiday-pricing days for `year`, sorted by date.
 *
 * The weekday-based dates (Family Day, Good Friday, Victoria Day, Civic
 * Holiday, Labour Day, Thanksgiving) never move, so they are laid down first;
 * the fixed dates (New Year, Canada Day, Christmas, Boxing Day) then slide to
 * the next weekday that is not already a holiday — the OEB's observation rule.
 */
export function ontarioHolidays(year: number): OntarioHoliday[] {
  const moving: OntarioHoliday[] = [
    { month: 2, day: nthWeekday(year, 2, 1, 3) ?? 15, label: 'Family Day' },
    { ...goodFriday(year), label: 'Good Friday' },
    // Victoria Day = the Monday preceding May 25 (when May 25 is a Monday it
    // is the one before).
    { month: 5, day: 25 - (((dowOf(year, 5, 25) + 6) % 7) || 7), label: 'Victoria Day' },
    { month: 8, day: nthWeekday(year, 8, 1, 1) ?? 3, label: 'Civic Holiday' },
    { month: 9, day: nthWeekday(year, 9, 1, 1) ?? 7, label: 'Labour Day' },
    { month: 10, day: nthWeekday(year, 10, 1, 2) ?? 12, label: 'Thanksgiving Day' },
  ];
  const out: OntarioHoliday[] = [...moving];
  const taken = new Set(moving.map((h) => `${h.month}-${h.day}`));

  /** First day at/after `month`/`day` that is a weekday and not already taken. */
  const observe = (month: number, day: number): { month: number; day: number } => {
    let t = Date.UTC(year, month - 1, day);
    for (let i = 0; i < 10; i += 1) {
      const d = new Date(t);
      const m = d.getUTCMonth() + 1;
      const dd = d.getUTCDate();
      const dow = d.getUTCDay();
      const key = `${m}-${dd}`;
      if (dow !== 0 && dow !== 6 && !taken.has(key)) {
        taken.add(key);
        return { month: m, day: dd };
      }
      t += 86400000;
    }
    return { month, day };
  };

  for (const [month, day, label] of [
    [1, 1, 'New Year’s Day'],
    [7, 1, 'Canada Day'],
    [12, 25, 'Christmas Day'],
    [12, 26, 'Boxing Day'],
  ] as const) {
    const observed = observe(month, day);
    out.push({ month: observed.month, day: observed.day, label });
  }

  return out.sort((a, b) => a.month - b.month || a.day - b.day);
}

/**
 * True when the OEB prices that day at the lowest rate all day.
 * Weekends are handled by the caller — they are not holidays.
 */
export function isOntarioHoliday(year: number, month: number, day: number): boolean {
  return ontarioHolidays(year).some((h) => h.month === month && h.day === day);
}
