/**
 * Wave R — the routine heatmap, split into weekday and weekend.
 *
 * One 7×24 grid forces five weekday rows and two weekend rows onto a single
 * colour scale, and the weekend rows' completely different shape (no 07–17
 * trough, no 19:00 charger) sets that scale. The weekday pattern the split
 * exists for — an EV that only charges Monday–Friday at 19:00 — then reads as
 * the same mid-blue as everything else.
 *
 * Two condensed grids fix the reading without touching the numbers: each is
 * a subset of the ORIGINAL cells (see `splitHeatmap`), and both keep the
 * source `maxAvg`, so a colour means the same kWh in either grid and the two
 * can still be compared by eye.
 *
 * Semantics are unchanged from the single grid: `role="grid"` with rows,
 * columnheaders, rowheaders and gridcells, and every cell carries its value
 * in its accessible name — a hover tooltip is a convenience, not the only
 * copy of the number.
 */

'use client';

import { type HeatmapData } from '@/lib/energy';
import { heatColor, splitHeatmap, type HeatmapGroup } from '@/lib/heatmapSplit';
import { fmtKwh, useTranslation } from '@/i18n';

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function HeatGrid({ group, maxAvg }: { group: HeatmapGroup; maxAvg: number }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-2 mb-2 md:mb-3">
        <h4 className="text-sm md:text-lg font-black uppercase text-black">{group.label}</h4>
        <span className="text-[8px] md:text-[10px] font-black uppercase text-slate-500">
          {t('heatmap.gridMeta', { total: group.dayLabels.length, inView: group.days })}
        </span>
      </div>
      <div className="overflow-x-auto pb-1">
        <div
          role="grid"
          aria-label={t('heatmap.gridAria', { group: group.label.toLowerCase() })}
          data-testid={`heatmap-grid-${group.id}`}
          className="min-w-[520px] text-black"
        >
          <div
            role="row"
            className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-1 text-black font-black uppercase"
          >
            <div role="presentation" className="w-10 md:w-12" />
            {HOURS.map((hour) => (
              <div
                key={hour}
                role="columnheader"
                className="text-center text-[8px] md:text-[10px] text-black font-black"
              >
                {hour}{t('heatmap.hourSuffix')}
              </div>
            ))}
          </div>
          {group.rows.map((row, rowIndex) => (
            <div
              key={group.dayLabels[rowIndex]}
              role="row"
              className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-1 mb-1 text-black font-black uppercase"
            >
              <div
                role="rowheader"
                className="w-10 md:w-12 text-[10px] md:text-xs flex items-center font-black uppercase"
              >
                {group.dayLabels[rowIndex]}
              </div>
              {row.map((cell, hour) => {
                const label = t('heatmap.cellLabel', {
                  day: group.dayLabels[rowIndex],
                  hour: `${String(hour).padStart(2, '0')}:00`,
                  // Two decimals: the a11y name IS the number a sighted user
                  // reads from the hover chip (Wave R's no-hover-only rule).
                  kwh: fmtKwh(cell.avg, 2),
                  count: cell.days,
                  days: cell.days,
                });
                return (
                  <div
                    key={hour}
                    role="gridcell"
                    aria-label={label}
                    title={label}
                    data-testid={`heat-cell-${group.id}-${group.dayLabels[rowIndex]}-${hour}`}
                    className={`heatmap-cell h-7 md:h-10 rounded-sm md:rounded-md border-b-2 md:border-b-4 ${heatColor(
                      cell.avg,
                      maxAvg,
                    )} hover:scale-110 active:scale-110 relative group transition-all font-black`}
                  >
                    <div className="opacity-0 group-hover:opacity-100 group-active:opacity-100 absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-black text-white text-[8px] md:text-[10px] p-2 rounded pointer-events-none z-50 whitespace-nowrap font-black">
                      {fmtKwh(cell.avg)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export type DualHeatmapProps = {
  heatmapData: HeatmapData;
};

export default function DualHeatmap({ heatmapData }: DualHeatmapProps) {
  const { t } = useTranslation();
  const split = splitHeatmap(heatmapData);

  return (
    <div
      data-testid="dual-heatmap"
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black overflow-hidden"
    >
      <h3 className="text-2xl md:text-4xl mb-2 italic text-black font-black uppercase">
        {t('heatmap.title')}
      </h3>
      <p className="mb-4 md:mb-6 text-[10px] md:text-xs font-bold text-slate-600 normal-case max-w-3xl">
        {t('heatmap.blurb', { max: fmtKwh(split.maxAvg) })}
      </p>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 md:gap-8">
        <HeatGrid group={split.weekday} maxAvg={split.maxAvg} />
        <HeatGrid group={split.weekend} maxAvg={split.maxAvg} />
      </div>
      <div className="mt-4 text-[8px] md:text-[10px] text-slate-400 font-black text-center xl:hidden">
        {t('heatmap.scrollHint')}
      </div>
    </div>
  );
}
