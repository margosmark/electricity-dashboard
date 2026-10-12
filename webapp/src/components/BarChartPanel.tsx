/**
 * Wave I item 4 — the bars, on their own chunk.
 *
 * Recharts (+ the date-fns/fast-xml-parser code that shares its chunk) is
 * ~651 KB uncompressed, and on a first visit there is nothing to draw: the
 * chart area shows the "no readings in this window" panel. Lighthouse measured
 * 74.7% of that chunk as unused JS on exactly that visit, and under mobile
 * throttling every byte on the critical path costs simulated main-thread time.
 *
 * So the card's chrome stays in `ChartView` (it renders instantly, empty state
 * included) and only the `<ResponsiveContainer>` half is dynamically imported —
 * and only when there is at least one bar to draw. Nothing about the rendered
 * output changes once data exists; the Wave H shimmer covers the chunk fetch the
 * same way it covers Recharts' own grow-in.
 */
'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceArea,
} from 'recharts';
import { type ChartDataItem, getBarColor } from '@/lib/energy';
import { type ZoomLevel } from '@/hooks/useDashboard';
import { type ChartSegment } from '@/lib/season';
import { fmtKwh, fmtMoney, useTranslation } from '@/i18n';

export type BarChartPanelProps = {
  data: ChartDataItem[];
  zoomLevel: ZoomLevel;
  /** Rate-season bands (Wave G item 6) drawn behind the bars. */
  segments: ChartSegment[];
  /** False when labels repeat — `ReferenceArea` anchors on labels. */
  labelsUnique: boolean;
  onBarClick: (item: { key?: string } | null) => void;
};

export default function BarChartPanel({
  data, zoomLevel, segments, labelsUnique, onBarClick,
}: BarChartPanelProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 24, left: 0, bottom: 8 }}>
        {/* Grid first: it must never out-shout the bars. A hard #000 line at
            10% was a near-black rule on light; on dark it disappears entirely,
            so both themes read `--grid` (black@10% / slate@9%). */}
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
        {/* Subtle season bands: blue = winter window, amber = summer. The
            7% wash is a BACKGROUND, so it is deliberately quiet in both
            themes — it is context for the bars, not data of its own. */}
        {labelsUnique &&
          segments.map((s, i) => (
            <ReferenceArea
              key={`season-${s.season}-${i}`}
              x1={s.fromLabel}
              x2={s.toLabel}
              fill={s.season === 'winter' ? '#2563EB' : '#F59E0B'}
              fillOpacity={0.07}
              stroke="none"
              label={{ value: s.season === 'winter' ? t('season.bandWinter') : t('season.bandSummer'), position: 'insideTop', fill: 'var(--ink-2)', fontSize: 10, fontWeight: 900 }}
            />
          ))}
        {/* The fat 4px axis IS the neobrutalist axis — keep the weight, take
            the colour from the token so it survives a dark card. */}
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--ink-3)', fontWeight: 900 }} stroke="var(--axis)" strokeWidth={4} />
        <YAxis tick={{ fontSize: 12, fill: 'var(--ink-3)', fontWeight: 900 }} stroke="var(--axis)" strokeWidth={4} />
        <Tooltip
          cursor={{ fill: 'var(--ink)', opacity: 0.05 }}
          contentStyle={{ borderRadius: '0px', border: '4px solid var(--edge)', boxShadow: '12px 12px 0px 0px var(--shadow)', padding: '24px', background: 'var(--card)', pointerEvents: 'none' }}
          itemStyle={{ color: 'var(--ink)', fontWeight: 900, fontSize: '18px' }}
          labelStyle={{ fontWeight: 900, color: 'var(--ink)', marginBottom: '8px', textTransform: 'uppercase' }}
          formatter={(v, name) => {
            if (name === 'usage') return [fmtKwh(Number(v), 2), 'Power'];
            return [fmtMoney(Number(v)), String(name).replace('cost', '') + ' Cost'];
          }}
        />
        <Bar
          dataKey="usage"
          fill="#2563EB"
          /* The seam between stacked segments. Deliberately NOT the border
             token: on dark that would be a #cbd5e1 line between every pair of
             bars — a light grid drawn over the data. The bar's own stroke
             reads as a card-tone gap on dark and a black one on light. */
          stroke="#000"
          strokeWidth={3}
          radius={0}
          activeBar={{ fill: 'var(--data-active)' }}
          onClick={(d) => onBarClick(d as { key?: string } | null)}
          className="cursor-pointer"
        >
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={getBarColor(zoomLevel, entry.key)}
              style={{ cursor: 'pointer', pointerEvents: 'auto' }}
            />
          ))}
        </Bar>
        <Bar dataKey="costTOU" hide /> <Bar dataKey="costTiered" hide /> <Bar dataKey="costULO" hide />
      </BarChart>
    </ResponsiveContainer>
  );
}
