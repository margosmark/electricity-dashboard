/**
 * The MONEY-FORMAT contract.
 *
 * Wave U fixed French money once (7ee0375) and the fr-CA build still printed
 * `1 420,89 $$/AN` on all four plan-cost headlines, `kWh kWh` three times on
 * Plans, and `11.9¢` beside `3,9 ¢` on one page. Two things were missing, and
 * this file supplies both:
 *
 *   1. a per-locale pin on the FORMATTERS — every money/unit string the app
 *      can produce, asserted in en-CA and fr-CA, so a symbol can only appear
 *      once and a decimal separator follows the active locale;
 *   2. a per-locale pin on the RENDER SITES — the source sweep in
 *      `scripts/money-contract.mjs` walks every file under `src/` and fails
 *      when a number reaches the DOM without going through `@/i18n`, or when
 *      a catalog template is handed a value that already carries the unit
 *      the template prints.
 *
 * Read `scripts/money-contract.mjs` for the rules (M1–M5); this file is the
 * gate. `node scripts/money-contract.mjs --list` prints the pinned sites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scan,
  scanFile,
  scanCatalogs,
  listSourceFiles,
} from '../../scripts/money-contract.mjs';
import {
  setLocale,
  fmtMoney,
  fmtMoney0,
  fmtSignedMoney,
  fmtCents,
  fmtCentsAuto,
  fmtKwh,
  fmtNumber,
  fmtNumberAuto,
  fmtPercent,
  moneyPeriodUnit,
  MONEY_PERIOD_UNIT_KEY,
} from './index';

/** The currency symbols a money string may carry. */
const SYMBOLS = /[¢$]/g;
const countSymbols = (s: string) => (s.match(SYMBOLS) ?? []).length;

/** A decimal separator: a dot (en-CA) or a comma (fr-CA) between digits.
 *  en-CA groups with commas (`1,420.89`), so a comma only counts as a
 *  separator when it is NOT followed by a third digit. */
const EN_DECIMAL = /\d\.\d/;
const FR_DECIMAL = /\d,\d(?!\d)/;
const FR_LEADING_SYMBOL = /\$\s*\d/;

describe('money formatters — one symbol, the locale’s own separators', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale('en'));

  it('en-CA: symbol first, dot decimal, comma grouping', () => {
    expect(fmtMoney(1420.89)).toBe('$1,420.89');
    expect(fmtMoney0(812)).toBe('$812');
    expect(fmtSignedMoney(-45.1)).toBe('−$45.10');
    expect(fmtCents(11.9)).toBe('11.9¢');
    expect(fmtCentsAuto(9.8)).toBe('9.8¢');
    expect(fmtKwh(8.7)).toBe('8.7 kWh');
    expect(fmtNumber(1249)).toBe('1,249');
    expect(fmtPercent(63)).toBe('63%');
  });

  it('fr-CA: symbol LAST, comma decimal, space grouping — never a leading $', () => {
    setLocale('fr');
    const money = fmtMoney(1420.89);
    expect(money).toMatch(/^1[\s\u00a0\u202f]420,89\s\$$/);
    expect(money).not.toContain('$1');
    expect(fmtMoney0(812)).toMatch(/^812\s\$$/);
    expect(fmtSignedMoney(-45.1)).toMatch(/^−45,10\s\$$/);
    expect(fmtCents(11.9)).toBe('11,9 ¢');
    expect(fmtCentsAuto(9.8)).toBe('9,8 ¢');
    expect(fmtKwh(8.7)).toBe('8,7 kWh');
    expect(fmtNumber(1249)).toMatch(/^1[\s\u00a0\u202f]249$/);
    expect(fmtPercent(63)).toBe('63 %');
  });

  it('pins EVERY money formatter x both locales against the shared invariants', () => {
    // The sweep, not the examples: every formatter, both locales, the same
    // three rules — one currency symbol, the locale's decimal separator, and
    // no digit-grouping with the other locale's separator.
    const cases: [string, (n: number) => string, number[]][] = [
      ['fmtMoney', (n) => fmtMoney(n), [0, 0.4, 11.9, 812, 1420.89, 1234567.89]],
      ['fmtMoney0', (n) => fmtMoney0(n), [0, 812, 1234567]],
      ['fmtSignedMoney', (n) => fmtSignedMoney(n), [-45.1, 0, 45.1]],
      ['fmtCents', (n) => fmtCents(n), [0, 0.4, 11.9, 39.1]],
      ['fmtCentsAuto', (n) => fmtCentsAuto(n), [0, 0.4, 9.75, 39.99]],
      ['fmtKwh', (n) => fmtKwh(n), [0, 8.7, 1234.5]],
      ['fmtNumber', (n) => fmtNumber(n), [0, 812, 1249]],
      ['fmtNumberAuto', (n) => fmtNumberAuto(n), [0, 0.4, 11.9, 1249]],
      ['fmtPercent', (n) => fmtPercent(n), [0, 3, 63]],
    ];
    for (const [name, format, values] of cases) {
      for (const value of values) {
        for (const locale of ['en', 'fr'] as const) {
          setLocale(locale);
          const out = format(value);
          const label = `${name}(${value}) in ${locale}`;
          // 1. Exactly one money symbol, whatever the unit is.
          expect(countSymbols(out), `${label} → ${JSON.stringify(out)}`).toBe(
            /[¢$]/.test(out) ? 1 : 0,
          );
          // 2. The decimal separator is the locale's own, and fr-CA never
          //    leads with the symbol.
          if (locale === 'fr') {
            expect(EN_DECIMAL.test(out), `${label} → ${out} uses an en decimal separator in fr`).toBe(false);
            expect(FR_LEADING_SYMBOL.test(out), `${label} → ${out} leads with $ in fr`).toBe(false);
          } else {
            expect(FR_DECIMAL.test(out), `${label} → ${out} uses a fr decimal separator in en`).toBe(false);
          }
        }
      }
    }
    setLocale('en');
  });

  it('never emits a leading `$` in fr-CA — the doubled-symbol source', () => {
    setLocale('fr');
    for (const value of [0, 0.4, 11.9, 812, 1420.89, 1234567.89]) {
      for (const out of [fmtMoney(value), fmtMoney0(value), fmtSignedMoney(value), fmtSignedMoney(-value)]) {
        expect(out.startsWith('$'), `${out} starts with $ in fr-CA`).toBe(false);
        expect(out).not.toContain('$$');
      }
    }
    setLocale('en');
  });

  it('the period unit is symbol-free in BOTH locales (the `$$/AN` pin)', () => {
    // `t('overview.perYear')` is "$/yr" / "$/an" — correct as a standalone
    // toggle label, and a doubled "1 420,89 $$/AN" the moment it is appended
    // to fmtMoney's output. Every chip that sits next to money uses THIS.
    for (const period of ['yr', 'day'] as const) {
      for (const locale of ['en', 'fr'] as const) {
        setLocale(locale);
        const unit = moneyPeriodUnit(period);
        expect(unit, `${MONEY_PERIOD_UNIT_KEY[period]} in ${locale}`).toMatch(/^\/[a-zà-ÿ]+$/);
        expect(unit).not.toMatch(/[¢$]/);
        // And composing it with money yields exactly one symbol, ever.
        expect(countSymbols(fmtMoney(1420.89) + unit)).toBe(1);
      }
    }
    setLocale('en');
  });
});

describe('money-format contract gate (source sweep)', () => {
  const { violations, sites } = scan();

  it('walks the real source tree and still pins unit-bearing render sites', () => {
    // A clean scan and a scanner that silently stopped working look identical
    // (both report zero violations), so pin the walk instead of a count.
    expect(listSourceFiles().length).toBeGreaterThan(50);
    expect(sites.length).toBeGreaterThanOrEqual(20);
    for (const s of sites.slice(0, 20)) {
      expect(s.file).toMatch(/^src\//);
      expect(s.key).toMatch(/\w+\.\w+/);
    }
  });

  it('introduces no raw money/number render and no doubled unit token', () => {
    const found = violations.map(
      (v) => `${v.rule} ${v.file}:${v.line} — ${v.source}\n    ${v.detail}`,
    );
    expect(
      found,
      found.length === 0
        ? ''
        : `\n${found.length} money-format violation(s) — the contract\n` +
          `(rules M1–M5, see scripts/money-contract.mjs):\n\n${found.join('\n')}\n\n` +
          'Every number a person reads must be formatted by @/i18n. A catalog\n' +
          'template that already prints the unit takes a BARE number\n' +
          '(`fmtNumber`/`fmtNumberAuto`), never `fmtKwh`/`fmtCents`/`fmtMoney`.\n',
    ).toEqual([]);
  });

  it('keeps the catalogs on the locale’s own side of the dollar sign (M5)', () => {
    const found = scanCatalogs().map((v) => `${v.file} — ${v.source}\n    ${v.detail}`);
    expect(found, found.length === 0 ? '' : `\n${found.join('\n')}\n`).toEqual([]);
  });

  it('still fires on every rule when a violation is planted', () => {
    // The planted-failure probe: one scratch file per rule, scanned through
    // the same code path as the real tree.
    const dir = mkdtempSync(join(tmpdir(), 'money-contract-probe-'));
    const probes: [string, string, string][] = [
      [
        'M1',
        'ProbeM1.tsx',
        "export const P = ({ n }: { n: number }) => <span>{`$${n.toFixed(2)}`}</span>;\n",
      ],
      [
        'M2',
        'ProbeM2.tsx',
        "export const P = ({ n }: { n: number }) => <span>{n.toLocaleString('en-CA', { maximumFractionDigits: 1 })}</span>;\n",
      ],
      [
        'M3',
        'ProbeM3.tsx',
        'export const P = ({ n }: { n: number }) => <span data-testid="x">{n.toFixed(1)}{"¢"}</span>;\n',
      ],
      [
        'M4',
        'ProbeM4.tsx',
        "import { fmtKwh } from '@/i18n';\nimport { t } from '@/i18n';\n" +
          "export const P = ({ kwh }: { kwh: number }) => <span>{t('wfh.annotation', { total: fmtKwh(kwh) })}</span>;\n",
      ],
    ];
    try {
      for (const [rule, name, body] of probes) {
        const file = join(dir, name);
        writeFileSync(file, body);
        const hits = scanFile(file).violations;
        expect(hits.map((h) => h.rule), `${name} should trip ${rule}`).toContain(rule);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
