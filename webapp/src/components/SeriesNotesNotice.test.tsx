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

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeriesNotesNotice } from './SeriesNotesNotice';
import type { SeriesNote } from '@/lib/greenbutton/series';

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
});
