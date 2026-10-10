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
/** Cold bins are blue, hot bins red — the axis reads as a thermometer. */
const BAR_FILL = ['#1d4ed8', '#2563eb', '#3b82f6', '#f59e0b', '#f97316', '#ef4444', '#b91c1c'];

function Chart({ report }: { report: TempBandReport }) {
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
          <line x1={PAD.left} y1={y(v)} x2={W - PAD.right} y2={y(v)} stroke="#e2e8f0" strokeWidth={1} />
          <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fontWeight={900} fill="#64748b">
            {v.toFixed(1)}
          </text>
        </g>
      ))}
      <line x1={PAD.left} y1={BASELINE} x2={W - PAD.right} y2={BASELINE} stroke="#000" strokeWidth={2} />
      <text x={PAD.left - 6} y={BASELINE + 4} textAnchor="end" fontSize={10} fontWeight={900} fill="#000">
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
              stroke="#000"
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
                fill="#000"
              >
                {row.meanKwhPerHour.toFixed(1)}
              </text>
            )}
            {/* The ¢/kWh sits INSIDE its own bar, so the row below the
                baseline belongs to the share strip and its title alone —
                two labels fighting for one row is how axis captions end up
                printed across somebody else's numbers. */}
            <text
              x={x(i)}
              y={BASELINE - 6}
              textAnchor="middle"
              fontSize={10}
              fontWeight={900}
              fill={row.hours > 0 ? '#fff' : '#94a3b8'}
            >
              {row.hours > 0 ? `${row.centsPerKwh.toFixed(1)}¢` : '—'}
            </text>

            {/* Share of the window's kWh — where the energy actually sits. */}
            <rect
              x={x(i) - barW / 2}
              y={SHARE_TOP + SHARE_MAX_H - Math.max(1.5, (row.shareOfKwh / maxShare) * SHARE_MAX_H)}
              width={barW}
              height={Math.max(1.5, (row.shareOfKwh / maxShare) * SHARE_MAX_H)}
              fill="#facc15"
              stroke="#000"
              strokeWidth={1.5}
              data-testid="temp-band-share"
              data-band={row.band.id}
            />
            <text x={x(i)} y={SHARE_TOP + SHARE_MAX_H + 13} textAnchor="middle" fontSize={10} fontWeight={900} fill="#000">
              {row.hours > 0 ? `${Math.round(row.shareOfKwh * 100)}%` : ''}
            </text>
            <text x={x(i)} y={SHARE_TOP + SHARE_MAX_H + 27} textAnchor="middle" fontSize={10} fontWeight={900} fill="#64748b">
              {row.band.label}
            </text>
          </g>
        );
      })}

      {/* Axis titles, because a bar height without a unit is a rumour. */}
      <text x={PAD.left} y={14} fontSize={10} fontWeight={900} fill="#000">
        kWh per hour (average draw)
      </text>
      <text x={W - PAD.right} y={SHARE_TOP - 4} textAnchor="end" fontSize={10} fontWeight={900} fill="#000">
        share of this window&apos;s kWh
      </text>
    </svg>
  );
}

export default function TempBandCard({ report, status, loading, source, spanLabel }: TempBandCardProps) {
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
      className="bg-white p-4 md:p-6 rounded-xl md:rounded-[2rem] shadow-xl border-4 border-black text-black"
    >
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-3">
        <span aria-hidden className="bg-black text-sky-400 p-2 md:p-3 rounded-xl border-2 md:border-4 border-black">
          <Thermometer size={22} strokeWidth={4} />
        </span>
        <div>
          <div className="text-[8px] md:text-[10px] tracking-[0.3em] text-slate-500 font-black uppercase">
            Every reading, binned by how hot it was that hour
          </div>
          <h3 id="temp-band-heading" className="text-xl md:text-3xl italic font-black uppercase">
            Usage vs outdoor temperature
          </h3>
        </div>
      </div>

      {fetching ? (
        <p
          data-testid="temp-band-loading"
          className="text-[11px] md:text-sm font-bold text-slate-600 normal-case min-h-[120px] flex items-center"
        >
          Asking Open-Meteo for the temperature of{' '}
          {spanLabel ?? 'the dates your readings cover'}…
        </p>
      ) : status === 'error' ? (
        <p data-testid="temp-band-error" className="text-[11px] md:text-sm font-bold text-slate-600 normal-case min-h-[80px]">
          No temperature data for these dates — the weather service did not answer, so this chart has
          nothing honest to draw. Your readings are unaffected; everything else on this tab still works.
        </p>
      ) : empty ? (
        <p data-testid="temp-band-empty" className="text-[11px] md:text-sm font-bold text-slate-600 normal-case min-h-[80px]">
          None of the hours in this window could be matched to a temperature, so there is nothing to
          band. Widen the window, or import a longer export.
        </p>
      ) : (
        <>
          <Chart report={report} />
          {/* The verdict in words, so the picture is never the only source. */}
          <p
            data-testid="temp-band-sentence"
            className="mt-2 text-[11px] md:text-sm font-bold text-slate-700 normal-case"
          >
            {(() => {
              const cold = report.rows[1];
              const hot = report.rows.find((r) => r.band.id === '24..30') ?? report.rows[5];
              const base = cold.hours > 0 ? cold.meanKwhPerHour : 0;
              const ratio = base > 0 && hot.hours > 0 ? hot.meanKwhPerHour / base : 0;
              return ratio > 0
                ? `Draw at ${cold.band.label}°C averages ${base.toFixed(2)} kWh/h; at ${hot.band.label}°C it is ${hot.meanKwhPerHour.toFixed(2)} — ${ratio.toFixed(1)}× as much. ${Math.round(hot.shareOfKwh * 100)}% of this window's energy was used in those hours.`
                : 'Not enough hours in a temperature band yet to compare them.';
            })()}
          </p>
        </>
      )}

      <p className="mt-3 text-[10px] md:text-xs font-bold text-slate-500 normal-case">
        {report.matchedHours > 0 || status === 'ready' ? (
          <>
            Temperature:{' '}
            {status === 'error'
              ? 'unavailable.'
              : `Open-Meteo (${OPEN_METEO.label}), fetched by THIS browser from their CDN for ${
                  spanLabel ?? 'your data\u2019s dates'
                } — the dates your readings cover, never a date you have no data for — and cached here. ${
                  report.matchedHours === report.totalHours
                    ? `All ${report.totalHours.toLocaleString('en-CA')} hours matched.`
                    : `${report.matchedHours.toLocaleString('en-CA')} of ${report.totalHours.toLocaleString('en-CA')} hours matched; the rest are left out of the averages rather than guessed.`
                } No server saw this request.`}
          </>
        ) : (
          'Temperature comes from Open-Meteo, fetched by this browser and cached here — no server involved.'
        )}
      </p>
    </section>
  );
}
