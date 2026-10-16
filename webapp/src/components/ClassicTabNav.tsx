'use client';

import { useRef, type KeyboardEvent } from 'react';
import { Banknote, Gauge, Scale, TrendingUp } from 'lucide-react';
import { useTranslation } from '@/i18n';

export type ClassicTabId = 'overview' | 'usage' | 'plans' | 'money';

type ClassicTab = { id: ClassicTabId; key: string };

const CLASSIC_TABS: ClassicTab[] = [
  { id: 'overview', key: 'tab.overview' },
  { id: 'usage', key: 'tab.usage' },
  { id: 'plans', key: 'tab.plans' },
  { id: 'money', key: 'tab.money' },
];

const ICONS = {
  overview: Gauge,
  usage: TrendingUp,
  plans: Scale,
  money: Banknote,
} as const;

type ClassicTabNavProps = {
  active: ClassicTabId;
  onChange: (tab: ClassicTabId) => void;
};

/** The pre-Quiet-Meter four-section dashboard navigation. */
export default function ClassicTabNav({ active, onChange }: ClassicTabNavProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const { t } = useTranslation();

  const move = (index: number) => {
    const next = (index + CLASSIC_TABS.length) % CLASSIC_TABS.length;
    buttons.current[next]?.focus();
    onChange(CLASSIC_TABS[next].id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = CLASSIC_TABS.findIndex((tab) => tab.id === active);
    if (event.key === 'ArrowRight') move(index + 1);
    else if (event.key === 'ArrowLeft') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(CLASSIC_TABS.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <nav
      className="no-print sticky top-0 z-[250] -mx-4 md:-mx-8 px-4 md:px-8 py-2 md:py-3 bg-inset/95 backdrop-blur-sm border-b-4 border-edge"
      data-testid="classic-tab-nav"
    >
      <div role="tablist" aria-label={t('tabnav.aria')} onKeyDown={onKeyDown} className="flex gap-2 md:gap-3 overflow-x-auto">
        {CLASSIC_TABS.map((tab, index) => {
          const Icon = ICONS[tab.id];
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(node) => { buttons.current[index] = node; }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-controls={selected ? `panel-${tab.id}` : undefined}
              aria-selected={selected}
              data-testid={`classic-tab-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              title={t(`tab.desc.${tab.id}`)}
              onClick={() => onChange(tab.id)}
              className={`inline-flex min-h-11 min-w-[76px] flex-1 items-center justify-center gap-1.5 rounded-lg border-2 border-edge px-3 py-2 text-[10px] font-black uppercase whitespace-nowrap transition-all md:flex-none md:px-5 md:text-xs ${selected ? 'bg-inv text-accent-yellow shadow-hard-blue-3' : 'bg-card text-ink-3 hover:bg-hover hover:text-ink'}`}
            >
              <Icon size={14} strokeWidth={4} aria-hidden="true" className="shrink-0" />
              <span>{t(tab.key)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
