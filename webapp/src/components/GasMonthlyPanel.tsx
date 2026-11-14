/**
 * Monthly gas overview (t_a2343a2f) — bars + table per CALENDAR month.
 *
 * The electricity UsagePanel's gas twin, fed by `buildGasMonthly` (pure):
 *
 *  - the BAR chart plots `row.chartM3` — one declared source per import
 *    (stored interval readings when the file carries any, else the billed
 *    volume each bill states) — with an honest gap (no bar) for months the
 *    chosen source does not cover, never a fabricated zero;
 *  - the TABLE keeps both m³ figures side by side (interval vs billed —
 *    never merged) plus each bill's own period dates and its stated Amount
 *    Due, so every number on screen is one the file states. A period that
 *    states no amount says "not in this import" — never a derived price.
 *
 * Feed scope: props only (`points` from `energy_gas_v2`, `summaries` from
 * `gas_usage_summaries`, both read by the dashboard shell) — this component
 * never touches a storage key, so it cannot be fed the other commodity.
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
  ResponsiveContainer,
} from 'recharts';
import { CalendarDays } from 'lucide-react';
import type { GasMonthly, GasMonthlyRow } from '@/lib/gasMonthly';
import { billPeriodLabel } from '@/lib/energy';
import { fmtMoney, fmtNumberAuto, useTranslation } from '@/i18n';
import { monthLabelsFor } from '@/lib/trend';
import { usePrefersReducedMotion } from './GasChartPanel';

/** Money with the currency symbol; − is U+2212, the app's minus. */
const dollars = (n: number) =>
  n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n);

/** ~8 x labels max; every tick shown while the data is short enough to read. */
function labelInterval(count: number): number {
  return count > 12 ? Math.ceil(count / 8) - 1 : 0;
}

export default function GasMonthlyPanel({ monthly }: { monthly: GasMonthly }) {
  const { t, locale } = useTranslation();
  const reduceMotion = usePrefersReducedMotion();
  // `locale` (not just `t`): the axis labels come from the same locale-aware
  // helper the table headers use, so the chart and the table can never
  // disagree about a month's name.
  const monthLabels = useMemo(() => monthLabelsFor(locale), [locale]);

  const rows = monthly.rows;
  const source = monthly.source;

  // Chart rows: one bar per calendar month, labeled "Jan 2025" (thinned).
  const chartRows = useMemo(
    () =>
      rows.map((r) => ({
        key: r.key,
        label: `${monthLabels[r.monthIndex]} ${r.year}`,
        m3: r.chartM3,
      })),
    [rows, monthLabels],
  );

  const sourceNote =
    source === 'interval'
      ? t('gasBill.monthlySourceInterval')
      : t('gasBill.monthlySourceBilled');
  // Bills exist but none states a volume → the chart would draw an empty
  // frame; say so instead (the table below still carries the periods and
  // the stated money, which ARE in this import).
  const chartable = rows.some((r) => r.chartM3 !== null);

  if (rows.length === 0) {
    // Defensive: the shell only paints this panel over a non-empty gas
    // bucket, but a bucket of unparseable rows must say so, not draw a
    // silent empty frame.
    return (
      <div
        className="quiet-card p-4 md:p-6 text-ink"
        data-testid="gas-monthly-panel"
      >
        <h2 className="flex items-center gap-2 text-base font-black uppercase tracking-tight mb-2">
          <CalendarDays size={18} strokeWidth={3} aria-hidden="true" />
          {t('gasBill.monthlyTitle')}
        </h2>
        <p
          data-testid="gas-monthly-empty"
          className="text-xs md:text-sm font-bold text-ink-2 normal-case"
        >
          {t('gasBill.monthlyEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div className="quiet-card p-4 md:p-6 text-ink" data-testid="gas-monthly-panel">
      <h2 className="flex items-center gap-2 text-base font-black uppercase tracking-tight mb-2">
        <CalendarDays size={18} strokeWidth={3} aria-hidden="true" />
        {t('gasBill.monthlyTitle')}
      </h2>
      <p className="text-xs md:text-sm font-bold text-ink-2 normal-case mb-4">
        {sourceNote}
      </p>

      {chartable ? (
      <div
        className="h-[300px] md:h-[360px]"
        data-testid="gas-monthly-chart"
        role="img"
        aria-label={t('gasBill.monthlyChartAria', { count: rows.length })}
        data-reduced-motion={reduceMotion ? 'true' : 'false'}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartRows}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            {/* Grid first: it must never out-shout the bars. */}
            <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
            <XAxis
              dataKey="label"
              angle={-25}
              textAnchor="end"
              height={60}
              interval={labelInterval(chartRows.length)}
              tick={{ fontSize: 11, fill: 'var(--ink-3)', fontWeight: 900 }}
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
              tick={{ fontSize: 12, fill: 'var(--ink-3)', fontWeight: 900 }}
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
            <Bar
              dataKey="m3"
              name={t('commodity.gasChartVolume')}
              fill="var(--chart-usage-weekday)"
              stroke="var(--edge)"
              strokeWidth={1}
              radius={[4, 4, 0, 0]}
              isAnimationActive={!reduceMotion}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      ) : (
        <p
          data-testid="gas-monthly-no-volume"
          className="bg-inset p-4 rounded-xl border-2 border-dashed border-edge text-xs md:text-sm font-bold text-ink-2 normal-case"
        >
          {t('gasBill.noChartableVolume')}
        </p>
      )}

      {/* The text alternative AND the money view: every charted number, both
          m³ figures side by side, the bill's own period and its stated
          Amount Due — nothing derived, nothing summed. */}
      <div className="mt-4 overflow-x-auto">
        <table
          className="w-full min-w-[560px] text-[10px] md:text-xs"
          data-testid="gas-monthly-table"
        >
          <caption className="sr-only">{t('gasBill.monthlyTableCaption')}</caption>
          <thead>
            <tr className="text-ink-4 uppercase text-left">
              <th className="py-1 pr-2 font-semibold">{t('gasBill.colMonth')}</th>
              <th className="py-1 px-2 font-semibold">{t('money.colPeriod')}</th>
              <th className="py-1 px-2 font-semibold text-right">
                {t('gasBill.colInterval')}
              </th>
              <th className="py-1 px-2 font-semibold text-right">
                {t('gasBill.colBilled')}
              </th>
              <th className="py-1 px-2 font-semibold text-right">
                {t('billnote.amountDue')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <MonthlyRow
                key={r.key}
                row={r}
                monthLabel={`${monthLabels[r.monthIndex]} ${r.year}`}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One month: period dates, both m³ columns, the stated amount (or the
 *  honest "not in this import" state when a bill exists but states none). */
function MonthlyRow({ row, monthLabel }: { row: GasMonthlyRow; monthLabel: string }) {
  const { t } = useTranslation();
  const bills = row.bills;
  return (
    <tr
      data-testid="gas-monthly-row"
      data-month={row.key}
      className="border-t border-edge-muted"
    >
      <td className="py-1.5 pr-2 whitespace-nowrap font-semibold">{monthLabel}</td>
      <td className="py-1.5 px-2 whitespace-nowrap tabular-nums text-ink-3">
        {bills.length === 0
          ? '—'
          : bills.map((b) => (
              <div key={b.startDate}>
                {billPeriodLabel(b.summary.start, b.summary.duration)}
              </div>
            ))}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">
        {row.intervalM3 !== null ? fmtNumberAuto(row.intervalM3, 3) : '—'}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">
        {bills.length === 0
          ? '—'
          : bills.map((b, i) => (
              <div key={`${b.startDate}-${i}`}>
                {b.billedM3 !== null ? fmtNumberAuto(b.billedM3, 3) : '—'}
              </div>
            ))}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">
        {bills.length === 0
          ? '—'
          : bills.map((b, i) => (
              <div key={`${b.startDate}-due-${i}`}>
                {b.amountDue !== null ? dollars(b.amountDue) : t('gasBill.notInImport')}
              </div>
            ))}
      </td>
    </tr>
  );
}
