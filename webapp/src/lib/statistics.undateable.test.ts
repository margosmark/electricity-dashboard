/**
 * An undateable bill start must not take the efficiency plane down.
 *
 * `efficiencyPeriods` labeled every period with
 * `fmtDate(`${summary.startDate}T00:00:00`, 'MMM yyyy')`, and `fmtDate`
 * hands that string straight to date-fns `format()` — which THROWS
 * `RangeError: Invalid time value` on an Invalid Date. A
 * `<billingPeriod><start>` outside the Date range stamps its day keys
 * through `utcDayKey` as `NaN-NaN-NaN` (day keys read `NaN` off an Invalid
 * Date rather than throwing — see `GasSection.outOfRangeStart.test.tsx`),
 * and `readStoredBillFeed` accepts any stored bill whose `start` is merely
 * a number: no date validity, no format bound. So ONE hostile bill reached
 * `Dashboard`'s `buildEfficiency` useMemo and fell the whole dashboard to
 * the AppErrorBoundary on every load (t_b9fe7438) — a crash, not garbage
 * text, which is why it is pinned apart from the display-text cards.
 *
 * The rule, same as the rest of the undateable-date class: an unrenderable
 * start DEGRADES, it is never fatal and never dropped — the period and its
 * ¢/kWh survive untouched (PM ruling t_2a09ca9d: keep + degrade); only the
 * month label falls back to the app's own `axis.unavailableDate` marker,
 * and a start no date reads keeps the same default season `seasonForDay`
 * itself picks for an unparseable month.
 *
 * Three hostile shapes, because `readStoredBillFeed` validates only
 * `start`/`duration`/`items` and passes everything else through:
 *  - `NaN-NaN-NaN` — the parser's own output for an out-of-range instant
 *    (the card's reproducer: healthy bill re-stamped at start=1e15);
 *  - an ABSENT `startDate` — a stored payload from before the field, or a
 *    hand-trimmed one (the ERR-4887C2 class: `undefined` reaches render);
 *  - `2026-13-45` — regex-matching but not a date: `dayKeyDate`'s
 *    component-wise `new Date(2026, 12, 45)` ROLLS OVER to a valid Date,
 *    while the string parse `${key}T00:00:00` that `fmtDate` performs is
 *    Invalid — so only guarding on the exact parse `fmtDate` does closes
 *    the hole.
 *
 * FIXTURE POLICY: SYNTHETIC only — the repo's own usage-summary fixture,
 * re-stamped; no real EGD export ever enters the repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseUsageSummaries, type RateSet, type UsageSummary } from './energy';
import { buildEfficiency, efficiencyPeriods } from './statistics';
import { setLocale } from '@/i18n';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);
const OAKVILLE = fs.readFileSync(
  path.join(FIXTURES, 'usage-summary-synthetic.xml'),
  'utf8',
);
const summaries = parseUsageSummaries(OAKVILLE);

/** Same shape `statistics.test.ts` prices the fixture with. */
const rates: RateSet[] = [
  {
    effectiveDate: '2026-01-01',
    tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
    tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
    ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  },
];

/** The fixture's own May bill, by day key — the file order is not the sort order. */
function mayBill(): UsageSummary {
  const bill = summaries.find((s) => s.startDate === '2026-05-25');
  if (!bill) throw new Error('fixture lost its May 2026 bill');
  return bill;
}

/** The healthy twin of a hostile stamp: same items, same money, unreadable start. */
function hostile(base: UsageSummary, start: number, startDate: string): UsageSummary {
  return { ...base, start, startDate, endDate: startDate };
}

const SHAPES: ReadonlyArray<[string, (b: UsageSummary) => UsageSummary]> = [
  // The card's reproducer: out-of-range instant → parser stamps NaN day keys.
  ['NaN-NaN-NaN (out-of-range instant)', (b) => hostile(b, 1e15, 'NaN-NaN-NaN')],
  // A payload that never carried the field at all.
  ['absent startDate (legacy/hand-trimmed payload)', (b) => ({
    ...b,
    startDate: undefined as unknown as string,
    endDate: undefined as unknown as string,
  })],
  // Regex-matching, string-parse-Invalid: component-wise dayKeyDate rolls
  // over, `${key}T00:00:00` does not.
  ['2026-13-45 (regex passes, no such date)', (b) => ({
    ...b,
    startDate: '2026-13-45',
    endDate: '2026-13-45',
  })],
];

afterEach(() => {
  setLocale('en');
});

describe('efficiencyPeriods — a bill start that is not a time', () => {
  it.each(SHAPES)('does not throw on %s', (_name, stamp) => {
    // RED before the fix: RangeError: Invalid time value, thrown from
    // fmtDate(`${summary.startDate}T00:00:00`, 'MMM yyyy').
    expect(() => efficiencyPeriods([stamp(mayBill())], rates)).not.toThrow();
  });

  it.each(SHAPES)('keeps the period and its ¢/kWh byte-identical for %s', (_name, stamp) => {
    const healthy = efficiencyPeriods([mayBill()], rates)[0];
    const [p] = efficiencyPeriods([stamp(mayBill())], rates);

    expect(p).toBeDefined();
    // The PM ruling (t_2a09ca9d): keep + degrade — the bill is NOT dropped.
    expect(p.kwh).toBe(healthy.kwh);
    expect(p.cost).toBe(healthy.cost);
    expect(p.cents).toBe(healthy.cents);
    expect(p.centsInclTax).toBe(healthy.centsInclTax);
    expect(p.usageCents).toBe(healthy.usageCents);
    expect(p.deliveryCents).toBe(healthy.deliveryCents);
    expect(p.rateCents).toBe(healthy.rateCents);
    // The fixture's audited figure: $497.45 ÷ 2,650 kWh (statistics.test.ts
    // pins it against the synthetic fixture).
    expect(p.cents.toFixed(2)).toBe('18.77');
  });

  it.each(SHAPES)('degrades the label to the app marker for %s', (_name, stamp) => {
    expect(efficiencyPeriods([stamp(mayBill())], rates)[0].label).toBe(
      'date unavailable',
    );
  });

  it.each(SHAPES)('keeps a valid season instead of throwing on %s', (_name, stamp) => {
    // The same fallback `seasonForDay` picks when the month is unparseable:
    // index 0 → winter. (Absent startDate would otherwise be a TypeError
    // two lines below the RangeError the label used to throw first.)
    expect(efficiencyPeriods([stamp(mayBill())], rates)[0].season).toBe('winter');
  });

  it('leaves every healthy label byte-identical to before the guard', () => {
    // Control: the guard must change nothing a real file can reach.
    expect(efficiencyPeriods(summaries, rates).map((p) => p.label)).toEqual([
      'May 2026',
      'Jun 2026',
      'Jul 2026',
    ]);
  });

  it('degrades in French too — the marker is catalogued, not hardcoded', () => {
    setLocale('fr');
    expect(efficiencyPeriods([hostile(mayBill(), 1e15, 'NaN-NaN-NaN')], rates)[0].label).toBe(
      'date indisponible',
    );
    expect(efficiencyPeriods([mayBill()], rates)[0].label).toBe('mai 2026');
  });
});

describe('buildEfficiency — the path Dashboard calls in a useMemo', () => {
  it('does not throw for an undateable bill, with or without a view', () => {
    const hostileBill = hostile(mayBill(), 1e15, 'NaN-NaN-NaN');
    expect(() => buildEfficiency({ summaries: [hostileBill], rates })).not.toThrow();
    expect(() =>
      buildEfficiency({
        summaries: [hostileBill],
        rates,
        view: { start: '2026-01-01', end: '2026-12-31' },
      }),
    ).not.toThrow();
  });

  it('prices the hostile bill through the headline exactly as its healthy twin', () => {
    const report = buildEfficiency({
      summaries: [hostile(mayBill(), 1e15, 'NaN-NaN-NaN')],
      rates,
    });
    expect(report.periods).toHaveLength(1);
    expect(report.allTime?.bills).toBe(1);
    expect(report.allTime?.cents.toFixed(2)).toBe('18.77');
    // The in-view window over the same bill: string compares only, no throw.
    const inView = buildEfficiency({
      summaries: [hostile(mayBill(), 1e15, 'NaN-NaN-NaN')],
      rates,
      view: { start: '2026-05-01', end: '2026-06-30' },
    });
    expect(inView.periods).toHaveLength(1);
  });
});
