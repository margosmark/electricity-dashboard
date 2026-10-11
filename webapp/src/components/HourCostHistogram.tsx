/**
 * Wave O slice 5a — average ¢/kWh by hour of day.
 *
 * The heatmap next to this already shows how much energy falls at each hour;
 * this shows what that hour COSTS, which is the number that makes the
 * on-peak wall visible (Ontario's peak window is where the rate steps up, so
 * the bars stair-step with it rather than following usage).
 *
 * Only commodity is priced here. Delivery, regulatory and HST arrive once per
 * billing period with no hour attached, so there is no per-hour version of
 * them to draw — the caption says so rather than implying a all-in rate the
 * bill never charged.
 */

'use client';

import { useMemo } from 'react';
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { hourCostProfile, type PlanId } from '@/lib/moneyViz';
import type { ProcessedPoint } from '@/lib/energy';
import { fmtCents, fmtMoney, fmtNumber, periodLabel, planLabel, useTranslation } from '@/i18n';

const WINDOW_COLOR: Record<string, string> = {
  'Off-Peak': '#10B981',
  'Mid-Peak': '#FACC15',
  'On-Peak': '#EF4444',
  other: '#94A3B8',
};

const money = (n: number) => fmtMoney(n);

export default function HourCostHistogram({
  rows,
  plan,
}: {
  rows: ProcessedPoint[];
  plan: PlanId;
}) {
  const { t } = useTranslation();
  const profile = useMemo(() => hourCostProfile(rows, plan), [rows, plan]);

  return (
    <div
      data-testid="money-hour-histogram"
      className="bg-white p-4 md:p-8 rounded-[1.5rem] md:rounded-[2rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
        {t('hourCost.caption', { plan: planLabel(plan) })}
      </div>
      <h3 className="text-lg md:text-2xl italic font-black">{t('hourCost.title')}</h3>

      {!profile.ready ? (
        <div
          data-testid="money-hour-empty"
          className="mt-4 bg-slate-50 border-2 border-dashed border-black rounded-xl p-4 text-[11px] font-bold normal-case text-slate-600"
        >
          {profile.reason}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[10px] md:text-xs font-black">
            <span>
              {t('hourCost.windowAverage')}{' '}
              <span className="italic text-base md:text-xl" data-testid="money-hour-average">
                {profile.averageCents != null ? fmtCents(profile.averageCents) : '—'}
              </span>
            </span>
            <span className="text-slate-500 font-bold normal-case">
              {t('hourCost.readings', { count: profile.rows, rows: fmtNumber(profile.rows) })}
            </span>
          </div>

          <div
            className="mt-3 h-[220px] md:h-[260px]"
            data-testid="money-hour-chart"
            role="img"
            aria-label={t('hourCost.chartAria')}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={profile.buckets} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <XAxis
                  dataKey="label"
                  interval={2}
                  tick={{ fontSize: 9, fontWeight: 900 }}
                  stroke="#000"
                  strokeWidth={2}
                />
                <YAxis
                  tick={{ fontSize: 10, fontWeight: 900 }}
                  stroke="#000"
                  strokeWidth={2}
                  width={48}
                  unit="¢"
                />
                <Tooltip
                  cursor={{ fill: '#000', opacity: 0.05 }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const b = payload[0]?.payload as
                      | { label: string; cents: number | null; kwh: number; cost: number; dominant: string }
                      | undefined;
                    if (!b) return null;
                    return (
                      <div
                        data-testid="money-hour-tooltip"
                        className="border-4 border-black bg-white p-3 shadow-[8px_8px_0px_0px_#000] text-black"
                        style={{ pointerEvents: 'none' }}
                      >
                        <div className="text-xs font-black uppercase border-b-2 border-black pb-1 mb-1">
                          {t('hourCost.tooltipHour', { hour: String(label ?? b.label) })}
                        </div>
                        <div className="text-[11px] font-black">
                          {b.cents === null
                            ? t('hourCost.noEnergy')
                            : `${fmtCents(b.cents, 2)}${t('efficiency.perKwh')}`}
                        </div>
                        <div className="text-[10px] font-bold text-slate-500">
                          {t('hourCost.tooltipDetail', {
                            cost: money(b.cost),
                            kwh: b.kwh.toFixed(1),
                            window: periodLabel(b.dominant),
                          })}
                        </div>
                      </div>
                    );
                  }}
                />
                <ReferenceLine
                  y={profile.averageCents ?? 0}
                  stroke="#000"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  label={{
                    value: t('hourCost.averageTick'),
                    position: 'insideTopRight',
                    fill: '#000',
                    fontSize: 10,
                    fontWeight: 900,
                  }}
                />
                <Bar dataKey="cents" name="cents" stroke="#000" strokeWidth={1}>
                  {profile.buckets.map((b) => (
                    <Cell key={b.hour} fill={WINDOW_COLOR[b.dominant] ?? WINDOW_COLOR.other} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[9px] uppercase font-black">
            {(['Off-Peak', 'Mid-Peak', 'On-Peak'] as const).map((w) => (
              <span key={w} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block w-3 h-3 border-2 border-black"
                  style={{ background: WINDOW_COLOR[w] }}
                />
                {periodLabel(w)} {t('hourCost.hoursWord')}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[10px] font-bold normal-case text-slate-500">
            {t('hourCost.footnote')}
          </p>
        </>
      )}
    </div>
  );
}
