import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MultiFileMerge, { type MergeFileChoice } from './MultiFileMerge';
import type { DataPoint, UsagePointGroup } from '@/lib/energy';

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
