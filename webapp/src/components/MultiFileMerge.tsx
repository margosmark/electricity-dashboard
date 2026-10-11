/**
 * Multi-export merge review — the step between "the user picked 2+ XML files"
 * and "the readings are imported".
 *
 * Nothing is merged silently: every file is listed with what it carries, any
 * file that holds more than one UsagePoint makes the user pick a meter (or
 * explicitly combine), and the summary states the merged date range, the row
 * count and how many duplicate timestamps were dropped before the confirm
 * button will act.
 */

"use client";

import { useMemo } from 'react';
import { Files, Combine, CheckCircle2, X } from 'lucide-react';
import {
  combineUsagePointGroups,
  mergeReadings,
  type DataPoint,
} from '@/lib/energy';
import type { MergeFileChoice } from '@/hooks/useDashboard';
import { useTranslation } from '@/i18n';

export type { MergeFileChoice };

function readingsFor(file: MergeFileChoice): DataPoint[] {
  if (file.groups.length === 0 || file.chosen === null) return [];
  if (file.chosen === 'combine') return combineUsagePointGroups(file.groups);
  return file.groups[file.chosen]?.readings ?? [];
}

export default function MultiFileMerge({
  files,
  onFilesChange,
  onConfirm,
  onCancel,
}: {
  files: MergeFileChoice[];
  onFilesChange: (next: MergeFileChoice[]) => void;
  onConfirm: (readings: DataPoint[]) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const merged = useMemo(
    () => mergeReadings(files.map((f) => ({ name: f.name, readings: readingsFor(f) }))),
    [files],
  );

  const setChoice = (index: number, chosen: number | 'combine') => {
    onFilesChange(files.map((f, i) => (i === index ? { ...f, chosen } : f)));
  };

  const awaitingMeterChoice = files.some((f) => f.groups.length > 1 && f.chosen === null);
  const canConfirm = merged.mergedRows > 0 && !awaitingMeterChoice;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('merge.reviewAria')}
      data-testid="merge-dialog"
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-[300] flex justify-center overflow-y-auto overlay-safe"
    >
      <div
        data-testid="merge-review"
        className="my-auto bg-white p-5 md:p-10 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] md:shadow-[20px_20px_0px_0px_rgba(0,0,0,1)] max-w-2xl w-full text-black max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-xl md:text-4xl uppercase tracking-tighter mb-1 md:mb-2 flex items-center gap-2 md:gap-3 font-black">
          <Files size={22} className="md:w-10 md:h-10" strokeWidth={4} /> {t('merge.title', { count: files.length })}
        </h2>
        <p className="text-[10px] md:text-sm font-bold text-slate-600 mb-4 md:mb-6">
          {t('merge.rowsMatched')}
        </p>

        <div className="space-y-3 md:space-y-4">
          {files.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              data-testid={`merge-file-${i}`}
              className="border-2 md:border-4 border-black rounded-xl md:rounded-2xl p-3 md:p-4 bg-slate-50"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-black uppercase text-xs md:text-base break-all">
                  {file.name}
                </span>
                <span className="text-[9px] md:text-[11px] font-black text-slate-600">
                  {readingsFor(file).length} {t('merge.readings', { count: readingsFor(file).length })}
                  {file.groups.length > 1 ? t('merge.metersSuffix', { count: file.groups.length }) : ''}
                </span>
              </div>

              {file.groups.length === 0 && (
                <div className="text-[9px] md:text-[11px] font-black text-red-600 mt-1">
                  {t('merge.noReadings')}
                </div>
              )}

              {file.groups.length > 1 && (
                <div className="mt-2 space-y-1">
                  <div className="text-[9px] md:text-[11px] font-black uppercase flex items-center gap-1">
                    <Combine size={11} strokeWidth={4} /> {t('merge.multiMeter')}
                  </div>
                  {file.groups.map((g, j) => (
                    <label
                      key={g.id || j}
                      data-testid={`merge-meter-${i}-${j}`}
                      className="min-h-11 flex items-center gap-2 text-sm md:text-xs font-bold border-2 border-black rounded-lg px-2 py-1.5 bg-white cursor-pointer"
                    >
                      <input
                        type="radio"
                        name={`merge-file-${i}`}
                        checked={file.chosen === j}
                        onChange={() => setChoice(i, j)}
                      />
                      {g.label} · {g.readings.length} {t('merge.readings', { count: g.readings.length })}
                    </label>
                  ))}
                  <label
                    data-testid={`merge-combine-${i}`}
                    className="min-h-11 flex items-center gap-2 text-sm md:text-xs font-bold border-2 border-black rounded-lg px-2 py-1.5 bg-white cursor-pointer"
                  >
                    <input
                      type="radio"
                      name={`merge-file-${i}`}
                      checked={file.chosen === 'combine'}
                      onChange={() => setChoice(i, 'combine')}
                    />
                    {t('merge.combineAll')}
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>

        <div
          data-testid="merge-summary"
          className="mt-4 md:mt-6 bg-yellow-400 border-4 border-black rounded-xl md:rounded-2xl p-3 md:p-5"
        >
          <div className="flex flex-wrap gap-4 md:gap-8">
            <div>
              <div className="text-[8px] md:text-[10px] font-black uppercase">{t('merge.mergedRange')}</div>
              <div data-testid="merge-range" className="text-base md:text-xl italic font-black">
                {merged.firstDate || '—'} → {merged.lastDate || '—'}
              </div>
            </div>
            <div>
              <div className="text-[8px] md:text-[10px] font-black uppercase">{t('merge.rowsToImport')}</div>
              <div data-testid="merge-rows" className="text-base md:text-xl italic font-black">
                {merged.mergedRows.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[8px] md:text-[10px] font-black uppercase">{t('merge.duplicatesDropped')}</div>
              <div data-testid="merge-duplicates" className="text-base md:text-xl italic font-black">
                {merged.duplicateRows.toLocaleString()} {t('merge.of')} {merged.totalRows.toLocaleString()}
              </div>
            </div>
          </div>
          <div className="text-[9px] md:text-[11px] font-bold mt-2">
            {merged.files
              .map((f) => `${f.name}: ${f.rows} kept${f.duplicates ? `, ${f.duplicates} duplicate` : ''}`)
              .join(' · ')}
          </div>
          {awaitingMeterChoice && (
            <div data-testid="merge-awaiting-choice" className="text-[9px] md:text-[11px] font-black text-red-700 mt-1">
              {t('merge.pickMeter')}
            </div>
          )}
        </div>

        <div className="mt-4 md:mt-6 flex flex-col sm:flex-row gap-3">
          <button
            data-testid="merge-confirm"
            onClick={() => onConfirm(merged.readings)}
            disabled={!canConfirm}
            className="flex-1 py-3 md:py-4 bg-black text-white border-4 border-black rounded-xl md:rounded-2xl font-black uppercase text-xs md:text-sm flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-600 transition-colors"
          >
            <CheckCircle2 size={16} strokeWidth={4} /> {t('merge.importBtn')} {merged.mergedRows.toLocaleString()} {t('merge.rows', { count: merged.mergedRows })}
          </button>
          <button
            data-testid="merge-cancel"
            onClick={onCancel}
            className="py-3 md:py-4 bg-white text-black border-4 border-black rounded-xl md:rounded-2xl font-black uppercase text-xs md:text-sm flex items-center justify-center gap-2 hover:bg-slate-100"
          >
            <X size={16} strokeWidth={4} /> {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
