import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MultiFileMerge, { type MergeFileChoice } from './MultiFileMerge';
import type { DataPoint, UsagePointGroup } from '@/lib/energy';
import { setLocale } from '@/i18n';

const at = (day: number, hour = 3) => Math.floor(new Date(2026, 9, day, hour).getTime() / 1000);

function range(from: number, to: number, kwh = 1): DataPoint[] {
  const out: DataPoint[] = [];
  for (let d = from; d <= to; d++) out.push({ timestamp: at(d), usage_kwh: kwh });
  return out;
}

function group(label: string, readings: DataPoint[], id = label): UsagePointGroup {
  return { id, label, readings, blocks: 1, series: [], notes: [] };
}

/** The component is controlled — this is the state it would sit in on screen. */
function Harness({
  initial,
  onConfirm = vi.fn() as (readings: DataPoint[]) => void,
  onCancel = vi.fn() as () => void,
}: {
  initial: MergeFileChoice[];
  onConfirm?: (readings: DataPoint[]) => void;
  onCancel?: () => void;
}) {
  const [files, setFiles] = useState(initial);
  return (
    <MultiFileMerge
      files={files}
      onFilesChange={setFiles}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function mergeFiles(...batches: DataPoint[][]): MergeFileChoice[] {
  return batches.map((readings, i) => ({
    name: `file${i + 1}.xml`,
    groups: [group('Meter A', readings)],
    chosen: 0,
  }));
}

describe('MultiFileMerge', () => {
  it('shows the merged range, row count and duplicate count before importing', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness initial={mergeFiles(range(1, 5), range(6, 10))} onConfirm={onConfirm} />);

    expect(screen.getByTestId('merge-review')).toBeInTheDocument();
    expect(screen.getByTestId('merge-file-0')).toHaveTextContent('file1.xml');
    expect(screen.getByTestId('merge-file-1')).toHaveTextContent('file2.xml');
    expect(screen.getByTestId('merge-range')).toHaveTextContent('2026-10-01 → 2026-10-10');
    expect(screen.getByTestId('merge-rows')).toHaveTextContent('10');
    expect(screen.getByTestId('merge-duplicates')).toHaveTextContent('0 of 10');
    expect(screen.getByTestId('merge-confirm')).toBeEnabled();

    await user.click(screen.getByTestId('merge-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toHaveLength(10);

    // Rows land in chronological order, not "file 1 then file 2".
    const merged = onConfirm.mock.calls[0][0] as DataPoint[];
    const stamps = merged.map((r) => r.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it('reports overlapping timestamps as dropped duplicates', () => {
    // file2 repeats file1's Oct 4 and Oct 5 timestamps.
    render(<Harness initial={mergeFiles(range(1, 5), range(4, 10))} />);

    expect(screen.getByTestId('merge-rows')).toHaveTextContent('10');
    expect(screen.getByTestId('merge-duplicates')).toHaveTextContent('2 of 12');
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('file2.xml: 5 kept, 2 duplicate');
  });

  it('refuses to import a multi-meter file until a meter is picked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const initial: MergeFileChoice[] = [
      {
        name: 'dual.xml',
        groups: [group('Meter A', range(1, 5)), group('Meter B', range(6, 8), 'mb')],
        chosen: null,
      },
    ];

    render(<Harness initial={initial} onConfirm={onConfirm} />);

    expect(screen.getByTestId('merge-awaiting-choice')).toBeInTheDocument();
    expect(screen.getByTestId('merge-confirm')).toBeDisabled();

    await user.click(screen.getByTestId('merge-meter-0-1'));
    expect(screen.queryByTestId('merge-awaiting-choice')).not.toBeInTheDocument();
    expect(screen.getByTestId('merge-confirm')).toBeEnabled();

    await user.click(screen.getByTestId('merge-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Meter B's three readings, not Meter A's five.
    expect(onConfirm.mock.calls[0][0]).toHaveLength(3);
  });

  it('imports every meter only when combine is chosen explicitly', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const initial: MergeFileChoice[] = [
      {
        name: 'dual.xml',
        groups: [group('Meter A', range(1, 5)), group('Meter B', range(6, 8), 'mb')],
        chosen: null,
      },
    ];

    render(<Harness initial={initial} onConfirm={onConfirm} />);

    expect(screen.getByTestId('merge-confirm')).toBeDisabled();
    await user.click(screen.getByTestId('merge-combine-0'));
    expect(screen.getByTestId('merge-confirm')).toBeEnabled();
    await user.click(screen.getByTestId('merge-confirm'));
    expect(onConfirm.mock.calls[0][0]).toHaveLength(8);
  });

  it('imports nothing when cancelled', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <Harness
        initial={mergeFiles(range(1, 5), range(6, 10))}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByTestId('merge-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/**
 * The meter rows' HEADINGS — the picker's second render site (t_203c6445).
 *
 * `lib/energy.ts` words the group label in English (`UsagePoint <id>`, or
 * `Meter` for a point the feed never identifies) and this dialog is the other
 * place it reaches the screen. The painted sweep over the picker itself lives
 * in `src/i18n/fr-runtime.test.tsx`; this pins the site those tests cannot
 * mount, in both locale paths.
 */
describe('the meter rows on the French page', () => {
  afterEach(() => setLocale('en'));

  const dualFile = (): MergeFileChoice[] => [
    {
      name: 'dual.xml',
      groups: [
        group('UsagePoint up-bravo', range(1, 5), 'up-bravo'),
        // The feed identifies no UsagePoint for this one — the parser's `Meter`.
        group('Meter', range(6, 8), ''),
      ],
      chosen: null,
    },
  ];

  it('names each meter in the reader’s language, not in the parser’s English', () => {
    setLocale('fr');
    render(<Harness initial={dualFile()} />);
    expect(screen.getByTestId('merge-meter-0-0')).toHaveTextContent('Point de consommation up-bravo');
    expect(screen.getByTestId('merge-meter-0-1')).toHaveTextContent('Compteur');
    expect(screen.getByTestId('merge-meter-0-1')).not.toHaveTextContent('Meter');
    // The id the row carries is the file's own data and stays canonical.
    expect(screen.getByTestId('merge-meter-0-0')).toHaveTextContent('up-bravo');
  });

  it('re-paints the headings when the locale flips', async () => {
    setLocale('en');
    render(<Harness initial={dualFile()} />);
    expect(screen.getByTestId('merge-meter-0-0')).toHaveTextContent('UsagePoint up-bravo');
    expect(screen.getByTestId('merge-meter-0-1')).toHaveTextContent('Meter');

    await act(async () => setLocale('fr'));
    expect(screen.getByTestId('merge-meter-0-0')).toHaveTextContent('Point de consommation up-bravo');
    expect(screen.getByTestId('merge-meter-0-1')).toHaveTextContent('Compteur');
  });
});

/**
 * The PER-FILE SUMMARY LINE — "file1.xml: 5 kept · file2.xml: 5 kept, 2
 * duplicate" (t_dd0263c0).
 *
 * It was one template literal inside JSX, so it was invisible to the i18n
 * coverage gate and shipped English on the French page. It now reads through
 * the catalog, in two keys because the line carries TWO counts: `_one`/`_other`
 * keys off exactly one `count`, so the `{rows} kept` agreement rides
 * `merge.fileKept` and the duplicate clause is its own key.
 *
 * The English wording is pinned byte for byte HERE — including the quirk the
 * catalog deliberately keeps: the clause reads "1 duplicate" AND "2 duplicate"
 * (the English pair is identical), so the en page does not change. The French
 * gets real agreement on BOTH counts.
 */
describe('the per-file summary line on the French page', () => {
  afterEach(() => setLocale('en'));

  // file1 keeps Oct 1–5; file2 repeats Oct 4–5 (2 duplicates) and keeps Oct 6–10.
  const overlapping = () => mergeFiles(range(1, 5), range(4, 10));
  // file1 keeps Oct 1; file2 repeats it and keeps Oct 2 — the singular counts.
  const singleRow = () => mergeFiles(range(1, 1), range(1, 2));

  it('keeps the English page byte for byte, quirk included', () => {
    render(<Harness initial={overlapping()} />);
    expect(screen.getByTestId('merge-summary')).toHaveTextContent(
      'file1.xml: 5 kept · file2.xml: 5 kept, 2 duplicate',
    );
    cleanup();
    render(<Harness initial={singleRow()} />);
    // "1 duplicate", not "1 duplicates" — the English pair is identical.
    expect(screen.getByTestId('merge-summary')).toHaveTextContent(
      'file1.xml: 1 kept · file2.xml: 1 kept, 1 duplicate',
    );
  });

  it('agrees on both counts in French', () => {
    setLocale('fr');
    render(<Harness initial={overlapping()} />);
    expect(screen.getByTestId('merge-summary')).toHaveTextContent(
      'file1.xml : 5 conservés · file2.xml : 5 conservés, 2 doublons',
    );
    cleanup();
    render(<Harness initial={singleRow()} />);
    expect(screen.getByTestId('merge-summary')).toHaveTextContent(
      'file1.xml : 1 conservé · file2.xml : 1 conservé, 1 doublon',
    );
  });

  it('re-paints the line when the locale flips', async () => {
    setLocale('en');
    render(<Harness initial={overlapping()} />);
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('2 duplicate');
    expect(screen.getByTestId('merge-summary')).not.toHaveTextContent('doublon');

    await act(async () => setLocale('fr'));
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('2 doublons');
    expect(screen.getByTestId('merge-summary')).not.toHaveTextContent('duplicate');
  });
});
