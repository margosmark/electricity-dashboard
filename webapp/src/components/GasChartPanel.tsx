/**
 * The gas interval chart (t_78f788b3) — x = interval start, y = volume in m³.
 *
 * FEED SCOPE (source-asserted in `GasChart.test.tsx`): this file and its
 * parent (`GasSection`) never contain the electric key — they receive gas
 * points as PROPS from the dashboard's gas bucket and never touch
 * `localStorage` themselves. The mirror holds for the electric chart
 * (`ChartView` / `BarChartPanel` never mention the gas key): two components,
 * two buckets, so a browser holding both commodities can never bleed one
 * commodity's numbers into the other's plot.
 *
 * HONESTY CONTRACT: every stored point becomes one bar and one table row —
 * never summed, never converted, never priced. Several volume series that
 * publish the same interval start (two MeterReadings covering one day) keep
 * separate bars; the axis disambiguates the later one as "date (2)" rather
 * than merging or dropping it, because both readings are in the browser and
 * neither may vanish silently. No kWh token exists anywhere in this file —
 * the m³ unit sits on the Y axis, in the tooltip, and in the sr-only table
 * (the repo's chart a11y pattern: every plotted number reachable without
 * hover, per `ChartDataTable` in ChartView/BarChartPanel).
 *
 * CHUNK DISCIPLINE: GasSection pulls this module through `next/dynamic`,
 * same as ChartView → BarChartPanel — recharts stays off the main bundle
 * until a gas tab with interval data actually renders.
 */
'use client';

import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { GasPoint } from '@/lib/storage';
import { sortGasPoints } from '@/lib/commodity';
import { fmtDateLong, fmtDay, fmtNumberAuto, useTranslation } from '@/i18n';

export type GasChartRow = {
  /** Unique axis slot — `${timestamp}#${occurrence}`; keeps same-start readings on separate bars. */
  slot: string;
  /** Axis/table label: the interval's day, suffixed " (2)" when a later series repeats the day. */
  label: string;
  /** UTC epoch seconds of the interval start — the tooltip's exact date. */
  timestamp: number;
  /** Volume in m³, exactly as stored (parser-scaled, never re-derived here). */
  volume: number;
};

/**
 * Sorted, de-garbled rows for the chart and its table — one row per STORED
 * point. Points sharing an interval start (several volume series published
 * the same day) each keep their own row; the second gets a "(2)" label so the
 * category axis cannot collapse the two bars onto one x. A non-finite point
 * is dropped rather than crashing the tab — `isGasPoint` already rejects
 * those on load, this is belt-and-braces.
 */
export function buildGasChartRows(points: readonly GasPoint[]): GasChartRow[] {
  const seen = new Map<number, number>();
  return sortGasPoints(points)
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.volume_m3))
    .map((p) => {
      const occurrence = seen.get(p.timestamp) ?? 0;
      seen.set(p.timestamp, occurrence + 1);
      // LOCAL day of the instant — the app's display convention everywhere
      // (bill cards fmtDate the same instant; a UTC slice would read one day
      // off from them for any browser west of Greenwich).
      const d = new Date(p.timestamp * 1000);
      const dayKey = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
      const day = fmtDay(dayKey);
      return {
        slot: `${p.timestamp}#${occurrence}`,
        label: occurrence === 0 ? day : `${day} (${occurrence + 1})`,
        timestamp: p.timestamp,
        volume: p.volume_m3,
      };
    });
}

/**
 * Reduced motion: recharts grows its bars with a JS animation the repo's CSS
 * `@media (prefers-reduced-motion: reduce)` block cannot reach, so the chart
 * asks the media query directly and renders final bar geometry with no
 * animation (`isAnimationActive={false}`). The same flag is exposed as
 * `data-reduced-motion` on the chart wrapper for tests and e2e.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduce(mq.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    // Older MediaQueryList API (jsdom and old Safari ship only these).
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduce;
}

/**
 * A text equivalent for the chart: every plotted number, with its unit, in
 * the DOM without hover — the `ChartDataTable` pattern from the electric
 * chart, with m³ instead of kWh.
 */
export function GasChartDataTable({ rows }: { rows: readonly GasChartRow[] }) {
  const { t } = useTranslation();
  return (
    <table className="sr-only" data-testid="gas-chart-data-table">
      <caption>{t('commodity.gasChartTableCaption')}</caption>
      <thead>
        <tr>
          <th>{t('chart.period')}</th>
          <th>{t('commodity.gasChartVolume')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.slot}>
            <th scope="row">{fmtDateLong(row.timestamp * 1000)}</th>
            <td>
              {fmtNumberAuto(row.volume, 3)} {t('gasBill.m3Unit')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Tooltip body — exported so the unit test can assert the m³ unit directly. */
export function GasTooltipBody({ row }: { row: GasChartRow }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="gas-chart-tooltip"
      className="border-4 border-edge bg-card p-3 shadow-hard-8 text-ink max-w-[260px]"
      style={{ pointerEvents: 'none' }}
    >
      <div className="text-xs font-black uppercase border-b-2 border-edge pb-1 mb-1">
        {fmtDateLong(row.timestamp * 1000)}
      </div>
      <div className="text-[11px] font-black">
        {fmtNumberAuto(row.volume, 3)} {t('gasBill.m3Unit')}
      </div>
    </div>
  );
}

/** ~8 x labels max; every tick shown while the data is short enough to read. */
function labelInterval(count: number): number {
  return count > 12 ? Math.ceil(count / 8) - 1 : 0;
}

export type GasBarChartProps = {
  rows: readonly GasChartRow[];
  /** Injected by ResponsiveContainer; passed explicitly in unit tests (jsdom has no layout). */
  width?: number;
  height?: number;
  reduceMotion?: boolean;
};

/**
 * The bare chart, separated from the panel so tests can render it with
 * explicit dimensions — jsdom gives ResponsiveContainer a zero-size box, so
 * through the container nothing paints (measured, t_78f788b3 probe).
 */
export function GasBarChart({ rows, width, height, reduceMotion = false }: GasBarChartProps) {
  const { t } = useTranslation();
  return (
    <BarChart
      data={[...rows]}
      width={width}
      height={height}
      margin={{ top: 12, right: 16, left: 8, bottom: 40 }}
    >
      {/* Grid first: it must never out-shout the bars (BarChartPanel rule). */}
      <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
      <XAxis
        dataKey="label"
        angle={-25}
        textAnchor="end"
        height={60}
        interval={labelInterval(rows.length)}
        tick={{ fontSize: 11, fill: 'var(--ink-3)', fontWeight: 900 }}
        stroke="var(--axis)"
        strokeWidth={4}
      />
      {/* The m³ unit sits ON the axis (the card's requirement), token-coloured
          so it survives a dark card. */}
      <YAxis
        dataKey="volume"
        width={72}
        label={{
          value: t('commodity.gasChartVolume'),
          angle: -90,
          position: 'insideLeft',
          fill: 'var(--ink-3)',
          fontSize: 11,
          fontWeight: 900,
        }}
        tick={{ fontSize: 12, fill: 'var(--ink-3)', fontWeight: 900 }}
        stroke="var(--axis)"
        strokeWidth={4}
      />
      <Tooltip
        cursor={{ fill: 'var(--ink)', opacity: 0.05 }}
        content={({ active, payload }) => {
          if (!active || !payload || payload.length === 0) return null;
          const row = payload[0]?.payload as GasChartRow | undefined;
          if (!row) return null;
          return <GasTooltipBody row={row} />;
        }}
      />
      {/* Single usage colour: gas has no weekday/weekend tariff to encode, and
          the edge stroke is the neobrutalist seam (BarChartPanel rule). No
          pointer cursor: the bars do nothing on click, so none is promised. */}
      <Bar
        dataKey="volume"
        fill="var(--chart-usage-weekday)"
        stroke="var(--edge)"
        strokeWidth={3}
        radius={0}
        isAnimationActive={!reduceMotion}
      />
    </BarChart>
  );
}

export default function GasChartPanel({ points }: { points: readonly GasPoint[] }) {
  const { t } = useTranslation();
  const reduceMotion = usePrefersReducedMotion();
  const rows = buildGasChartRows(points);
  // GasSection owns the honest empty state; nothing to draw here.
  if (rows.length === 0) return null;
  return (
    <>
      <GasChartDataTable rows={rows} />
      <div
        data-testid="gas-chart"
        role="img"
        aria-label={t('commodity.gasChartAria', { count: rows.length })}
        data-reduced-motion={reduceMotion ? 'true' : 'false'}
        className="h-[260px] md:h-[400px]"
      >
        <ResponsiveContainer width="100%" height="100%">
          <GasBarChart rows={rows} reduceMotion={reduceMotion} />
        </ResponsiveContainer>
      </div>
    </>
  );
}
