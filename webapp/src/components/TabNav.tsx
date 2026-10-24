/**
 * Wave R — the four-section tab strip, sticky under the header.
 *
 * ARIA tabs, properly: `role="tablist"` with roving tabindex (one stop for
 * the whole strip, arrows move BOTH focus and selection), Home/End to the
 * ends, `aria-selected` + `aria-controls`/`aria-labelledby` wiring, and a
 * panel that only exists when its tab is active. That is the same bar the
 * Wave H a11y checklist holds every control to, so tabs get no exemption.
 *
 * `aria-controls` therefore goes on the SELECTED tab only: an aria-controls
 * that names an id nothing renders is a dangling reference (axe
 * `aria-valid-attr-value`, which is what Lighthouse flagged at 0.87). The
 * inactive panels are not in the DOM at all, so only the one tab whose panel
 * is actually rendered may point at it.
 *
 * Layout: icons + short labels, `overflow-x-auto` so the four still fit as
 * one row at 390 px without shrinking the touch targets below 44 px.
 * `no-print` because a printed report is the active section, not the chrome
 * that chose it.
 */

'use client';

import { useRef, type ReactNode } from 'react';
import { Banknote, Gauge, Scale, TrendingUp } from 'lucide-react';
import { TABS, type TabId } from '@/lib/tabs';
import { useTranslation } from '@/i18n';

const ICONS: Record<TabId, typeof Gauge> = {
  overview: Gauge,
  analytics: TrendingUp,
  plans: Scale,
  money: Banknote,
};

export type TabNavProps = {
  active: TabId;
  onChange: (tab: TabId) => void;
  /** Global display preferences belong in the shell, not below page content. */
  shellTools?: ReactNode;
};

export default function TabNav({ active, onChange, shellTools }: TabNavProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // Wave U — `lib/tabs.ts` keeps the canonical English definitions (pure
  // data, unit-tested); the strip renders the localized view of them.
  const { t } = useTranslation();

  const focusTab = (index: number) => {
    const next = (index + TABS.length) % TABS.length;
    buttons.current[next]?.focus();
    onChange(TABS[next].id);
  };

  /**
   * Where the arrows move FROM. Prefer whichever tab currently holds focus
   * over the `active` prop: two arrow presses inside one frame (or a parent
   * that has not re-rendered yet) must walk ONE step each, not two steps from
   * the same anchor. Falls back to `active` when focus is outside the strip,
   * which is where the first arrow lands.
   */
  const anchorIndex = (): number => {
    const focused = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
    return focused >= 0 ? focused : TABS.findIndex((t) => t.id === active);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = anchorIndex();
    switch (event.key) {
      case 'ArrowRight':
        focusTab(current + 1);
        break;
      case 'ArrowLeft':
        focusTab(current - 1);
        break;
      case 'Home':
        focusTab(0);
        break;
      case 'End':
        focusTab(TABS.length - 1);
        break;
      default:
        return;
    }
    // Without this the browser also scrolls the strip / moves focus itself.
    event.preventDefault();
  };

  return (
    <nav
      className="no-print sticky top-0 z-[250] -mx-4 md:-mx-6 px-4 md:px-6 pt-2 md:pt-3 pb-[3px] bg-inset border-b-2 border-edge"
      data-testid="tab-nav"
    >
      {/*
        D2 (t_fcbba376): the selected pill's `shadow-hard-blue-3` is a 3px hard
        offset, and at gap-1 it ate 4 of the 4px gap — the blue band welded
        itself to the next pill. gap-2 leaves 8 − 3 = 5px of clear air; the
        360px fit still holds (4 × 76px + 3 × 8px = 328px).
      */}
      <div className="flex flex-wrap items-center gap-2 md:gap-3 xl:flex-nowrap">
        <div
          role="tablist"
          aria-label={t('tabnav.aria')}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto md:gap-3"
        >
          {TABS.map((tab, index) => {
          const Icon = ICONS[tab.id];
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-controls={selected ? `panel-${tab.id}` : undefined}
              aria-selected={selected}
              aria-current={selected ? 'page' : undefined}
              data-go={tab.id}
              data-testid={`tab-${tab.id}`}
              data-active={String(selected)}
              tabIndex={selected ? 0 : -1}
              title={t(`tab.desc.${tab.id}`)}
              onClick={() => onChange(tab.id)}
              className={`inline-flex min-h-11 min-w-[64px] flex-1 md:flex-none items-center justify-center gap-1 md:gap-2 px-1.5 md:px-5 py-2 rounded-lg md:rounded-xl border border-edge font-medium normal-case text-[10px] md:text-xs whitespace-nowrap transition-all ${
                selected
                  ? 'bg-card text-ink border-b-2 border-b-accent'
                  : 'bg-inset text-ink-2 hover:text-ink'
              }`}
            >
              <Icon size={14} strokeWidth={4} aria-hidden="true" className="shrink-0" />
              <span>{t(`tab.${tab.id}`)}</span>
            </button>
          );
          })}
        </div>
        {shellTools && <div className="order-2 basis-full sm:order-none sm:basis-auto">{shellTools}</div>}
      </div>
    </nav>
  );
}
