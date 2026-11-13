/**
 * The MONEY tab's commodity-7 branch (DoD 4/6/7 of t_ace035c5).
 *
 * For a gas dataset the electric money machinery must not run: the stacked
 * chart's plan column, its "Amount paid (incl. HST, less rebate)" payable
 * column (which double-counts HST on gas — P1 would print $180.52 against a
 * stated $175.76), its kWh usage mode, the ¢/kWh histogram, the delta table's
 * "Total electricity charges" row and the waterfall's electric captions.
 *
 * What replaces them is deliberately small and entirely feed-sourced: one
 * table of the two figures the file states per period plus their difference,
 * labeled with the spec's copy (t_860756c3). No derived payable, no bucket
 * sums, no plan columns — the money-honesty contract in one screen.
 */
'use client';

import { fmtMoney, useTranslation } from '@/i18n';
import { billPeriodLabel, type UsageSummary } from '@/lib/energy';
import { gasMoney, isGasSummary } from '@/lib/gasBillUi';

/** Money with the currency symbol; − is U+2212, the app's minus. */
const dollars = (n: number) =>
  n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n);

export default function GasMoneyTable({ summaries }: { summaries: UsageSummary[] }) {
  const { t: translate } = useTranslation();
  const tt = (key: string, params?: Record<string, string | number>) =>
    translate(key, params);
  const rows = summaries.filter(isGasSummary);

  return (
    <section
      data-testid="gas-money-section"
      className="bg-card border border-edge rounded-xl md:rounded-2xl p-4 md:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[10px] md:text-xs tracking-[0.2em] text-ink-4 font-semibold uppercase">
          {tt('gasBill.moneyTitle')}
        </h2>
        <span className="text-[9px] md:text-[10px] text-ink-4 normal-case font-medium">
          {tt('gasBill.granularity')}
        </span>
      </div>

      <div className="mt-3 md:mt-4 overflow-x-auto">
        <table
          className="w-full min-w-[520px] text-[10px] md:text-xs"
          data-testid="gas-money-table"
        >
          <thead>
            <tr className="text-ink-4 uppercase text-left">
              <th className="py-1 pr-2 font-semibold">{tt('money.colPeriod')}</th>
              <th className="py-1 px-2 font-semibold text-right">
                {tt('gasBill.totalGasCharges')}
              </th>
              <th className="py-1 px-2 font-semibold text-right">
                {tt('billnote.amountDue')}
              </th>
              <th className="py-1 px-2 font-semibold text-right">
                {tt('gasBill.difference')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const m = gasMoney(s);
              const delta = m.delta;
              const quiet = delta === null || delta === 0;
              return (
                <tr
                  key={s.start}
                  data-testid="gas-money-row"
                  data-period-start={s.startDate}
                  data-delta={delta !== null ? delta.toFixed(2) : ''}
                  data-reconciliation={
                    delta === null ? 'unknown' : delta !== 0 ? 'unexplained-in-feed' : 'equal'
                  }
                  className={`border-t border-edge-muted ${
                    quiet ? '' : 'bg-warn-soft text-warn font-semibold'
                  }`}
                >
                  <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">
                    {billPeriodLabel(s.start, s.duration)}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {m.total !== null ? dollars(m.total) : '—'}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {m.amountDue !== null ? dollars(m.amountDue) : '—'}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {delta === null
                      ? '—'
                      : delta !== 0
                        ? dollars(delta)
                        : tt('gasBill.differenceEqual')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p
        className="mt-3 text-[10px] md:text-xs text-ink-3 normal-case font-medium"
        data-testid="gas-money-not-summed"
      >
        {tt('gasBill.notSummed')}
      </p>
    </section>
  );
}
