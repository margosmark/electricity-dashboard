/**
 * The authoring-time half of the runtime i18n rule.
 *
 * `src/i18n/fr-runtime.test.tsx` catches a stale memo by PAINTING the page in
 * both locales — true, but late (the mistake is already written). This gate
 * catches it where it is made: a `useMemo` that produces locale-dependent text
 * and does not list `t` (or `locale`) in its deps caches the old language, so
 * the French page keeps English prose (qa's 2026-10-12 walk: 11 strings on
 * Usage/Plans that the catalogs could not have caught, because the catalogs
 * were complete — the RENDER SITES were stale).
 *
 * Why the scanner walks callees, not just `t(` calls: the app's prose is
 * written inside pure lib functions (`analyzeTouShifts`, `buildBillingAxis`,
 * `buildSwitchReport`, …) that read the module locale at call time — that is
 * deliberate (see `@/i18n`'s header), so the memo that CALLS one of them is
 * the thing that needs the dependency.
 *
 *   node scripts/i18n-locale-deps.mjs          # readable report
 *   node scripts/i18n-locale-deps.mjs --json    # machine-readable
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMissingLocaleDeps, listSourceFiles } from '../../scripts/i18n-locale-deps.mjs';

type Violation = { file: string; line: number; hook: string; deps: string };

const explain = (v: Violation) =>
  `${v.file}:${v.line} ${v.hook}(…) deps=${v.deps} — add \`t\` (or \`locale\`): its callee writes its text with the module locale at call time`;

describe('i18n locale-deps gate', () => {
  it('walks the real source tree and flags a stale memo when there is one', () => {
    // A clean scan is legitimate AND is what a broken scanner reports, so the
    // walk is pinned and the same code path is probed on a planted file.
    expect(listSourceFiles().length).toBeGreaterThan(50);

    const dir = mkdtempSync(join(tmpdir(), 'i18n-locale-deps-probe-'));
    const bad = join(dir, 'Bad.tsx');
    const good = join(dir, 'Good.tsx');
    writeFileSync(
      bad,
      [
        "import { useMemo } from 'react';",
        "import { t } from '@/i18n';",
        "import { analyzeTouShifts } from '@/lib/touShift';",
        'export function Bad({ rows, plan, rates }) {',
        "  const label = useMemo(() => t('shift.confVery'), [rows]);",
        '  const analysis = useMemo(() => analyzeTouShifts(rows, plan, rates), [rows, plan, rates]);',
        '  return <p>{label}{analysis.blocks.length}</p>;',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      good,
      [
        "import { useMemo } from 'react';",
        "import { useTranslation } from '@/i18n';",
        "import { analyzeTouShifts } from '@/lib/touShift';",
        'export function Good({ rows, plan, rates }) {',
        "  const { t } = useTranslation();",
        "  const label = useMemo(() => t('shift.confVery'), [t]);",
        '  const analysis = useMemo(() => analyzeTouShifts(rows, plan, rates), [rows, plan, rates, t]);',
        '  return <p>{label}{analysis.blocks.length}</p>;',
        '}',
      ].join('\n'),
    );
    try {
      // The lib functions are in the scan, so the transitive call resolves and
      // the planted stale memos are caught by the same code path as the tree.
      const files = [...listSourceFiles(), bad, good];
      const { violations } = findMissingLocaleDeps(files) as { violations: Violation[] };
      const planted = violations.filter((v) => v.file.includes('i18n-locale-deps-probe-'));
      expect(planted.map((v) => `${v.file.split('/').pop()}:${v.line}`)).toEqual([
        'Bad.tsx:5',
        'Bad.tsx:6',
      ]);
      expect(planted.every((v) => v.hook === 'useMemo')).toBe(true);
      // …and the compliant file is NOT flagged (a scanner that flags
      // everything would pass the assertion above).
      expect(planted.some((v) => v.file.endsWith('Good.tsx'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // 30s, not the 5s default: this scan compiles the WHOLE real source tree
    // plus the planted probe files, so under sibling-suite load it blows the
    // default and reports false-red (solo green, batch red). The assertions
    // above are the gate; the clock is not.
  }, 30_000);

  it('has no stale memo in the tree', () => {
    const { violations } = findMissingLocaleDeps() as { violations: Violation[] };
    const found = [...violations]
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map(explain);
    expect(
      found,
      found.length === 0
        ? ''
        : `\n${found.length} memo(s) cache the current language:\n\n  ${found.join('\n  ')}\n\n` +
          'The module `t()` reads the locale at CALL time, so a memo that calls it (or\n' +
          "a lib function that does) keeps last language's text after a toggle —\n" +
          '`t` in the deps array is what re-derives it (I18N.md, "Numbers, money, dates" + the toggle rule).\n',
    ).toEqual([]);
  });
});
