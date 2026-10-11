/**
 * Wave M — the in-app banner for "something in your comparison changed".
 *
 * Two notices can stack: a plan switch (the actionable one, so it is ordered
 * first) and a rate-set change (context for why the numbers moved). Both are
 * dismissible and both STAY dismissed: dismissing persists the acknowledgement
 * this banner is derived from, so it cannot come back on the next refresh
 * until the answer genuinely changes again.
 *
 * Visibility rules live in `lib/backgroundRefresh.ts` and are unit-tested
 * there; this component only renders whatever it is handed, which is why the
 * e2e can drive it by writing an acknowledgement and letting a refresh run.
 *
 * The honesty line is not decoration: without an account server nothing in
 * here can reach the user by email or SMS. On-device only.
 */

"use client";

import { RefreshCw, Bell, X } from "lucide-react";
import type { RefreshNotice } from "@/lib/backgroundRefresh";
import { useTranslation } from "@/i18n";

type Props = {
  notices: RefreshNotice[];
  onDismiss: (id: string) => void;
};

function PlanNotice({
  notice,
  onDismiss,
}: {
  notice: Extract<RefreshNotice, { kind: "plan-change" }>;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      key={notice.id}
      role="status"
      data-testid="refresh-notice-plan"
      data-plan={notice.plan}
      data-previous-plan={notice.previousBest}
      data-saving-vs-previous={notice.monthlySavingVsPrevious}
      className="relative z-[100] bg-emerald-400 border-4 border-black rounded-xl md:rounded-2xl shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] px-4 md:px-6 py-3 md:py-4 flex flex-wrap items-start gap-3 md:gap-4 text-black"
    >
      <Bell size={20} strokeWidth={4} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-[16rem] space-y-1">
        <div data-testid="refresh-notice-headline" className="text-[11px] md:text-sm font-black uppercase leading-snug">
          {notice.headline}
        </div>
        <p className="text-[10px] md:text-xs font-bold normal-case text-emerald-950">
          {notice.detail} {t('bgRefresh.recomputed')}
        </p>
        <p className="text-[9px] md:text-[10px] font-black uppercase text-emerald-950/70">
          {t('bgRefresh.alertsOnDevice')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 ml-auto">
        <div className="hidden sm:flex flex-col items-end bg-white border-2 border-black rounded-lg px-3 py-2">
          <span className="text-[8px] md:text-[10px] font-black uppercase">{t('bgRefresh.bestVsCurrent')}</span>
          <span data-testid="refresh-notice-saving" className="text-base md:text-xl italic font-black">
            ${notice.monthlySavingVsCurrent.toFixed(2)}
            <span className="text-[9px] md:text-[11px] not-italic ml-1">{t('common.perMonth')}</span>
          </span>
        </div>
        <button
          type="button"
          data-testid="refresh-notice-dismiss"
          onClick={() => onDismiss(notice.id)}
          aria-label={t('bgRefresh.dismissPlanAria')}
          className="min-h-11 min-w-11 inline-flex items-center justify-center p-3 bg-black text-emerald-400 border-4 border-black rounded-lg md:rounded-xl hover:bg-blue-600 hover:text-white transition-colors"
        >
          <X size={16} strokeWidth={4} />
        </button>
      </div>
    </div>
  );
}

function RateNotice({
  notice,
  onDismiss,
}: {
  notice: Extract<RefreshNotice, { kind: "rate-change" }>;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      key={notice.id}
      role="status"
      data-testid="refresh-notice-rate"
      data-effective-date={notice.effectiveDate}
      data-previous-effective-date={notice.previousEffectiveDate}
      className="relative z-[100] bg-sky-300 border-4 border-black rounded-xl md:rounded-2xl px-4 md:px-6 py-3 flex flex-wrap items-center gap-3 md:gap-4 text-black"
    >
      <RefreshCw size={18} strokeWidth={4} className="shrink-0" />
      <div className="flex-1 min-w-[14rem] space-y-1">
        <div data-testid="refresh-notice-headline" className="text-[11px] md:text-sm font-black uppercase">
          {notice.headline}
        </div>
        <p className="text-[10px] md:text-xs font-bold normal-case text-slate-800">{notice.detail}</p>
      </div>
      <button
        type="button"
        data-testid="refresh-notice-dismiss"
        onClick={() => onDismiss(notice.id)}
        aria-label={t('bgRefresh.dismissRateAria')}
        className="ml-auto min-h-11 min-w-11 inline-flex items-center justify-center p-3 bg-white text-black border-4 border-black rounded-lg md:rounded-xl hover:bg-blue-600 hover:text-white transition-colors"
      >
        <X size={16} strokeWidth={4} />
      </button>
    </div>
  );
}

export function RefreshNoticeBanner({ notices, onDismiss }: Props) {
  if (notices.length === 0) return null;
  return (
    <div data-testid="refresh-notice-banner" className="space-y-3">
      {notices.map((notice) =>
        notice.kind === "plan-change" ? (
          <PlanNotice key={notice.id} notice={notice} onDismiss={onDismiss} />
        ) : (
          <RateNotice key={notice.id} notice={notice} onDismiss={onDismiss} />
        ),
      )}
    </div>
  );
}

export default RefreshNoticeBanner;
