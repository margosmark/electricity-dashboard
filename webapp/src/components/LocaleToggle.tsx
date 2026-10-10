/**
 * Wave U — the EN/FR toggle.
 *
 * Sits in the toolbar's first row, next to the answer chip: the language
 * switch belongs where the user's eyes already are, on every tab, and it is
 * a real `<button>` in the tab order (Wave H's a11y bar — keyboard reachable,
 * `aria-label` localized, visible focus ring, ≥44 px target).
 *
 * One button, not a two-state radio group: the label NAMES the language you
 * would switch TO ("FR" while English is active, "EN" while French is), so
 * the control never has to explain its own state. `aria-pressed` still
 * carries "is French on" for assistive tech, and `lang` on the label makes a
 * screen reader pronounce the foreign-language code properly.
 */

'use client';

import React from 'react';
import { Languages } from 'lucide-react';
import { useTranslation } from '@/i18n';

export default function LocaleToggle() {
  const { t, locale, setLocale } = useTranslation();
  const next = locale === 'en' ? 'fr' : 'en';

  return (
    <button
      type="button"
      data-testid="locale-toggle"
      data-locale={locale}
      aria-pressed={locale === 'fr'}
      aria-label={t('locale.toggle.aria')}
      onClick={() => setLocale(next)}
      className="no-print inline-flex min-h-11 min-w-11 items-center gap-1.5 px-3 py-2 bg-white text-black border-4 border-black rounded-xl md:rounded-2xl font-black uppercase text-[10px] md:text-xs shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-y-1 active:translate-y-0 active:shadow-none transition-all focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500"
    >
      <Languages size={16} strokeWidth={4} aria-hidden="true" />
      <span lang={next}>{t('locale.toggle.label')}</span>
    </button>
  );
}
