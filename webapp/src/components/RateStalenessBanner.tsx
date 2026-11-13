"use client";

/**
 * Persistent staleness banner: shown when the OEB page carries an
 * effectiveDate newer than the rates currently used by this dashboard.
 *
 * Contains source/effective dates and an optional sample impact. Rate
 * publication is maintained separately; this notice offers no update action.
 */

import { AlertTriangle } from 'lucide-react';
import type { StalenessResult } from '@/hooks/useRateStaleness';
import { fmtCentsAuto, fmtKwh, fmtMoney, fmtSignedMoney, useTranslation } from '@/i18n';


const money = (n: number) => (n < 0 ? `-${fmtMoney(Math.abs(n))}` : fmtMoney(n));

export default function RateStalenessBanner({ result }: { result: StalenessResult }) {
  const { t } = useTranslation();
  if (!result.stale) return null;
  const { oebEffectiveDate, shippedEffectiveDate, deltas, impact, newSet } = result.stale;

  return (
    <div
      role="alert"
      data-testid="rate-staleness-banner"
      className="relative z-[100] bg-warn-slab p-4 md:p-6 rounded-xl md:rounded-[2rem] border-4 border-edge shadow-hard-8 text-accent-ink font-black uppercase space-y-3"
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
    </div>
  );
}
