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
import { buildYearOverYear, MONTH_LABELS } from '@/lib/trend';

const YEAR_COLORS = ['#2563EB', '#F97316', '#16A34A', '#A855F7'];

const fmtDelta = (pct: number | null): string =>
  pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;

export default function YearOverYearPanel({
  processedData,
}: {
  processedData: ProcessedPoint[];
}) {
  const trend = useMemo(() => buildYearOverYear(processedData), [processedData]);

  // Chart rows: one per month-of-year, keyed by year for grouped bars.
  const rows = useMemo(
    () =>
      MONTH_LABELS.map((month, i) => {
        const row: Record<string, string | number | null> = { month };
        for (const s of trend.series) row[String(s.year)] = s.kwh[i];
        return row;
      }),
    [trend.series],
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
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-2 md:border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black"
    >
      <div className="flex flex-wrap items-center gap-2 md:gap-4 mb-4 md:mb-8 text-black font-black uppercase">
        <TrendingUp size={24} className="md:w-10 md:h-10" strokeWidth={3} />
        <h3 className="text-2xl md:text-4xl">Year-over-Year — Monthly kWh</h3>
      </div>

      {!trend.ready ? (
        <div
          data-testid="trend-empty"
          className="bg-slate-50 p-6 md:p-8 rounded-xl md:rounded-2xl border-2 md:border-4 border-dashed border-black"
        >
          <p className="text-lg md:text-2xl font-black uppercase text-black">
            {trend.emptyMessage ?? 'No data loaded yet.'}
          </p>
          <p className="mt-3 text-xs md:text-sm font-black text-slate-500 normal-case">
            Once the dataset covers more than a year (or more than one rate-set change), this
            panel overlays each year&apos;s monthly kWh against the same month last year so
            heating/cooling seasonality is visible. Rates are versioned separately — cost
            comparisons always use the rate set active on each reading.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="min-h-[260px] md:min-h-[360px]" data-testid="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fontWeight: 900 }} />
                <YAxis tick={{ fontSize: 11, fontWeight: 900 }} unit=" kWh" width={80} />
                <Tooltip
                  formatter={(value, name) => [
                    `${Number(value).toFixed(1)} kWh`,
                    String(name),
                  ]}
                  contentStyle={{
                    borderRadius: 12, border: '3px solid #000', fontWeight: 900, fontSize: 12,
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
                            ? '#E2E8F0'
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
                Δ vs {latestDelta.year - 1} ({latestDelta.year} vs {latestDelta.year - 1})
              </div>
              <div className="grid grid-cols-12 gap-1 min-w-[560px]">
                {MONTH_LABELS.map((m, i) => {
                  const pct = latestDelta.pct[i];
                  const has = pct !== null;
                  const bg = !has
                    ? 'bg-slate-100 text-slate-400'
                    : pct > 5
                      ? 'bg-red-400 text-black'
                      : pct < -5
                        ? 'bg-emerald-400 text-black'
                        : 'bg-slate-200 text-black';
                  return (
                    <div key={m} className="text-center">
                      <div className={`text-[9px] md:text-[10px] font-black uppercase ${boundaryMonths.has(i) ? 'text-blue-700' : 'text-slate-500'}`}>
                        {m}
                        {boundaryMonths.has(i) && ' ▲'}
                      </div>
                      <div
                        className={`${bg} border-2 border-black rounded-md py-1 md:py-2 text-[10px] md:text-xs font-black`}
                      >
                        {fmtDelta(pct)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p data-testid="trend-no-delta" className="text-xs md:text-sm font-black text-slate-500">
              No prior-year overlap yet — deltas appear once two calendar years of data exist.
            </p>
          )}

          {/* Rate-set boundary legend */}
          <div data-testid="trend-boundaries" className="text-[10px] md:text-xs font-black text-slate-500 normal-case space-y-1">
            {trend.boundaries.length > 0 && (
              <p>
                ▲ Rate set changed inside this range:{' '}
                {trend.boundaries.join(', ')} — kWh is rate-independent, but every cost figure in
                the app prices each reading with its own active set.
              </p>
            )}
            {trend.partialMonths.length > 0 && (
              <p>
                Partial months (data does not cover them fully): {trend.partialMonths.join(', ')}
                {' — '}treat their deltas as indicative.
              </p>
            )}
            <p>
              {trend.series.length} year(s) · {trend.monthsOfData} months of data (
              {trend.firstMonthLabel} – {trend.lastMonthLabel}) ·{' '}
              {trend.rateSetChanges} rate-set change{trend.rateSetChanges === 1 ? '' : 's'}.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
