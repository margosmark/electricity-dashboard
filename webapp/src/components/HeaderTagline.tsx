/**
 * Wave U — the page header's tagline.
 *
 * `app/page.tsx` is a server component, so the one translated string in the
 * header lives in this tiny client leaf instead of turning the whole page
 * client-side. The `<h1>` is the product name (a proper noun) and stays as-is
 * in both locales.
 */

'use client';

import React from 'react';
import { useTranslation } from '@/i18n';

export default function HeaderTagline() {
  const { t } = useTranslation();
  return (
    <p className="text-xs sm:text-sm md:text-slate-600 font-bold mt-2">{t('app.tagline')}</p>
  );
}
