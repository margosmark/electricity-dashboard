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

import { COST_SLICE_META, type DeltaTable as DeltaTableModel } from '@/lib/moneyViz';

const money = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);

/** Colour a change by direction, but only once it is big enough to mean it. */
const changeClass = (v: number | null) => {
  if (v === null || Math.abs(v) < 0.005) return 'text-slate-400';
  return v > 0 ? 'text-red-600' : 'text-emerald-600';
};

export default function PeriodDeltaTable({ table }: { table: DeltaTableModel }) {
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
            Period over period
          </div>
          <h3 className="text-xl md:text-4xl italic font-black">What changed between periods</h3>
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
          style={{ minWidth: 220 + table.columns.length * 110 }}
          data-testid="money-deltas-table"
        >
          <caption className="sr-only">
            Change in each charge type between consecutive billing periods
          </caption>
          <thead>
            <tr className="border-b-4 border-black text-left">
              <th className="py-2 pr-3 uppercase">Charge</th>
              {table.columns.map((c, i) => (
                <th key={c.start} className="py-2 px-3 text-right uppercase">
                  {i === 0 ? `Baseline · ${c.label}` : `Δ ${table.columns[i - 1].label} → ${c.label}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => {
              const strong = row.key === 'total' || row.key === 'payable';
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
                      <span className={strong ? 'uppercase' : ''}>{row.label}</span>
                    </span>
                  </td>
                  {row.values.map((value, i) => {
                    const delta = row.deltas[i];
                    return (
                      <td key={i} className="py-1.5 px-3 text-right tabular-nums">
                        {i === 0 || baselineOnly ? (
                          <span className="text-black">{money(value)}</span>
                        ) : (
                          <span className={changeClass(delta)} data-testid="money-delta-value">
                            {delta !== null && delta > 0 ? '+' : ''}
                            {money(delta ?? 0)}
                          </span>
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
