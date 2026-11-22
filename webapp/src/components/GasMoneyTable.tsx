/**
 * The MONEY tab's commodity-7 branch (DoD 4/6/7 of t_ace035c5; extended by
 * t_a2343a2f with the per-period line disclosure).
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
 *
 * t_a2343a2f added the fifth column: a disclosure per period that opens the
 * bill's OWN line items (the same `gasCharges` grouping the Overview's bill
 * card renders — nonzero money lines plus the three balance lines, with the
 * all-zero lines behind their own toggle, never dropped). A period that
 * states no Amount Due says "not in this import" instead of a bare dash.
 * The table still never sums: `gasBill.notSummed` remains the contract.
 */
'use client';

import { Fragment, useState } from 'react';
import { fmtMoney, useTranslation } from '@/i18n';
import {
  billPeriodLabel,
  classifyBillLine,
  type BillLineClass,
  type UsageSummary,
} from '@/lib/energy';
import { gasCharges, gasMoney, isGasSummary } from '@/lib/gasBillUi';
import { billNoteText } from '@/i18n/billNote';
import { CLASS_STYLE } from './GasBillPeriodCard';

/** Money with the currency symbol; − is U+2212, the app's minus. */
const dollars = (n: number) =>
  n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n);

export default function GasMoneyTable({ summaries }: { summaries: UsageSummary[] }) {
  const { t: translate } = useTranslation();
  const tt = (key: string, params?: Record<string, string | number>) =>
    translate(key, params);
  const rows = summaries.filter(isGasSummary);
  // Which period's line items are open (null = none). One at a time keeps
  // the DOM — and the reader's attention — on a single bill.
  const [openKey, setOpenKey] = useState<number | null>(null);
  const [showZero, setShowZero] = useState(false);

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
          className="w-full min-w-[640px] text-[10px] md:text-xs"
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
              <th className="py-1 px-2 font-semibold text-right">
                {tt('gasBill.linesHeader')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const m = gasMoney(s);
              const delta = m.delta;
              const quiet = delta === null || delta === 0;
              const open = openKey === s.start;
              const period = billPeriodLabel(s.start, s.duration);
              return (
                <Fragment key={s.start}>
                  <tr
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
                    <td className="py-1.5 pr-2 whitespace-nowrap">{period}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {m.total !== null ? dollars(m.total) : '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {m.amountDue !== null ? dollars(m.amountDue) : tt('gasBill.notInImport')}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {delta === null
                        ? '—'
                        : delta !== 0
                          ? dollars(delta)
                          : tt('gasBill.differenceEqual')}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      <button
                        type="button"
                        data-testid="gas-money-lines-toggle"
                        data-period-start={s.startDate}
                        aria-expanded={open}
                        // aria-controls only while the region is actually
                        // rendered: an aria-controls naming an id nothing
                        // paints is the dangling reference axe dings as
                        // `aria-valid-attr-value` (the rule TabNav.tsx
                        // documents and GasBillPeriodCard follows by
                        // carrying no aria-controls at all).
                        aria-controls={open ? `gas-money-lines-${s.start}` : undefined}
                        onClick={() => {
                          setOpenKey(open ? null : s.start);
                          setShowZero(false);
                        }}
                        className="min-h-[36px] px-2 border rounded-lg text-[9px] md:text-[10px] uppercase font-semibold bg-inset border-edge text-ink-2 hover:text-ink"
                      >
                        {open ? tt('gasBill.linesHide') : tt('gasBill.linesShow')}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr
                      data-testid="gas-money-lines"
                      data-period-start={s.startDate}
                      className="border-t border-edge-muted"
                    >
                      <td colSpan={5} className="px-2 pb-3 pt-1">
                        <div
                          id={`gas-money-lines-${s.start}`}
                          role="region"
                          aria-label={tt('gasBill.linesRegion', { period })}
                          className="bg-inset rounded-lg p-3 space-y-2"
                        >
                          <p className="text-[10px] md:text-xs font-black uppercase text-ink-3">
                            {tt('gasBill.chargesTitle')}
                          </p>
                          <LineItems summary={s} showZero={showZero} setShowZero={setShowZero} />
                          <p className="text-[10px] md:text-xs font-medium text-ink-3 normal-case">
                            {tt('gasBill.notSummed')}
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
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

/**
 * The bill's own money lines, feed order: nonzero charges + the three
 * balance lines (the discrepancy evidence, visible even at $0.00), then the
 * all-zero lines behind their own toggle — the same grouping and the same
 * `data-bill-note` contract the Overview's bill card renders, so a line is
 * greppable by the utility's own wording on either surface.
 */
function LineItems({
  summary,
  showZero,
  setShowZero,
}: {
  summary: UsageSummary;
  showZero: boolean;
  setShowZero: (v: boolean) => void;
}) {
  const { t: translate } = useTranslation();
  const tt = (key: string, params?: Record<string, string | number>) =>
    translate(key, params);
  const charges = gasCharges(summary);
  return (
    <>
      <ul className="space-y-1">
        {charges.visible.map((item, i) => {
          const cls: BillLineClass = classifyBillLine(item);
          const lineName = billNoteText(item.note, translate);
          return (
            <li
              key={`${item.note}-${i}`}
              data-testid={`gas-money-line-${cls}`}
              className={`flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5 rounded-md border-l-8 ${CLASS_STYLE[cls]} text-ink text-xs`}
            >
              <span className="min-w-0">
                <span
                  className="uppercase break-words"
                  data-bill-note={item.note}
                  title={lineName === item.note ? undefined : item.note}
                >
                  {lineName}
                </span>
              </span>
              <span className="whitespace-nowrap tabular-nums">
                {item.amount !== null ? dollars(item.amount) : '—'}
              </span>
            </li>
          );
        })}
      </ul>
      {charges.zero.length > 0 && (
        <div data-testid="gas-money-zero-lines" data-count={String(charges.zero.length)}>
          <button
            type="button"
            onClick={() => setShowZero(!showZero)}
            aria-expanded={showZero}
            className="min-h-[36px] px-3 border rounded-lg text-[10px] md:text-xs uppercase font-semibold bg-card border-edge text-ink-2 hover:text-ink"
          >
            {showZero
              ? tt('gasBill.zeroLinesLess')
              : tt('gasBill.zeroLinesMore', { count: charges.zero.length })}
          </button>
          {showZero && (
            <ul className="mt-1 space-y-1">
              {charges.zero.map((item, i) => {
                const cls: BillLineClass = classifyBillLine(item);
                const lineName = billNoteText(item.note, translate);
                return (
                  <li
                    key={`${item.note}-zero-${i}`}
                    data-testid={`gas-money-line-${cls}`}
                    className={`flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1 rounded-md border-l-8 ${CLASS_STYLE[cls]} text-ink-3 text-[10px]`}
                  >
                    <span className="min-w-0">
                      <span
                        className="uppercase break-words"
                        data-bill-note={item.note}
                        title={lineName === item.note ? undefined : item.note}
                      >
                        {lineName}
                      </span>
                    </span>
                    <span className="whitespace-nowrap tabular-nums">
                      {item.amount !== null ? dollars(item.amount) : '—'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
