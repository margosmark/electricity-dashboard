/**
 * CSV export of the processed per-interval table.
 *
 * The heavy lifting (column list, serialization, filename) lives in
 * lib/energy.ts so it is testable without a DOM; this file only wires it to a
 * button and a blob download.
 */

"use client";

/* Wave U — user-visible copy translates; lib/hook code reads the module locale. */
import { useTranslation } from "@/i18n";
import { Download } from 'lucide-react';
import { type ProcessedPoint, processedDataToCSV, csvFilenameForRows } from '@/lib/energy';
import { downloadTextFile } from '@/lib/download';

export const CSV_MIME = 'text/csv;charset=utf-8';

/**
 * Serialize `rows` and trigger a browser download.
 * Returns the filename used, so callers/tests can assert on it.
 */
export function downloadCSV(rows: ProcessedPoint[]): string {
  return downloadTextFile(csvFilenameForRows(rows), processedDataToCSV(rows), CSV_MIME);
}

type Props = {
  rows: ProcessedPoint[];
  className?: string;
  /** Wave H item 6: a printed document does not offer a download button. */
  printHidden?: boolean;
};

export function ExportCsvButton({ rows, className = '', printHidden = false }: Props) {
  const { t } = useTranslation();
  const disabled = rows.length === 0;
  return (
    <button
      type="button"
      data-testid="export-csv"
      aria-label={t("csv.exportAria")}
      title={t("csv.exportTitle")}
      disabled={disabled}
      onClick={() => downloadCSV(rows)}
      className={
        (printHidden ? 'no-print ' : '') +
        'min-h-11 flex items-center gap-1 md:gap-2 px-3 md:px-5 py-2 md:py-3 rounded-lg md:rounded-xl ' +
        'border-2 md:border-4 border-edge bg-card text-ink font-black uppercase ' +
        'text-[8px] md:text-[10px] whitespace-nowrap ' +
        'shadow-hard-2 md:shadow-hard-4 ' +
        'hover:bg-accent hover:text-accent-ink active:translate-y-0.5 active:shadow-none transition-all ' +
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-card ' +
        className
      }
    >
      <Download size={14} strokeWidth={4} />
      {t('csv.exportAria')}
    </button>
  );
}

export default ExportCsvButton;
