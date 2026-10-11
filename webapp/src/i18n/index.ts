/**
 * Wave U — the i18n core: one locale singleton, one `t()`, one set of
 * locale-aware formatters.
 *
 * Why a module singleton + a React subscription, instead of next-intl or a
 * context-only `t`: MOST user-visible prose in this app is produced inside
 * pure lib functions (`lib/verdict.ts`, `lib/parseDiagnostic.ts`,
 * `lib/moneyViz.ts`, …) that are called from `useMemo`s all over the tree.
 * Threading a translator through every one of those signatures would be a
 * several-thousand-line refactor of the computation layer. A module-level
 * `t()` keeps every lib signature untouched: the functions read the current
 * locale at call time, and components re-render on toggle by subscribing
 * with `useTranslation()`.
 *
 * The two rules that make that safe (both enforced by review + Wave U tests):
 *   1. Every component that renders ANY user-visible text calls
 *      `useTranslation()` — even if it only needs the subscription.
 *   2. Any `useMemo`/`useCallback` whose body (or callee) produces text
 *      lists `t` in its dependency array, so a locale switch recomputes it.
 *
 * Locale lives in localStorage (`oeo_locale`), default English, no
 * header/browser auto-detection — the toggle is the only thing that changes
 * it (prefs over surprise). The initial client render is ALWAYS English to
 * avoid a hydration mismatch; the stored locale is applied in an effect.
 */

'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { format as dateFnsFormat } from 'date-fns';
import { enUS, fr, type Locale as DateFnsLocale } from 'date-fns/locale';
import { PLAN_LABEL, type PlanId } from '@/hooks/useSelectedPlan';
import enCatalog from './en.json';
import frCatalog from './fr.json';

export type Locale = 'en' | 'fr';

export const LOCALES: readonly Locale[] = ['en', 'fr'];

/** French is opt-in; nothing about the request or the browser picks it. */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_STORAGE_KEY = 'oeo_locale';

/** OEB-official French plan names — see I18N.md for the citation. */
export const CATALOGS: Record<Locale, Record<string, string>> = {
  en: enCatalog,
  fr: frCatalog,
};

let currentLocale: Locale = DEFAULT_LOCALE;

/** Every subscriber is a React `useSyncExternalStore` bound to the tree. */
const subscribers = new Set<() => void>();

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Current locale. SSR-safe: never touches `window`. */
export function getLocale(): Locale {
  return currentLocale;
}

function notify(): void {
  for (const cb of subscribers) cb();
}

/** Subscribe to locale changes — the primitive under `useTranslation`. */
export function subscribeLocale(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/**
 * Switch locale. Persists to localStorage (when available) and notifies
 * every subscriber. A storage failure is non-fatal: the session stays
 * translated even if the preference cannot be remembered.
 */
export function setLocale(next: Locale): void {
  if (!isLocale(next) || next === currentLocale) return;
  currentLocale = next;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    document.documentElement.lang = next;
  } catch {
    // Private mode / quota — the in-memory locale is still authoritative.
  }
  notify();
}

/**
 * One-shot restore, called from the provider AFTER mount (never during the
 * first render — that would hydrate French markup against English SSR HTML).
 */
export function restoreStoredLocale(): void {
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(raw) && raw !== currentLocale) {
      currentLocale = raw;
      document.documentElement.lang = raw;
      notify();
    }
  } catch {
    // No storage access: stay on the default.
  }
}

/** `params.count` picks `_one`/`_other` when the catalog defines them. */
function selectKey(locale: Locale, key: string, params?: Record<string, string | number>): string {
  if (params && typeof params.count === 'number') {
    const suffix =
      new Intl.PluralRules(LOCALE_TO_BCP47[locale]).select(params.count) === 'one'
        ? '_one'
        : '_other';
    if (key + suffix in CATALOGS[locale] || key + suffix in CATALOGS.en) return key + suffix;
  }
  return key;
}

/**
 * Translate `key`, interpolating `{param}` placeholders.
 *
 * Fallback order: current locale → English → the key itself (a missing key
 * is visible in the UI instead of silently blank, and I18N.md's review pass
 * is what catches those).
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const resolved = selectKey(currentLocale, key, params);
  const template = CATALOGS[currentLocale][resolved] ?? CATALOGS.en[resolved] ?? resolved;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/* -------------------------------------------------------------------------- *
 * React binding
 * -------------------------------------------------------------------------- */

export type TranslationBag = {
  t: typeof t;
  locale: Locale;
  setLocale: (next: Locale) => void;
};

/**
 * Subscribe the component to the locale. The returned `t` is referentially
 * stable per-locale, so `useMemo(() => …, [t])` recomputes exactly when the
 * language changes — that is the idiomatic dep for text-producing memos.
 */
export function useTranslation(): TranslationBag {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
  // `t` closes over the module singleton, but its identity tracks `locale`
  // so memo dependency arrays work.
  const translate = useCallback(
    (key: string, params?: Record<string, string | number>) => t(key, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );
  return { t: translate, locale, setLocale };
}

/**
 * Locale-only subscription for components that format (no prose of their
 * own) — formatters read the module locale, so a re-render re-formats.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
}

/** Applies the stored locale to <html lang> once, after hydration. */
export function useLocaleBootstrap(): void {
  useEffect(() => {
    restoreStoredLocale();
  }, []);
}

/* -------------------------------------------------------------------------- *
 * Locale-aware formatting
 * -------------------------------------------------------------------------- */

const LOCALE_TO_BCP47: Record<Locale, string> = { en: 'en-CA', fr: 'fr-CA' };

/** date-fns locale objects for chart/table/period labels. */
export const DATE_FNS_LOCALE: Record<Locale, DateFnsLocale> = { en: enUS, fr };

export function bcp47(locale: Locale = currentLocale): string {
  return LOCALE_TO_BCP47[locale];
}

function num(value: number, digits: number): string {
  return new Intl.NumberFormat(bcp47(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Money, CAD. en-CA → "$1,365.03"; fr-CA → "1 365,03 $" (symbol trailing,
 * narrow no-break space before it — fr-CA convention, per the task's
 * fr-CA currency-symbol rule).
 */
export function fmtMoney(value: number, digits = 2): string {
  return new Intl.NumberFormat(bcp47(), {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Money without cents — "$812" / "812 $". */
export function fmtMoney0(value: number): string {
  return fmtMoney(value, 0);
}

/** Signed money for deltas — "−$45.10" / "−45,10 $"; zero stays "$0.00". */
export function fmtSignedMoney(value: number, digits = 2): string {
  const abs = fmtMoney(Math.abs(value), digits);
  if (value < 0) return `−${abs}`;
  if (value > 0) return `+${abs}`;
  return abs;
}

/**
 * DISPLAY CONTRACT for ¢/kWh figures (the rate-display SSOT, PR #39).
 *
 * Two formatters, split by WHERE THE NUMBER CAME FROM — never by which
 * component is printing it, so the card and the row underneath it can never
 * disagree about one rate:
 *
 *  - `fmtCentsAuto` — anything that QUOTES THE TARIFF: every RateSet field
 *    and every value that is a RateSet field under another name (plan-card
 *    rate chips, the shift optimizer's baseline and destination rates, the
 *    rate-staleness deltas, the EV peak-exposure rate). The tariff chose the
 *    precision, so the number prints exactly as the source reads it: 9.75
 *    stays "9.75¢" and 12.0 becomes "12¢". A forced single digit here would
 *    print 9.75 as 9.8¢ while the bill on the same card still used 9.75.
 *
 *  - `fmtCents` — MEASURED or DERIVED ¢/kWh where the digit count is a
 *    deliberate presentation choice: the efficiency card's bill ÷ kWh, the
 *    per-kWh splits of a real bill, an unbilled-period estimate, the
 *    kWh-weighted hourly average. Fixed digits keep a derived figure's float
 *    noise out of the UI ("16.9¢", never "16.900000000001¢").
 *
 * Rule of thumb: came off a rate schedule → `fmtCentsAuto`; computed from
 * readings or bills → `fmtCents(x, n)`.
 */
export function fmtCents(value: number, digits = 1): string {
  const n = num(value, digits);
  return currentLocale === 'fr' ? `${n} ¢` : `${n}¢`;
}

/**
 * Cents with the number's OWN precision (no forced digits) — for anything
 * that quotes a RateSet value: the rate table reads "9.75¢→22¢" exactly as
 * the source data reads. See the display contract on `fmtCents` above.
 * fr-CA puts a space before the symbol: "9,75 ¢".
 */
export function fmtCentsAuto(value: number): string {
  const n = new Intl.NumberFormat(bcp47(), { maximumFractionDigits: 2 }).format(value);
  return currentLocale === 'fr' ? `${n} ¢` : `${n}¢`;
}

/** "8.7 kWh" / "8,7 kWh". */
export function fmtKwh(value: number, digits = 1): string {
  return `${num(value, digits)} kWh`;
}

/** "412 Wh" / "412 Wh". */
export function fmtWh(value: number, digits = 0): string {
  return `${num(value, digits)} Wh`;
}

/** Plain locale-aware number — "1,249" / "1 249". */
export function fmtNumber(value: number, digits = 0): string {
  return num(value, digits);
}

/** Percent — "63%" / "63 %". */
export function fmtPercent(value: number, digits = 0): string {
  const n = num(value, digits);
  return currentLocale === 'fr' ? `${n} %` : `${n}%`;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a `yyyy-MM-dd` day string as a LOCAL date (the dataset's own days,
 * never UTC — the DST and zone rules in lib/localTimeParameters assume this).
 */
export function isoDayToDate(day: string): Date {
  const m = ISO_DAY.exec(day);
  if (!m) return new Date(day);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const D = DATE_FNS_LOCALE;

/** Date-fns `format` bound to the current locale. */
export function fmtDate(date: Date | number | string, pattern: string): string {
  const d = date instanceof Date ? date : new Date(date);
  return dateFnsFormat(d, pattern, { locale: D[currentLocale] });
}

/**
 /**
  * "Aug 26, 2025" / "26 août 2025" — the totals strip's long date. The
  * English form keeps its comma; fr-CA does not use one after the day.
  */
 export function fmtDateLong(date: Date | number): string {
   return fmtDate(date, currentLocale === 'fr' ? 'd MMM yyyy' : 'MMM d, yyyy');
 }

 /**
 * "Sunday, Aug 26th" / "dimanche 26 août" — the anomaly card's day label.
 * English keeps date-fns' ordinal suffix; French writes the day first with
 * no ordinal, which is how a French calendar spells it.
 */
export function fmtWeekdayDate(date: Date | number): string {
  return currentLocale === 'fr'
    ? fmtDate(date, 'EEEE d MMMM yyyy')
    : fmtDate(date, 'EEEE, MMM do');
}

/** "Aug 26" / "26 août" — from a `yyyy-MM-dd` day string.
 *
 * date-fns' fr locale abbreviates some months with a trailing dot
 * ("24 sept."), which the OEB-style period caption does not use; strip it
 * so ranges read "26 août – 24 sept".
 */
export function fmtDay(day: string): string {
  const raw = fmtDate(isoDayToDate(day), currentLocale === 'fr' ? 'd MMM' : 'MMM d');
  return currentLocale === 'fr' ? raw.replace(/\.$/, '') : raw;
}

/** "Aug 26 – Sep 24" / "26 août – 24 sept" — the billing-period caption. */
export function fmtDayRange(startDay: string, endDay: string): string {
  const dash = ' – ';
  return fmtDay(startDay) + dash + fmtDay(endDay);
}

/** "Mon 26" style short weekday — charts label buckets with this. */
export function fmtWeekday(date: Date | number, pattern = 'EEE'): string {
  return fmtDate(date, pattern);
}

/* -------------------------------------------------------------------------- *
 * Canonical, translated-on-display labels
 * -------------------------------------------------------------------------- */

/**
 * The plan name FOR DISPLAY. `PLAN_LABEL` stays the canonical English name
 * (storage, fingerprints, data-* attributes, the classifier) — this is the
 * localized view of it, using the OEB's own French wording (I18N.md).
 */
export function planLabel(plan: PlanId, locale: Locale = currentLocale): string {
  return locale === 'fr' ? FR_PLAN_LABEL[plan] : PLAN_LABEL[plan];
}

/** OEB French names — verified on oeb.ca/fr (see I18N.md). */
export const FR_PLAN_LABEL: Record<PlanId, string> = {
  TOU: 'Tarification selon l’heure de consommation',
  Tiered: 'Tarification par paliers',
  ULO: 'Tarif d’électricité de nuit très bas',
};

/**
 * Short forms for tight chips/buttons (the toolbar switcher, the verdict
 * chip) where the full OEB name cannot fit at 390 px. Compact but still
 * French words a Hydro Ontario customer reads on their own bill.
 */
export const FR_PLAN_SHORT: Record<PlanId, string> = {
  TOU: 'Heures',
  Tiered: 'Paliers',
  ULO: 'Nuit',
};

/** Canonical English rate-period names → OEB French period names. */
export const FR_PERIOD_LABEL: Record<string, string> = {
  'Off-Peak': 'Période creuse',
  'Mid-Peak': 'Période normale',
  'On-Peak': 'Période de pointe',
  'Weekend Off-Peak': 'Période creuse (fin de semaine)',
  'Ultra-Low Overnight': 'Période basse de nuit',
};

/**
 * Translate a canonical rate-period name ("Off-Peak" → "Période creuse").
 * Unknown names pass through untouched: rate-set names and fingerprints are
 * canonical data (task rule 4), and only known periods get a French view.
 */
export function periodLabel(name: string, locale: Locale = currentLocale): string {
  return locale === 'fr' ? (FR_PERIOD_LABEL[name] ?? name) : name;
}
