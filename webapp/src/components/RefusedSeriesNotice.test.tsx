/**
 * Refused series reach the dashboard — t_880370e6.
 *
 * The picker prints why a point's series were left out of priced consumption,
 * but a SINGLE-UsagePoint file never renders the picker: the user saw a
 * smaller kWh total with nothing on screen to explain it. These tests drive
 * the real upload path (a file into the modal) and pin the notice the ruling
 * asked for: the parser's own `feed.notes`, verbatim, dismissible, and only
 * when there is something to say.
 *
 * The fixtures are built inline. The reactive case is the evidenced one: a
 * VArh (uom 73) series beside a Wh consumption series on one UsagePoint, which
 * is what the real Oakville export carries.
 *
 * Run: `npx vitest run src/components/RefusedSeriesNotice.test.tsx`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dashboard from './Dashboard';
import { parseGreenButtonFeed } from '@/lib/energy';
import { loadEnergyData } from '@/lib/storage';

const mockRates = {
  historicalRates: [
    {
      effectiveDate: '2023-01-01',
      tou: { offPeak: 9.8, midPeak: 15.7, onPeak: 20.3 },
      tiered: { tier1: 12.0, tier2: 14.2, thresholdWinter: 1000, thresholdSummer: 600 },
      ulo: { overnight: 3.9, weekendOffPeak: 9.8, midPeak: 15.7, onPeak: 39.1 },
    },
  ],
};

/** The evidenced refusal, byte for byte as `SeriesNote.detail` words it. */
const VARH_DETAIL =
  'Series up-B · mr-B2 · VArh (uom 73) was NOT loaded as consumption: it measures apparent or reactive energy or power, or a unit that is not an amount of energy at all. Its readings are preserved here and none of them was priced.';

/** One hour after the first: two points must not share a timestamp. */
const T = 1790000000;

/* ==========================================================================
 * Inline ESPI document builder (same shape series.test.ts uses)
 * ========================================================================== */

type RtSpec = { uom: number; mult?: number; commodity?: number; fd?: number };

function entry(self: string, body: string, related: string[] = []): string {
  return `<entry><link rel="self" href="${self}"/>${related
    .map((href) => `<link rel="related" href="${href}"/>`)
    .join('')}<content>${body}</content></entry>`;
}

function readingType(spec: RtSpec): string {
  const el = (n: string, v: number) => `<espi:${n}>${v}</espi:${n}>`;
  return `<espi:ReadingType>${el('uom', spec.uom)}${el('powerOfTenMultiplier', spec.mult ?? 0)}${el(
    'accumulationBehaviour',
    4,
  )}${el('commodity', spec.commodity ?? 1)}${el('flowDirection', spec.fd ?? 1)}${el('kind', 12)}${el(
    'intervalLength',
    3600,
  )}</espi:ReadingType>`;
}

function block(start: number, value: number): string {
  return `<espi:IntervalBlock><espi:interval><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:interval><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>${start}</espi:start></espi:timePeriod><espi:value>${value}</espi:value></espi:IntervalReading></espi:IntervalBlock>`;
}

/** ReadingType + MeterReading + its IntervalBlock. */
function pointPart(up: string, mr: string, rtId: string, spec: RtSpec, value: number, start: number): string[] {
  return [
    entry(`/ReadingType/${rtId}`, readingType(spec)),
    entry(`/UsagePoint/${up}/MeterReading/${mr}`, '<espi:MeterReading/>', [`/ReadingType/${rtId}`]),
    entry(`/UsagePoint/${up}/MeterReading/${mr}/IntervalBlock/ib`, block(start, value)),
  ];
}

function doc(parts: string[][]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">${parts
    .flat()
    .join('')}</feed>`;
}

/** One UsagePoint (up-B): 1.5 kWh of Wh consumption + 4000 VArh. */
const VARH_AND_CONSUMPTION = doc([
  pointPart('up-B', 'mr-B1', 'rt-cons', { uom: 72 }, 1500, T),
  pointPart('up-B', 'mr-B2', 'rt-varh', { uom: 73, mult: 3 }, 4000, T),
]);

/** The same point plus a gas series — two refusals, one feed. */
const TWO_REFUSALS = doc([
  pointPart('up-B', 'mr-B1', 'rt-cons', { uom: 72 }, 1500, T),
  pointPart('up-B', 'mr-B2', 'rt-varh', { uom: 73, mult: 3 }, 4000, T),
  pointPart('up-B', 'mr-B3', 'rt-gas', { uom: 72, commodity: 7 }, 1000, T),
]);

/** Nothing refused: one declared ReadingType, forward, in Wh. */
const CLEAN = doc([pointPart('up-B', 'mr-B1', 'rt-cons', { uom: 72 }, 1500, T)]);

/** Two UsagePoints — the file the existing picker exists for. */
const TWO_POINTS = doc([
  pointPart('up-B', 'mr-B1', 'rt-cons', { uom: 72 }, 1500, T),
  pointPart('up-B', 'mr-B2', 'rt-varh', { uom: 73, mult: 3 }, 4000, T),
  pointPart('up-C', 'mr-C1', 'rt-cons-c', { uom: 72 }, 2000, T + 3600),
]);

/* ==========================================================================
 * Harness
 * ========================================================================== */

function storedRows() {
  const res = loadEnergyData();
  return res.ok && res.value ? res.value.points : [];
}

async function upload(fileName: string, contents: string) {
  const input = document.querySelector('input[type="file"][accept=".xml"]') as HTMLInputElement;
  await userEvent.setup().upload(input, new File([contents], fileName, { type: 'text/xml' }));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve(mockRates) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function renderEmptyDashboard() {
  render(<Dashboard />);
  await waitFor(() => expect(screen.queryByText(/preparing optimizer/i)).not.toBeInTheDocument());
}

/** The dashboard notice's per-refusal rows, in DOM order. */
const noticeDetails = () => screen.getAllByTestId('series-note-detail').map((n) => n.textContent ?? '');

/* ==========================================================================
 * Tests
 * ========================================================================== */

describe('refused series after a single-UsagePoint import', () => {
  it('says which series were left out of priced consumption', async () => {
    // The fixture is the evidenced shape: ONE UsagePoint, so the picker that
    // used to carry these sentences does not render at all.
    const parsed = parseGreenButtonFeed(VARH_AND_CONSUMPTION);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.notes.map((n) => n.detail)).toEqual([VARH_DETAIL]);

    await renderEmptyDashboard();
    expect(screen.queryByTestId('series-notes-notice')).toBeNull();

    await upload('oakville-varh.xml', VARH_AND_CONSUMPTION);

    await screen.findByTestId('series-notes-notice');
    expect(screen.queryByTestId('usage-point-picker')).toBeNull();
    expect(screen.getByTestId('series-notes-heading').textContent).toBe(
      'Some readings weren’t included in priced consumption',
    );
    // The notice is the PARSER's sentence, not a second copy of the wording.
    expect(noticeDetails()).toEqual([VARH_DETAIL]);

    // …and the readings that WERE priceable are the ones that landed.
    await waitFor(() => expect(storedRows()).toHaveLength(1));
    expect(storedRows()[0].usage_kwh).toBeCloseTo(1.5, 6);
  });

  it('prints every refusal when the feed left out more than one series', async () => {
    const expected = parseGreenButtonFeed(TWO_REFUSALS).notes.map((n) => n.detail);
    expect(expected).toHaveLength(2);

    await renderEmptyDashboard();
    await upload('varh-and-gas.xml', TWO_REFUSALS);

    await screen.findByTestId('series-notes-notice');
    expect(noticeDetails()).toEqual(expected);
    expect(noticeDetails()[0]).toBe(VARH_DETAIL);
  });

  it('shows no notice when nothing was refused', async () => {
    expect(parseGreenButtonFeed(CLEAN).notes).toEqual([]);

    await renderEmptyDashboard();
    await upload('clean.xml', CLEAN);

    await waitFor(() => expect(storedRows()).toHaveLength(1));
    expect(screen.queryByTestId('series-notes-notice')).toBeNull();
  });

  it('clears a previous file’s notice when a clean file replaces it', async () => {
    await renderEmptyDashboard();
    await upload('oakville-varh.xml', VARH_AND_CONSUMPTION);
    await screen.findByTestId('series-notes-notice');

    // The modal closed on the successful import; open it again for file two.
    await userEvent.setup().click(screen.getByTitle('Upload XML'));
    await upload('clean.xml', CLEAN);

    await waitFor(() => expect(screen.queryByTestId('series-notes-notice')).toBeNull());
    // The clean file imported: its rows are on screen and the row is gone.
    await waitFor(() => expect(storedRows()).toHaveLength(1));
    expect(storedRows()[0].usage_kwh).toBeCloseTo(1.5, 6);
  });
});

describe('dismissing the refusal notice', () => {
  it('hides the notice and leaves the readings and the notes alone', async () => {
    await renderEmptyDashboard();
    await upload('oakville-varh.xml', VARH_AND_CONSUMPTION);
    await screen.findByTestId('series-notes-notice');

    const storedBefore = localStorage.getItem('energy_data_v2');
    expect(storedBefore).not.toBeNull();

    const dismiss = screen.getByTestId('series-notes-dismiss');
    expect(dismiss).toHaveAccessibleName('Dismiss');
    await userEvent.setup().click(dismiss);

    await waitFor(() => expect(screen.queryByTestId('series-notes-notice')).toBeNull());
    // Not one byte of the imported readings moved.
    expect(localStorage.getItem('energy_data_v2')).toBe(storedBefore);
    expect(storedRows().map((r) => r.usage_kwh)).toEqual([1.5]);
    // The refusal itself is still the parser's: dismissing consumed nothing,
    // so the same file says the same thing the next time it is imported.
    expect(parseGreenButtonFeed(VARH_AND_CONSUMPTION).notes.map((n) => n.detail)).toEqual([
      VARH_DETAIL,
    ]);

    await userEvent.setup().click(screen.getByTitle('Upload XML'));
    await upload('oakville-varh.xml', VARH_AND_CONSUMPTION);
    await screen.findByTestId('series-notes-notice');
    expect(noticeDetails()).toEqual([VARH_DETAIL]);
  });
});

describe('the multi-UsagePoint picker', () => {
  it('keeps its own refusal details, and the notice lands once a point is chosen', async () => {
    const parsed = parseGreenButtonFeed(TWO_POINTS);
    expect(parsed.groups).toHaveLength(2);

    await renderEmptyDashboard();
    await upload('two-points.xml', TWO_POINTS);

    await screen.findByTestId('usage-point-picker');
    // Nothing is imported yet, so no notice — and the picker's own block still
    // carries the reason, unchanged by this card.
    expect(screen.queryByTestId('series-notes-notice')).toBeNull();
    const seriesBlock = screen.getByTestId('usage-point-series-up-B');
    expect(seriesBlock.textContent).toContain('Why some of this point was left out:');
    expect(seriesBlock.textContent).toContain(VARH_DETAIL);

    await userEvent.setup().click(screen.getByTestId('usage-point-up-B'));

    await screen.findByTestId('series-notes-notice');
    expect(screen.queryByTestId('usage-point-picker')).toBeNull();
    expect(noticeDetails()).toEqual([VARH_DETAIL]);
    await waitFor(() => expect(storedRows()).toHaveLength(1));
  });
});
