/**
 * Wave U — the client boundary that owns the locale.
 *
 * Mounted once in `app/layout.tsx` (a server component) so the whole tree —
 * header chip, dashboard, error boundary — sits under one subscription. The
 * first render is always English (SSR renders English markup; hydration
 * matches), then `restoreStoredLocale()` applies the stored choice in an
 * effect and every subscriber re-renders in place. No URL routing, no
 * header sniffing: the stored preference is the only input.
 */

'use client';

import React from 'react';
import { useLocaleBootstrap } from '@/i18n';

export default function I18nProvider({ children }: { children: React.ReactNode }) {
  useLocaleBootstrap();
  return <>{children}</>;
}
