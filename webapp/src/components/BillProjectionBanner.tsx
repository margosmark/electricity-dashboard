/**
 * "This month's bill" projection banner — month-to-date actuals plus the
 * recent daily average carried to month end.
 *
 * Before day 5 of the month it says exactly that instead of guessing, so the
 * banner is always honest about whether it has a number to show.
 */

"use client";

import { CalendarDays, Hourglass } from 'lucide-react';
import type { BillProjection } from '@/lib/billProjection';
import type { AlwaysOnFloor } from '@/lib/energy';
import { fmtKwh, fmtMoney, useTranslation } from '@/i18n';

export default function BillProjectionBanner({ projection, floor }: { projection: BillProjection; floor?: AlwaysOnFloor | null }) {
  // Wave U — `t` also re-renders this banner on a locale switch.
  const { t } = useTranslation();
  if (!projection.ready) {
    return (
      <div
        data-testid="bill-projection"
        data-state="gated"
        className="quiet-projection flex flex-wrap items-center gap-3"
      >
        <Hourglass size={18} strokeWidth={2} className="shrink-0 text-ink-3" />
        <div className="text-sm">
          <span className="mr-2 font-medium">{t('projection.thisMonthBill')}</span>
          <span className="text-ink-2">{projection.gateNote}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="bill-projection"
      data-state="ready"
      className="quiet-projection flex flex-wrap items-center gap-5 md:gap-8"
    >
      <div className="flex items-center gap-2 md:gap-3">
        <CalendarDays size={20} strokeWidth={2} className="text-ink-2" />
        <div>
          <div className="quiet-overview-label">{t('projection.projected', { month: projection.monthLabel })}</div>
          <div className="flex flex-wrap items-end gap-2">
            <div data-testid="bill-projection-amount" className="quiet-projection-amount tabular-nums">
              {fmtMoney(projection.projectedCost)}
            </div>
            <span data-testid="bill-projection-provisional" className="quiet-projection-provisional">{t('overview.provisional')}</span>
          </div>
        </div>
      </div>

      {/* The supporting facts use their own muted sub-surface, so they retain
          legible themed ink without competing with the projected amount. */}
      <div className="quiet-projection-stat px-3 md:px-4 py-2">
        <div className="quiet-overview-label">{t('projection.monthToDate')}</div>
        <div className="mt-1 text-lg md:text-xl font-semibold tabular-nums">
          {fmtMoney(projection.monthToDateCost)}
          <span className="text-xs font-medium ml-1 text-ink-3">
            · {fmtKwh(projection.monthToDateKwh, 0)}
          </span>
        </div>
      </div>

      <div className="quiet-projection-stat px-3 md:px-4 py-2">
        <div className="quiet-overview-label">{t('projection.daysMeasured')}</div>
        <div className="mt-1 text-lg md:text-xl font-semibold tabular-nums">
          {projection.monthDaysCovered}/{projection.daysInMonth}
        </div>
      </div>

      {floor && <div className="quiet-projection-stat px-3 md:px-4 py-2" data-testid="bill-projection-always-on">
        <div className="quiet-overview-label">{t('projection.alwaysOnLoad')}</div>
        <div className="mt-1 text-lg md:text-xl font-semibold tabular-nums">
          {fmtKwh(floor.kwhPerDay, 1)}
          <span className="text-xs font-medium ml-1 text-ink-3">{t('projection.perDay')}</span>
        </div>
      </div>}

      {/* The method caption remains explicit without competing with the amount. */}
      <p className="text-xs text-ink-2 basis-full md:basis-auto max-w-2xl">
        {projection.caption}
      </p>
    </div>
  );
}
