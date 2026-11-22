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

type AccessibleBarProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  payload?: ChartDataItem;
  onActivate?: (item: { key?: string } | null) => void;
};

export function AccessibleBar({
  x = 0, y = 0, width = 0, height = 0, fill = 'currentColor', payload, onActivate,
}: AccessibleBarProps) {
  const { t } = useTranslation();
  const activate = () => onActivate?.(payload ? { key: payload.key } : null);
  /* The 44px tap-target floor, in GEOMETRY: `globals.css` floors every
     `[role="button"]` box at 44×44 with min-width/min-height, but those are
     CSS box properties and an SVG <g> has no box — the painted mark IS the
     whole measured target, so a short bar fails the budget (measured:
     quiet-meter-regression:677, `390 light: targets under 44px`, one
     100×42 bar at origin/main). Height encodes the reading and is never
     inflated, so the group carries a second, INVISIBLE rect that floors both
     axes at 44px: it grows UP from the bar's top (bars rise from the
     baseline; the space above a short bar is empty plot) and symmetrically
     sideways, and it keeps the bar's baseline exactly where the data put it.
     The painted mark, its label and the activation contract are untouched. */
  const hitWidth = Math.max(width, 44);
  const hitHeight = Math.max(height, 44);
  const hitX = x - (hitWidth - width) / 2;
  const hitY = y - (hitHeight - height);
  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={t('chart.barAria', { label: payload?.label ?? '', usage: fmtKwh(payload?.usage ?? 0, 2) })}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      }}
    >
      {/* Bottom layer: the expanded hit area sits UNDER the mark, so the
          painted bar keeps the top of the stack (cursor, hover, active state)
          while the group's box — and its hit area — grows to the floor. */}
      <rect
        x={hitX}
        y={hitY}
        width={hitWidth}
        height={hitHeight}
        fill="transparent"
        pointerEvents="all"
        style={{ cursor: 'pointer' }}
      />
      <rect x={x} y={y} width={width} height={height} fill={fill} />
    </g>
  );
}

/** A text equivalent for the interactive SVG: every plotted number is available without hover. */
export function ChartDataTable({ data }: { data: ChartDataItem[] }) {
  const { t } = useTranslation();
  return (
    <table className="sr-only" data-testid="chart-data-table">
      <caption>{t('chart.dataTableCaption')}</caption>
      <thead><tr><th>{t('chart.period')}</th><th>{t('chart.usage')}</th><th>{t('chart.planTou')}</th><th>{t('chart.planTiered')}</th><th>{t('chart.planUlo')}</th></tr></thead>
      <tbody>{data.map((row) => (
        <tr key={row.key}>
          <th scope="row">{row.label}</th>
          <td>{fmtKwh(row.usage, 2)}</td>
          <td>{fmtMoney(row.costTOU)}</td>
          <td>{fmtMoney(row.costTiered)}</td>
          <td>{fmtMoney(row.costULO)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

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
    <>
      <ChartDataTable data={data} />
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
              fill={s.season === 'winter' ? 'var(--chart-season-winter)' : 'var(--chart-season-summer)'}
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
          fill="var(--chart-usage-weekday)"
          /* The seam between stacked segments. Deliberately NOT the border
             token: on dark that would be a #cbd5e1 line between every pair of
             bars — a light grid drawn over the data. The bar's own stroke
             reads as a card-tone gap on dark and a black one on light. */
          stroke="var(--edge)"
          strokeWidth={3}
          radius={0}
          activeBar={{ fill: 'var(--plan-tou)', stroke: 'var(--ink-3)', strokeWidth: 1 }}
          className="cursor-pointer"
          shape={(props: AccessibleBarProps) => <AccessibleBar {...props} onActivate={onBarClick} />}
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
    </>
  );
}
