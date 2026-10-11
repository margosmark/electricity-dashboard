/**
 * Picker shown when a Green Button file contains more than one UsagePoint
 * (multiple meters / rate classes). Loading one silently-merged stream was
 * the old behavior; now the user chooses which point — or asks for all of
 * them to be combined.
 */

"use client";

import { format } from 'date-fns';
import { Combine, Gauge, X } from 'lucide-react';
import { type UsagePointGroup, type DataPoint, combineUsagePointGroups } from '@/lib/energy';
import { fmtKwh, useTranslation } from '@/i18n';

export function usagePointStats(group: UsagePointGroup): {
  kwh: number;
  count: number;
  from: string;
  to: string;
} {
  const readings = group.readings;
  if (readings.length === 0) return { kwh: 0, count: 0, from: '—', to: '—' };
  const kwh = readings.reduce((sum, r) => sum + r.usage_kwh, 0);
  const first = new Date(readings[0].timestamp * 1000);
  const last = new Date(readings[readings.length - 1].timestamp * 1000);
  return {
    kwh,
    count: readings.length,
    from: format(first, 'yyyy-MM-dd'),
    to: format(last, 'yyyy-MM-dd'),
  };
}

type Props = {
  fileName: string;
  groups: UsagePointGroup[];
  /** Load exactly one point's rows, or every row when the user combines. */
  onChoose: (readings: DataPoint[]) => void;
  onCancel: () => void;
};

export function UsagePointPicker({ fileName, groups, onChoose, onCancel }: Props) {
  const { t } = useTranslation();
  const combined = combineUsagePointGroups(groups);

  return (
    <div
      className="fixed inset-0 bg-inv/80 backdrop-blur-md z-[350] flex justify-center overflow-y-auto overlay-safe"
      role="dialog"
      aria-modal="true"
      aria-label={t('picker.aria')}
      data-testid="usage-point-picker"
    >
      <div className="my-auto bg-card p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-edge shadow-hard-10 md:shadow-hard-20 max-w-2xl w-full text-ink font-black uppercase max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 mb-4 md:mb-6">
          <h2 className="text-2xl md:text-4xl tracking-tighter flex items-center gap-2 md:gap-3">
            <Gauge size={24} strokeWidth={4} /> {t('picker.title', { count: groups.length })}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('common.close')}
            className="min-h-11 min-w-11 inline-flex items-center justify-center p-2 border-2 md:border-4 border-edge rounded-xl hover:bg-red-500 hover:text-white active:bg-red-600 transition-all"
          >
            <X size={18} strokeWidth={4} />
          </button>
        </div>

        <p className="text-[10px] md:text-sm text-ink-2 mb-4 md:mb-8 break-all normal-case">
          <span className="font-black uppercase">{fileName}</span> {t('picker.blurb')}
        </p>

        <div className="space-y-3 md:space-y-4">
          {groups.map((group) => {
            const stats = usagePointStats(group);
            return (
              <button
                key={group.id || 'unidentified'}
                type="button"
                data-testid={`usage-point-${group.id || 'unidentified'}`}
                onClick={() => onChoose(group.readings)}
                className="w-full text-left bg-inset p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-edge shadow-hard-4 hover:bg-yellow-400 hover:translate-y-0.5 active:shadow-none transition-all"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base md:text-2xl">{group.label}</span>
                  <span className="text-xl md:text-3xl italic">{fmtKwh(stats.kwh)}</span>
                </div>
                <div className="mt-1 md:mt-2 text-[8px] md:text-[10px] text-ink-3 flex flex-wrap gap-x-4 gap-y-1 normal-case">
                  <span>{group.id || t('picker.noId')}</span>
                  <span>{t('picker.readings', { count: stats.count })}</span>
                  <span>
                    {stats.from} → {stats.to}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-5 md:mt-8 flex flex-col md:flex-row gap-3 md:gap-4">
          <button
            type="button"
            data-testid="usage-point-combine"
            onClick={() => onChoose(combined)}
            className="min-h-11 flex-1 flex items-center justify-center gap-2 py-3 md:py-4 bg-inv text-inv-ink rounded-xl md:rounded-2xl border-2 md:border-4 border-edge font-black uppercase text-[10px] md:text-xs hover:bg-blue-600 active:bg-blue-700 transition-colors"
          >
            <Combine size={16} strokeWidth={4} /> {t('picker.combine', { count: groups.length, readings: combined.length })}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 py-3 md:py-4 px-6 bg-hover rounded-xl md:rounded-2xl border-2 md:border-4 border-edge font-black uppercase text-[10px] md:text-xs hover:bg-track active:bg-track transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default UsagePointPicker;
