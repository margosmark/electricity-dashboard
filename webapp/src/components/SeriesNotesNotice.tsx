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
 *   - identical RENDERED sentences print once with a ×N count (the sentence
 *     itself stays fully visible — nothing an error says is shortened);
 *   - every distinct sentence always prints on its own line;
 *   - a `<details>` disclosure lists every note individually, in feed order,
 *     so the raw record is one click away and never lost.
 *
 * Grouping is by the RENDERED text (via `seriesNoteText`), not by `code` or
 * `seriesKey`: two notes with the same code can word different things, and
 * two codes can word the same sentence — the reader sees sentences.
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
import { seriesNoteText } from '@/i18n/seriesNote';

/** One rendered sentence with the notes that produced it, in feed order. */
type NoteGroup = { text: string; notes: SeriesNote[] };

function groupByText(notes: readonly SeriesNote[], text: (n: SeriesNote) => string): NoteGroup[] {
  const groups: NoteGroup[] = [];
  const byText = new Map<string, NoteGroup>();
  for (const note of notes) {
    const rendered = text(note);
    let group = byText.get(rendered);
    if (!group) {
      group = { text: rendered, notes: [] };
      byText.set(rendered, group);
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

  const groups = groupByText(notes, (n) => seriesNoteText(n, t));
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
        {/* One <li> per DISTINCT sentence: a refusal the feed repeated N times
            reads once, with its count — every distinct reason stays visible. */}
        <ul
          data-testid="series-notes-list"
          className="list-disc pl-5 space-y-1 text-[10px] md:text-xs font-bold normal-case text-ink-2"
        >
          {groups.map((group, i) => (
            <li key={`${group.text}-${i}`} data-testid="series-note-detail">
              {group.text}
              {group.notes.length > 1 && (
                <span
                  data-testid="series-note-count"
                  className="ml-1 font-black text-ink"
                >
                  {t('gbseries.notice.repeatCount', { count: group.notes.length })}
                </span>
              )}
            </li>
          ))}
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
