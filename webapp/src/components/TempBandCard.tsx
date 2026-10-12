/**
 * Wave T slice 1 — the USAGE VS OUTDOOR TEMPERATURE card.
 *
 * Seven fixed temperature bins across the window, each bar the household's
 * average draw for hours that cold (or that hot). The shape that falls out of
 * a real two-year Ontario export is the point of the card: the cold half is
 * FLAT — ~1.3 kWh/h from −14 °C to +4 °C, because a house that heats with gas
 * does not change its electricity draw when the lake freezes — and then the
 * curve leaves the floor at 18–24 °C and roughly triples by the time it is
 * over 30 °C. That is an air-conditioning signature, drawn from the user's own
 * meter instead of asserted by an article.
 *
 * Under the bars, a second strip: each bin's share of the window's kWh. A bin
 * can be dramatic per hour and irrelevant per bill — Toronto spends ~1.8% of
 * its hours over 30 °C — so the strip is what stops "3× your baseline" from
 * being read as "3× your bill".
 *
 * Hand-drawn SVG, like the EFFICIENCY card: the Recharts chunk stays off the
 * first visit, and every number drawn is also printed as text (the DOM
 * attributes are what the browser check reads back against an independent
 * parser).
 */

'use client';

import React, { useMemo } from 'react';
import { Thermometer } from 'lucide-react';

import { fmtCents, fmtNumber, useTranslation } from '@/i18n';
import { OPEN_METEO, type TempFetchStatus } from '@/lib/openMeteo';
import { TEMP_BANDS, tempBandEmpty, type TempBandReport } from '@/lib/tempBands';

export type TempBandCardProps = {
  report: TempBandReport;
  status: 'idle' | TempFetchStatus;
  loading: boolean;
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
/** Cold bins are blue, hot bins red — the axis reads as a thermometer.
 *
 * One token per stop, not a literal list: the ramp is the card's AXIS, and on
 * the dark card blue-700 / red-700 measured 2.66:1 / 2.76:1 — under the 3:1
 * non-text floor. The tokens carry a lifted dark variant that keeps the hue
 * direction and the step weight (see the `--temp-band-*` note in
 * globals.css); LIGHT resolves to the byte-identical literals this replaced.
 * The `¢/kWh` label inside each bar carries its OWN per-stop ink
 * (`--temp-band-lab-1..7`, t_3e571ddb Phase 2/L4): the label's background IS
 * the fill it sits on, so a single colour cannot clear AA over a ramp that
 * runs dark→pale→dark — the fills stay byte-identical and only the ink
 * follows the stop. */
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
 * Wave U — the axis tick under each bar is prose ("-10 to 5", "over 30"),
 * so it translates. `TEMP_BANDS[].label` stays canonical: it is the bin's
 * data identity (`data-label`, and the `{cold}`/`{hot}` slot in the verdict
 * sentence, which supplies its own °C).
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

function Chart({ report }: { report: TempBandReport }) {
  // Wave U — the axis titles translate; `t` is a hook, and Chart is a real
  // component so it can use it directly.
  const { t } = useTranslation();
  const geo = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const step = innerW / TEMP_BANDS.length;
    const peak = Math.max(...report.rows.map((r) => r.meanKwhPerHour), 0.001);
    const top = Math.ceil(peak * 10) / 10 + 0.2;
    const maxShare = Math.max(...report.rows.map((r) => r.shareOfKwh), 0.0001);
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
      data-testid="temp-band-chart"
      data-bands={report.rows.length}
      data-matched-hours={report.matchedHours}
      data-total-hours={report.totalHours}
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

      {/* The bars: mean kWh/h per hour in that temperature band. */}
      {report.rows.map((row, i) => {
        const h = Math.max(0, BASELINE - y(row.meanKwhPerHour));
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
              data-testid="temp-band-bar"
              data-band={row.band.id}
              data-label={row.band.label}
              data-hours={row.hours}
              data-mean-kwh={row.meanKwhPerHour.toFixed(3)}
              data-cents={row.centsPerKwh.toFixed(2)}
              data-share={row.shareOfKwh.toFixed(4)}
              data-mean-temp={row.meanTempC.toFixed(1)}
            />
            {row.hours > 0 && (
              <text
                x={x(i)}
                y={y(row.meanKwhPerHour) - 6}
                textAnchor="middle"
                fontSize={11}
                fontWeight={900}
                fill="var(--ink)"
              >
                {fmtNumber(row.meanKwhPerHour, 1)}
              </text>
            )}
            {/* The ¢/kWh sits INSIDE its own bar, so the row below the
                baseline belongs to the share strip and its title alone —
                two labels fighting for one row is how axis captions end up
                printed across somebody else's numbers.
                Its ink therefore PAIRS PER STOP (t_3e571ddb Phase 2, L4):
                one colour cannot clear AA over seven fills that run
                dark→pale→dark, so `--temp-band-lab-<stop>` carries the
                white/black pairing. The FILLS stay byte-identical. */}
            <text
              x={x(i)}
              y={BASELINE - 6}
              textAnchor="middle"
              fontSize={10}
              fontWeight={900}
              fill={row.hours > 0 ? `var(--temp-band-lab-${i + 1})` : 'var(--ink-4)'}
              data-testid="temp-band-cents"
              data-band={row.band.id}
            >
              {row.hours > 0 ? fmtCents(row.centsPerKwh, 1) : '—'}
            </text>

            {/* Share of the window's kWh — where the energy actually sits. */}
            <rect
              x={x(i) - barW / 2}
              y={SHARE_TOP + SHARE_MAX_H - Math.max(1.5, (row.shareOfKwh / maxShare) * SHARE_MAX_H)}
              width={barW}
              height={Math.max(1.5, (row.shareOfKwh / maxShare) * SHARE_MAX_H)}
              fill="#facc15"
              stroke="var(--ink)"
              strokeWidth={1.5}
              data-testid="temp-band-share"
              data-band={row.band.id}
            />
            <text x={x(i)} y={SHARE_TOP + SHARE_MAX_H + 13} textAnchor="middle" fontSize={10} fontWeight={900} fill="var(--ink)">
              {row.hours > 0 ? `${Math.round(row.shareOfKwh * 100)}%` : ''}
            </text>
            <text x={x(i)} y={SHARE_TOP + SHARE_MAX_H + 27} textAnchor="middle" fontSize={10} fontWeight={900} fill="var(--ink-3)">
              {t(BAND_LABEL_KEY[row.band.id] ?? '') || row.band.label}
            </text>
          </g>
        );
      })}

      {/* Axis titles, because a bar height without a unit is a rumour. */}
      <text x={PAD.left} y={14} fontSize={10} fontWeight={900} fill="var(--ink)">
        {t('tempBand.axisKwh')}
      </text>
      <text x={W - PAD.right} y={SHARE_TOP - 4} textAnchor="end" fontSize={10} fontWeight={900} fill="var(--ink)">
        {t('tempBand.axisShare')}
      </text>
    </svg>
  );
}

export default function TempBandCard({ report, status, loading, source, spanLabel }: TempBandCardProps) {
  const { t } = useTranslation();
  const empty = tempBandEmpty(report);
  const fetching = loading || status === 'idle';

  return (
    <section
      data-testid="temp-band-card"
      data-status={status}
      data-source={source ?? 'none'}
      data-matched={report.matchedHours}
      data-total={report.totalHours}
      aria-labelledby="temp-band-heading"
      className="bg-card p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-edge text-ink"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-3">
        <span aria-hidden className="bg-inv text-accent-sky p-2 md:p-3 rounded-xl border-2 md:border-4 border-edge">
          <Thermometer size={22} strokeWidth={4} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-ink-3 font-black uppercase">
            {t('tempBand.subtitle')}
          </div>
          <h3 id="temp-band-heading" className="text-xl md:text-3xl italic font-black uppercase">
            {t('tempBand.title')}
          </h3>
        </div>
      </div>

      {fetching ? (
        <p
          data-testid="temp-band-loading"
          className="text-[11px] md:text-sm font-bold text-ink-2 normal-case min-h-[120px] flex items-center"
        >
          {t('tempBand.loading', { span: spanLabel ?? t('tempBand.loadingSpan') })}
        </p>
      ) : status === 'error' ? (
        <p data-testid="temp-band-error" className="text-[11px] md:text-sm font-bold text-ink-2 normal-case min-h-[80px]">
          {t('tempBand.error')}
        </p>
      ) : empty ? (
        <p data-testid="temp-band-empty" className="text-[11px] md:text-sm font-bold text-ink-2 normal-case min-h-[80px]">
          {t('tempBand.empty')}
        </p>
      ) : (
        <>
          <Chart report={report} />
          {/* The verdict in words, so the picture is never the only source. */}
          <p
            data-testid="temp-band-sentence"
            className="mt-2 text-[11px] md:text-sm font-bold text-ink-2 normal-case"
          >
            {(() => {
              const cold = report.rows[1];
              const hot = report.rows.find((r) => r.band.id === '24..30') ?? report.rows[5];
              const base = cold.hours > 0 ? cold.meanKwhPerHour : 0;
              const ratio = base > 0 && hot.hours > 0 ? hot.meanKwhPerHour / base : 0;
              return ratio > 0
                ? t('tempBand.verdict', {
                    cold: cold.band.label,
                    base: fmtNumber(base, 2),
                    hot: hot.band.label,
                    hotval: fmtNumber(hot.meanKwhPerHour, 2),
                    ratio: fmtNumber(ratio, 1),
                    pct: String(Math.round(hot.shareOfKwh * 100)),
                  })
                : t('tempBand.verdictThin');
            })()}
          </p>
        </>
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
