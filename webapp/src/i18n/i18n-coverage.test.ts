/**
 * The i18n coverage gate — Wave U's missing half.
 *
 * Wave U shipped EN↔FR and `i18n.test.tsx` pins the catalogs against each
 * other, but nothing failed when a component ADDED later printed hardcoded
 * English. These tests close that hole from both directions:
 *
 *   1. Forward: no user-facing string literal in src/ may bypass `t()`.
 *      Anything already on screen when the gate landed is pinned in
 *      `coverage-baseline.json`; the list can only shrink.
 *   2. Reverse: every literal `t('key')` call must resolve to an en.json
 *      entry, so a typo can't render raw key text at the user.
 *
 * The scanner itself lives in `scripts/i18n-coverage.mjs` so a human can run
 * the same sweep with a readable report:
 *
 *   node scripts/i18n-coverage.mjs            # report + exit 1 on drift
 *   node scripts/i18n-coverage.mjs --write-baseline
 */

import { describe, it, expect } from 'vitest';
import {
  scanSource,
  findMissingCatalogKeys,
  loadBaseline,
  diffAgainstBaseline,
} from '../../scripts/i18n-coverage.mjs';

type Violation = {
  file: string;
  line: number;
  column?: number;
  kind: string;
  text: string;
  category?: string;
  catalogKey?: string | null;
};
type MissingKey = { file: string; line: number; key: string };

const sortViolations = (list: readonly Violation[]) =>
  [...list].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const explain = (v: Violation) =>
  `${v.file}:${v.line} [${v.kind}] ${JSON.stringify(v.text)}` +
  (v.catalogKey
    ? ` — en.json already has this text under "${v.catalogKey}"; render t('${v.catalogKey}') instead`
    : ' — no en.json value carries this text; add it to an area file (en + fr), run `node scripts/i18n-merge.mjs`, then use t()');

describe('i18n coverage gate (hardcoded user-facing strings)', () => {
  const violations = scanSource();
  const baseline = loadBaseline();
  const { newViolations, staleEntries } = diffAgainstBaseline(violations, baseline);

  it('reports a non-trivial scan (the sweep actually walked src/)', () => {
    // Sanity pin: if the scanner silently stops finding anything — a broken
    // import, a walk that misses directories — the gate below would pass on
    // nothing. The app has ~100 source files and Wave U left real debt.
    expect(violations.length).toBeGreaterThan(0);
    expect(new Set(violations.map((v) => v.file)).size).toBeGreaterThan(1);
  });

  it('introduces no NEW hardcoded user-facing string outside the baseline', () => {
    const found = sortViolations(newViolations).map(explain);
    expect(
      found,
      found.length === 0
        ? ''
        : `\n${found.length} new untranslated string(s) — the i18n coverage gate:\n\n` +
          `${found.join('\n')}\n\n` +
          'To fix: add the text under both en and fr in src/i18n/areas/<area>.json, run\n' +
          '`node scripts/i18n-merge.mjs`, and render it with t(\'your.key\').\n' +
          'Do NOT grow coverage-baseline.json for new work — that file is frozen debt.\n',
    ).toEqual([]);
  });

  it('keeps the baseline honest: no stale entries for violations that are fixed', () => {
    // A paid-off string must be removed from the baseline, or the file rots
    // into a place where dead lines hide real regressions.
    expect(
      [...staleEntries].sort(),
      staleEntries.length === 0
        ? ''
        : `\nThese baseline entries no longer match any violation — delete them from\n` +
          `src/i18n/coverage-baseline.json:\n\n${[...staleEntries].sort().join('\n')}\n`,
    ).toEqual([]);
  });
});

describe('i18n coverage gate (t() keys resolve to the catalog)', () => {
  it('calls t() only with keys en.json defines', () => {
    const missing = [...findMissingCatalogKeys() as MissingKey[]]
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map((m) => `${m.file}:${m.line} t('${m.key}')`);
    expect(
      missing,
      missing.length === 0
        ? ''
        : `\n${missing.length} t() key(s) with no en.json entry — t() falls back to printing the\n` +
          `raw key at the user:\n\n${missing.join('\n')}\n`,
    ).toEqual([]);
  });
});
