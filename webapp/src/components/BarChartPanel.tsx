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
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 24, left: 0, bottom: 8 }}>
        <CartesianGrid vertical={false} stroke="#000" strokeWidth={1} opacity={0.1} />
        {/* Subtle season bands: blue = winter window, amber = summer. */}
        {labelsUnique &&
          segments.map((s, i) => (
            <ReferenceArea
              key={`season-${s.season}-${i}`}
              x1={s.fromLabel}
              x2={s.toLabel}
              fill={s.season === 'winter' ? '#2563EB' : '#F59E0B'}
              fillOpacity={0.07}
              stroke="none"
              label={{ value: s.season === 'winter' ? 'WINTER' : 'SUMMER', position: 'insideTop', fill: '#000', fontSize: 10, fontWeight: 900 }}
            />
          ))}
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#000', fontWeight: 900 }} stroke="#000" strokeWidth={4} />
        <YAxis tick={{ fontSize: 12, fill: '#000', fontWeight: 900 }} stroke="#000" strokeWidth={4} />
        <Tooltip
          cursor={{ fill: '#000', opacity: 0.05 }}
          contentStyle={{ borderRadius: '0px', border: '4px solid #000', boxShadow: '12px 12px 0px 0px #000', padding: '24px', background: '#FFF', pointerEvents: 'none' }}
          itemStyle={{ color: '#000', fontWeight: 900, fontSize: '18px' }}
          labelStyle={{ fontWeight: 900, color: '#000', marginBottom: '8px', textTransform: 'uppercase' }}
          formatter={(v, name) => {
            if (name === 'usage') return [`${Number(v).toFixed(2)} kWh`, 'Power'];
            return [`$${Number(v).toFixed(2)}`, String(name).replace('cost', '') + ' Cost'];
          }}
        />
        <Bar
          dataKey="usage"
          fill="#2563EB"
          stroke="#000"
          strokeWidth={3}
          radius={0}
          activeBar={{ fill: '#FFD600' }}
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
