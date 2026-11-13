/**
 * The refusal notice — t_880370e6.
 *
 * `feed.notes` used to reach the user only in the multi-UsagePoint picker, so
 * a single-UsagePoint file (which never renders the picker) showed a smaller
 * kWh total with nothing to explain it. This row prints the ingestion's own
 * refusals verbatim on the dashboard, for one refusal and for several.
 *
 * Run: `npx vitest run src/components/SeriesNotesNotice.test.tsx`
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeriesNotesNotice } from './SeriesNotesNotice';
import { parseGreenButtonFeed } from '@/lib/energy';
import { setLocale } from '@/i18n';
import type { SeriesNote } from '@/lib/greenbutton/series';

/** Every id here is invented for the fixture; the SHAPE is what it reproduces. */
const WALL_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/volume-series-wall-fixture.xml',
);

/**
 * Mark's real shape: ONE UsagePoint, 23 volume series, and a sentence whose
 * only difference from its neighbour is `{label}` (`seriesLabel` renders
 * `upId · meterId · unit`, so no two match). Parser-built, never hand-made:
 * a hand-written note proves nothing about what the ingestion emits.
 */
function volumeWall(): SeriesNote[] {
  return parseGreenButtonFeed(fs.readFileSync(WALL_FIXTURE, 'utf8')).notes;
}

afterEach(() => setLocale('en'));

/** The evidenced VArh refusal, byte for byte as the parser words it. */
const VARH_DETAIL =
  'Series up-B · mr-B2 · VArh (uom 73) was NOT loaded as consumption: it measures apparent or reactive energy or power, or a unit that is not an amount of energy at all. Its readings are preserved here and none of them was priced.';

const VARH: SeriesNote = { code: 'unsupported-series', seriesKey: 'up-B|mr-B2|rt-varh', detail: VARH_DETAIL };

const GAS: SeriesNote = {
  code: 'unsupported-series',
  seriesKey: 'up-B|mr-B3|rt-gas',
  detail:
    'Series up-B · mr-B3 · Wh (uom 72) was NOT loaded as consumption: it measures a non-electricity commodity (gas, water, steam, refuse …), so it must never be priced with electricity rates. Its readings are preserved here and none of them was priced.',
};

/** A document-wide refusal: it belongs to no series, so no picker row shows it. */
const AMBIGUOUS: SeriesNote = {
  code: 'ambiguous-inline-reading-types',
  detail:
    'An entry carried 2 inline ReadingTypes with no per-block link. Their readings were kept apart by ReadingType instead of merged, and none was converted, because which block belongs to which type is not stated.',
};

describe('SeriesNotesNotice', () => {
  it('renders nothing when nothing was refused', () => {
    const { container } = render(<SeriesNotesNotice notes={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('series-notes-notice')).toBeNull();
    expect(screen.queryByText(/priced consumption/i)).toBeNull();
  });

  it('prints the frozen heading and the refusal verbatim', () => {
    render(<SeriesNotesNotice notes={[VARH]} onDismiss={vi.fn()} />);

    expect(screen.getByTestId('series-notes-heading').textContent).toBe(
      'Some readings weren’t included in priced consumption',
    );
    const details = screen.getAllByTestId('series-note-detail');
    expect(details).toHaveLength(1);
    // Verbatim: not a summary, not a rewritten sentence.
    expect(details[0].textContent).toBe(VARH_DETAIL);
  });

  it('prints every refusal, in order, when the feed carried several', () => {
    render(<SeriesNotesNotice notes={[VARH, GAS, AMBIGUOUS]} onDismiss={vi.fn()} />);

    expect(screen.getAllByTestId('series-note-detail').map((n) => n.textContent)).toEqual([
      VARH.detail,
      GAS.detail,
      AMBIGUOUS.detail,
    ]);
    // The list is one list, not three stacked banners.
    expect(screen.getAllByTestId('series-notes-notice')).toHaveLength(1);
  });

  it('labels the dismiss control "Dismiss" and reports the click', async () => {
    const onDismiss = vi.fn();
    render(<SeriesNotesNotice notes={[VARH]} onDismiss={onDismiss} />);

    const button = screen.getByTestId('series-notes-dismiss');
    expect(button).toHaveAccessibleName('Dismiss');
    expect(button.textContent).toBe('Dismiss');

    await userEvent.setup().click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /* Aggregation (t_8a9038d6): Mark's gas upload printed the same volume
     sentence once per series — a wall of 23 lines that buried everything
     else. Repeats collapse to ONE line with a count; nothing is hidden. */
  it('prints an identical sentence once with ×N, and lists every note behind a disclosure', () => {
    const VOLUME = 'This series is natural gas volume (m³) and was not priced as electricity.';
    const repeated: SeriesNote = { code: 'volume-series', detail: VOLUME };
    render(
      <SeriesNotesNotice
        notes={[repeated, { ...repeated }, { ...repeated }, VARH]}
        onDismiss={vi.fn()}
      />,
    );

    // Two distinct sentences → two lines, the repeated one counted.
    const lines = screen.getAllByTestId('series-note-detail');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain(VOLUME);
    expect(lines[0].textContent).toContain('×3');
    expect(screen.getByTestId('series-note-count').textContent).toBe('×3');
    // The distinct refusal still prints verbatim on its own line.
    expect(lines[1].textContent).toBe(VARH_DETAIL);

    // The raw record is one click away — every note, in feed order.
    const raw = screen.getAllByTestId('series-note-raw');
    expect(raw).toHaveLength(4);
    expect(raw.map((n) => n.textContent)).toEqual([
      VOLUME, VOLUME, VOLUME, VARH_DETAIL,
    ]);
    expect(screen.getByTestId('series-notes-details')).toBeInTheDocument();
  });

  it('shows no disclosure when nothing repeated (one line per distinct note)', () => {
    render(<SeriesNotesNotice notes={[VARH, GAS, AMBIGUOUS]} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('series-notes-details')).toBeNull();
    expect(screen.queryByTestId('series-note-count')).toBeNull();
    expect(screen.getAllByTestId('series-note-detail')).toHaveLength(3);
  });

  /* The shape t_8a9038d6's aggregation MISSED (t_1d93a874): 23 notes, one
     code, one uom/multiplier/count, 23 DISTINCT labels — grouping by the
     rendered sentence gave 23 groups of 1 and the wall survived the fix. */
  it('collapses 23 distinct-label volume notes to ONE line with ×23, and keeps all 23 raw', () => {
    const wall = volumeWall();
    // The fixture reproduces the shape, or this test proves nothing:
    expect(wall).toHaveLength(23);
    expect(new Set(wall.map((n) => n.code))).toEqual(new Set(['volume-series']));
    expect(new Set(wall.map((n) => n.params?.label)).size).toBe(23);
    expect(
      new Set(wall.map((n) => `${n.params?.count}|${n.params?.uom}|${n.params?.multiplier}`)).size,
    ).toBe(1);
    // …and the rendered sentences really are 23 different strings (the old
    // grouping key), which is exactly why they used to print as a wall.
    expect(new Set(wall.map((n) => n.detail)).size).toBe(23);

    render(<SeriesNotesNotice notes={wall} onDismiss={vi.fn()} />);

    const lines = screen.getAllByTestId('series-note-detail');
    expect(lines).toHaveLength(1);
    // The count is stated IN WORDS on the line, not only in the badge…
    expect(lines[0].textContent).toContain('23 series were loaded as volume');
    expect(lines[0].textContent).toContain('4 reading(s)');
    expect(screen.getByTestId('series-note-count').textContent).toBe('×23');
    // …and no series' label is quoted as if the line described only it.
    expect(lines[0].textContent).not.toContain('READ0001');

    // Disclosure: EVERY note, in feed order, each with its own label.
    expect(screen.getByTestId('series-notes-details')).toBeInTheDocument();
    const raw = screen.getAllByTestId('series-note-raw');
    expect(raw).toHaveLength(23);
    expect(raw.map((n) => n.textContent)).toEqual(wall.map((n) => n.detail));
    expect(new Set(raw.map((n) => n.textContent)).size).toBe(23);
  });

  it('paints that one line in French, with the raw record still in the file’s words', () => {
    setLocale('fr');
    const wall = volumeWall();

    render(<SeriesNotesNotice notes={wall} onDismiss={vi.fn()} />);

    const lines = screen.getAllByTestId('series-note-detail');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('23 séries ont été chargées en volume');
    expect(lines[0].textContent).toContain('4 lecture(s)');
    expect(screen.getByTestId('series-note-count').textContent).toBe('×23');

    // The raw record is the parser's own sentences — in FRENCH, never the
    // English `detail`, and still one entry per series, in feed order, each
    // quoting its own label (nobody's line is dropped from the record).
    const raw = screen.getAllByTestId('series-note-raw');
    expect(raw).toHaveLength(23);
    expect(raw[0].textContent).toContain('chargée en volume');
    expect(raw[0].textContent).not.toBe(wall[0].detail);
    expect(raw.map((n) => n.textContent)).toEqual(
      wall.map((n) => expect.stringContaining(String(n.params?.label))),
    );
  });

  it('keeps series that differ in DATA on their own lines — only the label collapses', () => {
    const one: SeriesNote = {
      code: 'volume-series',
      detail: 'Series A was loaded as volume: 1 reading(s) in m3 scaled by m.',
      params: { label: 'UP · MR1 · m3', count: 1, uom: 'm3', multiplier: 'm' },
    };
    const many: SeriesNote = {
      code: 'volume-series',
      detail: 'Series B was loaded as volume: 9 reading(s) in m3 scaled by m.',
      params: { label: 'UP · MR2 · m3', count: 9, uom: 'm3', multiplier: 'm' },
    };

    render(<SeriesNotesNotice notes={[one, many]} onDismiss={vi.fn()} />);

    const lines = screen.getAllByTestId('series-note-detail');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('1 reading(s)');
    expect(lines[1].textContent).toContain('9 reading(s)');
    // Nothing repeated ⇒ no count badge, no disclosure — no invented merge.
    expect(screen.queryByTestId('series-note-count')).toBeNull();
    expect(screen.queryByTestId('series-notes-details')).toBeNull();
  });
});
