/**
 * Year-over-year gas panel (t_a2343a2f) — the electricity
 * `YearOverYearPanel`'s gas twin, minus the rate-set machinery (gas bills
 * carry ¢/m³ rates but no versioned rate sets, so there are no boundaries
 * to annotate — that concept stays on the electricity side).
 *
 * Fed by `buildGasYearOverYear` (pure, gated on a span of MORE than 12
 * months): monthly m³ per year as overlay bars, the delta % row vs the
 * same month one year earlier, per-year FULL totals with an honest
 * partial flag, and an honest empty state that says exactly how much
 * history exists. Every figure is read straight off the feed — m³ never
 * converted, never priced.
 */
'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import type { GasYearOverYear } from '@/lib/gasMonthly';
import { fmtNumberAuto, fmtPercent, useTranslation } from '@/i18n';
import { monthLabelsFor } from '@/lib/trend';
import { usePrefersReducedMotion } from './GasChartPanel';

/**
 * One token per year (globals.css `--data-year-1..4`) — byte-identical to
 * the electricity trend panel's list, so a year wears the same colour in
 * both sections. DARK lifts year-1 to blue-500 (a blue-600 bar measured
 * 3.45:1 on the dark card).
 */
const YEAR_COLORS = [
  'var(--data-year-1)',
  'var(--data-year-2)',
  'var(--data-year-3)',
  'var(--data-year-4)',
];

const fmtDelta = (pct: number | null): string =>
  pct === null ? '—' : `${pct > 0 ? '+' : ''}${fmtPercent(pct, 0)}`;

export default function GasYearOverYearPanel({ yoy }: { yoy: GasYearOverYear }) {
  const { t, locale } = useTranslation();
  const reduceMotion = usePrefersReducedMotion();
  // `locale` (not just `t`): the trend lib labels its months with the same
  // locale-aware helper the headers below use.
  const monthLabels = useMemo(() => monthLabelsFor(locale), [locale]);

  // Chart rows: one per month-of-year, keyed by year for grouped bars.
  const rows = useMemo(
    () =>
      monthLabels.map((month, i) => {
        const row: Record<string, string | number | null> = { month };
        for (const s of yoy.series) row[String(s.year)] = s.m3[i];
        return row;
      }),
    [yoy.series, monthLabels],
  );

  // Latest delta row (most recent year with a prior year to compare against).
  const latestDelta =
    yoy.deltas.length > 0 ? yoy.deltas[yoy.deltas.length - 1] : null;

  return (
    <div
      className="quiet-card p-4 md:p-6 text-ink"
      data-testid="gas-yoy-panel"
    >
      <h2 className="flex items-center gap-2 text-base font-black uppercase tracking-tight mb-2">
        <TrendingUp size={18} strokeWidth={3} aria-hidden="true" />
        {t('gasBill.yoyTitle')}
      </h2>

      {!yoy.ready ? (
        <div
          data-testid="gas-yoy-empty"
          className="bg-inset p-4 md:p-6 rounded-xl border-2 border-dashed border-edge"
        >
          <p className="text-sm md:text-lg font-black uppercase text-ink">
            {yoy.emptyMessage ?? t('yoy.emptyNoData')}
          </p>
          <p className="mt-3 text-xs md:text-sm font-bold text-ink-3 normal-case">
            {t('gasBill.yoyEmptyBody')}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <p className="text-xs md:text-sm font-bold text-ink-2 normal-case">
            {t('gasBill.yoySourceNote')}
          </p>

          {/* Definite height (not min-h): ResponsiveContainer's height="100%"
              resolves against height, and min-height alone leaves it 0×0. */}
          <div
            className="h-[300px] md:h-[360px]"
            data-testid="gas-yoy-chart"
            role="img"
            aria-label={t('gasBill.yoyChartAria', { count: yoy.series.length })}
            data-reduced-motion={reduceMotion ? 'true' : 'false'}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fontWeight: 900, fill: 'var(--ink-3)' }}
                  stroke="var(--axis)"
                  strokeWidth={4}
                />
                <YAxis
                  width={72}
                  label={{
                    value: t('commodity.gasChartVolume'),
                    angle: -90,
                    position: 'insideLeft',
                    fill: 'var(--ink-3)',
                    fontSize: 11,
                    fontWeight: 900,
                  }}
                  tick={{ fontSize: 12, fontWeight: 900, fill: 'var(--ink-3)' }}
                  stroke="var(--axis)"
                  strokeWidth={4}
                />
                <Tooltip
                  formatter={(value, name) => [
                    `${fmtNumberAuto(Number(value), 3)} ${t('gasBill.m3Unit')}`,
                    String(name),
                  ]}
                  contentStyle={{
                    borderRadius: 12,
                    border: '3px solid var(--edge)',
                    fontWeight: 900,
                    fontSize: 12,
                    background: 'var(--card)',
                    color: 'var(--ink)',
                  }}
                />
                {/* L3 (t_3e571ddb Phase 2): the legend LABEL is prose, not a
                    data mark — it must not wear the series hue. The SWATCH
                    keeps the hue; only the text moves to --ink-2. */}
                <Legend
                  wrapperStyle={{ fontWeight: 900, fontSize: 12 }}
                  formatter={(value) => (
                    <span style={{ color: 'var(--ink-2)' }}>{value}</span>
                  )}
                />
                {yoy.series.map((s, i) => (
                  <Bar
                    key={s.year}
                    dataKey={String(s.year)}
                    name={s.label}
                    fill={YEAR_COLORS[i % YEAR_COLORS.length]}
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={!reduceMotion}
                  >
                    {rows.map((row, m) => (
                      <Cell
                        key={m}
                        fill={
                          row[String(s.year)] === null
                            ? 'var(--track)'
                            : YEAR_COLORS[i % YEAR_COLORS.length]
                        }
                      />
                    ))}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Delta % vs same month prior year */}
          {latestDelta ? (
            <div data-testid="gas-yoy-deltas" className="overflow-x-auto">
              <div className="text-xs md:text-sm font-black uppercase mb-2">
                {t('yoy.deltaHeader', {
                  year: latestDelta.year,
                  prior: latestDelta.year - 1,
                })}
              </div>
              <div className="grid grid-cols-12 gap-1 min-w-[560px]">
                {monthLabels.map((m, i) => {
                  const pct = latestDelta.pct[i];
                  const has = pct !== null;
                  const bg = !has
                    // "No data yet" is a real state, not a whisper: the cell
                    // is the same weight as its siblings, so it carries
                    // --ink like they do.
                    ? 'bg-hover text-ink'
                    : pct > 5
                      ? 'bg-bad-slab text-accent-ink'
                      : pct < -5
                        ? 'bg-good-slab text-accent-ink'
                        : 'bg-track text-ink';
                  return (
                    <div key={m} className="text-center">
                      <div className="text-[9px] md:text-[10px] font-black uppercase text-ink-3">
                        {m}
                      </div>
                      <div
                        className={`${bg} border-2 border-edge rounded-md py-1 md:py-2 text-[10px] md:text-xs font-black`}
                      >
                        {fmtDelta(pct)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p data-testid="gas-yoy-no-delta" className="text-xs md:text-sm font-black text-ink-3">
              {t('yoy.noOverlap')}
            </p>
          )}

          {/* Full-year totals — the year-at-a-glance comparison, with an
              honest partial flag on any year that does not carry all twelve
              months (or touches a partial edge month). */}
          <div data-testid="gas-yoy-totals">
            <div className="text-xs md:text-sm font-black uppercase mb-2">
              {t('gasBill.yoyTotalsTitle')}
            </div>
            <table className="w-full min-w-[360px] text-[10px] md:text-xs">
              <thead>
                <tr className="text-ink-4 uppercase text-left">
                  <th className="py-1 pr-2 font-semibold">{t('gasBill.yoyColYear')}</th>
                  <th className="py-1 px-2 font-semibold text-right">
                    {t('gasBill.yoyColTotal')}
                  </th>
                  <th className="py-1 px-2 font-semibold text-right">
                    {t('gasBill.yoyColMonths')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {yoy.yearTotals.map((yt) => (
                  <tr
                    key={yt.year}
                    data-testid="gas-yoy-year-total"
                    data-year={yt.year}
                    data-partial={yt.partial ? 'true' : 'false'}
                    className="border-t border-edge-muted"
                  >
                    <td className="py-1.5 pr-2 whitespace-nowrap font-semibold">
                      {yt.year}
                      {yt.partial && (
                        <span
                          data-testid="gas-yoy-partial-badge"
                          className="ml-2 px-1.5 py-0.5 rounded border border-edge text-[9px] uppercase text-ink-3"
                        >
                          {t('gasBill.yoyPartial')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {fmtNumberAuto(yt.m3, 3)} {t('gasBill.m3Unit')}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {`${yt.months}/12`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Honest edges: partial months + the span this panel is built on. */}
          <div
            data-testid="gas-yoy-meta"
            className="text-[10px] md:text-xs font-black text-ink-3 normal-case space-y-1"
          >
            {yoy.partialMonths.length > 0 && (
              <p>
                {t('yoy.partialMonths', {
                  months: yoy.partialMonths
                    .map((k) => gasMonthLabel(k, monthLabels))
                    .join(', '),
                })}
              </p>
            )}
            <p>
              {t('gasBill.yoyMeta', {
                count: yoy.series.length,
                years: yoy.series.length,
                months: yoy.monthsOfData,
                first: yoy.firstMonthLabel ?? '—',
                last: yoy.lastMonthLabel ?? '—',
              })}
            </p>
          </div>

          {/* Every plotted number in the DOM without hover — the
              ChartDataTable pattern, m³ instead of kWh. */}
          <table className="sr-only" data-testid="gas-yoy-data-table">
            <caption>{t('gasBill.yoyTableCaption')}</caption>
            <thead>
              <tr>
                <th>{t('chart.period')}</th>
                {yoy.series.map((s) => (
                  <th key={s.year}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthLabels.map((m, i) => (
                <tr key={m}>
                  <th scope="row">{m}</th>
                  {yoy.series.map((s) => (
                    <td key={s.year}>
                      {s.m3[i] !== null
                        ? `${fmtNumberAuto(s.m3[i] as number, 3)} ${t('gasBill.m3Unit')}`
                        : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** `yyyy-MM` → "Jan 2025" with the caller's locale-aware month names. */
function gasMonthLabel(key: string, monthLabels: readonly string[]): string {
  const [y, m] = key.split('-');
  return `${monthLabels[Number(m) - 1]} ${y}`;
}
