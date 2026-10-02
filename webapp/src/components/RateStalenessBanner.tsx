"use client";

/**
 * Persistent staleness banner: shown when the OEB page carries an
 * effectiveDate newer than the shipped /api/rates set. Never dismissible —
 * the whole point is that it stays until the rates file is updated (that is
 * also what the weekly cron nudges about).
 *
 * Contains: deep-link editing hint (GitHub edit URL for the rates file) and
 * a computed sample impact — the last ~30 days of the user's own readings
 * repriced under the incoming set, per plan.
 */

import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { StalenessResult } from '@/hooks/useRateStaleness';

export const RATES_FILE_EDIT_URL =
  'https://github.com/margosmark/electricity-dashboard/edit/main/webapp/src/app/api/rates/route.ts';

const money = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

export default function RateStalenessBanner({ result }: { result: StalenessResult }) {
  if (!result.stale) return null;
  const { oebEffectiveDate, shippedEffectiveDate, deltas, impact, newSet } = result.stale;

  return (
    <div
      role="alert"
      data-testid="rate-staleness-banner"
      className="relative z-[100] bg-orange-400 p-4 md:p-6 rounded-xl md:rounded-[2rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2 md:gap-4">
        <AlertTriangle size={22} strokeWidth={4} className="shrink-0" />
        <h3 className="text-lg md:text-2xl leading-tight">
          Ontario rates changed – update /api/rates
        </h3>
      </div>

      <div className="text-[10px] md:text-sm font-black space-y-1 normal-case">
        <p data-testid="banner-dates">
          OEB now publishes rates effective{' '}
          <span className="bg-black text-orange-400 px-2 py-0.5 rounded">{oebEffectiveDate}</span>
          {' — '}
          this build ships{' '}
          <span className="bg-white px-2 py-0.5 rounded border-2 border-black">{shippedEffectiveDate}</span>
        </p>

        {deltas.length > 0 && (
          <p data-testid="banner-deltas">
            {newSet && `New rates (${oebEffectiveDate}): `}
            {deltas.map((d) => `${d.label} ${d.current}¢→${d.next}¢`).join(' · ')}
          </p>
        )}

        {impact && impact.delta !== 0 && (
          <p data-testid="banner-impact">
            Sample impact — last {impact.windowDays} days of your data ({impact.kwh.toFixed(0)} kWh):{' '}
            <span className="bg-white px-1.5 py-0.5 rounded border-2 border-black">
              {money(impact.costCurrent)} → {money(impact.costNew)} ({impact.delta > 0 ? '+' : ''}{money(impact.delta)})
            </span>
            {' · '}
            {impact.perPlan
              .map((p) => `${p.plan} ${p.delta > 0 ? '+' : ''}${money(p.delta)}`)
              .join(' · ')}
          </p>
        )}

        {!newSet && (
          <p data-testid="banner-partial">
            Date detected but the price tables could not be parsed — verify the OEB page manually
            before editing.
          </p>
        )}
      </div>

      <a
        href={RATES_FILE_EDIT_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="banner-edit-link"
        className="inline-flex items-center gap-2 bg-black text-orange-400 px-4 py-2 md:px-6 md:py-3 rounded-xl md:rounded-2xl border-2 border-black text-xs md:text-sm font-black uppercase hover:bg-blue-600 hover:text-white transition-colors"
      >
        Edit webapp/src/app/api/rates/route.ts
        <ExternalLink size={14} strokeWidth={4} />
      </a>
    </div>
  );
}
