/**
 * Wave U follow-up — the i18n coverage gate's scanner.
 *
 * Wave U shipped EN↔FR, but nothing in the local battery failed when a later
 * component printed hardcoded English. This module is the mechanical sweep
 * I18N.md used to promise by hand: it walks `src/` with the TypeScript
 * compiler and reports every user-facing string literal that bypasses `t()`.
 *
 * What counts as user-facing (each rule exists because the string reaches a
 * person's eyes or a screen reader):
 *
 *   1. JSX text nodes                        `<h3>How the bill adds up</h3>`
 *   2. JSX child expressions that render     `{cond ? 'Live' : 'Authorised'}`
 *      a literal (incl. `&&` / `||` / template literals)
 *   3. Literal values of accessible/text     aria-label, title, placeholder,
 *      attributes                                alt, …
 *   4. recharts annotation `label={{         `<ReferenceArea label={{ value:
 *      value: … }}` objects                       'WINTER' : 'SUMMER' }}`
 *
 * What it deliberately does NOT flag, and why:
 *
 *   - Canonical English data (plan ids, rate-period names, fingerprints):
 *     I18N.md's "deliberately NOT translated" list. Those are data the
 *     classifier matches; `planLabel()` / `periodLabel()` translate at the
 *     display layer instead.
 *   - Strings built dynamically (`t(`tab.${id}`)`, `t(KEYS[k])`): not
 *     statically resolvable. The reverse check covers the literal subset.
 *   - `app/layout.tsx` metadata / manifest / service-worker strings:
 *     server-rendered, never under the toggle (I18N.md known gaps).
 *
 * Two violation categories, both of which print English to a French user:
 *
 *   missing  — no en.json value carries this text at all; a key must be
 *              invented before it can be translated.
 *   unwired  — en.json already has this text under some key, but the
 *              component hardcodes it, so the FR catalog never renders.
 *
 * CLI:
 *   node scripts/i18n-coverage.mjs                 report + exit 1 on drift
 *   node scripts/i18n-coverage.mjs --json          machine-readable report
 *   node scripts/i18n-coverage.mjs --write-baseline  regenerate the baseline
 *
 * The checked-in baseline (`src/i18n/coverage-baseline.json`) is the honest
 * list of today's debt: the gate fails on anything NEW, and also fails on
 * stale baseline entries, so the list can only shrink.
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const WEBAPP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(WEBAPP_ROOT, 'src');
export const BASELINE_PATH = join(SRC_DIR, 'i18n', 'coverage-baseline.json');
const EN_CATALOG = join(SRC_DIR, 'i18n', 'en.json');

/** JSX attributes whose literal value is rendered or announced to a person. */
const USER_FACING_ATTRS = new Set([
  'alt',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'placeholder',
  'title',
]);

/** Object keys inside a recharts `label={{…}}` that render as chart text. */
const LABEL_TEXT_PROPS = new Set(['value']);

/** Files the sweep skips: its own machinery, tests, and the catalog layer. */
function shouldScan(absPath) {
  if (!/\.(ts|tsx)$/.test(absPath)) return false;
  if (/\.test\.(ts|tsx)$/.test(absPath)) return false;
  const rel = relative(SRC_DIR, absPath).split(/[\\/]/);
  if (rel[0] === 'i18n' || rel[0] === 'test') return false;
  return true;
}

function listSourceFiles(dir = SRC_DIR, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSourceFiles(p, out);
    else if (shouldScan(p)) out.push(p);
  }
  return out;
}

const NAMED_ENTITIES = {
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  amp: '&',
  nbsp: ' ',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  middot: '\u00b7',
};

/** JSX text arrives with entities escaped; decode before comparing. */
export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

/** One normalization for both catalog values and source literals, so
 *  `"Merged  range"` and `"Merged range"` compare equal. */
export function normalize(s) {
  return decodeEntities(String(s)).replace(/\s+/g, ' ').trim();
}

/**
 * Collect every string-ish leaf an expression can put on screen:
 * literals, substitution-free templates, the literal spans of a template,
 * both arms of a ternary, and the right side of `&&` / `||`.
 */
function collectRenderedTexts(expr, out = []) {
  if (!expr) return out;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    out.push(expr.text);
  } else if (ts.isTemplateExpression(expr)) {
    out.push(expr.head.text);
    for (const span of expr.templateSpans) out.push(span.literal.text);
  } else if (ts.isConditionalExpression(expr)) {
    collectRenderedTexts(expr.whenTrue, out);
    collectRenderedTexts(expr.whenFalse, out);
  } else if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.getText();
    if (op === '&&' || op === '||') collectRenderedTexts(expr.right, out);
  } else if (ts.isParenthesizedExpression(expr)) {
    collectRenderedTexts(expr.expression, out);
  }
  return out;
}

/** Is this literal a plausible user-facing string (not a glyph/number)? */
function looksLikeProse(text) {
  const n = normalize(text);
  return n.length > 0 && /[A-Za-z]/.test(n);
}

/**
 * Scan one source file. Returns [{ kind, text, line, column }].
 * kind is a stable category label used in reports and the baseline.
 */
export function scanFile(absPath) {
  const source = readFileSync(absPath, 'utf8');
  const scriptKind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const hits = [];

  const at = (node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, column: character + 1 };
  };
  const report = (node, kind, raw) => {
    if (!looksLikeProse(raw)) return;
    hits.push({ kind, text: normalize(raw), ...at(node) });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      report(node, 'jsx-text', node.text);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (USER_FACING_ATTRS.has(name)) {
        if (ts.isStringLiteral(init)) {
          report(node, `attr:${name}`, init.text);
        } else if (ts.isJsxExpression(init)) {
          for (const t of collectRenderedTexts(init.expression)) report(node, `attr:${name}`, t);
        }
      } else if (name === 'label' && ts.isJsxExpression(init) && ts.isObjectLiteralExpression(init.expression)) {
        // recharts annotation label: `<ReferenceArea label={{ value: 'WINTER' }} />`
        for (const prop of init.expression.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const propName = prop.name.getText(sf);
          if (!LABEL_TEXT_PROPS.has(propName)) continue;
          for (const t of collectRenderedTexts(prop.initializer)) report(node, 'recharts-label', t);
        }
      }
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // Expression CHILDREN render; the same expression as an attribute value
      // is usually chart/config plumbing (recharts layout=, unit=, …).
      for (const child of node.children) {
        if (!ts.isJsxExpression(child)) continue;
        for (const t of collectRenderedTexts(child.expression)) report(child, 'jsx-child-expr', t);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

/** en.json values keyed by normalized text — the "is this already catalogued?" index. */
export function loadEnIndex() {
  const en = JSON.parse(readFileSync(EN_CATALOG, 'utf8'));
  const byText = new Map();
  for (const [key, value] of Object.entries(en)) {
    const n = normalize(value);
    if (!byText.has(n)) byText.set(n, key);
  }
  return { catalog: en, byText };
}

/** Stable dedupe key: same text in the same file is one debt item. */
export function violationKey(v) {
  return `${v.file}::${v.text}`;
}

/** The full forward sweep: every hardcoded user-facing literal in src/. */
export function scanSource() {
  const { byText } = loadEnIndex();
  const violations = [];
  for (const absPath of listSourceFiles()) {
    const file = relative(SRC_DIR, absPath).split(/[\\/]/).join('/');
    for (const hit of scanFile(absPath)) {
      const catalogKey = byText.get(hit.text) ?? null;
      violations.push({
        file,
        line: hit.line,
        column: hit.column,
        kind: hit.kind,
        text: hit.text,
        category: catalogKey ? 'unwired' : 'missing',
        catalogKey,
      });
    }
  }
  return violations;
}

/**
 * The reverse sweep: every literal `t('key')` call must resolve to a real
 * en.json key. A typo here renders the raw key text ("tab.overview") at the
 * user — untranslated AND meaningless. Dynamic keys are skipped (see header).
 */
export function findMissingCatalogKeys() {
  const { catalog } = loadEnIndex();
  const missing = [];
  for (const absPath of listSourceFiles()) {
    const source = readFileSync(absPath, 'utf8');
    const scriptKind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, scriptKind);
    const file = relative(SRC_DIR, absPath).split(/[\\/]/).join('/');

    const known = (key) => key in catalog || `${key}_one` in catalog || `${key}_other` in catalog;
    const checkLiteral = (arg) => {
      if (!arg) return;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        if (!known(arg.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
          missing.push({ file, line, key: arg.text });
        }
      } else if (ts.isConditionalExpression(arg)) {
        checkLiteral(arg.whenTrue);
        checkLiteral(arg.whenFalse);
      }
    };

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't'
      ) {
        checkLiteral(node.arguments[0]);
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return missing;
}

/* -------------------------------------------------------------------------- *
 * Baseline (the ratchet)
 * -------------------------------------------------------------------------- */

export function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { _readme: 'no baseline yet', entries: [] };
  }
}

export function saveBaseline(entries) {
  const payload = {
    _readme:
      'Known i18n-coverage debt: hardcoded user-facing strings that predate the gate. ' +
      'Regenerate with `node scripts/i18n-coverage.mjs --write-baseline`. ' +
      'The gate fails on any violation NOT listed here and on any entry this file ' +
      'no longer matches — so this list can only shrink. Fix a string? Delete its line.',
    entries: [...entries].sort(),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

/**
 * Diff a scan against the baseline.
 *  newViolations — hardcoded strings the baseline does not cover (FAIL).
 *  staleEntries  — baseline lines the scan no longer produces (FAIL: the debt
 *                  was paid, so the entry must go, keeping the list honest).
 */
export function diffAgainstBaseline(violations, baseline) {
  const current = new Map();
  for (const v of violations) {
    const key = violationKey(v);
    if (!current.has(key)) current.set(key, v);
  }
  const baselineSet = new Set(baseline.entries ?? []);
  const newViolations = [];
  for (const [key, v] of current) {
    if (!baselineSet.has(key)) newViolations.push({ ...v, key });
  }
  const staleEntries = [...baselineSet].filter((key) => !current.has(key));
  return { newViolations, staleEntries };
}

/* -------------------------------------------------------------------------- *
 * CLI
 * -------------------------------------------------------------------------- */

function formatViolation(v) {
  const via = v.catalogKey ? ` (en.json has "${v.text}" under ${v.catalogKey} — wire t('${v.catalogKey}'))` : '';
  return `  ${v.file}:${v.line} [${v.kind}] ${JSON.stringify(v.text)}${via}`;
}

function main(argv) {
  const violations = scanSource();
  const missingKeys = findMissingCatalogKeys();
  const baseline = loadBaseline();
  const { newViolations, staleEntries } = diffAgainstBaseline(violations, baseline);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ violations, missingKeys, newViolations, staleEntries }, null, 2));
    return newViolations.length === 0 && staleEntries.length === 0 && missingKeys.length === 0 ? 0 : 1;
  }

  if (argv.includes('--write-baseline')) {
    const before = new Set(baseline.entries ?? []);
    const after = new Set(violations.map(violationKey));
    saveBaseline(after);
    const added = [...after].filter((k) => !before.has(k));
    const removed = [...before].filter((k) => !after.has(k));
    console.log(`baseline rewritten: ${after.size} entries (+${added.length} / -${removed.length})`);
    for (const k of added) console.log(`  + ${k}`);
    for (const k of removed) console.log(`  - ${k}`);
    return 0;
  }

  const byCategory = { missing: 0, unwired: 0 };
  for (const v of violations) byCategory[v.category] += 1;

  console.log(
    `i18n coverage: ${violations.length} hardcoded user-facing strings ` +
      `(${byCategory.missing} missing from en.json, ${byCategory.unwired} catalogued but unwired) ` +
      `across ${new Set(violations.map((v) => v.file)).size} files; ` +
      `${missingKeys.length} t() keys missing from en.json; ` +
      `baseline covers ${baseline.entries?.length ?? 0}.`,
  );

  if (newViolations.length > 0) {
    console.error(`\nNEW violations not in the baseline (${newViolations.length}):`);
    for (const v of newViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(formatViolation(v));
    }
    console.error(
      '\nFix: add the text to an area file under both en and fr, run `node scripts/i18n-merge.mjs`,\n' +
        'and render it with t(\'your.key\'). If the string is genuinely not user-facing, teach the\n' +
        'scanner about it in scripts/i18n-coverage.mjs rather than growing the baseline.',
    );
  }
  if (staleEntries.length > 0) {
    console.error(`\nStale baseline entries — these violations are gone, delete them (${staleEntries.length}):`);
    for (const k of staleEntries.sort()) console.error(`  ${k}`);
  }
  if (missingKeys.length > 0) {
    console.error(`\nt() keys with no en.json entry (${missingKeys.length}):`);
    for (const m of missingKeys.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  ${m.file}:${m.line} t('${m.key}')`);
    }
  }

  const ok =
    newViolations.length === 0 && staleEntries.length === 0 && missingKeys.length === 0;
  console.log(ok ? '\ni18n coverage gate: PASS' : '\ni18n coverage gate: FAIL');
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
