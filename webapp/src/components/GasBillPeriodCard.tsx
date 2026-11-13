/**
 * One natural-gas billing period in "Your actual bill" (commodity-7 branch of
 * `ActualBillPanel`, UX spec t_860756c3).
 *
 * Order on the card, straight from the spec's wireframe:
 *
 *   header (feed Amount Due + m³ billed, badge, granularity, skip line)
 *   → discrepancy banner (Δ≠0 only, role="status")
 *   → money group (the two feed figures + their difference, always three rows)
 *   → charges list (listed, never summed, zero-line disclosure)
 *   → rates group (¢/m³, never dollars, never summed)
 *   → volume group (billed / unadjusted / previous usage / meter reads /
 *     interval state A-B-C)
 *   → bill facts (dates, the feed's own days line, factors as reported)
 *
 * Every figure is read from `gasBillUi` — the feed's own lines, never a
 * derived total (`totals.payable` double-counts HST on gas) and never a
 * sum of line items. Every string comes from `gasBill.*`; money and numbers
 * travel as `{param}` filled by `@/i18n` formatters, so fr-CA composes
 * "13,87 $" inside the sentence instead of inheriting "$13.87".
 *
 * `classic` switches only the styling tokens (the classic theme's heavier
 * borders/weights); markup, copy and hooks are identical in both themes so
 * QA inspects one DOM contract.
 */
'use client';

import { useState } from 'react';

import {
  billPeriodLabel,
  classifyBillLine,
  type BillLineClass,
  type PeriodReconciliation,
} from '@/lib/energy';
import {
  gasCharges,
  gasFacts,
  gasInterval,
  gasIntervalState,
  gasMoney,
  gasRates,
  gasSupplier,
  gasVolume,
} from '@/lib/gasBillUi';
import { fmtDate, fmtMoney, fmtNumber, fmtNumberAuto, useTranslation } from '@/i18n';
import { billNoteText } from '@/i18n/billNote';

/** Money WITH the currency symbol — the figures a bill reader checks.
 *  − is U+2212, the app's minus (never an ASCII hyphen). */
const dollars = (n: number) =>
  n < 0 ? `−${fmtMoney(Math.abs(n))}` : fmtMoney(n);

/** Rate lines: signed, 4 decimals (the feed's own precision), bare number —
 *  the ¢/m³ symbol comes from the catalog key beside it. */
const rateNumber = (n: number): string =>
  n < 0 ? `−${fmtNumber(Math.abs(n), 4)}` : fmtNumber(n, 4);

const CLASS_STYLE: Record<BillLineClass, string> = {
  commodity: 'border-l-8 border-info-edge',
  delivery: 'border-l-8 border-ulo',
  regulatory: 'border-l-8 border-ulo',
  tax: 'border-l-8 border-warn',
  credit: 'border-l-8 border-good',
  total: 'border-l-8 border-edge bg-accent-soft',
  info: 'border-l-8 border-track',
  other: 'border-l-8 border-warn',
};

type Style = {
  card: string;
  sectionTitle: string;
  rowStrong: string;
  chip: string;
  muted: string;
  caption: string;
  factRow: string;
};

const MODERN: Style = {
  card: 'border border-edge rounded-xl md:rounded-2xl bg-card p-4 md:p-6',
  sectionTitle: 'text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4 font-semibold uppercase',
  rowStrong: 'font-semibold text-xs md:text-sm',
  chip: 'border border-edge-muted',
  muted: 'text-ink-3',
  caption: 'text-[9px] md:text-[10px] text-ink-4 normal-case font-medium',
  factRow: 'font-medium text-xs md:text-sm',
};

const CLASSIC: Style = {
  card: 'border-4 border-edge rounded-xl md:rounded-2xl bg-card p-4 md:p-6',
  sectionTitle: 'text-[8px] md:text-[10px] tracking-[0.2em] text-ink-4 font-black uppercase',
  rowStrong: 'font-black text-xs md:text-sm',
  chip: 'border-2 border-edge',
  muted: 'text-ink-3',
  caption: 'text-[9px] md:text-[10px] text-ink-4 normal-case font-bold',
  factRow: 'font-bold text-xs md:text-sm',
};

/** Section heading: short rule + the exact catalog copy. */
function SectionTitle({ children, style }: { children: string; style: string }) {
  return (
    <div className="mt-4 md:mt-6 mb-2 flex items-center gap-2">
      <h4 className={style}>{children}</h4>
      <span aria-hidden className="h-px flex-1 bg-edge-muted" />
    </div>
  );
}

/** A label/value row that wraps instead of truncating (390 px contract). */
function LineRow({
  label,
  value,
  caption,
  testId,
  dataAttrs,
  className = '',
  style,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  caption?: React.ReactNode;
  testId?: string;
  dataAttrs?: Record<string, string>;
  className?: string;
  style: Style;
}) {
  return (
    <div
      data-testid={testId}
      {...(dataAttrs ?? {})}
      className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-1.5 md:py-2 rounded-md ${className}`}
    >
      <span className="min-w-0">
        <span className={`uppercase break-words ${style.rowStrong}`}>{label}</span>
        {caption ? <span className={`block ${style.caption}`}>{caption}</span> : null}
      </span>
      <span className="whitespace-nowrap tabular-nums font-semibold text-xs md:text-sm">
        {value}
      </span>
    </div>
  );
}

export default function GasBillPeriodCard({
  rec,
  classic = false,
}: {
  rec: PeriodReconciliation;
  classic?: boolean;
}) {
  const { t: translate } = useTranslation();
  const [showZero, setShowZero] = useState(false);
  const style = classic ? CLASSIC : MODERN;
  const { summary } = rec;
  const tt = (key: string, params?: Record<string, string | number>) =>
    translate(key, params);

  const bill = gasMoney(summary);
  const charges = gasCharges(summary);
  const rates = gasRates(summary);
  const volume = gasVolume(summary);
  const facts = gasFacts(summary);
  const state = gasIntervalState(summary);
  const interval = gasInterval(summary);
  const supplier = gasSupplier(summary);
  const delta = bill.delta;

  const skip =
    'mt-3 md:mt-4 bg-hover border border-edge-muted rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-semibold text-ink-2 normal-case';

  return (
    <div
      data-testid="gas-period"
      data-period-start={summary.startDate}
      className={style.card}
    >
      {/* ---- header: the feed's own headline, never a derived payable ---- */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <div className="font-semibold uppercase text-base md:text-xl">
            {billPeriodLabel(summary.start, summary.duration)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 normal-case">
            <span
              data-testid="gas-badge"
              className={`inline-block px-2 py-0.5 rounded-md bg-inv text-accent-yellow text-[9px] md:text-[10px] font-bold uppercase tracking-[0.12em] ${style.chip}`}
            >
              {tt('gasBill.commodity')}
            </span>
            <span className={`text-[10px] md:text-xs font-semibold ${style.muted}`}>
              {supplier !== null
                ? supplier === 'Enbridge Gas Distribution'
                  ? tt('gasBill.supplier')
                  : supplier
                : null}
              {supplier !== null ? ' · ' : ''}
              {tt('gasBill.badgeMonthly')}
            </span>
          </div>
          <div className={`mt-1 text-[10px] md:text-xs font-medium ${style.muted} normal-case`}>
            {tt('gasBill.granularity')}
          </div>
        </div>
        <div className="text-right">
          <div className="font-semibold text-lg md:text-xl tabular-nums" data-testid="gas-amount-due">
            {bill.amountDue !== null ? dollars(bill.amountDue) : '—'}
          </div>
          <div
            className="text-[10px] md:text-xs text-ink-3 font-medium tabular-nums"
            data-testid="gas-header-volume"
          >
            {tt('gasBill.headerVolume', {
              volume: volume.billed !== null ? fmtNumber(volume.billed, 1) : '—',
            })}
          </div>
        </div>
      </div>

      {/* ---- electricity-only checks, replaced by the explicit skip ---- */}
      <div data-testid="gas-skip-electricity" className={skip}>
        {tt('gasBill.notComparedGas')}
      </div>

      {/* ---- the discrepancy: data, not an event (role=status) ---------- */}
      {delta !== null && delta !== 0 && (
        <div
          data-testid="gas-unexplained-banner"
          role="status"
          data-reconciliation="unexplained-in-feed"
          className="mt-3 md:mt-4 bg-warn-soft border border-warn rounded-lg px-3 py-2 md:px-4 md:py-3 text-[11px] md:text-xs font-semibold text-warn normal-case"
        >
          <div className="uppercase tracking-[0.08em]">{tt('gasBill.unexplainedTitle')}</div>
          <p className="mt-1 font-medium">
            {tt('gasBill.unexplainedBody', { delta: dollars(delta) })}
          </p>
        </div>
      )}

      {/* ---- money, exactly as the file reports it ---------------------- */}
      <SectionTitle style={style.sectionTitle}>{tt('gasBill.moneyTitle')}</SectionTitle>
      <div className="space-y-1 md:space-y-2">
        <LineRow
          style={style}
          className="bg-inset font-semibold"
          label={
            <>
              {tt('billnote.amountDue')}
              <span className={`ml-2 text-[9px] normal-case font-medium ${style.muted}`}>
                {tt('gasBill.asReported')}
              </span>
            </>
          }
          value={bill.amountDue !== null ? dollars(bill.amountDue) : '—'}
        />
        <LineRow
          style={style}
          testId="gas-total-charges"
          className="bg-inset font-semibold"
          label={
            <>
              {tt('gasBill.totalGasCharges')}
              <span className={`ml-2 text-[9px] normal-case font-medium ${style.muted}`}>
                {tt('gasBill.asReported')}
              </span>
            </>
          }
          value={bill.total !== null ? dollars(bill.total) : '—'}
        />
        <LineRow
          style={style}
          testId="gas-difference"
          dataAttrs={{
            'data-delta': delta !== null ? delta.toFixed(2) : '',
            'data-reconciliation':
              delta === null ? 'unknown' : delta !== 0 ? 'unexplained-in-feed' : 'equal',
          }}
          className={
            delta !== null && delta !== 0
              ? 'bg-warn-soft border border-warn text-warn font-semibold'
              : 'font-medium'
          }
          label={tt('gasBill.difference')}
          value={
            delta === null
              ? '—'
              : delta !== 0
                ? dollars(delta)
                : tt('gasBill.differenceEqual')
          }
        />
      </div>

      {/* ---- charges: listed, never summed ------------------------------ */}
      <SectionTitle style={style.sectionTitle}>{tt('gasBill.chargesTitle')}</SectionTitle>
      <p
        data-testid="gas-not-summed"
        className={`text-[10px] md:text-xs font-medium ${style.muted} normal-case`}
      >
        {tt('gasBill.notSummed')}
      </p>
      <ul className="mt-2 space-y-1 md:space-y-2">
        {charges.visible.map((item, i) => {
          const cls = classifyBillLine(item);
          const lineName = billNoteText(item.note, translate);
          return (
            <li
              key={`${item.note}-${i}`}
              data-testid={`bill-line-${cls}`}
              className={`flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5 md:py-2 rounded-md border-l-8 ${CLASS_STYLE[cls]} ${style.rowStrong} text-xs md:text-sm`}
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
        <div className="mt-2" data-testid="gas-zero-lines" data-count={String(charges.zero.length)}>
          <button
            type="button"
            onClick={() => setShowZero((v) => !v)}
            aria-expanded={showZero}
            className={`min-h-[44px] px-3 border rounded-lg text-[10px] md:text-xs uppercase font-semibold bg-inset ${style.chip} ${style.muted}`}
          >
            {showZero
              ? tt('gasBill.zeroLinesLess')
              : tt('gasBill.zeroLinesMore', { count: charges.zero.length })}
          </button>
          {showZero && (
            <ul className="mt-2 space-y-1 md:space-y-2">
              {charges.zero.map((item, i) => {
                const cls = classifyBillLine(item);
                const lineName = billNoteText(item.note, translate);
                return (
                  <li
                    key={`${item.note}-${i}`}
                    data-testid={`bill-line-${cls}`}
                    className={`flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5 md:py-2 rounded-md border-l-8 ${CLASS_STYLE[cls]} text-[10px] md:text-[11px] text-ink-3 font-medium`}
                  >
                    <span className="min-w-0">
                      {/* Same contract as the visible list above: the label is
                          localized, the file's own wording rides the node and
                          the tooltip — a collapsed line must stay as checkable
                          as a listed one. */}
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

      {/* ---- rates: price per cubic metre, never a charge --------------- */}
      <SectionTitle style={style.sectionTitle}>{tt('gasBill.ratesTitle')}</SectionTitle>
      <div data-testid="gas-rates" className="space-y-1 md:space-y-2">
        {rates.map((item, i) => {
          const lineName = billNoteText(item.note, translate);
          return (
            <LineRow
              key={`${item.note}-${i}`}
              style={style}
              className="bg-inset"
              label={
                <span data-bill-note={item.note} title={lineName === item.note ? undefined : item.note}>
                  {lineName}
                </span>
              }
              value={
                <>
                  {rateNumber(item.amount ?? 0)} {tt('gasBill.rateUnit')}
                </>
              }
            />
          );
        })}
      </div>

      {/* ---- volume: three legitimate numbers, each labeled as such ----- */}
      <SectionTitle style={style.sectionTitle}>{tt('gasBill.volumeTitle')}</SectionTitle>
      <div className="space-y-1 md:space-y-2">
        <LineRow
          style={style}
          testId="gas-volume-billed"
          dataAttrs={{ 'data-m3': volume.billed !== null ? volume.billed.toFixed(1) : '' }}
          className="bg-inset font-semibold"
          label={tt('gasBill.billedVolume')}
          value={
            <>
              {volume.billed !== null ? fmtNumber(volume.billed, 1) : '—'} {tt('gasBill.m3Unit')}
            </>
          }
          caption={
            facts.adjustment !== null
              ? tt('gasBill.adjustmentNote', {
                  factor: fmtNumberAuto(facts.adjustment.measurement?.scaled ?? 0, 4),
                })
              : undefined
          }
        />
        {volume.unadjusted !== null && (
          <LineRow
            style={style}
            testId="gas-volume-unadjusted"
            className="font-medium"
            label={billNoteText('Usage (unadjusted)', translate)}
            value={
              <>
                {fmtNumberAuto(volume.unadjusted, 3)} {tt('gasBill.m3Unit')}
              </>
            }
          />
        )}
        {/* The feed's own prior-period figure, as reported: this document
            states it (as 0) in every period and no other group printed it, so
            a reader could not check the line at all. The caption is what keeps
            the stated 0 from reading as our claim that nobody used gas — the
            number is the file's, never derived and never used as this
            period's volume. Absent line → no row (see `gasVolume`). */}
        {volume.previousUsage !== null && (
          <LineRow
            style={style}
            testId="gas-volume-previous"
            className="font-medium"
            label={
              <>
                {billNoteText('Previous Usage consumption', translate)}
                <span className={`ml-2 text-[9px] normal-case font-medium ${style.muted}`}>
                  {tt('gasBill.asReported')}
                </span>
              </>
            }
            value={
              <>
                {fmtNumberAuto(volume.previousUsage, 3)} {tt('gasBill.m3Unit')}
              </>
            }
          />
        )}
        {volume.reads !== null && (
          <LineRow
            style={style}
            testId="gas-volume-reads"
            className="font-medium"
            label={tt('gasBill.meterReads')}
            value={
              <>
                {fmtNumber(volume.reads.previous, 3)} → {fmtNumber(volume.reads.current, 3)}{' '}
                {tt('gasBill.m3Unit')}
              </>
            }
            caption={tt('gasBill.readDifference', {
              volume: fmtNumberAuto(volume.reads.delta, 1),
            })}
          />
        )}

        {/* interval state A / B / C — absence is a sentence, never 0 m³ */}
        <div
          data-testid="gas-interval-state"
          data-state={state}
          className={`px-3 py-2 md:py-3 rounded-md ${
            state === 'absent' ? 'bg-inset border border-dashed border-edge-muted' : 'bg-inset'
          }`}
        >
          {state === 'present' && interval ? (
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className={`uppercase break-words ${style.rowStrong}`}>
                {tt('gasBill.intervalReading')}
              </span>
              <span className="whitespace-nowrap tabular-nums font-semibold text-xs md:text-sm">
                {fmtNumber(interval.m3, 1)} {tt('gasBill.m3Unit')}
                <span className={`ml-2 text-[10px] font-medium ${style.muted} normal-case`}>
                  {tt('gasBill.intervalRange', {
                    start: fmtDate(interval.timestamp * 1000, 'd MMM'),
                    end: fmtDate((interval.timestamp + interval.duration_s) * 1000, 'd MMM'),
                  })}
                </span>
              </span>
            </div>
          ) : state === 'stub' && interval ? (
            <p className={`text-[11px] md:text-xs normal-case ${style.muted}`}>
              {tt('gasBill.intervalStub', {
                start: fmtDate(interval.timestamp * 1000, 'd MMM'),
                end: fmtDate((interval.timestamp + interval.duration_s) * 1000, 'd MMM'),
              })}
            </p>
          ) : (
            <p className={`text-[11px] md:text-xs normal-case ${style.muted}`}>
              {tt('gasBill.intervalAbsent')}
            </p>
          )}
        </div>
      </div>

      {/* ---- bill facts: the file's own numbers, as reported ------------ */}
      <SectionTitle style={style.sectionTitle}>{tt('gasBill.factsTitle')}</SectionTitle>
      <div className="space-y-1 md:space-y-2">
        {(facts.billDate !== null || facts.dueDate !== null) && (
          <LineRow
            style={style}
            className="font-medium"
            label={
              <>
                {facts.billDate !== null && lineLabel('Bill Date', summary, translate)}
                {facts.billDate !== null && facts.dueDate !== null ? ' · ' : ''}
                {facts.dueDate !== null && lineLabel('Due Date', summary, translate)}
              </>
            }
            value={
              <>
                {facts.billDate !== null ? fmtDate(facts.billDate * 1000, 'yyyy-MM-dd') : '—'}
                {' · '}
                {facts.dueDate !== null ? fmtDate(facts.dueDate * 1000, 'yyyy-MM-dd') : '—'}
              </>
            }
          />
        )}
        {(facts.readStart !== null || facts.readEnd !== null) && (
          <LineRow
            style={style}
            className="font-medium"
            label={
              <>
                {facts.readStart !== null && lineLabel('Billing Period - Previous Read Date', summary, translate)}
                {facts.readStart !== null && facts.readEnd !== null ? ' → ' : ''}
                {facts.readEnd !== null && lineLabel('Billing Period - Current Read Date', summary, translate)}
              </>
            }
            value={
              <>
                {facts.readStart !== null ? fmtDate(facts.readStart * 1000, 'yyyy-MM-dd') : '—'}
                {' → '}
                {facts.readEnd !== null ? fmtDate(facts.readEnd * 1000, 'yyyy-MM-dd') : '—'}
              </>
            }
          />
        )}
        {facts.days !== null && (
          <LineRow
            style={style}
            className="font-medium"
            label={billNoteText(facts.days.note, translate)}
            value={fmtNumber(facts.days.measurement?.scaled ?? 0, 0)}
            caption={tt('gasBill.daysNote')}
          />
        )}
        {(facts.adjustment !== null || facts.pressure !== null) && (
          <LineRow
            style={style}
            className="font-medium"
            label={
              <>
                {facts.adjustment !== null && billNoteText(facts.adjustment.note, translate)}
                {facts.adjustment !== null && facts.pressure !== null ? ' · ' : ''}
                {facts.pressure !== null && billNoteText(facts.pressure.note, translate)}
              </>
            }
            value={
              <>
                {facts.adjustment !== null
                  ? fmtNumberAuto(facts.adjustment.measurement?.scaled ?? 0, 4)
                  : '—'}
                {' · '}
                {facts.pressure !== null
                  ? fmtNumberAuto(facts.pressure.measurement?.scaled ?? 0, 2)
                  : '—'}
              </>
            }
          />
        )}
      </div>
    </div>
  );
}

/** A utility line's localized name (catalog, else verbatim) — used inside
 *  composite labels where the whole row cannot take `data-bill-note`. */
function lineLabel(
  note: string,
  summary: PeriodReconciliation['summary'],
  translate: (key: string, params?: Record<string, string | number>) => string,
): string {
  const item = summary.items.find((i) => i.note.trim() === note);
  return item ? billNoteText(item.note, translate) : note;
}
