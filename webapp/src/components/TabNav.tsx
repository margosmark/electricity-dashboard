/**
 * Wave R — the four-section tab strip, sticky under the header.
 *
 * ARIA tabs, properly: `role="tablist"` with roving tabindex (one stop for
 * the whole strip, arrows move BOTH focus and selection), Home/End to the
 * ends, `aria-selected` + `aria-controls`/`aria-labelledby` wiring, and a
 * panel that only exists when its tab is active. That is the same bar the
 * Wave H a11y checklist holds every control to, so tabs get no exemption.
 *
 * Layout: icons + short labels, `overflow-x-auto` so the four still fit as
 * one row at 390 px without shrinking the touch targets below 44 px.
 * `no-print` because a printed report is the active section, not the chrome
 * that chose it.
 */

'use client';

import { useRef } from 'react';
import { Banknote, Gauge, Scale, TrendingUp } from 'lucide-react';
import { TABS, type TabId } from '@/lib/tabs';

const ICONS: Record<TabId, typeof Gauge> = {
  overview: Gauge,
  usage: TrendingUp,
  plans: Scale,
  money: Banknote,
};

export type TabNavProps = {
  active: TabId;
  onChange: (tab: TabId) => void;
};

export default function TabNav({ active, onChange }: TabNavProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

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
      className="no-print sticky top-0 z-[250] -mx-4 md:-mx-8 px-4 md:px-8 py-2 md:py-3 bg-slate-50/95 backdrop-blur-sm border-b-4 border-black"
      data-testid="tab-nav"
    >
      <div
        role="tablist"
        aria-label="Dashboard sections"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex gap-1 md:gap-2 overflow-x-auto"
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
              aria-controls={`panel-${tab.id}`}
              aria-selected={selected}
              data-testid={`tab-${tab.id}`}
              data-active={String(selected)}
              tabIndex={selected ? 0 : -1}
              title={tab.description}
              onClick={() => onChange(tab.id)}
              className={`inline-flex min-h-11 min-w-[76px] flex-1 md:flex-none items-center justify-center gap-1.5 md:gap-2 px-3 md:px-5 py-2 rounded-lg md:rounded-xl border-2 md:border-4 border-black font-black uppercase text-[10px] md:text-xs whitespace-nowrap transition-all ${
                selected
                  ? 'bg-black text-yellow-400 shadow-[3px_3px_0px_0px_rgba(37,99,235,1)]'
                  : 'bg-white text-slate-500 hover:text-black hover:bg-slate-100'
              }`}
            >
              <Icon size={14} strokeWidth={4} aria-hidden="true" className="shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
