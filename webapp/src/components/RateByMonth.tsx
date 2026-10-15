'use client';

import { useMemo, useState } from 'react';
import type { ProcessedPoint } from '@/lib/energy';
import type { PlanId } from '@/hooks/useSelectedPlan';
import { fmtCents, fmtNumber, useTranslation } from '@/i18n';

type MonthRate = { key: string; label: string; rate: number; kwh: number };

function rateFor(point: ProcessedPoint, plan: PlanId): number {
  if (plan === 'TOU') return point.costTOU;
  if (plan === 'Tiered') return point.costTiered;
  return point.costULO;
}

/** Monthly observed commodity rate, weighted by actual kWh in the source readings. */
export default function RateByMonth({ rows, plan }: { rows: ProcessedPoint[]; plan: PlanId }) {
  const { t, locale } = useTranslation();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const data = useMemo<MonthRate[]>(() => {
    const grouped = new Map<string, { cost: number; kwh: number; date: Date }>();
    for (const row of rows) {
      const key = `${row.dateObj.getFullYear()}-${String(row.dateObj.getMonth() + 1).padStart(2, '0')}`;
      const group = grouped.get(key) ?? { cost: 0, kwh: 0, date: row.dateObj };
      group.cost += rateFor(row, plan);
      group.kwh += row.usage_kwh;
      grouped.set(key, group);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-27).map(([key, value]) => ({
      key,
      label: new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
        month: locale === 'fr' ? '2-digit' : 'short', year: '2-digit',
      }).format(value.date).toUpperCase(),
      rate: value.kwh > 0 ? value.cost / value.kwh * 100 : 0,
      kwh: value.kwh,
    }));
  }, [rows, plan, locale]);
  const selected = data.find((point) => point.key === activeKey) ?? data[data.length - 1];
  const maxRate = 14;
  const plot = { x: 58, y: 10, width: 910, height: 180 };
  const barWidth = data.length ? Math.min(24, plot.width / data.length * 0.62) : 10;
  const currentMonth = data[data.length - 1]?.key;

  return (
    <section className="border border-edge-muted rounded-lg bg-card p-4 md:p-5" aria-labelledby="rate-by-month-title" data-testid="rate-by-month">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 id="rate-by-month-title" className="text-sm font-semibold normal-case">{t('rateChart.title')}</h2>
        <p className="text-xs font-normal normal-case text-ink-3">{t('rateChart.subtitle', { count: data.length })}</p>
      </div>
      <div className="flex items-center gap-2 mb-2 text-xs font-normal normal-case text-ink-2">
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-accent" aria-hidden="true" />
        <span>{t('rateChart.rateLegend')}</span>
        <span role="status" aria-live="polite" className="ml-auto font-medium text-ink tabular-nums" data-testid="rate-chart-readout">
          {selected ? `${selected.label} · ${fmtCents(selected.rate, 1)}${selected.key === currentMonth ? ` · ${t('rateChart.current')}` : ''}` : t('rateChart.empty')}
        </span>
      </div>
      {data.length > 0 ? <>
        <div className="w-full overflow-hidden">
          <svg viewBox="0 0 1000 235" role="group" aria-label={t('rateChart.chartAria')} className="w-full h-auto" data-testid="rate-chart-svg">
            {Array.from({ length: 8 }, (_, index) => {
              const value = index * 2;
              const y = plot.y + plot.height - value / maxRate * plot.height;
              return <g key={value}>
                <line x1={plot.x} x2={plot.x + plot.width} y1={y} y2={y} stroke="var(--grid)" strokeWidth="1" />
                <text x="48" y={y + 4} textAnchor="end" className="fill-current text-[11px]">{value}</text>
              </g>;
            })}
            {data.map((point, index) => {
              const slot = plot.width / data.length;
              const x = plot.x + index * slot + (slot - barWidth) / 2;
              const height = Math.max(0, Math.min(plot.height, point.rate / maxRate * plot.height));
              const y = plot.y + plot.height - height;
              const isCurrent = point.key === currentMonth;
              const accessibleName = t('rateChart.barAria', { month: point.label, rate: fmtCents(point.rate, 1), kwh: Math.round(point.kwh) });
              return <g key={point.key}>
                <rect x={x} y={plot.y} width={slot} height={plot.height} fill="transparent" />
                <rect x={x} y={y} width={barWidth} height={height} rx="2" fill={isCurrent ? 'var(--accent)' : 'var(--ink-3)'}
                  stroke={isCurrent ? 'var(--ink)' : 'none'} strokeWidth="1" tabIndex={0} role="img" aria-label={accessibleName}
                  data-testid="rate-chart-bar" data-month={point.key}
                  onFocus={() => setActiveKey(point.key)} onMouseEnter={() => setActiveKey(point.key)} />
                {index % (data.length > 15 ? 3 : data.length > 9 ? 2 : 1) === 0 && <text x={x + barWidth / 2} y="211" textAnchor="middle" className="fill-current text-[10px]">{point.label}</text>}
              </g>;
            })}
          </svg>
        </div>
        <details className="mt-3 text-xs normal-case">
          <summary className="min-h-11 inline-flex items-center cursor-pointer text-ink-2">{t('rateChart.tableSummary')}</summary>
          <table className="w-full text-left border-collapse" data-testid="rate-chart-table">
            <caption className="sr-only">{t('rateChart.tableCaption')}</caption>
            <thead><tr><th className="py-2 border-b border-edge-muted">{t('rateChart.month')}</th><th className="py-2 border-b border-edge-muted">{t('rateChart.averageRate')}</th><th className="py-2 border-b border-edge-muted">{t('rateChart.usage')}</th></tr></thead>
            <tbody>{data.map((point) => <tr key={point.key}><th scope="row" className="py-2 border-b border-edge-muted">{point.label}</th><td className="py-2 border-b border-edge-muted tabular-nums">{fmtCents(point.rate, 1)}</td><td className="py-2 border-b border-edge-muted tabular-nums">{fmtNumber(Math.round(point.kwh), 0)}</td></tr>)}</tbody>
          </table>
        </details>
      </> : <p className="py-8 text-sm font-normal normal-case text-ink-3">{t('rateChart.noData')}</p>}
    </section>
  );
}
