/**
 * "Some readings weren't included in priced consumption" (t_880370e6),
 * aggregated (t_8a9038d6).
 *
 * `feed.notes` is the ingestion's own list of what it refused to price: a
 * reactive (VArh) or apparent (VAh) series, another commodity, exported
 * energy, a register, a block whose ReadingType is not stated. Until this row
 * existed those reasons only reached the multi-UsagePoint picker — and a
 * single-UsagePoint file NEVER renders the picker, so the user was left
 * looking at a smaller kWh total with nothing on screen to explain it.
 *
 * Mark's gas upload printed the SAME volume sentence once per series — a wall
 * of 23 near-identical lines that buried anything else in the row. The fix is
 * aggregation WITHOUT concealment:
 *
 *   - notes that say the same thing about DIFFERENT series (the sentence's
 *     only difference is its {label} — the shape of Mark's 23 lines) print
 *     once as ONE line that states the count in words, via the catalog's
 *     aggregate sentence (`seriesNoteAggregateText`), with a ×N count;
 *   - identical RENDERED sentences print once with a ×N count (the sentence
 *     itself stays fully visible — nothing an error says is shortened);
 *   - every distinct sentence always prints on its own line;
 *   - a `<details>` disclosure lists every note individually, in feed order,
 *     so the raw record is one click away and never lost.
 *
 * Grouping is by `seriesNoteGroupKey` — the note's catalog sentence plus its
 * non-label params, or the rendered text (via `seriesNoteText`) when the
 * catalog cannot word that group as an "N series" line. Two notes with the
 * same code can word different things (a different uom or refusal status is a
 * different line), and two codes can word the same sentence — the reader sees
 * sentences.
 *
 * Presentation only: it prints each note through `seriesNoteText()` — the
 * same sentences the picker and the diagnostics panels show, in the reader's
 * own language — and hands the dismiss click back to the caller. Dismissing
 * clears this row; the readings and the notes themselves are not its business.
 */

"use client";

import { AlertTriangle, X } from 'lucide-react';
import type { SeriesNote } from '@/lib/greenbutton/series';
import { useTranslation } from '@/i18n';
import { seriesNoteAggregateText, seriesNoteGroupKey, seriesNoteText } from '@/i18n/seriesNote';

/** One line on the notice, with the notes that produced it, in feed order. */
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

export function SeriesNotesNotice({
  notes,
  onDismiss,
}: {
  /** The refusals to print, in the order the feed carried them. */
  notes: SeriesNote[];
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // Nothing refused ⇒ nothing to say (never an empty frame).
  if (notes.length === 0) return null;

  const groups = groupByKey(notes, (n) => seriesNoteGroupKey(n, t));
  const hasRepeats = groups.some((g) => g.notes.length > 1);

  return (
    <div
      role="status"
      data-testid="series-notes-notice"
      className="bg-warn-strip border-4 border-edge rounded-xl md:rounded-2xl px-4 md:px-6 py-3 md:py-4 flex flex-wrap items-start gap-3 md:gap-4 text-ink"
    >
      <AlertTriangle size={20} strokeWidth={4} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-[16rem] space-y-1">
        <div
          data-testid="series-notes-heading"
          className="text-[11px] md:text-sm font-black uppercase leading-snug"
        >
          {t('gbseries.notice.heading')}
        </div>
        {/* One <li> per GROUP: a refusal the feed repeated N times reads once,
            with its count — every distinct reason stays visible. A group that
            spans DIFFERENT series prints the catalog's "N series" sentence
            (nobody's label is dropped in silence); anything else prints the
            sentence the notes actually share. */}
        <ul
          data-testid="series-notes-list"
          className="list-disc pl-5 space-y-1 text-[10px] md:text-xs font-bold normal-case text-ink-2"
        >
          {groups.map((group, i) => {
            const count = group.notes.length;
            const aggregate = count > 1 ? seriesNoteAggregateText(group.notes[0], count, t) : null;
            const text = aggregate ?? seriesNoteText(group.notes[0], t);
            return (
              <li key={`${text}-${i}`} data-testid="series-note-detail">
                {text}
                {count > 1 && (
                  <span data-testid="series-note-count" className="ml-1 font-black text-ink">
                    {t('gbseries.notice.repeatCount', { count })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {/* The raw record, unaggregated: every note in feed order, one click
            away. Disclosure only — nothing is withheld from the reader. */}
        {hasRepeats && (
          <details data-testid="series-notes-details" className="text-[10px] md:text-xs normal-case">
            <summary className="font-black uppercase cursor-pointer min-h-11 inline-flex items-center">
              {t('gbseries.notice.showAll', { count: notes.length })}
            </summary>
            <ul
              data-testid="series-notes-all"
              className="list-disc pl-5 space-y-1 font-bold text-ink-2 mt-1"
            >
              {notes.map((note, i) => (
                <li key={`${note.code}-raw-${i}`} data-testid="series-note-raw">
                  {seriesNoteText(note, t)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <button
        type="button"
        data-testid="series-notes-dismiss"
        onClick={onDismiss}
        aria-label={t('gbseries.notice.dismiss')}
        className="ml-auto min-h-11 min-w-11 inline-flex items-center justify-center gap-2 px-3 md:px-4 py-2 bg-card text-ink border-4 border-edge rounded-lg md:rounded-xl font-black uppercase text-[10px] md:text-xs hover:bg-hover transition-colors"
      >
        <X size={16} strokeWidth={4} />
        {t('gbseries.notice.dismiss')}
      </button>
    </div>
  );
}

export default SeriesNotesNotice;
