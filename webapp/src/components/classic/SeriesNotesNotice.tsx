/**
 * "Some readings weren't included in priced consumption" (t_880370e6).
 *
 * `feed.notes` is the ingestion's own list of what it refused to price: a
 * reactive (VArh) or apparent (VAh) series, another commodity, exported
 * energy, a register, a block whose ReadingType is not stated. Until this row
 * existed those reasons only reached the multi-UsagePoint picker — and a
 * single-UsagePoint file NEVER renders the picker, so the user was left
 * looking at a smaller kWh total with nothing on screen to explain it.
 *
 * Presentation only, and deliberately dumb: it prints each note through
 * `seriesNoteText()` — the same sentences the picker and the diagnostics panels
 * show, in the reader's own language — and hands the dismiss click back to the
 * caller. Dismissing clears this row; the readings and the notes themselves are
 * not its business.
 */

"use client";

import { AlertTriangle, X } from 'lucide-react';
import type { SeriesNote } from '@/lib/greenbutton/series';
import { useTranslation } from '@/i18n';
import { seriesNoteText } from '@/i18n/seriesNote';

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
        {/* One <li> per refusal: a single refused series and several print the
            same way, and each detail is the parser's own sentence. */}
        <ul
          data-testid="series-notes-list"
          className="list-disc pl-5 space-y-1 text-[10px] md:text-xs font-bold normal-case text-ink-2"
        >
          {notes.map((note, i) => (
            <li key={`${note.code}-${i}`} data-testid="series-note-detail">
              {seriesNoteText(note, t)}
            </li>
          ))}
        </ul>
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
