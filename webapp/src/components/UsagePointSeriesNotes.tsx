/**
 * The note list inside one UsagePoint row of the picker (t_7aa2bd0c).
 *
 * WHY IT IS A COMPONENT, AND WHY IT SITS OUTSIDE THE ROW BUTTON
 * `group.notes` is per-UsagePoint: a multi-UsagePoint file whose ONE point
 * carries 23 volume series used to print 23 full sentences inside that row —
 * the same wall `SeriesNotesNotice` collapses on the dashboard. The honest
 * treatment needs a `<details>` raw record, and `<details>`/`<summary>` cannot
 * nest inside the row's `<button>` (invalid HTML, and clicking the summary
 * would fire the row's choose-point action). So the row is restructured: the
 * button keeps the label/total/meta, this list renders as its SIBLING inside
 * the same card, and the card stays one visual unit (the border/background/
 * hover chrome moved onto the card that wraps both).
 *
 * WHAT IT RENDERS — the same contract as `SeriesNotesNotice`, no fork of the
 * grouping logic:
 *   - notes grouped by `seriesNoteGroupKey` (the catalog sentence plus its
 *     non-label params, or the rendered text when the catalog cannot word the
 *     group for N series): ONE line per group, `seriesNoteAggregateText` for a
 *     group of N > 1 stating the count in words, plus a ×N count — a wall of
 *     23 distinct-label sentences reads as one line that says 23;
 *   - every distinct sentence still prints on its own line, verbatim;
 *   - when anything repeated, a `<details>` lists EVERY note verbatim in feed
 *     order — the raw record is one click away and never lost.
 *
 * Presentation only: ingestion is untouched, and each note reaches the screen
 * through `seriesNoteText()` — the same sentences the rest of the picker
 * prints, in the reader's own language. Shared by both picker twins
 * (`components/UsagePointPicker.tsx` and `components/classic/…`), whose notes
 * markup is identical.
 */

"use client";

import type { SeriesNote } from '@/lib/greenbutton/series';
import { useTranslation } from '@/i18n';
import { seriesNoteAggregateText, seriesNoteGroupKey, seriesNoteText } from '@/i18n/seriesNote';

/** One line on the list, with the notes that produced it, in feed order. */
type NoteGroup = { notes: SeriesNote[] };

function groupByKey(notes: readonly SeriesNote[], keyOf: (n: SeriesNote) => string): NoteGroup[] {
  const groups: NoteGroup[] = [];
  const byKey = new Map<string, NoteGroup>();
  for (const note of notes) {
    const key = keyOf(note);
    let group = byKey.get(key);
    if (!group) {
      group = { notes: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.notes.push(note);
  }
  return groups;
}

/**
 * The row's notes: one line per GROUP (aggregated honestly when the feed
 * repeated one sentence across series), then the raw record behind a
 * disclosure whenever anything collapsed. Returns nothing for a row whose
 * notes are empty — a picker row without refusals stays quiet.
 */
export function UsagePointSeriesNotes({
  id,
  notes,
}: {
  /** The UsagePoint's id (or 'unidentified') — scopes this row's testids. */
  id: string;
  /** The refusals for this point, in the order the feed carried them. */
  notes: readonly SeriesNote[];
}) {
  const { t } = useTranslation();
  if (notes.length === 0) return null;

  const groups = groupByKey(notes, (n) => seriesNoteGroupKey(n, t));
  const hasRepeats = groups.some((g) => g.notes.length > 1);

  return (
    <>
      {/* One <li> per GROUP: a refusal the feed repeated N times reads once,
          with its count — every distinct reason stays visible. A group that
          spans DIFFERENT series prints the catalog's "N series" sentence
          (nobody's label is dropped in silence); anything else prints the
          sentence the notes actually share. */}
      <ul className="space-y-1">
        <li className="font-black uppercase">{t('gbseries.reasons')}</li>
        {groups.map((group, i) => {
          const count = group.notes.length;
          const aggregate = count > 1 ? seriesNoteAggregateText(group.notes[0], count, t) : null;
          const text = aggregate ?? seriesNoteText(group.notes[0], t);
          return (
            <li key={`${text}-${i}`} data-testid={`usage-point-series-note-${id}`}>
              {text}
              {count > 1 && (
                <span data-testid={`usage-point-series-count-${id}`} className="ml-1 font-black">
                  {t('gbseries.notice.repeatCount', { count })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {/* The raw record, unaggregated: every note in feed order, one click
          away. Disclosure only — nothing is withheld from the reader, and it
          lives OUTSIDE the row button (see this file's header). */}
      {hasRepeats && (
        <details data-testid={`usage-point-series-details-${id}`}>
          <summary className="font-black uppercase cursor-pointer min-h-11 inline-flex items-center">
            {t('gbseries.notice.showAll', { count: notes.length })}
          </summary>
          <ul
            data-testid={`usage-point-series-all-${id}`}
            className="space-y-1"
          >
            {notes.map((note, i) => (
              <li key={`${note.code}-raw-${i}`} data-testid={`usage-point-series-raw-${id}`}>
                {seriesNoteText(note, t)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export default UsagePointSeriesNotes;
