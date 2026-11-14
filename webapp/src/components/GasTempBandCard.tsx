/**
 * Gas usage vs outdoor temperature (t_909aa5fa) — the gas twin of
 * `TempBandCard.tsx` (Wave T), drawn the SAME way on purpose: the same seven
 * fixed `TEMP_BANDS`, the same hand-drawn SVG (the Recharts chunk stays off
 * this card entirely), the same share strip under the bars, and every number
 * drawn is also printed as text — the sr-only table is the repo's chart
 * a11y pattern, so nothing here needs a hover to be read.
 *
 * THE SHAPE IT EXPECTS, AND WHY IT IS NOT THE ELECTRIC ONE: electricity's
 * card goes flat in the cold and triples in the heat (that house heats with
 * gas); this card should do the opposite — a heavy coldest band falling to a
 * mild-weather baseline — because gas is the heating fuel. The verdict
 * sentence says the ratio out loud either way, so the card never asserts a
 * shape the household's own meter does not show.
 *
 * Binning semantics live in `lib/gasTempBands.ts` (interval means, m³/day,
 * the two honest drop counters). This file only paints them and owns the
 * states: loading while the browser asks Open-Meteo, the shared honest
 * "no temperature data" error, the "nothing to band" empty, the honest
 * bill-only granularity note, and the footer that names the weather source
 * and the matched-hours coverage.
 *
 * FEED SCOPE (source-scanned in `GasChart.test.tsx` alongside the rest of
 * the gas section): props only — `points`/`summaries` arrive from the
 * dashboard's gas bucket. The temperature series comes from
 * `useHourlyTemps`, the SAME hook and the same Open-Meteo cache the
 * electricity side uses, fetched over the gas data's own span; this file
 * never touches a storage key itself, so it cannot be fed the other
 * commodity's numbers. No kWh token, no currency, no price exists anywhere
 * in this file: the unit on screen is m³, per day.
 */
'use client';

import { useMemo } from 'react';
import { Thermometer } from 'lucide-react';

import { fmtNumber, useTranslation } from '@/i18n';
import { OPEN_METEO, type TempFetchStatus } from '@/lib/openMeteo';
import { TEMP_BANDS } from '@/lib/tempBands';
import { gasTempBandEmpty, type GasTempBandReport } from '@/lib/gasTempBands';
import { usePrefersReducedMotion } from './GasChartPanel';

export type GasTempBandCardProps = {
  report: GasTempBandReport;
  status: 'idle' | TempFetchStatus;
  loading: boolean;
  /** Where the temperature series came from, for the honest footer. */
  source: 'cache' | 'network' | null;
  /** `Oct 6, 2024 – Oct 6, 2026`: the DATES the fetch was limited to. */
  spanLabel?: string | null;
};

const W = 720;
const H = 226;
const PAD = { top: 26, right: 12, bottom: 0, left: 44 };
const BASELINE = 150;
const SHARE_TOP = 166;
const SHARE_MAX_H = 22;
/** Same thermometer ramp as the electricity card — same bins, same axis. */
const BAR_FILL = [
  'var(--temp-band-1)',
  'var(--temp-band-2)',
  'var(--temp-band-3)',
  'var(--temp-band-4)',
  'var(--temp-band-5)',
  'var(--temp-band-6)',
  'var(--temp-band-7)',
];

/**
 * The axis tick under each bar is prose ("-10 to 5", "over 30"), so it
 * translates through the SHARED `tempBand.band*` keys: the two cards bin
 * identically, so the two cards name the bins identically.
 */
const BAND_LABEL_KEY: Record<string, string> = {
  'lt-10': 'tempBand.bandLt10',
  '-10..5': 'tempBand.band10to5',
  '5..12': 'tempBand.band5to12',
  '12..18': 'tempBand.band12to18',
  '18..24': 'tempBand.band18to24',
  '24..30': 'tempBand.band24to30',
  'gt-30': 'tempBand.bandGt30',
};

function bandLabel(t: (key: string) => string, bandId: string, fallback: string): string {
  return t(BAND_LABEL_KEY[bandId] ?? '') || fallback;
}

function Chart({ report }: { report: GasTempBandReport }) {
  const { t } = useTranslation();
  const geo = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const step = innerW / TEMP_BANDS.length;
    // eslint-disable-next-line no-restricted-syntax -- report.rows is one row per TEMP_BANDS bin: 7 by construction
    const peak = Math.max(...report.rows.map((r) => r.meanM3PerDay), 0.001);
    const top = Math.ceil(peak * 10) / 10 + 0.2;
    // eslint-disable-next-line no-restricted-syntax -- report.rows is one row per TEMP_BANDS bin: 7 by construction
    const maxShare = Math.max(...report.rows.map((r) => r.shareOfM3), 0.0001);
    const x = (i: number) => PAD.left + step * i + step / 2;
    const barW = Math.min(64, step * 0.62);
    const y = (v: number) => BASELINE - ((v / top) * (BASELINE - PAD.top));
    return { step, top, maxShare, x, barW, y };
  }, [report]);

  const { top, maxShare, x, barW, y } = geo;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      aria-hidden="true"
      data-testid="gas-temp-band-chart"
      data-bands={report.rows.length}
      data-matched-intervals={report.matchedIntervals}
      data-total-intervals={report.totalIntervals}
    >
      {/* Y grid: two labelled ticks, enough to read a bar height by eye. */}
      {[top / 2, top].map((v) => (
        <g key={v}>
          <line x1={PAD.left} y1={y(v)} x2={W - PAD.right} y2={y(v)} stroke="var(--grid)" strokeWidth={1} />
          <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fontWeight={900} fill="var(--ink-3)">
            {fmtNumber(v, 1)}
          </text>
        </g>
      ))}
      <line x1={PAD.left} y1={BASELINE} x2={W - PAD.right} y2={BASELINE} stroke="var(--ink)" strokeWidth={2} />
      <text x={PAD.left - 6} y={BASELINE + 4} textAnchor="end" fontSize={10} fontWeight={900} fill="var(--ink)">
        0
      </text>

      {/* The bars: mean m³ per day for intervals that cold. */}
      {report.rows.map((row, i) => {
        const h = Math.max(0, BASELINE - y(row.meanM3PerDay));
        return (
          <g key={row.band.id}>
            <rect
              x={x(i) - barW / 2}
              y={BASELINE - h}
              width={barW}
              height={h}
              fill={BAR_FILL[i]}
              stroke="var(--ink)"
              strokeWidth={2}
              data-testid="gas-temp-band-bar"
              data-band={row.band.id}
              data-label={row.band.label}
              data-intervals={row.intervals}
              data-days={row.days.toFixed(2)}
              data-mean-perday={row.meanM3PerDay.toFixed(3)}
              data-share={row.shareOfM3.toFixed(4)}
              data-mean-temp={row.meanTempC.toFixed(1)}
            />
            {row.intervals > 0 && (
              <text
                x={x(i)}
                y={y(row.meanM3PerDay) - 6}
                textAnchor="middle"
                fontSize={11}
                fontWeight={900}
                fill="var(--ink)"
              >
                {fmtNumber(row.meanM3PerDay, 1)}
              </text>
            )}
            {/* Share of the matched volume — where the m³ actually sits. */}
            <rect
              x={x(i) - barW / 2}
              y={SHARE_TOP + SHARE_MAX_H - Math.max(1.5, (row.shareOfM3 / maxShare) * SHARE_MAX_H)}
              width={barW}
              height={Math.max(1.5, (row.shareOfM3 / maxShare) * SHARE_MAX_H)}
              fill="var(--chart-pace)"
              stroke="var(--ink)"
              strokeWidth={1.5}
              data-testid="gas-temp-band-share"
              data-band={row.band.id}
            />
            <text x={x(i)} y={SHARE_TOP + SHARE_MAX_H + 13} textAnchor="middle" fontSize={10} fontWeight={900} fill="var(--ink)">
              {row.intervals > 0 ? `${Math.round(row.shareOfM3 * 100)}%` : ''}
            </text>
            <text x={x(i)} y={SHARE_TOP + SHARE_MAX_H + 27} textAnchor="middle" fontSize={10} fontWeight={900} fill="var(--ink-3)">
              {bandLabel(t, row.band.id, row.band.label)}
            </text>
          </g>
        );
      })}

      {/* Axis titles, because a bar height without a unit is a rumour. */}
      <text x={PAD.left} y={14} fontSize={10} fontWeight={900} fill="var(--ink)">
        {t('gasTempBand.axisM3')}
      </text>
      <text x={W - PAD.right} y={SHARE_TOP - 4} textAnchor="end" fontSize={10} fontWeight={900} fill="var(--ink)">
        {t('gasTempBand.axisShare')}
      </text>
    </svg>
  );
}

/** The text alternative: every plotted number, in the DOM without hover. */
export function GasTempBandDataTable({ report }: { report: GasTempBandReport }) {
  const { t } = useTranslation();
  return (
    <table className="sr-only" data-testid="gas-temp-band-table">
      <caption>{t('gasTempBand.tableCaption')}</caption>
      <thead>
        <tr>
          <th>{t('gasTempBand.colBand')}</th>
          <th>{t('gasTempBand.colIntervals')}</th>
          <th>{t('gasTempBand.colDays')}</th>
          <th>{t('gasTempBand.colM3Day')}</th>
          <th>{t('gasTempBand.colMeanTemp')}</th>
          <th>{t('gasTempBand.colShare')}</th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <tr key={row.band.id} data-band={row.band.id}>
            <th scope="row">{bandLabel(t, row.band.id, row.band.label)}</th>
            <td>{row.intervals}</td>
            <td>{fmtNumber(row.days, 1)}</td>
            <td>{row.intervals > 0 ? fmtNumber(row.meanM3PerDay, 2) : '—'}</td>
            <td>{row.intervals > 0 ? fmtNumber(row.meanTempC, 1) : '—'}</td>
            <td>{row.intervals > 0 ? `${Math.round(row.shareOfM3 * 100)}%` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function GasTempBandCard({
  report,
  status,
  loading,
  source,
  spanLabel,
}: GasTempBandCardProps) {
  const { t } = useTranslation();
  const reduceMotion = usePrefersReducedMotion();
  const empty = gasTempBandEmpty(report);
  const fetching = loading || status === 'idle';
  const noVolume = report.source === 'none';
  const sourceNote =
    report.source === 'interval'
      ? t('gasTempBand.sourceInterval')
      : report.source === 'billed'
        ? t('gasTempBand.sourceBilled')
        : null;

  return (
    <section
      data-testid="gas-temp-band-card"
      data-status={status}
      data-source={source ?? 'none'}
      data-band-source={report.source}
      data-matched={report.matchedIntervals}
      data-total={report.totalIntervals}
      aria-labelledby="gas-temp-band-heading"
      className="bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-edge text-ink"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-3">
        <span aria-hidden className="bg-inv text-accent-sky p-2 md:p-3 rounded-xl border-2 md:border-4 border-edge">
          <Thermometer size={22} strokeWidth={4} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-ink-3 font-black uppercase">
            {t('gasTempBand.subtitle')}
          </div>
          <h3 id="gas-temp-band-heading" className="text-xl md:text-3xl italic font-black uppercase">
            {t('gasTempBand.title')}
          </h3>
        </div>
      </div>

      {sourceNote && (
        <p
          data-testid="gas-temp-band-source"
          className="text-xs md:text-sm font-bold text-ink-2 normal-case mb-3"
        >
          {sourceNote}
        </p>
      )}

      {noVolume ? (
        <p
          data-testid="gas-temp-band-no-volume"
          className="text-[11px] md:text-sm font-bold text-ink-2 normal-case min-h-[80px]"
        >
          {report.skippedReadings > 0
            ? t('gasTempBand.noDuration', { count: report.skippedReadings })
            : t('gasTempBand.noVolume')}
        </p>
      ) : fetching ? (
        <p
          data-testid="gas-temp-band-loading"
          className="text-[11px] md:text-sm font-bold text-ink-2 normal-case min-h-[120px] flex items-center"
        >
          {t('tempBand.loading', { span: spanLabel ?? t('tempBand.loadingSpan') })}
        </p>
      ) : status === 'error' ? (
        <p data-testid="gas-temp-band-error" className="text-[11px] md:text-sm font-bold text-ink-2 normal-case min-h-[80px]">
          {t('tempBand.error')}
        </p>
      ) : empty ? (
        <p data-testid="gas-temp-band-empty" className="text-[11px] md:text-sm font-bold text-ink-2 normal-case min-h-[80px]">
          {t('gasTempBand.empty')}
        </p>
      ) : (
        <>
          <GasTempBandDataTable report={report} />
          <div
            data-testid="gas-temp-band-plot"
            role="img"
            aria-label={t('gasTempBand.aria', { count: report.rows.length })}
            data-reduced-motion={reduceMotion ? 'true' : 'false'}
          >
            <Chart report={report} />
          </div>
          {/* The verdict in words, so the picture is never the only source. */}
          <p
            data-testid="gas-temp-band-sentence"
            className="mt-2 text-[11px] md:text-sm font-bold text-ink-2 normal-case"
          >
            {(() => {
              const cold =
                report.rows[1].intervals > 0
                  ? report.rows[1]
                  : report.rows[0].intervals > 0
                    ? report.rows[0]
                    : null;
              const mild =
                report.rows[3].intervals > 0
                  ? report.rows[3]
                  : report.rows[4].intervals > 0
                    ? report.rows[4]
                    : null;
              const base = cold && cold.days > 0 ? cold.meanM3PerDay : 0;
              const ratio =
                base > 0 && mild && mild.days > 0 && mild.meanM3PerDay > 0
                  ? base / mild.meanM3PerDay
                  : 0;
              return cold && mild && ratio > 0
                ? t('gasTempBand.verdict', {
                    cold: cold.band.label,
                    base: fmtNumber(base, 2),
                    mild: mild.band.label,
                    mildval: fmtNumber(mild.meanM3PerDay, 2),
                    ratio: fmtNumber(ratio, 1),
                    pct: String(Math.round(cold.shareOfM3 * 100)),
                  })
                : t('gasTempBand.verdictThin');
            })()}
          </p>
        </>
      )}

      {/* The two honest drop counters: what was left out, and why. */}
      {!noVolume && report.skippedReadings > 0 && (
        <p
          data-testid="gas-temp-band-skipped"
          className="mt-2 text-[10px] md:text-xs font-bold text-ink-3 normal-case"
        >
          {t('gasTempBand.skippedReadings', { count: report.skippedReadings })}
        </p>
      )}
      {report.volumelessBills > 0 && (
        <p
          data-testid="gas-temp-band-volumeless"
          className="mt-2 text-[10px] md:text-xs font-bold text-ink-3 normal-case"
        >
          {t('gasTempBand.volumelessBills', { count: report.volumelessBills })}
        </p>
      )}

      <p className="mt-3 text-[10px] md:text-xs font-bold text-ink-3 normal-case">
        {report.matchedHours > 0 || status === 'ready' ? (
          <>
            {t('tempBand.footTemp')}{' '}
            {status === 'error'
              ? t('tempBand.footUnavailable')
              : t('tempBand.footSource', {
                  label: OPEN_METEO.label,
                  span: spanLabel ?? t('tempBand.footSpan'),
                  matched:
                    report.matchedHours === report.totalHours
                      ? t('tempBand.matchAll', { n: fmtNumber(report.totalHours) })
                      : t('tempBand.matchSome', {
                          matched: fmtNumber(report.matchedHours),
                          total: fmtNumber(report.totalHours),
                        }),
                })}
          </>
        ) : (
          t('tempBand.footIdle')
        )}
      </p>
    </section>
  );
}
