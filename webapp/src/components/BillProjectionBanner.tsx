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
import { fmtKwh, fmtMoney, useTranslation } from '@/i18n';

export default function BillProjectionBanner({ projection }: { projection: BillProjection }) {
  // Wave U — `t` also re-renders this banner on a locale switch.
  const { t } = useTranslation();
  if (!projection.ready) {
    return (
      <div
        data-testid="bill-projection"
        data-state="gated"
        className="bg-hover border-2 md:border-4 border-edge rounded-xl md:rounded-2xl px-4 md:px-6 py-3 md:py-4 flex flex-wrap items-center gap-3 text-ink font-black uppercase"
      >
        <Hourglass size={16} strokeWidth={4} className="shrink-0" />
        <div className="text-[10px] md:text-xs">
          <span className="mr-2">{t('projection.thisMonthBill')}</span>
          <span className="font-bold text-ink-2 normal-case">{projection.gateNote}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="bill-projection"
      data-state="ready"
      className="bg-emerald-400 border-4 border-edge rounded-xl md:rounded-2xl shadow-hard-6 px-4 md:px-8 py-4 md:py-6 flex flex-wrap items-center gap-4 md:gap-8 text-accent-ink font-black uppercase"
    >
      <div className="flex items-center gap-2 md:gap-3">
        <CalendarDays size={20} strokeWidth={4} />
        <div>
          <div className="text-[8px] md:text-[10px]">{t('projection.projected', { month: projection.monthLabel })}</div>
          <div data-testid="bill-projection-amount" className="text-3xl md:text-5xl italic leading-none">
            {fmtMoney(projection.projectedCost)}
          </div>
        </div>
      </div>

      <div className="bg-card border-2 md:border-4 border-edge rounded-lg md:rounded-xl px-3 md:px-4 py-2">
        <div className="text-[8px] md:text-[10px]">{t('projection.monthToDate')}</div>
        <div className="text-lg md:text-2xl italic">
          {fmtMoney(projection.monthToDateCost)}
          <span className="text-[8px] md:text-[10px] not-italic font-black ml-1">
            · {fmtKwh(projection.monthToDateKwh, 0)}
          </span>
        </div>
      </div>

      <div className="bg-card border-2 md:border-4 border-edge rounded-lg md:rounded-xl px-3 md:px-4 py-2">
        <div className="text-[8px] md:text-[10px]">{t('projection.daysMeasured')}</div>
        <div className="text-lg md:text-2xl italic">
          {projection.monthDaysCovered}/{projection.daysInMonth}
        </div>
      </div>

      <p className="text-[8px] md:text-[11px] font-bold text-ink-2 normal-case basis-full md:basis-auto max-w-2xl">
        {projection.caption}
      </p>
    </div>
  );
}
