/**
 * The picker's per-row note list (t_7aa2bd0c) — the same 23-series wall the
 * dashboard notice collapses, inside ONE UsagePoint row of the picker.
 *
 * `group.notes` is per-UsagePoint, so a multi-UsagePoint file whose single
 * point carries 23 volume series stacked 23 full sentences inside that row's
 * `<button>`. Two halves of the fix are pinned here:
 *
 *   1. the COLLAPSE: one line that states the count in words (EN and FR),
 *      with the ×N badge — reusing `seriesNoteGroupKey` /
 *      `seriesNoteAggregateText`, never a fork;
 *   2. the DISCLOSURE placement: every note still reachable verbatim, in
 *      feed order, and the `<details>` never nested inside the row button
 *      (invalid HTML — and its summary click must not choose the point).
 *
 * The 23 notes are the PARSER's, from the same fixture the notice tests use:
 * a hand-written note proves nothing about what the ingestion emits.
 *
 * Run: `npx vitest run src/components/UsagePointPicker.notes.test.tsx`
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsagePointPicker } from './UsagePointPicker';
import { UsagePointPicker as ClassicUsagePointPicker } from './classic/UsagePointPicker';
import { parseGreenButtonFeed } from '@/lib/energy';
import { setLocale } from '@/i18n';
import type { DataPoint, UsagePointGroup } from '@/lib/energy';
import type { SeriesNote } from '@/lib/greenbutton/series';

const WALL_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/volume-series-wall-fixture.xml',
);

const at = Math.floor(new Date(2026, 9, 1, 3).getTime() / 1000);

/**
 * Mark's real shape, straight from the parser: ONE UsagePoint carrying 23
 * volume series whose sentences differ only in `{label}` (23 distinct
 * rendered strings — exactly the shape grouping-by-text could not collapse).
 * The picker dialog exists for multi-point files, so a second, plain point
 * rides along; the wall still lands in ONE row.
 */
function wall(): { groups: UsagePointGroup[]; id: string; notes: SeriesNote[] } {
  const feed = parseGreenButtonFeed(fs.readFileSync(WALL_FIXTURE, 'utf8'));
  expect(feed.groups).toHaveLength(1);
  const wallGroup = feed.groups[0];
  expect(wallGroup.notes).toHaveLength(23);
  const plain: UsagePointGroup = {
    id: 'up-plain',
    label: 'UsagePoint up-plain',
    readings: [{ timestamp: at, usage_kwh: 1.5 }] as DataPoint[],
    blocks: 1,
    series: [],
    notes: [],
  };
  return { groups: [wallGroup, plain], id: wallGroup.id, notes: wallGroup.notes };
}

function renderPicker(onChoose = vi.fn()) {
  const { groups, id, notes } = wall();
  render(
    <UsagePointPicker
      fileName="volume-wall.xml"
      groups={groups}
      onChoose={onChoose}
      onCancel={vi.fn()}
    />,
  );
  return { id, notes, onChoose };
}

afterEach(() => setLocale('en'));

describe('UsagePointPicker — the 23-series wall inside one row', () => {
  it('collapses the wall to ONE line with the count in words and ×23 (EN)', () => {
    const { id, notes } = renderPicker();
    const block = screen.getByTestId(`usage-point-series-${id}`);

    const lines = within(block).getAllByTestId(`usage-point-series-note-${id}`);
    expect(lines).toHaveLength(1);
    // The count is stated IN WORDS on the line, not only in the badge…
    expect(lines[0].textContent).toContain('23 series were loaded as volume');
    // The reading count is per series and SAYS so (parent's security L1
    // wording — it must not read as 4 readings across all 23 series).
    expect(lines[0].textContent).toContain('each with 4 reading(s)');
    expect(within(block).getByTestId(`usage-point-series-count-${id}`).textContent).toBe('×23');
    // …and no series' label is quoted as if the line described only it.
    const firstLabel = String(notes[0].params?.label);
    expect(firstLabel).not.toBe('undefined');
    expect(lines[0].textContent).not.toContain(firstLabel);
  });

  it('keeps every note verbatim behind a disclosure, in feed order (EN)', () => {
    const { id, notes } = renderPicker();
    const block = screen.getByTestId(`usage-point-series-${id}`);

    expect(within(block).getByTestId(`usage-point-series-details-${id}`)).toBeInTheDocument();
    const raw = within(block).getAllByTestId(`usage-point-series-raw-${id}`);
    expect(raw).toHaveLength(23);
    // Verbatim and in order: the EN catalog composes back to `detail` byte
    // for byte (pinned in seriesNote.test.ts), so the record reads exactly
    // as the parser worded it.
    expect(raw.map((n) => n.textContent)).toEqual(notes.map((n) => n.detail));
    // All 23 are distinct sentences — nothing merged the record away.
    expect(new Set(raw.map((n) => n.textContent)).size).toBe(23);
  });

  it('places the disclosure OUTSIDE the row button, inside the same card', () => {
    const { id } = renderPicker();
    const block = screen.getByTestId(`usage-point-series-${id}`);
    const button = screen.getByTestId(`usage-point-${id}`);
    const card = screen.getByTestId(`usage-point-card-${id}`);

    // `<details>` cannot nest inside a `<button>` (invalid HTML), and its
    // summary click must not fire choose-point — the block is a sibling.
    expect(block.closest('button')).toBeNull();
    expect(button.querySelector('details')).toBeNull();
    // …but the row still reads as ONE unit: both live in the card.
    expect(card).toContainElement(button);
    expect(card).toContainElement(block);
  });

  it('summary click does not choose the point; the row button still does', async () => {
    const { id, onChoose } = renderPicker();
    const details = screen.getByTestId(`usage-point-series-details-${id}`);
    const summary = details.querySelector('summary');
    expect(summary).not.toBeNull();

    await userEvent.setup().click(summary as HTMLElement);
    expect(onChoose).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByTestId(`usage-point-${id}`));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it('paints that one line in French, with the raw record still in the file’s words', () => {
    setLocale('fr');
    const { id, notes } = renderPicker();
    const block = screen.getByTestId(`usage-point-series-${id}`);

    const lines = within(block).getAllByTestId(`usage-point-series-note-${id}`);
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('23 séries ont été chargées en volume');
    expect(lines[0].textContent).toContain('chacune de 4 lecture(s)');
    expect(within(block).getByTestId(`usage-point-series-count-${id}`).textContent).toBe('×23');

    // The raw record is the parser's own sentences — in FRENCH, never the
    // English `detail`, still one entry per series, in feed order, each
    // quoting its own label (nobody's line is dropped from the record).
    const raw = within(block).getAllByTestId(`usage-point-series-raw-${id}`);
    expect(raw).toHaveLength(23);
    expect(raw[0].textContent).toContain('chargée en volume');
    expect(raw[0].textContent).not.toBe(notes[0].detail);
    expect(raw.map((n) => n.textContent)).toEqual(
      notes.map((n) => expect.stringContaining(String(n.params?.label))),
    );
  });

  it('the classic twin collapses the same wall outside its row button', () => {
    const { groups, id, notes } = wall();
    render(
      <ClassicUsagePointPicker
        fileName="volume-wall.xml"
        groups={groups}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const block = screen.getByTestId(`usage-point-series-${id}`);
    expect(block.closest('button')).toBeNull();

    const lines = within(block).getAllByTestId(`usage-point-series-note-${id}`);
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('23 series were loaded as volume');
    expect(within(block).getAllByTestId(`usage-point-series-raw-${id}`)).toHaveLength(
      notes.length,
    );
  });

  it('prints distinct sentences on their own lines, with no disclosure', () => {
    const volume: SeriesNote = {
      code: 'volume-series',
      detail: 'Series A was loaded as volume: 1 reading(s) in m3 scaled by m.',
      params: { label: 'UP · MR1 · m3', count: 1, uom: 'm3', multiplier: 'm' },
    };
    const refused: SeriesNote = {
      code: 'unsupported-series',
      seriesKey: 'out|k',
      detail: 'Series up-1 · mr-1 · VArh (uom 73) was NOT loaded as consumption.',
    };
    const groups: UsagePointGroup[] = [
      {
        id: 'up-mixed',
        label: 'UsagePoint up-mixed',
        readings: [{ timestamp: at, usage_kwh: 1.5 }] as DataPoint[],
        blocks: 1,
        series: [],
        notes: [volume, refused],
      },
    ];
    render(
      <UsagePointPicker
        fileName="feed.xml"
        groups={groups}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const block = screen.getByTestId('usage-point-series-up-mixed');
    const lines = within(block).getAllByTestId('usage-point-series-note-up-mixed');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('1 reading(s)');
    expect(lines[1].textContent).toBe(refused.detail);
    // Nothing repeated ⇒ no count badge, no disclosure — no invented merge.
    expect(within(block).queryByTestId('usage-point-series-count-up-mixed')).toBeNull();
    expect(within(block).queryByTestId('usage-point-series-details-up-mixed')).toBeNull();
  });
});
