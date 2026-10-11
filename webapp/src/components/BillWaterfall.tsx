/**
 * Wave O slice 5b — the attribution waterfall for one billing period.
 *
 * commodity → +delivery → +regulatory → [Total electricity charges] → +HST
 * → −rebate → amount due, drawn so the steps literally add up to the figure
 * the "Your actual bill" panel prints. When the utility's stated total and
 * its own itemized lines disagree, the difference gets its own bar instead of
 * being smoothed away — that is the whole point of drawing a bill as a
 * waterfall rather than listing it.
 *
 * Recharts has no waterfall series, so this is the standard two-bar trick: an
 * invisible `base` bar and a visible `value` bar sharing one stackId. The
 * step geometry (where the base sits for a rising vs a falling step) is
 * decided once, in `billWaterfall`, so the chart only has to colour it.
 */

'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { billWaterfall, type WaterfallKind, type WaterfallStep } from '@/lib/moneyViz';
import type { UsageSummary } from '@/lib/energy';
import { useTranslation } from '@/i18n';

const money = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);

const KIND_COLOR: Record<WaterfallKind, string> = {
  start: '#2563EB',
  add: '#8B5CF6',
  credit: '#059669',
  subtotal: '#FACC15',
  total: '#111111',
};

const KEY_COLOR: Record<string, string> = {
  commodity: '#2563EB',
  delivery: '#8B5CF6',
  regulatory: '#A78BFA',
  tax: '#F59E0B',
  credit: '#059669',
  other: '#FB923C',
  gap: '#FB923C',
  drift: '#FB923C',
  subtotal: '#FACC15',
  payable: '#111111',
};

const colorOf = (step: WaterfallStep) => KEY_COLOR[step.key] ?? KIND_COLOR[step.kind];

type Row = {
  key: string;
  label: string;
  base: number;
  value: number;
  running: number;
  kind: WaterfallKind;
  detail: string;
};

/** Steps are labelled for an axis, so the long ones are shortened here. */
const axisLabel = (step: WaterfallStep, t: (key: string) => string) =>
  step.key === 'subtotal' ? t('wf.subtotalShort') : step.label;

export default function BillWaterfall({ summaries }: { summaries: UsageSummary[] }) {
  const { t } = useTranslation();
  // Newest period first: it is the one whose rates the rest of the app uses.
  const [selected, setSelected] = useState<string>(
    summaries.length > 0 ? summaries[summaries.length - 1].startDate : '',
  );

  const summary = useMemo(() => {
    if (summaries.length === 0) return null;
    return (
      summaries.find((s) => s.startDate === selected) ?? summaries[summaries.length - 1]
    );
  }, [summaries, selected]);

  // `t` in both deps: the lib labels these steps with the module locale, so
  // a language switch has to re-run the chain or the chart keeps English.
  const waterfall = useMemo(
    () => (summary ? billWaterfall(summary) : null),
    // `billWaterfall` reads the module locale; `t` is what changes when the
    // locale does, so it has to be a dep even though eslint cannot see why.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary, t],
  );

  const rows = useMemo<Row[]>(
    () =>
      (waterfall?.steps ?? []).map((s) => ({
        key: s.key,
        label: axisLabel(s, t),
        base: s.base,
        value: s.value,
        running: s.running,
        kind: s.kind,
        detail: s.detail,
      })),
    [waterfall, t],
  );

  if (summaries.length === 0 || !waterfall) return null;

  return (
    <div
      data-testid="money-waterfall"
      className="bg-white p-4 md:p-8 rounded-[1.5rem] md:rounded-[2rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
        {t('wf.eyebrow')}
      </div>
      <h3 className="text-lg md:text-2xl italic font-black">{t('wf.title')}</h3>

      {summaries.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="money-waterfall-picker">
          {summaries.map((s) => (
            <button
              key={s.start}
              type="button"
              aria-pressed={s.startDate === (summary?.startDate ?? '')}
              data-testid={`money-waterfall-pick-${s.startDate}`}
              onClick={() => setSelected(s.startDate)}
              className={`min-h-[44px] px-3 border-2 border-black rounded-lg text-[10px] uppercase font-black ${
                s.startDate === (summary?.startDate ?? '') ? 'bg-yellow-400' : 'bg-slate-50'
              }`}
            >
              {s.startDate}
            </button>
          ))}
        </div>
      )}

      {!waterfall.ready ? (
        <div
          data-testid="money-waterfall-empty"
          className="mt-4 bg-slate-50 border-2 border-dashed border-black rounded-xl p-4 text-[11px] font-bold normal-case text-slate-600"
        >
          {waterfall.reason}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-4 text-[10px] md:text-xs font-black">
            <span className="text-slate-500 uppercase">{t('wf.amountDue')}</span>
            <span className="text-2xl md:text-3xl italic" data-testid="money-waterfall-total">
              {money(waterfall.amountDue)}
            </span>
            <span className="text-slate-500 font-bold normal-case">
              {t('wf.daysNote', { days: summary ? summary.days : 0 })}
            </span>
          </div>

          <div className="mt-3 overflow-x-auto">
            <div
              className="h-[260px] md:h-[300px] min-w-[560px]"
              data-testid="money-waterfall-chart"
              role="img"
              aria-label={t('wf.chartAria', { amount: money(waterfall.amountDue) })}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 40 }}>
                  <XAxis
                    dataKey="label"
                    angle={-25}
                    textAnchor="end"
                    height={60}
                    interval={0}
                    tick={{ fontSize: 9, fontWeight: 900 }}
                    stroke="#000"
                    strokeWidth={2}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fontWeight: 900 }}
                    stroke="#000"
                    strokeWidth={2}
                    width={56}
                    tickFormatter={(v: number | string) => `$${Math.round(Number(v))}`}
                  />
                  <Tooltip
                    cursor={{ fill: '#000', opacity: 0.05 }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const r = (payload.find((p) => p.dataKey === 'value') ?? payload[0])
                        ?.payload as Row | undefined;
                      if (!r) return null;
                      return (
                        <div
                          data-testid="money-waterfall-tooltip"
                          className="border-4 border-black bg-white p-3 shadow-[8px_8px_0px_0px_#000] text-black max-w-[260px]"
                          style={{ pointerEvents: 'none' }}
                        >
                          <div className="text-xs font-black uppercase border-b-2 border-black pb-1 mb-1">
                            {String(label ?? r.label)}
                          </div>
                          <div className="text-[11px] font-black">{money(r.value)}</div>
                          <div className="text-[10px] font-bold text-slate-500 normal-case">
                            {r.detail}
                          </div>
                          <div className="text-[10px] font-black mt-1">
                            {t('wf.running')} {money(r.running)}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="base" stackId="w" fill="transparent" stroke="none" isAnimationActive={false} />
                  <Bar dataKey="value" stackId="w" stroke="#000" strokeWidth={2}>
                    {rows.map((r) => (
                      <Cell
                        key={r.key}
                        fill={KEY_COLOR[r.key] ?? KIND_COLOR[r.kind]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* The same steps as text: the chart is a picture of this list. */}
          <ol className="mt-3 space-y-1 text-[10px] md:text-[11px] font-bold normal-case" data-testid="money-waterfall-steps">
            {waterfall.steps.map((s) => (
              <li key={s.key} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b-2 border-black/10 pb-1">
                <span className="flex items-center gap-2 uppercase font-black">
                  <span
                    aria-hidden
                    className="inline-block w-3 h-3 border-2 border-black shrink-0"
                    style={{ background: colorOf(s) }}
                  />
                  {s.label}
                </span>
                <span className="tabular-nums text-slate-600">{money(s.value)}</span>
                <span className="tabular-nums font-black">→ {money(s.running)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
