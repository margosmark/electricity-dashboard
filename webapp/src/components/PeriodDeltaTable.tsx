/**
 * Wave O slice 4 — period → period change, per charge type.
 *
 * The first column prints that period's OWN figure and is labelled a
 * baseline: a delta against nothing would be an invented number, and with a
 * single period in the file the table says so instead of showing one lonely
 * column of zeros. Money is printed with an explicit sign so "delivery
 * jumped" is a glance, not arithmetic.
 */

'use client';

import { COST_SLICE_META, DELTA_LABEL_KEYS, type DeltaTable as DeltaTableModel } from '@/lib/moneyViz';
import { fmtMoney, useTranslation } from '@/i18n';

const money = (n: number) => (n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n));

/** Colour a change by direction, but only once it is big enough to mean it. */
const changeClass = (v: number | null) => {
  if (v === null || Math.abs(v) < 0.005) return 'text-slate-400';
  return v > 0 ? 'text-red-600' : 'text-emerald-600';
};

export default function PeriodDeltaTable({ table }: { table: DeltaTableModel }) {
  const { t } = useTranslation();
  if (table.rows.length === 0) return null;

  const baselineOnly = !table.hasComparison;

  return (
    <div
      data-testid="money-deltas"
      className="bg-white p-4 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
            {t('delta.eyebrow')}
          </div>
          <h3 className="text-xl md:text-4xl italic font-black">{t('delta.title')}</h3>
        </div>
        <div
          className="text-[10px] md:text-xs font-bold normal-case text-slate-500 max-w-md"
          data-testid="money-deltas-note"
        >
          {table.note}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table
          className="w-full text-[10px] md:text-xs font-black"
          /* One column per transition: 24 periods need real room, so the
             table scrolls instead of squashing every figure to a sliver. */
          style={{ minWidth: 200 + table.columns.length * 96 }}
          data-testid="money-deltas-table"
        >
          <caption className="sr-only">
            {t('delta.caption')}
          </caption>
          <thead>
            <tr className="border-b-4 border-black text-left">
              <th className="py-2 pr-3 uppercase">{t('delta.chargeCol')}</th>
              {table.columns.map((c, i) => (
                <th key={c.start} className="py-2 px-3 text-right uppercase whitespace-nowrap">
                  {i === 0 ? t('delta.baseline', { label: c.label }) : t('delta.arrow', { label: c.label })}
                  {/* A column that is not a real bill says so in the header,
                      so no number under it can be read as a charge. */}
                  {c.kind !== 'billed' && (
                    <span
                      data-testid="money-column-flag"
                      className={`ml-1 inline-block border-2 border-black px-1 rounded text-[8px] ${
                        c.estimated ? 'bg-yellow-400' : 'bg-slate-200'
                      }`}
                    >
                      {c.estimated ? t('delta.estimate') : t('delta.noBill')}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => {
              const strong = row.key === 'total' || row.key === 'payable';
              /* A tier row is only defined for periods billed on that tier:
                 on a TOU period — or in the OPEN column, where the estimate
                 is one blended commodity figure we cannot honestly split —
                 the cell is a dash, never "$0.00" (which would read as "you
                 were charged nothing on tier 1") and never "TIER X" over an
                 amount the utility has not billed yet. */
              const tierRow = row.key === 'tier1' || row.key === 'tier2';
              const meta = COST_SLICE_META[row.key as keyof typeof COST_SLICE_META];
              return (
                <tr
                  key={row.key}
                  data-testid={`money-delta-${row.key}`}
                  className={`border-b-2 border-black/20 ${strong ? 'bg-yellow-50' : ''}`}
                >
                  <td className="py-1.5 pr-3">
                    <span className="flex items-center gap-2">
                      {/* Summary rows carry no slice colour — keep the column
                          flush anyway instead of letting it jump left. */}
                      <span
                        aria-hidden
                        className="inline-block w-3 h-3 border-2 border-black shrink-0"
                        style={{ background: meta?.color ?? 'transparent' }}
                      />
                      <span className={strong ? 'uppercase' : ''}>{t(DELTA_LABEL_KEYS[row.key])}</span>
                    </span>
                  </td>
                  {row.values.map((value, i) => {
                    const delta = row.deltas[i];
                    const column = table.columns[i];
                    const flagged = column && column.kind !== 'billed';
                    return (
                      <td key={i} className="py-1.5 px-3 text-right tabular-nums">
                        {tierRow && Math.abs(value) < 0.005 ? (
                          <span
                            className="text-slate-400"
                            data-testid="money-delta-no-tier"
                            title={t('delta.noTier', { row: t(DELTA_LABEL_KEYS[row.key]) })}
                          >
                            —
                          </span>
                        ) : i === 0 || baselineOnly ? (
                          <span className="text-black">{money(value)}</span>
                        ) : !flagged ? (
                          <span className={changeClass(delta)} data-testid="money-delta-value">
                            {delta !== null && delta > 0 ? '+' : ''}
                            {money(delta ?? 0)}
                          </span>
                        ) : column.kind === 'gap' ? (
                          /* No bill covers these days: there is no change to
                             report, and printing $0.00 would claim one. */
                          <span className="text-slate-400" title={t('delta.gapTitle')}>
                            —
                          </span>
                        ) : (
                          /* The open period: the number itself, marked as an
                             estimate, because a delta against an unbilled
                             window would be two wrongs. A charge that does
                             not exist yet (delivery, HST) prints a dash
                             rather than "~$0.00", which would read like an
                             estimate of zero. */
                          value === 0 ? (
                            <span
                              className="text-slate-400"
                              title={t('delta.notBilledTitle')}
                            >
                              —
                            </span>
                          ) : (
                            <span
                              className="text-amber-700 font-black"
                              data-testid="money-delta-estimate"
                              title={t('delta.estimatedTitle')}
                            >
                              ~{money(value)}
                            </span>
                          )
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* A 24-period table cannot fit on one screen; say so rather than
          leaving a column looking amputated at the right edge. */}
      {table.columns.length > 6 && (
        <div
          data-testid="money-deltas-scroll-hint"
          className="mt-1 text-[9px] font-bold text-slate-400 normal-case"
        >
          {t('delta.scrollHint', { count: table.columns.length })}
        </div>
      )}

      {baselineOnly && (
        <div
          data-testid="money-deltas-baseline"
          className="mt-3 bg-slate-50 border-2 border-black rounded-lg px-3 py-2 text-[10px] md:text-[11px] font-bold normal-case text-slate-600"
        >
          {table.note}
        </div>
      )}
    </div>
  );
}
