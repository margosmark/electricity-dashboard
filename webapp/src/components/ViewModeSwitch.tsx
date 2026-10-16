'use client';

import Link from 'next/link';
import { useTranslation } from '@/i18n';

type ViewModeSwitchProps = {
  current: 'quiet' | 'classic';
};

/** A persistent, keyboard-accessible link between the two dashboard views. */
export default function ViewModeSwitch({ current }: ViewModeSwitchProps) {
  const { t } = useTranslation();
  const classic = current === 'classic';
  return (
    <nav
      aria-label={t('view.switch.aria')}
      data-testid="view-switch"
      className="no-print ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-edge-muted bg-card p-1 text-[10px] font-medium"
    >
      <Link
        href="/"
        aria-current={!classic ? 'page' : undefined}
        data-testid="quiet-view-link"
        className={`inline-flex min-h-11 items-center rounded-md px-3 py-2 transition-colors ${!classic ? 'bg-hover text-ink' : 'text-ink-2 hover:bg-hover'}`}
      >
        {t('view.switch.quiet')}
      </Link>
      <Link
        href="/classic"
        aria-current={classic ? 'page' : undefined}
        data-testid="classic-view-link"
        className={`inline-flex min-h-11 items-center rounded-md px-3 py-2 transition-colors ${classic ? 'bg-hover text-ink' : 'text-ink-2 hover:bg-hover'}`}
      >
        {t('view.switch.classic')}
      </Link>
    </nav>
  );
}
