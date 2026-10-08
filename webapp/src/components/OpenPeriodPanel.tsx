/**
 * The OPEN PERIOD panel — "billed through {date}: $X actual · unbilled since
 * {date}: $Y estimated commodity".
 *
 * The whole point of this panel is the line it refuses to cross: the tail
 * after the last bill is REAL energy at an ESTIMATED commodity price, and
 * delivery / regulatory / HST for those days are not charges yet, so they are
 * never added to make the number look finished. The panel says exactly that,
 * then shows how well the previous guesses did once the utility billed them
 * (the estimate ledger), which is the app scoring itself with no input from
 * anyone.
 */

'use client';

import { ESTIMATE_KEY_LABEL, type PeriodStack } from '@/lib/moneyViz';
import {
  accuracySummary,
  type EstimateLedger,
} from '@/lib/estimateLedger';

const money = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const kwh = (n: number) =>
  `${n.toLocaleString('en-CA', { maximumFractionDigits: 1 })} kWh`;

export type OpenPeriodPanelProps = {
  /** The tail after the last bill — null when every reading is billed. */
  open: PeriodStack | null;
  /** The last REAL bill, for "billed through …". */
  lastBilled: PeriodStack | null;
  /** Settled estimate-vs-bill comparisons, oldest first. */
  ledger: EstimateLedger;
  /** How the timeline was built (de-dupes, gaps, fallback) — printed as is. */
  axisNote: string;
};

export default function OpenPeriodPanel({
  open,
  lastBilled,
  ledger,
  axisNote,
}: OpenPeriodPanelProps) {
  if (!open && ledger.closed.length === 0) return null;

  const summary = accuracySummary(ledger.closed);
  const billedThrough = lastBilled
    ? { date: lastBilled.endDate, amount: lastBilled.totals.payable, label: lastBilled.label }
    : null;
  const estimate = open ? open.totals.payable : 0;
  const metered = open?.usageTotal ?? 0;
  const cents =
    open && metered > 0 ? ((estimate / metered) * 100).toFixed(1) : null;

  return (
    <section
      data-testid="open-period"
      className="bg-white p-4 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] md:shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
      aria-labelledby="open-period-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-slate-400">
            {ESTIMATE_KEY_LABEL}
          </div>
          <h3 id="open-period-heading" className="text-xl md:text-4xl italic font-black">
            {open ? 'Since your last bill' : 'Estimate track record'}
          </h3>
        </div>
        {open && (
          <span
            data-testid="open-period-badge"
            className="border-4 border-black bg-yellow-400 px-3 py-1 rounded-lg text-[10px] md:text-xs font-black"
          >
            Estimate · not billed yet
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        {billedThrough && (
          <div
            data-testid="billed-through"
            className="border-4 border-black rounded-xl md:rounded-2xl bg-slate-50 p-3 md:p-5"
          >
            <div className="text-[9px] md:text-[10px] uppercase text-slate-500">
              Billed through
            </div>
            <div className="text-2xl md:text-4xl italic" data-testid="billed-through-date">
              {billedThrough.date}
            </div>
            <div className="text-base md:text-xl" data-testid="billed-through-amount">
              {money(billedThrough.amount)} actual
            </div>
            <div className="mt-1 text-[9px] md:text-[11px] font-bold normal-case text-slate-500">
              What that bill charged, line for line — {billedThrough.label}.
            </div>
          </div>
        )}

        {open && (
          <div
            data-testid="unbilled-since"
            className="border-4 border-black rounded-xl md:rounded-2xl bg-yellow-50 p-3 md:p-5"
          >
            <div className="text-[9px] md:text-[10px] uppercase text-slate-500">
              Unbilled since
            </div>
            <div className="text-2xl md:text-4xl italic" data-testid="unbilled-since-date">
              {open.startDate}
            </div>
            <div className="text-base md:text-xl" data-testid="unbilled-since-amount">
              {money(estimate)} estimated commodity
            </div>
            <div className="mt-1 text-[9px] md:text-[11px] font-bold normal-case text-slate-600">
              {open.days} days · {kwh(metered)} measured
              {cents ? ` · ${cents}¢/kWh` : ''} · readings cover{' '}
              {Math.round(open.coverage * 100)}% of the window.
            </div>
          </div>
        )}
      </div>

      {open && (
        <p
          data-testid="open-period-caveat"
          className="mt-3 text-[10px] md:text-xs font-bold normal-case text-slate-600 border-2 border-black rounded-lg px-3 py-2 bg-slate-50"
        >
          Only the electricity itself is estimated here. Delivery, regulatory and HST for these
          days are <strong className="uppercase">not billed yet</strong> — they do not exist as
          charges until the utility issues the bill, so this panel will not invent them.
        </p>
      )}

      {/* ---- the loop: what we said, then what they charged -------------- */}
      <div className="mt-4 md:mt-6" data-testid="estimate-track-record">
        {ledger.closed.length > 0 ? (
          <>
            <div className="flex flex-wrap items-baseline gap-3">
              <div
                data-testid="estimate-accuracy"
                className="text-2xl md:text-4xl italic"
              >
                {summary.meanAccuracy !== null ? `${summary.meanAccuracy}%` : '—'} accurate
              </div>
              <div className="text-[10px] md:text-xs font-bold normal-case text-slate-500">
                {summary.settled} estimate{summary.settled === 1 ? '' : 's'} settled against a
                real bill
                {summary.allWithinDollar ? ' · every one within $1' : ''}
              </div>
            </div>
            <ul className="mt-2 space-y-1">
              {ledger.closed.map((check) => (
                <li
                  key={check.windowStart}
                  data-testid="estimate-check"
                  className="text-[10px] md:text-xs font-bold normal-case text-slate-700 border-2 border-black/20 rounded px-2 py-1.5"
                >
                  <span className="font-black uppercase">{check.label}</span> — we said{' '}
                  <strong>{money(check.estimated)}</strong>, Oakville billed{' '}
                  <strong>{money(check.actual)}</strong> (
                  {check.delta > 0 ? '+' : ''}
                  {money(check.delta)}):{' '}
                  <strong data-testid="estimate-check-accuracy">
                    {check.accuracy === null
                      ? 'no commodity line to score against'
                      : `${check.accuracy.toFixed(1)}% accurate`}
                  </strong>
                  {check.partial ? ' (bills prorated to this window)' : ''}.
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div
            data-testid="estimate-accuracy-empty"
            className="text-[10px] md:text-xs font-bold normal-case text-slate-500 border-2 border-dashed border-black/40 rounded-lg px-3 py-2"
          >
            No estimate has been settled yet. The first accuracy figure appears automatically the
            moment an export bills this window — nothing to enter, nothing to remember.
          </div>
        )}
      </div>

      <div
        className="mt-3 text-[9px] md:text-[10px] font-bold normal-case text-slate-400"
        data-testid="axis-note"
      >
        {axisNote}
      </div>
    </section>
  );
}
