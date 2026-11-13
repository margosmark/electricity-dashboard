/**
 * The Electricity / Gas section switch (t_8a9038d6).
 *
 * Mark asked for EXPLICIT sections: two uploads, two datasets, one clear
 * control that says which dataset is on screen. This is a VIEW choice only —
 * what an upload writes is decided by the parser's own classification in
 * `lib/commodity.ts`, never by which button is lit.
 *
 * Semantics follow the plan switcher (aria-pressed, visible label IS the
 * accessible name — no aria-label that would hide it from axe), because this
 * is a toggle between two views, not a navigation between two pages: both
 * datasets stay in the browser, and switching never re-reads or re-writes
 * storage.
 */

"use client";

import type { Commodity } from '@/lib/commodity';
import { useTranslation } from '@/i18n';

const ORDER: readonly Commodity[] = ['electricity', 'gas'];

export function CommodityTabs({
  value,
  onChange,
  className = '',
}: {
  /** Which section is on screen. */
  value: Commodity;
  /** Persisted by `useEnergyData`'s `setCommodity` (key `oeo_commodity`). */
  onChange: (next: Commodity) => void;
  /** Extra classes for placement (toolbar row, classic shell). */
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('commodity.switchLabel')}
      data-testid="commodity-switch"
      className={`bg-hover p-1 rounded-lg border border-edge-muted flex gap-1 ${className}`}
    >
      {ORDER.map((c) => (
        <button
          key={c}
          type="button"
          data-testid={`commodity-${c}`}
          aria-pressed={value === c}
          onClick={() => onChange(c)}
          className={`inline-flex min-h-11 items-center px-3 md:px-6 py-1 rounded-md text-[10px] font-medium transition-colors ${
            value === c
              ? 'bg-card text-ink border border-edge'
              : 'text-ink-2 hover:bg-card'
          }`}
        >
          {t(c === 'gas' ? 'commodity.gas' : 'commodity.electricity')}
        </button>
      ))}
    </div>
  );
}

export default CommodityTabs;
