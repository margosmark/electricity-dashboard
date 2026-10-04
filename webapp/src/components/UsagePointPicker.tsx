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
  const combined = combineUsagePointGroups(groups);

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-[350] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Choose usage point"
      data-testid="usage-point-picker"
    >
      <div className="bg-white p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] border-4 md:border-8 border-black shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] md:shadow-[20px_20px_0px_0px_rgba(0,0,0,1)] max-w-2xl w-full text-black font-black uppercase max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 mb-4 md:mb-6">
          <h2 className="text-2xl md:text-4xl tracking-tighter flex items-center gap-2 md:gap-3">
            <Gauge size={24} strokeWidth={4} /> {groups.length} Usage Points Found
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="p-2 border-2 md:border-4 border-black rounded-xl hover:bg-red-500 hover:text-white transition-all"
          >
            <X size={18} strokeWidth={4} />
          </button>
        </div>

        <p className="text-[10px] md:text-sm text-slate-600 mb-4 md:mb-8 break-all normal-case">
          <span className="font-black uppercase">{fileName}</span> holds data for more than one meter. Pick the
          usage point to load — nothing has been imported yet.
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
                className="w-full text-left bg-slate-50 p-4 md:p-6 rounded-xl md:rounded-2xl border-2 md:border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-400 hover:translate-y-0.5 active:shadow-none transition-all"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base md:text-2xl">{group.label}</span>
                  <span className="text-xl md:text-3xl italic">{stats.kwh.toFixed(1)} kWh</span>
                </div>
                <div className="mt-1 md:mt-2 text-[8px] md:text-[10px] text-slate-500 flex flex-wrap gap-x-4 gap-y-1 normal-case">
                  <span>{group.id || 'no UsagePoint id in feed'}</span>
                  <span>{stats.count} readings</span>
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
            className="flex-1 flex items-center justify-center gap-2 py-3 md:py-4 bg-black text-white rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black uppercase text-[10px] md:text-xs hover:bg-blue-600 transition-colors"
          >
            <Combine size={16} strokeWidth={4} /> Combine all {groups.length} points ({combined.length} readings)
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="py-3 md:py-4 px-6 bg-slate-100 rounded-xl md:rounded-2xl border-2 md:border-4 border-black font-black uppercase text-[10px] md:text-xs hover:bg-slate-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default UsagePointPicker;
