/**
 * Wave O slices 1–3 + 5c — the stacked composition of every billing period.
 *
 * One chart, three states behind one segmented control, because the two
 * toggles the spec asks for are the same control seen from two sides:
 *
 *   DOLLARS — stacked $ per period: commodity split into its own off/mid/on
 *             windows (three adjacent segments are what make a rate pattern
 *             scannable), then delivery, regulatory, HST — and the OEB rebate
 *             rendered BELOW the zero line, which is where a credit belongs
 *             and is the only rendering that does not lie about the total;
 *   % SHARE — the same period as a 100% horizontal bar, so "delivery +
 *             regulatory is N% of the bill" is read off the bar instead of
 *             computed in your head. The rebate is excluded from the
 *             denominator (it is not a charge) and stated underneath;
 *   kWh     — the bill's own per-window usage lines, so cost movement with
 *             steady consumption stops reading like a usage change.
 *
 * The plan overlay (slice 5c) draws the three plans as horizontal reference
 * lines over the SAME covered periods, plus what was actually paid, so the
 * pitch — "here is what you paid, here is what the alternatives would have
 * cost" — is one chart instead of two screens.
 */

'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import {
  COST_SLICE_META,
  COST_SLICE_ORDER,
  shareBreakdown,
  type PeriodStack,
  type PeriodStackKind,
  type PlanId,
  type PlanOverlay,
} from '@/lib/moneyViz';
import PlanBands from '@/components/PlanBands';
import { PLAN_LABEL } from '@/hooks/useSelectedPlan';
import type { PeriodPlanAnnotation } from '@/lib/planTimeline';

type Mode = 'dollars' | 'share' | 'usage';

/** Dash pattern per plan line — the key under the chart draws the same ones. */
const OVERLAY_LINE_STYLE: { plan: PlanId; dash: string }[] = [
  { plan: 'TOU', dash: '1' },
  { plan: 'Tiered', dash: '10 5' },
  { plan: 'ULO', dash: '2 5' },
];

const money = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const kwhFmt = (n: number) =>
  `${n.toLocaleString('en-CA', { maximumFractionDigits: 1 })} kWh`;

/** One row of the chart: fixed metadata + a numeric field per slice. */
type ChartRow = {
  key: number;
  label: string;
  fullLabel: string;
  days?: number;
  coverage: number;
  total: number;
  rebate?: number;
  /** Which slice of the axis the bar is — everything but `billed` is flagged. */
  kind: PeriodStackKind;
  /** True when the money shown is our estimate, never a bill. */
  estimated: boolean;
  [slice: string]: number | string | boolean | undefined;
};

/**
 * The badge every non-billed bar carries, in the chart's table and tooltip.
 * It exists so no hatched bar can ever be read as "you paid this".
 */
const KIND_BADGE: Record<PeriodStackKind, { text: string; cls: string } | null> = {
  billed: null,
  open: { text: 'Estimate', cls: 'bg-yellow-400 border-black' },
  gap: { text: 'No bill', cls: 'bg-slate-200 border-black' },
  derived: { text: 'Billing day', cls: 'bg-slate-200 border-black' },
};

/** Slices that actually occur in this file — the rest get no bar, no chip. */
const present = (
  stacks: PeriodStack[],
  keys: string[],
  read: (s: PeriodStack, k: string) => number,
): string[] => keys.filter((k) => stacks.some((s) => Math.abs(read(s, k)) > 0.005));

type TooltipRow = {
  payload?: ChartRow;
  dataKey?: string | number;
  value?: number | string;
};

function CompositionTooltip({
  active,
  payload,
  mode,
}: {
  active?: boolean;
  payload?: TooltipRow[];
  mode: Mode;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const format = (key: string, value: number) => {
    const meta = COST_SLICE_META[key as keyof typeof COST_SLICE_META];
    const label = meta ? meta.short : key;
    if (mode === 'usage') return `${label}: ${kwhFmt(value)}`;
    if (mode === 'share') return `${label}: ${value.toFixed(1)}%`;
    return `${label}: ${money(value)}`;
  };

  return (
    <div
      data-testid="money-tooltip"
      className="rounded-none border-4 border-black bg-white p-4 shadow-[8px_8px_0px_0px_#000] text-black"
      style={{ pointerEvents: 'none' }}
    >
      <div className="text-xs font-black uppercase mb-2 border-b-2 border-black pb-1">
        {row.fullLabel}
      </div>
      <ul className="space-y-1 text-[11px] font-black">
        {payload.map((p) => (
          <li key={String(p.dataKey)}>{format(String(p.dataKey), Number(p.value))}</li>
        ))}
      </ul>
      {mode !== 'usage' && (
        <div className="mt-2 pt-2 border-t-2 border-black flex justify-between gap-4 text-[11px] font-black">
          <span>
            {row.kind === 'billed' ? 'You paid' : row.kind === 'open' ? 'Estimated' : 'Billed'}
          </span>
          <span>
            {row.kind === 'gap'
              ? '—'
              : `${row.estimated ? '~' : ''}${money(Number(row.total ?? 0))}`}
          </span>
        </div>
      )}
      {row.kind !== 'billed' && (
        <div
          data-testid="money-tooltip-flag"
          className="mt-2 text-[9px] font-black uppercase bg-yellow-100 border-2 border-black px-2 py-1"
        >
          {row.kind === 'open'
            ? 'Estimate — not billed yet (commodity only)'
            : 'No bill in this file covers these days'}
        </div>
      )}
      <div className="mt-1 text-[9px] font-bold text-slate-500">
        Readings cover {Math.round((row.coverage ?? 0) * 100)}% of this period
      </div>
    </div>
  );
}

export type MoneyStackedChartProps = {
  stacks: PeriodStack[];
  /** Modelled plan lines over the covered periods (may be `ready: false`). */
  overlay: PlanOverlay;
  /**
   * Wave P slice 5 — the plan each period was ACTUALLY billed under
   * (detected from the bill, or declared in the timeline). Omitting it (or
   * an empty array) draws no bands and no table column, which is exactly
   * what a feed without bills must do.
   */
  planAnnotations?: PeriodPlanAnnotation[];
};

export default function MoneyStackedChart({ stacks, overlay, planAnnotations }: MoneyStackedChartProps) {
  const [mode, setMode] = useState<Mode>('dollars');
  const [showOverlay, setShowOverlay] = useState(true);

  const share = useMemo(() => shareBreakdown(stacks), [stacks]);

  // Wave P: one band per period with a known plan, keyed by the chart's own
  // category value (the period label) so the annotation rides the bars in
  // every mode. Unknown periods are skipped — nothing honest to tint.
  const planByStart = useMemo(
    () => new Map((planAnnotations ?? []).map((a) => [a.start, a])),
    [planAnnotations],
  );
  const bands = useMemo(
    () =>
      stacks
        .map((s) => {
          const a = planByStart.get(s.start);
          if (!a || a.plan === 'unknown') return null;
          return { key: s.shortLabel, plan: a.plan, origin: a.origin };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null),
    [stacks, planByStart],
  );
  const hasPlanColumn = (planAnnotations ?? []).length > 0;
  /** The plan cell for a row keyed by period start — same lookup as bands. */
  const planLabelFor = (start: number): string => {
    const a = planByStart.get(Number(start));
    if (!a || a.plan === 'unknown') return 'Unknown';
    return PLAN_LABEL[a.plan];
  };

  const costKeys = useMemo(
    () => present(stacks, COST_SLICE_ORDER, (s, k) => s.cost[k as keyof PeriodStack['cost']]),
    [stacks],
  );
  const usageKeys = useMemo(() => {
    const all = ['offPeak', 'midPeak', 'onPeak', 'commodityOther'];
    return present(
      stacks,
      all,
      (s, k) => s.usage?.[k as keyof NonNullable<PeriodStack['usage']>] ?? 0,
    );
  }, [stacks]);
  const usageMissing = stacks.length > 0 && stacks.every((s) => s.usage === null);
  /** Any bar on the timeline that is NOT a bill (the open tail, or a hole). */
  const hasFlagged = stacks.some((s) => s.kind !== 'billed');

  const rows = useMemo<ChartRow[]>(() => {
    if (mode === 'usage') {
      return stacks.map((s) => ({
        key: s.start,
        label: s.shortLabel,
        fullLabel: s.label,
        coverage: s.coverage,
        total: s.totals.payable,
        kind: s.kind,
        estimated: s.estimated,
        offPeak: s.usage?.offPeak ?? 0,
        midPeak: s.usage?.midPeak ?? 0,
        onPeak: s.usage?.onPeak ?? 0,
        commodityOther: s.usage?.commodityOther ?? 0,
      }));
    }
    return stacks.map((s) => {
      const gross = COST_SLICE_ORDER.reduce((n, k) => n + Math.max(0, s.cost[k]), 0);
      const row: ChartRow = {
        key: s.start,
        label: s.shortLabel,
        fullLabel: s.label,
        days: s.days,
        coverage: s.coverage,
        total: s.totals.payable,
        rebate: s.cost.credit,
        kind: s.kind,
        estimated: s.estimated,
      };
      for (const k of costKeys) {
        const v = s.cost[k as keyof PeriodStack['cost']];
        if (mode === 'share') {
          // Shares are of the CHARGES (positives only): a negative share of a
          // 100% stack is a contradiction, so the rebate is stated underneath
          // and contributes 0 here rather than a raw dollar figure.
          row[k] = gross > 0 && v > 0 ? (v / gross) * 100 : 0;
        } else {
          row[k] = v;
        }
      }
      return row;
    });
  }, [stacks, mode, costKeys]);

  // The rebate is a credit, not a charge: it gets no bar in the share view
  // (nothing to share a denominator with) and no kWh column in the usage one.
  const activeKeys =
    mode === 'usage'
      ? usageKeys
      : mode === 'share'
        ? costKeys.filter((k) => k !== 'credit')
        : costKeys;
  const isShare = mode === 'share';

  const modeButton = (id: Mode, label: string, testid: string) => (
    <button
      key={id}
      type="button"
      data-testid={testid}
      aria-pressed={mode === id}
      onClick={() => setMode(id)}
      className={`min-h-[44px] px-3 md:px-4 border-2 border-black text-[10px] md:text-xs font-black uppercase ${
        mode === id ? 'bg-black text-white' : 'bg-white text-black hover:bg-yellow-400'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      data-testid="money-stacked"
      className="bg-white p-4 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3 md:gap-4">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
            {stacks.length} billing period{stacks.length === 1 ? '' : 's'} · straight from your XML
          </div>
          <h3 className="text-xl md:text-4xl italic font-black">
            {mode === 'usage' ? 'What you used, per period' : 'What you paid for, per period'}
          </h3>
        </div>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Money chart mode"
          data-testid="money-mode-group"
        >
          {modeButton('dollars', '$ Dollars', 'money-mode-dollars')}
          {modeButton('share', '% Share', 'money-mode-share')}
          {modeButton('usage', 'kWh Usage', 'money-mode-usage')}
        </div>
      </div>

      {/* Legend: only the slices this file actually contains. */}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2" data-testid="money-legend">
        {activeKeys.map((k) => {
          const meta = COST_SLICE_META[k as keyof typeof COST_SLICE_META];
          return (
            <span
              key={k}
              className="flex items-center gap-2 text-[9px] md:text-[10px] uppercase font-black"
            >
              <span
                aria-hidden
                className="inline-block w-4 h-4 border-2 border-black"
                style={{ background: meta.color }}
              />
              {mode === 'usage' ? `${meta.short} kWh` : meta.label}
            </span>
          );
        })}
        {mode === 'dollars' && (
          <span className="flex items-center gap-2 text-[9px] md:text-[10px] uppercase font-black">
            <span
              aria-hidden
              className="inline-block w-4 h-4 border-2 border-black"
              style={{ background: COST_SLICE_META.credit.color }}
            />
            {COST_SLICE_META.credit.label} — below the line
          </span>
        )}
      </div>

      {mode === 'dollars' && (
        <p
          data-testid="money-chart-caption"
          className="mt-2 text-[10px] font-bold normal-case text-slate-500"
        >
          Each bar is that period&apos;s charges <em>before</em> the rebate; the rebate hangs below
          the axis, so what is left of the pile is what you paid — the exact figure is in the
          tooltip and the table below.
        </p>
      )}

      {mode === 'dollars' && hasFlagged && (
        <p
          data-testid="money-chart-flagged"
          className="mt-2 text-[10px] font-bold normal-case text-slate-500"
        >
          Hatched bars are not bills: the bar badged <strong>Estimate</strong> is your unbilled
          tail (commodity only), and a bar badged <strong>No bill</strong> is a stretch of days no
          bill in this file covers. Solid bars are what you were actually charged.
        </p>
      )}

      {mode === 'usage' && usageMissing && (
        <div
          data-testid="money-usage-empty"
          className="mt-4 bg-slate-100 border-2 border-dashed border-black rounded-lg px-3 py-2 text-[11px] font-bold normal-case text-slate-600"
        >
          This file states no per-window usage lines, so there is no honest kWh stack to draw. The
          dollar view still works — it is read straight off the bill.
        </div>
      )}

      {/* The community question, answered with this household's own numbers. */}
      {mode !== 'usage' && share !== null && (
        <div
          data-testid="money-share-stats"
          className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 text-[10px] md:text-xs"
        >
          <div className="bg-yellow-400 border-2 border-black rounded-lg p-2 md:p-3">
            <div className="text-[8px] uppercase">Delivery + regulatory</div>
            <div className="text-lg md:text-2xl italic" data-testid="non-commodity-pct">
              {share.nonCommodityPct.toFixed(1)}%
            </div>
            <div className="text-[8px] font-bold normal-case">of charges before the rebate</div>
          </div>
          <div className="bg-slate-50 border-2 border-black rounded-lg p-2 md:p-3">
            <div className="text-[8px] uppercase">Electricity itself</div>
            <div className="text-lg md:text-2xl italic" data-testid="commodity-pct">
              {share.commodityPct.toFixed(1)}%
            </div>
            <div className="text-[8px] font-bold normal-case">off/mid/on-peak commodity</div>
          </div>
          <div className="bg-slate-50 border-2 border-black rounded-lg p-2 md:p-3">
            <div className="text-[8px] uppercase">HST</div>
            <div className="text-lg md:text-2xl italic" data-testid="tax-pct">
              {share.taxPct.toFixed(1)}%
            </div>
            <div className="text-[8px] font-bold normal-case">of charges before the rebate</div>
          </div>
          <div className="bg-emerald-100 border-2 border-black rounded-lg p-2 md:p-3">
            <div className="text-[8px] uppercase">Rebate gives back</div>
            <div className="text-lg md:text-2xl italic text-emerald-700" data-testid="rebate-pct">
              {share.rebatePct.toFixed(1)}%
            </div>
            <div className="text-[8px] font-bold normal-case">
              you net {money(share.payable)} across these periods
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <div
          className="h-[300px] md:h-[380px] min-w-[520px]"
          data-testid="money-chart"
          role="img"
          aria-label={
            mode === 'usage'
              ? 'Stacked bar chart of billed kilowatt-hours per billing period'
              : isShare
                ? 'One hundred percent composition bar for each billing period'
                : 'Stacked bar chart of charges per billing period'
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              layout={isShare ? 'vertical' : 'horizontal'}
              margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
            >
              {/* One hatch pattern per slice: a bar drawn in it can never be
                  read as money somebody charged. The pattern keeps the
                  slice's colour, so the open period's off/mid/on-peak split
                  still reads — it is just visibly not solid. */}
              <defs>
                {COST_SLICE_ORDER.map((k) => (
                  <pattern
                    key={k}
                    id={`est-hatch-${k}`}
                    patternUnits="userSpaceOnUse"
                    width="8"
                    height="8"
                    patternTransform="rotate(45)"
                  >
                    <rect width="8" height="8" fill="#FFFFFF" />
                    <rect width="4" height="8" fill={COST_SLICE_META[k].color} />
                  </pattern>
                ))}
              </defs>
              <XAxis
                type={isShare ? 'number' : 'category'}
                dataKey={isShare ? undefined : 'label'}
                domain={isShare ? [0, 100] : undefined}
                unit={isShare ? '%' : undefined}
                /* 24 periods cannot all carry a date label without overlapping
                   itself into mush; show every Nth and let the table below
                   carry the exact dates. */
                interval={rows.length > 8 ? Math.ceil(rows.length / 8) : 0}
                tick={{ fontSize: 11, fontWeight: 900 }}
                stroke="#000"
                strokeWidth={2}
              />
              <YAxis
                type={isShare ? 'category' : 'number'}
                dataKey={isShare ? 'label' : undefined}
                width={isShare ? 96 : 62}
                tick={{ fontSize: 11, fontWeight: 900 }}
                stroke="#000"
                strokeWidth={2}
                unit={!isShare && mode === 'usage' ? ' kWh' : undefined}
                tickFormatter={
                  !isShare && mode === 'dollars'
                    ? (v: number | string) => `$${Math.round(Number(v))}`
                    : undefined
                }
              />
              <Tooltip
                cursor={{ fill: '#000', opacity: 0.05 }}
                content={<CompositionTooltip mode={mode} />}
              />
              {/* Wave P — plan-type background bands (before the bars, so
                  they paint behind them). */}
              {bands.length > 0 && (
                <PlanBands layout={isShare ? 'vertical' : 'horizontal'} bands={bands} />
              )}
              {activeKeys.map((k) => (
                <Bar
                  key={k}
                  dataKey={k}
                  /* The rebate gets its OWN stack group. Shares only stack
                     within a group, so with the credit in the same group d3
                     walks the cumulative total backwards and paints it ON TOP
                     of the positive segments (measured: the −$103.89 slice
                     landed over delivery, not under the axis). A separate
                     group baselines it at zero and hangs it below, which is
                     the only place a credit can honestly go. */
                  stackId={
                    isShare ? 'share' : mode === 'usage' ? 'usage' : k === 'credit' ? 'credit' : 'cost'
                  }
                  fill={COST_SLICE_META[k as keyof typeof COST_SLICE_META].color}
                  stroke="#000"
                  strokeWidth={1}
                >
                  {/* Cell per bar: billed periods keep the solid colour; any
                      other period is drawn hatched with a dashed outline. */}
                  {rows.map((r) => (
                    <Cell
                      key={r.key}
                      fill={
                        r.kind === 'billed'
                          ? COST_SLICE_META[k as keyof typeof COST_SLICE_META].color
                          : `url(#est-hatch-${k})`
                      }
                      stroke="#000"
                      strokeWidth={r.kind === 'billed' ? 1 : 2}
                      strokeDasharray={r.kind === 'billed' ? undefined : '6 4'}
                    />
                  ))}
                </Bar>
              ))}
              {/* Slice 5c — the alternatives, on the same dollars.
                  No text labels on the lines themselves: three plans can land
                  within a few dollars of each other (TOU $394.35 vs Tiered
                  $387.20 on Mark's real bill) and the labels then print on
                  top of each other. Each line gets its own dash pattern and
                  the key under the chart carries the numbers. */}
              {!isShare && mode === 'dollars' && showOverlay && overlay.ready && (
                <>
                  {OVERLAY_LINE_STYLE.map(({ plan, dash }) => {
                    const line = overlay.lines.find((l) => l.plan === plan);
                    if (!line) return null;
                    return (
                      <ReferenceLine
                        key={plan}
                        y={line.perPeriod}
                        stroke="#000"
                        strokeWidth={2}
                        strokeDasharray={dash}
                        /* A plan that costs more than any single period would
                           otherwise be discarded as out-of-range; extend the
                           axis instead of silently not drawing it. */
                        ifOverflow="extendDomain"
                      />
                    );
                  })}
                  <ReferenceLine
                    y={overlay.actualPerPeriod}
                    stroke="#059669"
                    strokeWidth={3}
                    ifOverflow="extendDomain"
                  />
                </>
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Slice 5c control + the honest small print. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[10px] md:text-xs font-black uppercase cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            data-testid="money-overlay-toggle"
            checked={mode === 'dollars' && showOverlay}
            disabled={mode !== 'dollars' || !overlay.ready}
            onChange={(e) => setShowOverlay(e.target.checked)}
            className="w-5 h-5 accent-black"
          />
          Plan overlay — the alternatives, same periods
          {mode !== 'dollars' && (
            <span className="text-[10px] font-bold normal-case text-slate-400">
              (lines only draw over dollars)
            </span>
          )}
        </label>
        {mode === 'dollars' && !overlay.ready && (
          <span
            data-testid="money-overlay-off"
            className="text-[10px] font-bold normal-case text-slate-500 max-w-md"
          >
            {overlay.reason}
          </span>
        )}
      </div>

      {mode === 'dollars' && showOverlay && overlay.ready && (
        <div className="mt-2 space-y-2">
          {/* The lines are keyed by dash pattern, not by an on-chart label —
              two of Mark's plans land $7 apart and the labels collided. */}
          <div
            className="flex flex-wrap gap-x-5 gap-y-1 text-[10px] font-black uppercase"
            data-testid="money-overlay-key"
          >
            {OVERLAY_LINE_STYLE.map(({ plan, dash }) => {
              const line = overlay.lines.find((l) => l.plan === plan);
              if (!line) return null;
              return (
                <span key={plan} className="flex items-center gap-2">
                  <svg width="34" height="10" aria-hidden focusable="false">
                    <line x1="0" y1="5" x2="34" y2="5" stroke="#000" strokeWidth="3" strokeDasharray={dash} />
                  </svg>
                  {line.label} {money(line.perPeriod)}
                  {overlay.covered > 1 ? '/period' : ''}
                  {overlay.covered > 1 ? (
                    <span className="text-slate-500 font-bold normal-case">
                      ({money(line.amount)} total)
                    </span>
                  ) : null}
                </span>
              );
            })}
            <span className="flex items-center gap-2">
              <svg width="34" height="10" aria-hidden focusable="false">
                <line x1="0" y1="5" x2="34" y2="5" stroke="#059669" strokeWidth="4" />
              </svg>
              You paid {money(overlay.actualPerPeriod)}
              {overlay.covered > 1 ? '/period' : ''}
              {overlay.covered > 1 ? (
                <span className="text-slate-500 font-bold normal-case">
                  ({money(overlay.actual)} total)
                </span>
              ) : null}
            </span>
          </div>
          <div className="text-[10px] md:text-[11px] font-bold normal-case text-slate-600 space-y-1">
            <div
              data-testid="money-overlay-lines"
              className="font-black uppercase text-black text-[10px]"
            >
              {overlay.lines.map((l) => `${l.label} ${money(l.amount)}`).join(' · ')} · you paid{' '}
              {money(overlay.actual)}
            </div>
            <div>
              Lines cover {overlay.covered} of {overlay.periods} billing period
              {overlay.periods === 1 ? '' : 's'} (fully-covered ones only), modelled with{' '}
              {overlay.chargesSource === 'bill' ? "your bill's own" : 'your typed'} delivery /
              regulatory / HST rates
              {overlay.rebateRate !== null
                ? ` plus the observed rebate (${(overlay.rebateRate * 100).toFixed(1)}% of the subtotal)`
                : ''}
              .
            </div>
            {overlay.assumptions.map((a) => (
              <div key={a}>— {a}</div>
            ))}
          </div>
        </div>
      )}

      {isShare && share !== null && (
        <div className="mt-3 text-[10px] md:text-[11px] font-bold normal-case text-slate-600">
          Each bar is 100% of that period&apos;s charges <em>before</em> the rebate (a credit has no
          share of a bill — it reduces it). Per dollar charged across these periods:{' '}
          <strong>
            {share.commodityPct.toFixed(1)}¢ electricity · {share.deliveryPct.toFixed(1)}¢ delivery ·{' '}
            {share.regulatoryPct.toFixed(1)}¢ regulatory · {share.taxPct.toFixed(1)}¢ HST
          </strong>
          , then the rebate hands back {share.rebatePct.toFixed(1)}¢.
        </div>
      )}

      {/* Raw numbers, so the chart is never the only way to read the data. */}
      <div className="mt-4 overflow-x-auto" data-testid="money-table">
        <table className="w-full min-w-[560px] text-[10px] md:text-xs font-black">
          <caption className="sr-only">Charges per billing period</caption>
          <thead>
            <tr className="border-b-4 border-black text-left">
              <th className="py-1 pr-2 uppercase">Period</th>
              {hasPlanColumn && (
                <th className="py-1 pr-2 uppercase" data-testid="money-plan-head">
                  Plan
                </th>
              )}
              {activeKeys.map((k) => (
                <th key={k} className="py-1 px-2 uppercase text-right">
                  {COST_SLICE_META[k as keyof typeof COST_SLICE_META].short}
                </th>
              ))}
              <th className="py-1 px-2 uppercase text-right">
                {mode === 'usage' ? 'Billed' : 'You paid'}
              </th>
              <th className="py-1 px-2 uppercase text-right">Covered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const badge = r.kind !== 'billed' ? KIND_BADGE[r.kind] : null;
              return (
              <tr key={r.key} className="border-b-2 border-black/20" data-testid="money-row">
                <td className="py-1 pr-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <span>{r.label}</span>
                    {badge && (
                      <span
                        data-testid="money-row-badge"
                        className={`text-[8px] px-1.5 py-0.5 border-2 rounded ${badge.cls}`}
                      >
                        {badge.text}
                      </span>
                    )}
                  </span>
                </td>
                {hasPlanColumn && (
                  <td className="py-1 pr-2 whitespace-nowrap" data-testid="money-plan-cell">
                    {planLabelFor(Number(r.key))}
                  </td>
                )}
                {activeKeys.map((k) => {
                  const v = Number(r[k] ?? 0);
                  return (
                    <td key={k} className="py-1 px-2 text-right tabular-nums">
                      {mode === 'usage'
                        ? v.toLocaleString('en-CA', { maximumFractionDigits: 1 })
                        : r.kind === 'gap'
                          /* No bill covers these days: every money cell is a
                             dash, because "$0.00 delivery" would claim the
                             utility charged nothing for a period it never
                             billed. */
                          ? '—'
                          : r.estimated && v === 0
                            /* Same honesty for the open period: delivery,
                               regulatory and HST there are not "zero", they
                               do not exist yet. */
                            ? '—'
                            : isShare
                              ? `${v.toFixed(1)}%`
                              : money(v)}
                    </td>
                  );
                })}
                <td className="py-1 px-2 text-right tabular-nums">
                  {mode === 'usage'
                    ? kwhFmt(usageKeys.reduce((n, k) => n + Number(r[k] ?? 0), 0))
                    : r.kind === 'gap'
                      ? '—'
                      : `${r.estimated ? '~' : ''}${money(Number(r.total ?? 0))}`}
                </td>
                <td className="py-1 px-2 text-right tabular-nums">
                  {Math.round((Number(r.coverage ?? 0)) * 100)}%
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
