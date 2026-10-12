"use client";

/**
 * Year-over-year trend panel (Insights tab): monthly kWh per year as overlay
 * bars + delta % vs the same month one year earlier.
 *
 * Gated by buildYearOverYear (pure, tested): renders only when the loaded
 * dataset spans >12 months OR >1 rate-set change; otherwise an honest empty
 * state naming how much history exists. Rate-set boundaries are annotated on
 * the chart — every cost figure in the app keys off each reading's own
 * activeRateSet, so crossing a boundary is expected, and this panel tells you
 * exactly where they fell.
 */

import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import type { ProcessedPoint } from '@/lib/energy';
import { buildYearOverYear, monthLabelsFor } from '@/lib/trend';
import { fmtKwh, useTranslation } from '@/i18n';

/**
 * One token per year (globals.css `--data-year-1..4`). LIGHT is byte-identical
 * to the `#2563EB / #F97316 / #16A34A / #A855F7` literals this list used to
 * hold; DARK lifts year-1 to blue-500, because a blue-600 bar measured 3.45:1
 * on the dark card (and the legend paints its own label in the series colour,
 * so the lift fixes the label and the bar at once). The bars and the legend
 * both read the token, so the swatch can never drift from the bar it names.
 */
const YEAR_COLORS = [
  'var(--data-year-1)',
  'var(--data-year-2)',
  'var(--data-year-3)',
  'var(--data-year-4)',
];

const fmtDelta = (pct: number | null): string =>
  pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;

export default function YearOverYearPanel({
  processedData,
}: {
  processedData: ProcessedPoint[];
}) {
  const { t, locale } = useTranslation();
  const trend = useMemo(() => buildYearOverYear(processedData), [processedData]);
  // Wave U — the 12 month headers come from the same locale-aware helper
  // the trend lib uses, so the axis and the delta row can never disagree.
  // Pass `locale` explicitly so the memo genuinely re-runs on a switch.
  const monthLabels = useMemo(() => monthLabelsFor(locale), [locale]);

  // Chart rows: one per month-of-year, keyed by year for grouped bars.
  const rows = useMemo(
    () =>
      monthLabels.map((month, i) => {
        const row: Record<string, string | number | null> = { month };
        for (const s of trend.series) row[String(s.year)] = s.kwh[i];
        return row;
      }),
    [trend.series, monthLabels],
  );

  // Latest delta row (most recent year with a prior year to compare against).
  const latestDelta = trend.deltas.length > 0 ? trend.deltas[trend.deltas.length - 1] : null;

  // Month-of-year indexes where a rate set changed inside the data span.
  const boundaryMonths = useMemo(() => {
    const set = new Set<number>();
    for (const b of trend.boundaries) set.add(parseInt(b.slice(5, 7), 10) - 1);
    return set;
  }, [trend.boundaries]);

  return (
    <div
      data-testid="trend-panel"
      className="bg-card p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-edge shadow-hard-8 md:shadow-hard-16 text-ink"
    >
      <div className="flex flex-wrap items-center gap-2 md:gap-4 mb-4 md:mb-8 text-ink font-black uppercase">
        <TrendingUp size={24} className="md:w-10 md:h-10" strokeWidth={3} />
        <h3 className="text-2xl md:text-4xl">{t('yoy.title')}</h3>
      </div>

      {!trend.ready ? (
        <div
          data-testid="trend-empty"
          className="bg-inset p-6 md:p-8 rounded-xl md:rounded-2xl border-2 md:border-4 border-dashed border-edge"
        >
          <p className="text-lg md:text-2xl font-black uppercase text-ink">
            {trend.emptyMessage ?? t('yoy.emptyNoData')}
          </p>
          <p className="mt-3 text-xs md:text-sm font-black text-ink-3 normal-case">
            {t('yoy.emptyBody')}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Definite height (not min-h): ResponsiveContainer's height="100%"
              resolves against height, and min-height alone leaves it 0×0. */}
          <div className="h-[300px] md:h-[360px]" data-testid="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fontWeight: 900 }} />
                <YAxis tick={{ fontSize: 11, fontWeight: 900 }} unit=" kWh" width={80} />
                <Tooltip
                  formatter={(value, name) => [
                    fmtKwh(Number(value)),
                    String(name),
                  ]}
                  contentStyle={{
                    borderRadius: 12, border: '3px solid var(--edge)', fontWeight: 900, fontSize: 12,
                    background: 'var(--card)', color: 'var(--ink)',
                  }}
                />
                <Legend wrapperStyle={{ fontWeight: 900, fontSize: 12 }} />
                {trend.series.map((s, i) => (
                  <Bar
                    key={s.year}
                    dataKey={String(s.year)}
                    name={s.label}
                    fill={YEAR_COLORS[i % YEAR_COLORS.length]}
                    radius={[4, 4, 0, 0]}
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
            <div data-testid="trend-deltas" className="overflow-x-auto">
              <div className="text-xs md:text-sm font-black uppercase mb-2">
                {t('yoy.deltaHeader', { year: latestDelta.year, prior: latestDelta.year - 1 })}
              </div>
              <div className="grid grid-cols-12 gap-1 min-w-[560px]">
                {monthLabels.map((m, i) => {
                  const pct = latestDelta.pct[i];
                  const has = pct !== null;
                  const bg = !has
                    // "No data yet" is a real state, not a whisper: the cell
                    // is the same weight as its three siblings, so it carries
                    // --ink like they do. --ink-4 measured 2.34:1 on the
                    // hover surface — under the 4.5 floor at 10px.
                    ? 'bg-hover text-ink'
                    : pct > 5
                      ? 'bg-red-400 text-accent-ink'
                      : pct < -5
                        ? 'bg-emerald-400 text-accent-ink'
                        : 'bg-track text-ink';
                  return (
                    <div key={m} className="text-center">
                      <div className={`text-[9px] md:text-[10px] font-black uppercase ${boundaryMonths.has(i) ? 'text-info' : 'text-ink-3'}`}>
                        {m}
                        {boundaryMonths.has(i) && ' ▲'}
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
            <p data-testid="trend-no-delta" className="text-xs md:text-sm font-black text-ink-3">
              {t('yoy.noOverlap')}
            </p>
          )}

          {/* Rate-set boundary legend */}
          <div data-testid="trend-boundaries" className="text-[10px] md:text-xs font-black text-ink-3 normal-case space-y-1">
            {trend.boundaries.length > 0 && (
              <p>
                {t('yoy.boundaries', { dates: trend.boundaries.join(', ') })}
              </p>
            )}
            {trend.partialMonths.length > 0 && (
              <p>
                {t('yoy.partialMonths', { months: trend.partialMonths.join(', ') })}
              </p>
            )}
            <p>
              {t('yoy.meta', {
                count: trend.rateSetChanges,
                years: trend.series.length,
                months: trend.monthsOfData,
                first: trend.firstMonthLabel ?? '—',
                last: trend.lastMonthLabel ?? '—',
                changes: trend.rateSetChanges,
              })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
