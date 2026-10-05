/**
 * CSV export of the processed per-interval table.
 *
 * The heavy lifting (column list, serialization, filename) lives in
 * lib/energy.ts so it is testable without a DOM; this file only wires it to a
 * button and a blob download.
 */

"use client";

import { Download } from 'lucide-react';
import { type ProcessedPoint, processedDataToCSV, csvFilenameForRows } from '@/lib/energy';

export const CSV_MIME = 'text/csv;charset=utf-8';

/**
 * Serialize `rows` and trigger a browser download.
 * Returns the filename used, so callers/tests can assert on it.
 */
export function downloadCSV(rows: ProcessedPoint[]): string {
  const filename = csvFilenameForRows(rows);
  const blob = new Blob([processedDataToCSV(rows)], { type: CSV_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return filename;
}

type Props = {
  rows: ProcessedPoint[];
  className?: string;
  /** Wave H item 6: a printed document does not offer a download button. */
  printHidden?: boolean;
};

export function ExportCsvButton({ rows, className = '', printHidden = false }: Props) {
  const disabled = rows.length === 0;
  return (
    <button
      type="button"
      data-testid="export-csv"
      aria-label="Export CSV"
      title="Download the selected interval table as CSV"
      disabled={disabled}
      onClick={() => downloadCSV(rows)}
      className={
        (printHidden ? 'no-print ' : '') +
        'min-h-11 flex items-center gap-1 md:gap-2 px-3 md:px-5 py-2 md:py-3 rounded-lg md:rounded-xl ' +
        'border-2 md:border-4 border-black bg-white text-black font-black uppercase ' +
        'text-[8px] md:text-[10px] whitespace-nowrap ' +
        'shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] ' +
        'hover:bg-yellow-400 active:translate-y-0.5 active:shadow-none transition-all ' +
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white ' +
        className
      }
    >
      <Download size={14} strokeWidth={4} />
      Export CSV
    </button>
  );
}

export default ExportCsvButton;
