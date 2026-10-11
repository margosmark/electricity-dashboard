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

import { ESTIMATE_KEY_LABEL_KEY, type PeriodStack } from '@/lib/moneyViz';
import {
  accuracySummary,
  type EstimateLedger,
} from '@/lib/estimateLedger';
// Wave U — the local money/kwh helpers were hard-wired to en-CA; the shared
// formatters switch with the toggle.
import { fmtCents, fmtKwh, fmtMoney, fmtPercent, useTranslation } from '@/i18n';

const money = (n: number) => (n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n));

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
  const { t } = useTranslation();
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
      className="bg-card p-4 md:p-8 rounded-[1.5rem] md:rounded-[3rem] border-4 border-edge shadow-hard-8 md:shadow-hard-16 text-ink font-black uppercase"
      aria-labelledby="open-period-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4">
            {t(ESTIMATE_KEY_LABEL_KEY)}
          </div>
          <h3 id="open-period-heading" className="text-xl md:text-4xl italic font-black">
            {open ? t('openPeriod.sinceLastBill') : t('openPeriod.trackRecord')}
          </h3>
        </div>
        {open && (
          <span
            data-testid="open-period-badge"
            className="border-4 border-edge bg-yellow-400 px-3 py-1 rounded-lg text-[10px] md:text-xs font-black"
          >
            {t('openPeriod.badge')}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        {billedThrough && (
          <div
            data-testid="billed-through"
            className="border-4 border-edge rounded-xl md:rounded-2xl bg-inset p-3 md:p-5"
          >
            <div className="text-[9px] md:text-[10px] uppercase text-ink-3">
              {t('openPeriod.billedThrough')}
            </div>
            <div className="text-2xl md:text-4xl italic" data-testid="billed-through-date">
              {billedThrough.date}
            </div>
            <div className="text-base md:text-xl" data-testid="billed-through-amount">
              {t('openPeriod.actual', { amount: money(billedThrough.amount) })}
            </div>
            <div className="mt-1 text-[9px] md:text-[11px] font-bold normal-case text-ink-3">
              {t('openPeriod.lineForLine', { label: billedThrough.label })}
            </div>
          </div>
        )}

        {open && (
          <div
            data-testid="unbilled-since"
            className="border-4 border-edge rounded-xl md:rounded-2xl bg-accent-soft p-3 md:p-5"
          >
            <div className="text-[9px] md:text-[10px] uppercase text-ink-3">
              {t('openPeriod.unbilledSince')}
            </div>
            <div className="text-2xl md:text-4xl italic" data-testid="unbilled-since-date">
              {open.startDate}
            </div>
            <div className="text-base md:text-xl" data-testid="unbilled-since-amount">
              {t('openPeriod.estimatedCommodity', { amount: money(estimate) })}
            </div>
            <div className="mt-1 text-[9px] md:text-[11px] font-bold normal-case text-ink-2">
              {t('openPeriod.tailDetail', {
                count: open.days,
                days: open.days,
                kwh: fmtKwh(metered),
                coverage: fmtPercent(Math.round(open.coverage * 100)),
              })}
              {cents ? ` · ${fmtCents(Number(cents))}` : ''}
            </div>
          </div>
        )}
      </div>

      {open && (
        <p
          data-testid="open-period-caveat"
          className="mt-3 text-[10px] md:text-xs font-bold normal-case text-ink-2 border-2 border-edge rounded-lg px-3 py-2 bg-inset"
        >
          {t('openPeriod.caveatA')}{' '}
          <strong className="uppercase">{t('openPeriod.caveatStrong')}</strong>{' '}
          {t('openPeriod.caveatB')}
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
                {summary.meanAccuracy !== null
                  ? t('openPeriod.accurate', { pct: fmtPercent(summary.meanAccuracy) })
                  : '—'}
              </div>
              <div className="text-[10px] md:text-xs font-bold normal-case text-ink-3">
                {t('openPeriod.settled', { count: summary.settled })}
                {summary.allWithinDollar ? ` · ${t('openPeriod.withinDollar')}` : ''}
              </div>
            </div>
            <ul className="mt-2 space-y-1">
              {ledger.closed.map((check) => (
                <li
                  key={check.windowStart}
                  data-testid="estimate-check"
                  className="text-[10px] md:text-xs font-bold normal-case text-ink-2 border-2 border-edge/20 rounded px-2 py-1.5"
                >
                  <span className="font-black uppercase">{check.label}</span>{' '}
                  {t('openPeriod.checkWeSaid')}{' '}
                  <strong>{money(check.estimated)}</strong>,{' '}
                  {t('openPeriod.checkBilled')}{' '}
                  <strong>{money(check.actual)}</strong> (
                  {check.delta > 0 ? '+' : ''}
                  {money(check.delta)}):{' '}
                  <strong data-testid="estimate-check-accuracy">
                    {check.accuracy === null
                      ? t('openPeriod.noScore')
                      : t('openPeriod.checkAccuracy', { pct: fmtPercent(check.accuracy, 1) })}
                  </strong>
                  {check.partial ? ` ${t('openPeriod.partial')}` : ''}.
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div
            data-testid="estimate-accuracy-empty"
            className="text-[10px] md:text-xs font-bold normal-case text-ink-3 border-2 border-dashed border-edge/40 rounded-lg px-3 py-2"
          >
            {t('openPeriod.emptyLedger')}
          </div>
        )}
      </div>

      <div
        className="mt-3 text-[9px] md:text-[10px] font-bold normal-case text-ink-4"
        data-testid="axis-note"
      >
        {axisNote}
      </div>
    </section>
  );
}
