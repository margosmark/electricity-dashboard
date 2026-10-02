/**
 * ShiftCheck — "did moving that load actually help?", the weekly loop that
 * pairs with ShiftOptimizer's recommendations.
 *
 * Everything on this card comes from lib/shiftVerification: two 7-day windows
 * anchored on the newest FULL day of data, an off-peak share delta, a
 * week-rate cost delta, and a verdict that refuses to call noise a win.
 */

"use client";

import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, Scale } from 'lucide-react';
import type { ShiftVerification, ShiftVerdict } from '@/lib/shiftVerification';

const VERDICT_STYLE: Record<ShiftVerdict, { box: string; icon: ReactNode }> = {
  improved: { box: 'bg-emerald-400', icon: <ArrowUpRight size={16} strokeWidth={4} /> },
  worse: { box: 'bg-red-400', icon: <ArrowDownRight size={16} strokeWidth={4} /> },
  diverged: { box: 'bg-orange-400', icon: <Scale size={16} strokeWidth={4} /> },
  'no-change': { box: 'bg-slate-200', icon: <Minus size={16} strokeWidth={4} /> },
  'no-offpeak': { box: 'bg-blue-300', icon: <Scale size={16} strokeWidth={4} /> },
};

function WindowChip({
  label,
  window,
  accent,
}: {
  label: string;
  window: NonNullable<ShiftVerification['recent']>;
  accent: boolean;
}) {
  return (
    <div
      className={`border-2 md:border-4 border-black rounded-xl md:rounded-2xl p-3 md:p-4 ${accent ? 'bg-yellow-400' : 'bg-white'}`}
    >
      <div className="text-[8px] md:text-[10px] font-black uppercase">{label}</div>
      <div className="text-[10px] md:text-xs font-bold text-slate-600">
        {window.start} → {window.end} · {window.days} day{window.days === 1 ? '' : 's'}
      </div>
      <div className="text-xl md:text-2xl italic font-black mt-1">
        {window.offPeakShare !== null
          ? `${(window.offPeakShare * 100).toFixed(1)}%`
          : `$${window.totalCost.toFixed(2)}`}
      </div>
      <div className="text-[8px] md:text-[10px] font-black uppercase text-slate-500">
        {window.offPeakShare !== null
          ? `off-peak · $${window.totalCost.toFixed(2)} · ${window.totalKwh.toFixed(1)} kWh`
          : `${window.totalKwh.toFixed(1)} kWh · flat rate`}
      </div>
    </div>
  );
}

export default function ShiftVerificationCard({
  verification,
}: {
  verification: ShiftVerification;
}) {
  const style = VERDICT_STYLE[verification.verdict];

  return (
    <div
      data-testid="shift-verification"
      data-verdict={verification.verdict}
      className="bg-white p-6 md:p-10 rounded-[1.5rem] md:rounded-[3rem] border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] text-black font-black uppercase"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 md:mb-6">
        <h3 className="text-2xl md:text-4xl italic">Did the shift show up?</h3>
        <span className="bg-black text-white border-2 border-black rounded-full px-3 py-1 text-[9px] md:text-[11px]">
          Last 7 days vs the 7 before
        </span>
      </div>

      {!verification.ready ? (
        <div
          data-testid="shift-verification-empty"
          className="bg-slate-100 border-2 md:border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6"
        >
          <div className="font-black uppercase text-sm md:text-xl mb-2">
            {verification.headline}
          </div>
          <p className="font-bold text-slate-600 text-xs md:text-sm normal-case">
            {verification.detail}
          </p>
        </div>
      ) : (
        <div className="space-y-4 md:space-y-6">
          <div
            data-testid="shift-verification-headline"
            className={`${style.box} border-4 border-black rounded-xl md:rounded-2xl p-4 md:p-6 flex items-start gap-3`}
          >
            <span className="shrink-0 mt-1">{style.icon}</span>
            <div className="text-lg md:text-2xl leading-tight">{verification.headline}</div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            <WindowChip
              label={`Last 7 days${verification.offPeakLabel ? ` · ${verification.offPeakLabel}` : ''}`}
              window={verification.recent!}
              accent
            />
            <WindowChip
              label={`Prior 7 days${verification.offPeakLabel ? ` · ${verification.offPeakLabel}` : ''}`}
              window={verification.prior!}
              accent={false}
            />
          </div>

          <p
            data-testid="shift-verification-detail"
            className="text-[10px] md:text-xs font-bold text-slate-600 normal-case"
          >
            {verification.detail}
          </p>
          <p className="text-[9px] md:text-[11px] font-bold text-slate-500 normal-case">
            {verification.caveat}
          </p>
        </div>
      )}
    </div>
  );
}
