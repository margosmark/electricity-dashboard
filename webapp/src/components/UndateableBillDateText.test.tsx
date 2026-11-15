/**
 * Visible text for a billed period whose date is not a date — PM ruling
 * t_2a09ca9d (keep + degrade): the bill STAYS in the data model, only what a
 * human reads changes.
 *
 * The garbage this pins, at the two formatting chokepoints plus the three
 * render sites the security trace named:
 *
 *  - `billPeriodLabel` (energy.ts) used to compose
 *    `"undefined NaN, NaN – undefined NaN"` (`MONTH_ABBR()[NaN]` is
 *    `undefined`); F3's guard now prints a bare `—`, which neither says WHY
 *    the period looks odd nor switches with the locale.
 *  - `stampDayKey`/`localDayKey` (billingAxis.ts) stamp `NaN-NaN-NaN`
 *    (TRUTHY — it survives every truthiness guard) into
 *    `AxisPeriod.startDate`/`endDate`, and the parser writes the same string
 *    into `UsageSummary.startDate`/`endDate`. That reaches the screen at the
 *    open-period dates (OpenPeriodPanel), the gap caption and open/gap
 *    short labels (the axis rows), and the waterfall's period picker.
 *
 * RAW VALUES STAY RAW (decision 1): `startDate`/`endDate`/`summary.startDate`
 * keep `NaN-NaN-NaN` — they feed React `key`, `data-testid`, `aria-pressed`,
 * `dateWindowOf`, sorting and dedupe, and two hostile periods must not collide
 * on one marker string as duplicate keys. Only the strings a human READS are
 * mapped to the localized `axis.unavailableDate` marker.
 *
 * FINITE INPUTS ARE BYTE-IDENTICAL: every healthy assertion in
 * `usageSummary.test.ts` / `billingAxis.test.ts` / `OpenPeriod.test.tsx`
 * still reads the same label — none of them is edited here.
 *
 * RED control (measured before the fix): the first assertion of each block
 * fails — MoneySection's text carries `NaN-NaN-NaN` from the gap caption and
 * the waterfall picker, `billed-through-date` reads `NaN-NaN-NaN`, and the
 * marker assertions read `"—"` instead of `"date unavailable"`.
 *
 * FIXTURE POLICY: SYNTHETIC only — the committed `usage-summary-synthetic.xml`
 * bills re-stamped at an undateable instant, no real EGD export.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import MoneySection from './MoneySection';
import { ActualBillPanel } from './ActualBillPanel';
import OpenPeriodPanel from './OpenPeriodPanel';
import { buildBillingAxis } from '@/lib/billingAxis';
import { buildAxisStacks } from '@/lib/moneyViz';
import {
  billPeriodLabel,
  billTotals,
  parseUsageSummaries,
  processRawData,
  type ProcessedPoint,
  type RateSet,
  type UsageSummary,
} from '@/lib/energy';
import { dayKeyLabel } from '@/lib/dateSpan';
import { setLocale } from '@/i18n';

const DAY = 86_400;

/** The five shapes every undateable-instant test in this repo pins. */
const HOSTILE_STARTS = [
  1_000_000_000_000_000,
  -1_000_000_000_000_000,
  8_640_000_000_001,
  Number.MAX_SAFE_INTEGER,
  1e308,
];

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);
const healthy = parseUsageSummaries(
  fs.readFileSync(path.join(FIXTURES, 'usage-summary-synthetic.xml'), 'utf8'),
);

const rateSet: RateSet = {
  effectiveDate: '2025-11-01',
  tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
  tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
  ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
};

/** `stampDayKey`'s exact output, without throwing on an Invalid Date. */
function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/**
 * A stated bill re-stamped at an undateable instant, shaped exactly like the
 * parser's own output: every money line, item and the currency are the
 * committed fixture's, so the bill keeps its amount while its date rots.
 *
 * The read-date items are dropped because they are DATE fields, not money:
 * `billWindow` prefers a bill's own "previous/current read date" stamps over
 * the `billingPeriod` start, and with them present the read span silently
 * RESCUES the end date of a negative-direction stamp (the panel then prints a
 * real date, which is honest but exercises nothing). Without them the window
 * falls back to `start + duration` — the undateable instant itself — which is
 * the payload this card is about: a bill that states no reads, only a stamp.
 */
function hostileBill(ts: number): UsageSummary {
  const base = healthy[healthy.length - 1];
  return {
    ...base,
    start: ts,
    startDate: dayKey(ts),
    endDate: dayKey(ts + base.duration),
    items: base.items.filter(
      (i) => !(i.measurement?.uom === 27 && /read date/i.test(i.note)),
    ),
  };
}

/** Daily noon readings across the healthy bills, plus `tailDays` past the last. */
function rowsFor(summaries: UsageSummary[], tailDays: number): ProcessedPoint[] {
  const raw: { timestamp: number; usage_kwh: number }[] = [];
  for (const s of summaries) {
    const days = Math.round(s.duration / DAY);
    for (let i = 0; i < days; i += 1) {
      raw.push({ timestamp: s.start + i * DAY + 3 * 3600, usage_kwh: 1 });
    }
  }
  const last = summaries[summaries.length - 1];
  for (let i = 0; i < tailDays; i += 1) {
    raw.push({
      timestamp: last.start + last.duration + i * DAY + 3 * 3600,
      usage_kwh: 1,
    });
  }
  return processRawData(raw, [rateSet]);
}

const rows = rowsFor(healthy, 40);
const money = (n: number) => `$${n.toFixed(2)}`;
const GARBAGE = /NaN|undefined/;

/** No text node anywhere under `node` may read `NaN…` or `undefined…`. */
const expectCleanText = (node: HTMLElement) => {
  expect(node.textContent ?? '').not.toMatch(GARBAGE);
};

beforeEach(() => {
  localStorage.clear();
  setLocale('en');
});
afterEach(() => {
  cleanup();
  setLocale('en');
});

/* ================================================================ the axis */

describe('the billing axis over an undateable billed period', () => {
  it.each(HOSTILE_STARTS)(
    'keeps the period, its money and a garbage-free caption for start %s',
    (ts) => {
      const bill = hostileBill(ts);
      const axis = buildBillingAxis({
        summaries: [...healthy, bill],
        rows,
      });

      // Keep + degrade: the undateable bill is still a period on the axis.
      expect(axis.billed.some((p) => p.summary?.start === ts)).toBe(true);

      // Every composed caption — label AND short label, billed/gap/open — is
      // free of the garbage the chokepoints used to emit.
      const captions = axis.periods
        .map((p) => `${p.label} ${p.shortLabel}`)
        .join(' ');
      expect(captions).not.toMatch(GARBAGE);

      // ...and the raw day keys stay raw: they are data, not display.
      const raw = axis.billed.find((p) => p.summary?.start === ts)!;
      expect(raw.startDate).toBe('NaN-NaN-NaN');
      expect(raw.endDate).toBe('NaN-NaN-NaN');
    },
  );
});

/* ====================================================== the money section */

describe('MoneySection with an undateable billed period', () => {
  it.each(HOSTILE_STARTS)(
    'renders no NaN/undefined text and still lists the bill for start %s',
    async (ts) => {
      const bill = hostileBill(ts);
      const summaries = [...healthy, bill];
      const { container } = render(
        <MoneySection summaries={summaries} allData={rows} plan="TOU" />,
      );

      await screen.findByTestId('money-stacked');
      await screen.findByTestId('money-waterfall');

      // AC1: no text node anywhere in the section reads NaN/undefined —
      // the axis rows (gap caption + open short label), the open-period
      // dates, and the waterfall's period picker.
      expectCleanText(container);

      // The bill is still THERE: listed in the waterfall's period picker
      // (the testid keeps the raw day key — structural, decision 1), given a
      // row on the chart, and carrying its own money.
      const picks = [...container.querySelectorAll('[data-testid^="money-waterfall-pick-"]')];
      expect(picks).toHaveLength(summaries.length);
      expect(picks.map((b) => b.getAttribute('data-testid'))).toContain(
        `money-waterfall-pick-${bill.startDate}`,
      );

      const chartRows = screen.getAllByTestId('money-row');
      expect(chartRows.length).toBeGreaterThanOrEqual(summaries.length);

      // Its amount, on screen, computed from the bill's own lines.
      expect(screen.getByTestId('money-waterfall-total')).toHaveTextContent(
        money(billTotals(bill).payable),
      );

      // ...and the axis column that names it reads with the marker.
      const headers = screen
        .getAllByRole('columnheader')
        .map((h) => h.textContent ?? '');
      expect(headers.some((h) => h.includes('date unavailable'))).toBe(true);
    },
  );
});

/* ======================================================= the open period */

describe('OpenPeriodPanel dates for an undateable billed period', () => {
  it.each(HOSTILE_STARTS)(
    'prints the marker at both date nodes for a last bill at %s',
    (ts) => {
      const bill = hostileBill(ts);
      const hostileAxis = buildBillingAxis({ summaries: [bill], rows });
      const hostileStacks = buildAxisStacks(hostileAxis, rows, 'TOU');

      // MoneySection's own picks: the newest billed stack, and the open tail.
      const lastBilled = [...hostileStacks].reverse().find((s) => s.kind === 'billed');
      expect(lastBilled).toBeDefined();

      // An undateable bill that sorts LAST has no open tail (its window is
      // past every reading), so the healthy axis's tail stands in — the panel
      // must render at all for the billed-through node to be exercised.
      const open =
        hostileStacks.find((s) => s.kind === 'open') ??
        buildAxisStacks(buildBillingAxis({ summaries: healthy, rows }), rows, 'TOU').find(
          (s) => s.kind === 'open',
        ) ??
        null;
      expect(open).not.toBeNull();

      render(
        <OpenPeriodPanel
          open={open}
          lastBilled={lastBilled ?? null}
          ledger={{ open: [], closed: [] }}
          axisNote={hostileAxis.note}
        />,
      );

      const panel = screen.getByTestId('open-period');
      expectCleanText(panel);
      expect(within(panel).getByTestId('billed-through-date')).toHaveTextContent(
        'date unavailable',
      );
      // The negative-direction shape sorts FIRST, so the open tail starts
      // where its undateable window ended — the second garbage site.
      if (hostileStacks.some((s) => s.kind === 'open')) {
        expect(within(panel).getByTestId('unbilled-since-date')).toHaveTextContent(
          'date unavailable',
        );
      }
      // The bill's money is intact behind the marker.
      expect(within(panel).getByTestId('billed-through-amount')).toHaveTextContent(/\$/);
    },
  );
});

/* ==================================================== the actual bill panel */

describe('ActualBillPanel with an undateable billed period', () => {
  it.each(HOSTILE_STARTS)(
    'renders no NaN/undefined text and the bill\'s amount for start %s',
    (ts) => {
      const bill = hostileBill(ts);
      const summaries = [...healthy, bill];
      const { container } = render(
        <ActualBillPanel summaries={summaries} allData={rows} plan="TOU" />,
      );

      expectCleanText(container);

      // Every period — the undateable one included — still states its money.
      const payables = screen.getAllByTestId('actual-payable');
      expect(payables).toHaveLength(summaries.length);
      payables.forEach((p) => expect(p).toHaveTextContent(/\$/));
      expect(
        payables.some((p) =>
          (p.textContent ?? '').includes(money(billTotals(bill).payable)),
        ),
      ).toBe(true);

      // Its picker button carries the marker, not `undefined NaN, NaN`.
      const picks = container.querySelectorAll('[data-testid^="actual-bill-pick-"]');
      expect(picks).toHaveLength(summaries.length);
      expect([...picks].some((b) => b.textContent === 'date unavailable')).toBe(true);
    },
  );
});

/* ============================================================ the marker */

describe('the unavailable-date marker', () => {
  it('is localized at both chokepoints, en and fr', () => {
    setLocale('en');
    expect(billPeriodLabel(1e15, 30 * DAY)).toBe('date unavailable');
    expect(dayKeyLabel('NaN-NaN-NaN')).toBe('date unavailable');

    setLocale('fr');
    expect(billPeriodLabel(1e15, 30 * DAY)).toBe('date indisponible');
    expect(dayKeyLabel('NaN-NaN-NaN')).toBe('date indisponible');
  });

  it('leaves every finite day key and label byte-identical', () => {
    setLocale('en');
    expect(dayKeyLabel('2026-08-20')).toBe('2026-08-20');
    expect(billPeriodLabel(healthy[2].start, healthy[2].duration)).toBe(
      'Jul 22, 2026 – Aug 20',
    );
    setLocale('fr');
    expect(dayKeyLabel('2026-08-20')).toBe('2026-08-20');
    expect(billPeriodLabel(healthy[2].start, healthy[2].duration)).toBe(
      '22 juil. 2026 – 20 août',
    );
  });
});
