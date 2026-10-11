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
import { fmtCentsAuto, fmtKwh, fmtMoney, fmtSignedMoney, useTranslation } from '@/i18n';

export const RATES_FILE_EDIT_URL =
  'https://github.com/margosmark/electricity-dashboard/edit/main/webapp/src/app/api/rates/route.ts';

const money = (n: number) => (n < 0 ? `-${fmtMoney(Math.abs(n))}` : fmtMoney(n));

export default function RateStalenessBanner({ result }: { result: StalenessResult }) {
  const { t } = useTranslation();
  if (!result.stale) return null;
  const { oebEffectiveDate, shippedEffectiveDate, deltas, impact, newSet } = result.stale;

  return (
    <div
      role="alert"
      data-testid="rate-staleness-banner"
      className="relative z-[100] bg-orange-400 p-4 md:p-6 rounded-xl md:rounded-[2rem] border-4 border-edge shadow-hard-8 text-accent-ink font-black uppercase space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2 md:gap-4">
        <AlertTriangle size={22} strokeWidth={4} className="shrink-0" />
        <h3 className="text-lg md:text-2xl leading-tight">
          {t('staleness.title')}
        </h3>
      </div>

      <div className="text-[10px] md:text-sm font-black space-y-1 normal-case">
        <p data-testid="banner-dates">
          {t('staleness.datesA')}{' '}
          <span className="bg-inv text-accent-orange px-2 py-0.5 rounded">{oebEffectiveDate}</span>
          {' — '}
          {t('staleness.datesB')}{' '}
          <span className="bg-card px-2 py-0.5 rounded border-2 border-edge">{shippedEffectiveDate}</span>
        </p>

        {deltas.length > 0 && (
          <p data-testid="banner-deltas">
            {newSet ? `${t('staleness.newRates', { date: oebEffectiveDate })} ` : ''}
            {deltas
              .map((d) => `${d.label} ${fmtCentsAuto(d.current)}→${fmtCentsAuto(d.next)}`)
              .join(' · ')}
          </p>
        )}

        {impact && impact.delta !== 0 && (
          <p data-testid="banner-impact">
            {t('staleness.impactIntro', { days: impact.windowDays, kwh: fmtKwh(impact.kwh, 0) })}{' '}
            <span className="bg-card px-1.5 py-0.5 rounded border-2 border-edge">
              {money(impact.costCurrent)} → {money(impact.costNew)} ({fmtSignedMoney(impact.delta)})
            </span>
            {' · '}
            {/* The canonical plan id stays: this is the operator's own
                rates-file triage line, and Wave C's test pins "TOU +$1.40". */}
            {impact.perPlan
              .map((p) => `${p.plan} ${fmtSignedMoney(p.delta)}`)
              .join(' · ')}
          </p>
        )}

        {!newSet && (
          <p data-testid="banner-partial">
            {t('staleness.partial')}
          </p>
        )}
      </div>

      <a
        href={RATES_FILE_EDIT_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="banner-edit-link"
        className="inline-flex items-center gap-2 bg-inv text-accent-orange px-4 py-2 md:px-6 md:py-3 rounded-xl md:rounded-2xl border-2 border-edge text-xs md:text-sm font-black uppercase hover:bg-blue-600 hover:text-white transition-colors"
      >
        {t('staleness.editLink')}
        <ExternalLink size={14} strokeWidth={4} />
      </a>
    </div>
  );
}
