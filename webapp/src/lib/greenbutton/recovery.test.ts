/**
 * The RECOVERY-MESSAGE contract, run over the hostile-XML corpus in both
 * locales.
 *
 * Run: `npx vitest run src/lib/greenbutton/recovery.test.ts`
 *
 * WHAT IS BEING PINNED
 * For every document `hostileCorpus.ts` can produce, the app must show the
 * reader a message that:
 *
 *   1. EXISTS — headline, detail and at least one hint, never nothing;
 *   2. IS OURS — every part composes from a catalog entry of the CURRENT
 *      locale, so no library string (`readTagExp returned undefined…`,
 *      `Maximum nested tags exceeded`, the validator's own `Invalid '[…]'`
 *      dump) can be the thing a French reader sees, and the French answer
 *      differs from the English one;
 *   3. IS CLEAN — no raw catalog key, no unfilled `{placeholder}`;
 *   4. MOVES THE READER — at least one hint, because a refusal with no next
 *      step is just bad news.
 *
 * Composition is checked against the catalog with the placeholders widened to
 * `[\s\S]*`, which is what lets a template like `parse.refuseBytes` pass while
 * an echoed parser message (which no entry ever produced) fail. The denylist
 * below is the belt to that braces: a param IS interpolated into a catalog
 * template, so the specific parser strings this corpus provokes are named
 * outright — the class this card found (an English validator message inside
 * the French sentence) cannot come back silently.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CATALOGS, getLocale, setLocale, type Locale } from '@/i18n';
import { parseGreenButtonUsagePoints } from '@/lib/energy';
import { describeGbError } from './client';
import { HOSTILE_CORPUS, type CorpusCase, type CorpusOutcome } from './hostileCorpus';
import { isGreenButtonRefusal } from './limits';
import { recoveryMessage, type RecoveryMessage } from './recovery';

/** fast-xml-parser's own prose, as this corpus provokes it. Never shown. */
const PARSER_PROSE = [
  'readTagExp',
  'Maximum nested tags',
  'Comment is not closed',
  'CDATA is not closed',
  'Pi Tag is not closed',
  'Closing Tag is not closed',
  'External entities are not supported',
  'Invalid entity name',
  'exceeds maximum allowed size',
  'Start tag expected',
  'Expected closing tag',
  'is an invalid name',
  'boolean attribute',
  'Unclosed tag',
  'XML declaration allowed only',
  "Invalid '",
  'TypeError',
  'RangeError',
  'unparseable',
];

/** Compile `{param}` templates into matchers once, for the locale in hand. */
function composedMatchers(catalog: Record<string, string>): RegExp[] {
  return Object.values(catalog)
    .filter((v) => v.includes('{'))
    .map((v) => {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]*\\\}/g, '[\\s\\S]*');
      return new RegExp(`^${escaped}$`);
    });
}

function isComposed(message: string, exact: Set<string>, patterns: RegExp[]): boolean {
  return exact.has(message) || patterns.some((p) => p.test(message));
}

type Pass = {
  locale: Locale;
  exact: Set<string>;
  patterns: RegExp[];
  /** case id → the message the surface shows (null when the case imports). */
  messages: Map<string, RecoveryMessage | null>;
  outcomes: Map<string, CorpusOutcome>;
};

/** One locale's run of the WHOLE corpus through the real funnel. */
function runPass(locale: Locale): Pass {
  setLocale(locale);
  const catalog = CATALOGS[locale];
  const pass: Pass = {
    locale,
    exact: new Set(Object.values(catalog)),
    patterns: composedMatchers(catalog),
    messages: new Map(),
    outcomes: new Map(),
  };

  for (const c of HOSTILE_CORPUS) {
    let message: RecoveryMessage | null = null;
    let outcome: CorpusOutcome;
    try {
      const readings = parseGreenButtonUsagePoints(c.xml).reduce((n, g) => n + g.readings.length, 0);
      if (readings > 0) {
        outcome = 'import';
      } else {
        outcome = 'reject';
        message = recoveryMessage({ text: c.xml, readings: 0 });
      }
    } catch (error) {
      outcome = isGreenButtonRefusal(error) ? 'refuse' : 'reject';
      // A refusal carries the copy it was raised with — translated at throw
      // time — which is why each locale re-runs the funnel instead of reusing
      // the previous pass's text.
      message = recoveryMessage({ text: c.xml, error });
    }
    pass.messages.set(c.id, message);
    pass.outcomes.set(c.id, outcome);
  }
  return pass;
}

function assertContract(id: string, msg: RecoveryMessage, pass: Pass): void {
  const label = `${id} (${pass.locale})`;
  expect(msg.ok, `${label}: not a failure message`).toBe(false);

  const fields: [string, string][] = [
    ['headline', msg.headline],
    ['detail', msg.detail],
    ...msg.hints.map((h, i) => [`hint${i}`, h] as [string, string]),
  ];

  for (const [name, value] of fields) {
    const where = `${label}: ${name}`;
    expect(typeof value, where).toBe('string');
    expect(value.trim().length, `${where} is empty`).toBeGreaterThan(0);
    // A raw key means `t()` never ran — the catalog key itself painted.
    expect(value, `${where} is a raw catalog key`).not.toMatch(/\b(diag|parse|upload|gb|import)\.[a-zA-Z]/);
    // An unfilled `{placeholder}` means a template was called without its param.
    expect(value, `${where} has an unfilled placeholder`).not.toMatch(/\{\w+\}/);
    // Composed from THIS locale's catalog: the definition of "our words".
    expect(
      isComposed(value, pass.exact, pass.patterns),
      `${where} is not ours: ${JSON.stringify(value)}`,
    ).toBe(true);
    // Belt: no parser prose, even when it arrives as an interpolated param.
    for (const prose of PARSER_PROSE) {
      expect(value, `${where} quotes the parser: ${JSON.stringify(value)}`).not.toContain(prose);
    }
  }

  expect(msg.hints.length, `${label}: a refusal must say what to do next`).toBeGreaterThan(0);
}

describe('recoveryMessage over the hostile-XML corpus', () => {
  afterEach(() => setLocale('en'));

  it('holds the contract in English and French, and no message falls back to English', () => {
    const en = runPass('en');
    const fr = runPass('fr');

    let messages = 0;
    let compared = 0;
    for (const c of HOSTILE_CORPUS) {
      const enMsg = en.messages.get(c.id)!;
      const frMsg = fr.messages.get(c.id)!;

      if (en.outcomes.get(c.id) === 'import') {
        expect(enMsg, `${c.id}: an import must produce no error message`).toBeNull();
        expect(frMsg, `${c.id}: French pass disagrees`).toBeNull();
        continue;
      }
      messages += 1;
      assertContract(c.id, enMsg, en);
      assertContract(c.id, frMsg, fr);
      compared += 1;
      expect(JSON.stringify(frMsg), `${c.id}: the French message is identical to the English one`).not.toBe(
        JSON.stringify(enMsg),
      );
    }

    // The corpus must contain plenty of failures, or this proves nothing: a
    // corpus where everything imports would pass vacuously.
    expect(messages).toBeGreaterThan(50);
    expect(compared).toBe(messages);
    // The last pass run above is French — proof the locale actually flipped.
    expect(getLocale()).toBe('fr');
  }, 300_000);

  it('the sync toolbar gets a sentence instead of the bare code word', () => {
    // The toolbar renders `outcome.detail ?? describeGbError(code).detail`,
    // and describeGbError's default branch ECHOES its argument — so a parse
    // failure that carried no detail printed the literal word "unparseable"
    // where a recovery message belongs.
    expect(describeGbError('unparseable').detail).toBe('unparseable');

    const hostile = HOSTILE_CORPUS.find((c: CorpusCase) => c.id === 'truncated-pi')!;
    let error: unknown;
    let readings = 0;
    try {
      readings = parseGreenButtonUsagePoints(hostile.xml).reduce((n, g) => n + g.readings.length, 0);
    } catch (e) {
      error = e;
    }
    const detail = recoveryMessage({ text: hostile.xml, error, readings }).detail;

    expect(detail).not.toBe('unparseable');
    expect(detail.trim().length).toBeGreaterThan(0);
    expect(isComposed(detail, new Set(Object.values(CATALOGS.en)), composedMatchers(CATALOGS.en))).toBe(true);
    for (const prose of PARSER_PROSE) expect(detail).not.toContain(prose);
  });
});
