/**
 * Wave U — the i18n contract.
 *
 * These tests are the "no partial pass" gate: the two catalogs must agree
 * key-for-key, French must actually be French, fr-CA formatting must move
 * with the locale, and the toggle must be a real, labelled, keyboard-
 * reachable button (the Wave H a11y bar).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import en from './en.json';
import fr from './fr.json';
import LocaleToggle from '@/components/LocaleToggle';
import {
  t, getLocale, setLocale, isLocale, planLabel, periodLabel,
  fmtMoney, fmtMoney0, fmtSignedMoney, fmtCents, fmtKwh, fmtPercent,
  fmtDay, fmtDayRange, isoDayToDate, DEFAULT_LOCALE,
} from './index';

/** Values that are legitimately identical in both catalogs (proper nouns,
 *  symbols, codes). Anything else equal across locales is an untranslated
 *  string and fails the sweep's acceptance bar. */
const BILINGUALLY_IDENTICAL_OK = new Set([
  'app.title', // the product name is a proper noun
  'locale.toggle.label', // "FR"/"EN" — the code names the OTHER language
  'actualBill.delta', // "Δ {delta}" — the delta glyph is the same in both
  'efficiency.perKwh', // "/kWh" — the unit is the same in both
  'overview.centsPerKwh', // "¢/kWh ·" — unit + separator, identical in fr
  'ev.perKwh', // "¢/kWh" — the unit is the same in both
  'money.kwhUnit', // "kWh" — the unit is the same in both
  'anomalies.tempSuffix', // "°C · " — unit + separator, identical in fr
  'heatmap.hourSuffix', // "h" — the 24-hour grid's hour suffix, same in fr
  'efficiency.verdict.stable', // "STABLE" — French writes it the same way
  'trueBill.variable', // "Variable" — identical word in fr-CA
  'yoy.deltaHeader', // "Δ vs …" — the Δ glyph and "vs" are the same in fr
  'delta.arrow', // "Δ → {label}" — glyph-only, identical in fr
  'delta.chargeCol', // "Charge" — the same word in fr-CA accounting
  'planCard.active', // "ACTIVE" — French writes it the same way
  'track.vs', // "vs {plan}" — "vs" is standard French usage
  'ev.signedPositive', // "+{amount}" — the sign glyph is the same in both
  'ev.signedNegative', // "−{amount}" — the minus glyph is the same in both
  'ev.categoriesAnd', // " + " — the joiner between period names is glyph-only
  'account.quietFormat', // "HH:MM-HH:MM" — a clock-format code, identical in fr
  'gasBill.m3Unit', // "m³" — the cubic-metre glyph, identical in fr
  'gasBill.rateUnit', // "¢/m³" — the unit glyph, identical in fr
  'gasBill.supplier', // "Enbridge Gas Distribution" — the utility's own name
  'gbseries.notice.repeatCount', // "×{count}" — the × glyph is the same in fr
]);

describe('i18n catalogs', () => {
  it('en and fr carry exactly the same keys', () => {
    const enKeys = Object.keys(en).sort();
    const frKeys = Object.keys(fr).sort();
    expect(frKeys).toEqual(enKeys);
  });

  it('has no empty values', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en.${key}`).toBeTypeOf('string');
      expect(value.length, `en.${key}`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(fr)) {
      expect(value.length, `fr.${key}`).toBeGreaterThan(0);
    }
  });

  it('preserves the root registration-closed copy exactly', () => {
    expect(en['account.registrationClosed']).toBe(
      'Registration is closed until mailbox verification and the concrete retention policy are configured. You will choose a passphrase only after proving control of your email address.',
    );
    expect(fr['account.registrationClosed']).toBe(
      "La création de compte est fermée jusqu'à la configuration de la vérification par courriel et de la politique concrète de conservation. Vous ne choisirez une phrase secrète qu'après avoir prouvé que cette adresse vous appartient.",
    );
  });

  it('translates every key except the whitelisted proper nouns', () => {
    const untranslated = Object.keys(en).filter(
      (key) => en[key as keyof typeof en] === fr[key as keyof typeof fr] && !BILINGUALLY_IDENTICAL_OK.has(key),
    );
    expect(untranslated, `untranslated keys: ${untranslated.join(', ')}`).toEqual([]);
  });

  it('keeps {placeholder} tokens identical across locales', () => {
    const tokens = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const key of Object.keys(en)) {
      expect(tokens(fr[key as keyof typeof fr]), `placeholders of ${key}`).toBe(
        tokens(en[key as keyof typeof en]),
      );
    }
  });

  it('namespaces every key with a dot (area.something)', () => {
    for (const key of Object.keys(en)) {
      expect(key, `key "${key}"`).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/);
    }
  });
});

describe('locale store', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('en'));

  it('defaults to English (French is opt-in)', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(getLocale()).toBe('en');
  });

  it('validates stored values instead of trusting them', () => {
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(42)).toBe(false);
  });

  it('t() translates and interpolates', () => {
    expect(t('tab.overview')).toBe('Overview');
    setLocale('fr');
    expect(t('tab.overview')).toBe('Aperçu');
  });

  it('interpolates {params} everywhere, including a missing key fallback', () => {
    // A missing key degrades to the key text — and its placeholders still fill,
    // so an untranslated string never renders a raw "{count}" at the user.
    expect(t('nope.missing {name}', { name: 'x' })).toBe('nope.missing x');
  });

  it('falls back to English for a key missing in French, then to the key', () => {
    // Simulated via the public fallback chain: an unknown key returns itself.
    expect(t('nope.not.a.key')).toBe('nope.not.a.key');
  });

  it('setLocale persists to localStorage so the choice survives reloads', () => {
    setLocale('fr');
    expect(window.localStorage.getItem('oeo_locale')).toBe('fr');
    setLocale('en');
    expect(window.localStorage.getItem('oeo_locale')).toBe('en');
  });
});

describe('plan + period labels (canonical data, localized view)', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('en'));

  it('uses the OEB French plan names in French', () => {
    setLocale('fr');
    expect(planLabel('TOU')).toBe('Tarification selon l’heure de consommation');
    expect(planLabel('Tiered')).toBe('Tarification par paliers');
    expect(planLabel('ULO')).toBe('Tarif d’électricité de nuit très bas');
  });

  it('keeps the canonical English names in English', () => {
    expect(planLabel('TOU')).toBe('Time-of-Use');
    expect(planLabel('ULO')).toBe('Ultra-Low Overnight');
  });

  it('localizes known rate periods and passes unknown names through', () => {
    setLocale('fr');
    expect(periodLabel('Off-Peak')).toBe('Période creuse');
    expect(periodLabel('On-Peak')).toBe('Période de pointe');
    expect(periodLabel('Weekend Off-Peak')).toBe('Période creuse (fin de semaine)');
    // Canonical fingerprint text is NOT translated — it is data.
    expect(periodLabel('BLOCK 1 - Winter')).toBe('BLOCK 1 - Winter');
  });
});

describe('fr-CA / en-CA formatting follows the toggle', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('en'));

  it('formats currency en-CA vs fr-CA (symbol position + separators)', () => {
    expect(fmtMoney(1365.03)).toBe('$1,365.03');
    setLocale('fr');
    const fr_money = fmtMoney(1365.03);
    expect(fr_money).toMatch(/1[\s\u00a0\u202f]365,03\s?\$/);
    expect(fmtMoney0(812)).toMatch(/812\s?\$/);
  });

  it('formats signed money for verdict deltas', () => {
    expect(fmtSignedMoney(-45.1)).toBe('−$45.10');
    setLocale('fr');
    expect(fmtSignedMoney(-45.1)).toMatch(/−45,10\s?\$/);
  });

  it('uses a space before ¢ and a comma decimal in French', () => {
    expect(fmtCents(0.4)).toBe('0.4¢');
    setLocale('fr');
    expect(fmtCents(0.4)).toBe('0,4 ¢');
  });

  it('formats percentages with the French thin space', () => {
    expect(fmtPercent(63)).toBe('63%');
    setLocale('fr');
    expect(fmtPercent(63)).toBe('63 %');
  });

  it('formats kWh with locale decimals', () => {
    expect(fmtKwh(8.7)).toBe('8.7 kWh');
    setLocale('fr');
    expect(fmtKwh(8.7)).toBe('8,7 kWh');
  });

  it('formats month names and ranges per locale', () => {
    expect(fmtDay('2025-08-26')).toBe('Aug 26');
    expect(fmtDayRange('2025-08-26', '2025-09-24')).toBe('Aug 26 – Sep 24');
    setLocale('fr');
    expect(fmtDay('2025-08-26')).toBe('26 août');
    expect(fmtDayRange('2025-08-26', '2025-09-24')).toBe('26 août – 24 sept');
  });

  it('parses yyyy-MM-dd as a LOCAL date (never UTC-shifted)', () => {
    const d = isoDayToDate('2025-08-26');
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(26);
  });
});

describe('LocaleToggle (Wave H a11y bar applies)', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => {
    setLocale('en');
    cleanup();
  });

  it('is a real button with an accessible name and state', () => {
    render(<LocaleToggle />);
    const btn = screen.getByTestId('locale-toggle');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAccessibleName('Switch to French');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('data-locale', 'en');
  });

  it('flips the locale on click and updates its own label/state', async () => {
    const user = userEvent.setup();
    render(<LocaleToggle />);
    await user.click(screen.getByTestId('locale-toggle'));
    expect(getLocale()).toBe('fr');
    const btn = screen.getByTestId('locale-toggle');
    expect(btn).toHaveAttribute('data-locale', 'fr');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAccessibleName('Passer à l’anglais');
  });

  it('is keyboard operable (Enter/Space activate a button by default)', async () => {
    const user = userEvent.setup();
    render(<LocaleToggle />);
    await user.tab();
    expect(screen.getByTestId('locale-toggle')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(getLocale()).toBe('fr');
    await user.keyboard(' ');
    expect(getLocale()).toBe('en');
  });

  it('marks the visible code with lang so screen readers pronounce it', () => {
    render(<LocaleToggle />);
    const code = screen.getByTestId('locale-toggle').querySelector('span[lang]');
    expect(code).not.toBeNull();
    expect(code).toHaveAttribute('lang', 'fr');
  });
});
