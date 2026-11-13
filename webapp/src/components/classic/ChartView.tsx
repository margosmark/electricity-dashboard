/**
 * USAGE tab — zoom navigation, the bar chart, the rate-season bands.
 *
 * Markup only — every piece of state lives in src/hooks/useDashboard.ts and is
 * handed in as props by Dashboard, so extracting this file is a pure render
 * split (styling and data-testids unchanged).
 *
 * Wave R moved the rest of its old contents OUT: the projection banner went
 * to Overview (decision-first), the plan cards / true-bill / actual-bill /
 * Wave P tables went to Plans & Track Record, and the "best choice" banner
 * became Overview's first element. What is left is the chart and the two
 * things that explain how to read it — which season the bars fall in, and
 * what the window cost.
 */

"use client";

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { type ChartDataItem, type ProcessedPoint } from '@/lib/energy';
import { type ZoomLevel } from '@/hooks/useDashboard';
import { fmtMoney, useTranslation } from '@/i18n';
import { ExportCsvButton } from '@/components/classic/ExportCsvButton';
import { chartSegments } from '@/lib/season';
import type { PlanId } from '@/lib/planIds';

export type { PlanId };
export type Comparison = { TOU: number; Tiered: number; ULO: number };

export type ChartViewProps = {
  zoomLevel: ZoomLevel;
  zoomTarget: string | null;
  goBack: () => void;
  navigatePeriod: (dir: 'prev' | 'next') => void;
  setZoomLevelAndClear: (l: ZoomLevel) => void;
  activeChartData: ChartDataItem[];
  handleBarClick: (item: { key?: string } | null) => void;
  selectionCost: number;
  userPlan: PlanId;
  /** Window start — the season anchor for hourly bars (their key is a clock time). */
  startDate: string;
  /** Current window rows: the CSV export downloads these. */
  filteredData: ProcessedPoint[];
};

/**
 * Wave H item 4 — the skeleton that covers Recharts' empty first frame.
 *
 * The bars animate in over ~500 ms (Wave B evidence), so for half a second
 * after data ARRIVES the chart area is a blank white box — exactly what a
 * first-time user reads as "broken". The shimmer shows instead, keyed on the
 * 0 -> N rows transition (upload, sample button, restore) so it never flashes
 * on a zoom or a tab switch, where the bars are already on screen.
 */
const CHART_ANIMATION_MS = 520;

function ChartSkeleton({ bars }: { bars?: number }) {
  const { t } = useTranslation();
  const columns = Math.min(Math.max(bars ?? 12, 6), 16);
  return (
    <div
      data-testid="chart-skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={t('chart.drawingAria')}
      className="absolute inset-0 z-20 bg-card px-4 md:px-8 pt-4 pb-6 flex flex-col"
    >
      <div className="text-[8px] md:text-[10px] font-black uppercase text-ink-4 mb-3">
        {t('chart.drawing', { count: bars ?? 0, bars: bars ?? 0 })}
      </div>
      <div className="flex-1 flex items-end gap-[2px] md:gap-2 border-b-4 border-edge min-h-0">
        {Array.from({ length: columns }).map((_, i) => (
          <div
            key={i}
            className="skeleton-bar flex-1 border-2 border-edge/10 rounded-t-sm"
            style={{ height: `${28 + ((i * 37) % 62)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Wave I item 4 — Recharts only ships when there is something to draw.
 *
 * `next/dynamic` pulls the chart panel (and with it the ~651 KB vendor chunk:
 * recharts, date-fns, fast-xml-parser) onto its own request, and the render
 * below is gated on there being at least one bar — so a first visit, whose
 * chart area is the "no readings in this window" panel, never downloads or
 * parses it. Lighthouse measured 74.7% of that chunk as unused on exactly that
 * visit; under mobile throttling every byte on the critical path is simulated
 * main-thread time. The Wave H shimmer covers the fetch just as it covers
 * Recharts' own grow-in.
 */
const BarChartPanel = dynamic(() => import('@/components/BarChartPanel'), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

export default function ChartView({
  zoomLevel, zoomTarget, goBack, navigatePeriod, setZoomLevelAndClear,
  activeChartData, handleBarClick, selectionCost,
  userPlan, startDate,
  filteredData,
}: ChartViewProps) {
  const { t } = useTranslation();
  const [skeleton, setSkeleton] = useState(false);
  const rowCountRef = useRef(activeChartData.length);

  useEffect(() => {
    const previous = rowCountRef.current;
    rowCountRef.current = activeChartData.length;
    // Only a cold 0 -> N transition (data just landed) earns a skeleton.
    if (previous === 0 && activeChartData.length > 0) {
      setSkeleton(true);
      const timer = setTimeout(() => setSkeleton(false), CHART_ANIMATION_MS);
      return () => clearTimeout(timer);
    }
    setSkeleton(false);
  }, [activeChartData]);
  /**
   * Rate-season bands (Wave G item 6): Ontario flips its rate windows on
   * May 1 / Nov 1, and a window that straddles a boundary would otherwise
   * render as one undifferentiated row of bars.
   */
  const segments = chartSegments(zoomLevel, activeChartData, zoomTarget ?? startDate);
  // ReferenceArea anchors on axis LABELS; they must be unique or a band would
  // span the wrong bars, so shading degrades to the chips below when they are not.
  const labelsUnique = new Set(activeChartData.map((d) => d.label)).size === activeChartData.length;

  return (
    <div className="space-y-6 md:space-y-10" data-testid="chart-view">
      {/* Main Graph. The three testids are the geometry gate's handles
          (toolbar-layout.spec.ts measures the header row at 1440/1383/1280/
          1152/1024 — the row's overflow and the cost block's right edge). */}
      <div data-testid="chart-card" className="bg-card p-4 md:p-8 rounded-[1.5rem] md:rounded-[3rem] shadow-hard-8 md:shadow-hard-16 border-4 border-edge overflow-hidden relative z-10 text-ink font-black uppercase">
        <div data-testid="chart-header-row" className="flex flex-col lg:flex-row justify-between items-center mb-6 md:mb-12 gap-4 md:gap-6 text-ink font-black">
          {/* `min-w-0` is what gives the h2's `truncate` a shrink floor: without
              it the group keeps its full intrinsic width at every viewport, the
              trailing cost block absorbs the whole flex deficit and the card's
              `overflow-hidden` hard-cuts the number (38px @1440 → 358px @1024,
              no ellipsis, no scrollbar). The title yields instead — it already
              truncates. */}
          <div data-testid="chart-title-group" className="min-w-0 flex items-center gap-3 md:gap-6 w-full lg:w-auto justify-between lg:justify-start">
            {zoomLevel !== 'monthly' && <button type="button" aria-label={t('chart.backAria')} onClick={goBack} className="no-print min-h-11 min-w-11 inline-flex items-center justify-center p-2 md:p-4 bg-card border-2 md:border-4 border-edge rounded-xl md:rounded-2xl shadow-hard-2 md:shadow-hard-4 hover:bg-inv hover:text-inv-ink active:bg-inv active:text-inv-ink transition-all"><ArrowLeft size={20} className="md:w-8 md:h-8" strokeWidth={4} /></button>}
            <div className="flex items-center gap-2 md:gap-4">
              <button type="button" aria-label={t('chart.prevAria')} onClick={() => navigatePeriod('prev')} className="no-print min-h-11 min-w-11 inline-flex items-center justify-center p-1 md:p-2 border-2 md:border-4 border-edge rounded-lg md:rounded-xl hover:bg-yellow-400 hover:text-accent-ink active:bg-yellow-400 active:text-accent-ink shadow-hard-2 md:shadow-hard-4 active:translate-y-1 active:shadow-none"><ChevronLeft size={16} className="md:w-6 md:h-6" strokeWidth={4} /></button>
              <h2 className="min-w-0 flex-1 text-xl sm:text-3xl md:text-6xl tracking-tighter italic truncate">{zoomTarget || (zoomLevel === 'monthly' ? t('chart.monthlyOverview') : t(`chart.zoom.${zoomLevel}`))}</h2>
              <button type="button" aria-label={t('chart.nextAria')} onClick={() => navigatePeriod('next')} className="no-print min-h-11 min-w-11 inline-flex items-center justify-center p-1 md:p-2 border-2 md:border-4 border-edge rounded-lg md:rounded-xl hover:bg-yellow-400 hover:text-accent-ink active:bg-yellow-400 active:text-accent-ink shadow-hard-2 md:shadow-hard-4 active:translate-y-1 active:shadow-none"><ChevronRight size={16} className="md:w-6 md:h-6" strokeWidth={4} /></button>
            </div>
          </div>
          <div className="no-print flex bg-hover p-1 rounded-lg md:rounded-xl border-2 md:border-4 border-edge text-ink" role="group" aria-label={t('chart.zoomAria')}>
             {(['monthly', 'weekly', 'daily'] as const).map((l) => <button key={l} type="button" aria-pressed={zoomLevel === l && !zoomTarget} onClick={() => setZoomLevelAndClear(l)} className={`inline-flex min-h-11 items-center px-3 md:px-6 py-1 md:py-2 rounded-md md:rounded-lg text-[11px] md:text-xs font-black transition-all ${zoomLevel === l && !zoomTarget ? 'bg-inv text-inv-ink' : 'text-ink-2'}`}>{t(`chart.zoom.${l}`)}</button>)}
          </div>
          {/* `shrink-0`: the number is the one thing on this row that must never
              clip, so the deficit has to come out of the title group above. */}
          <div data-testid="chart-cost-block" className="shrink-0 text-center lg:text-right text-ink font-black">
             <div className="text-[8px] md:text-[10px]">{t('chart.selectionCost', { plan: userPlan })}</div>
              <div className="text-2xl md:text-5xl italic mt-1 md:mt-2 font-black">{fmtMoney(selectionCost)}</div>
          </div>
        </div>

        <div className="relative h-[300px] md:h-[500px] -ml-4 md:-ml-6" data-testid="chart-area">
          {activeChartData.length === 0 ? (
            /* Nothing in this window yet: say so, instead of drawing an
               empty axis frame that reads as a rendering failure. */
            <div
              data-testid="chart-empty-window"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6"
            >
              <div className="text-lg md:text-2xl font-black uppercase text-ink">
                {t('chart.emptyTitle')}
              </div>
              <div className="text-[10px] md:text-xs font-bold text-ink-3 normal-case max-w-sm">
                {t('chart.emptyBody')}
              </div>
            </div>
          ) : (
            <>
          <BarChartPanel
            data={activeChartData}
            zoomLevel={zoomLevel}
            segments={segments}
            labelsUnique={labelsUnique}
            onBarClick={handleBarClick}
          />
              {/* Wave H item 4: shimmer over Recharts' ~500 ms grow-in. */}
              {skeleton && <ChartSkeleton bars={activeChartData.length} />}
            </>
          )}
        </div>

        <div className="mt-4 md:mt-6 flex flex-wrap items-center justify-between gap-3">
          {/* Which rate window(s) the visible bars fall in — the band above
              shades them, this says what the shading means. */}
          <div className="flex flex-wrap gap-2 md:gap-3" data-testid="season-band">
            {segments.map((s, i) => (
              <span
                key={`chip-${s.season}-${i}`}
                data-testid="season-chip"
                className={`px-2 md:px-3 py-1 rounded-full border-2 border-edge text-[8px] md:text-[10px] font-black ${s.season === 'winter' ? 'bg-info-soft text-info' : 'bg-warn-soft text-warn'}`}
              >
                {s.season === 'winter' ? '❄' : '☀'} {t(`season.${s.season}`)} · {t(`season.range.${s.season}`)}
                {segments.length > 1 ? t('chart.barsSuffix', { bars: s.bars, count: s.bars }) : ''}
              </span>
            ))}
          </div>
          <ExportCsvButton rows={filteredData} printHidden />
        </div>
      </div>
    </div>
  );
}
