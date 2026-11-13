/**
 * The i18n LOCALE-DEPENDENCY gate's scanner.
 *
 * I18N.md's Wave U rule: prose and numbers are produced in `useMemo`s all
 * over the tree, by lib functions that read the locale at CALL time from the
 * `@/i18n` module singleton. A `useMemo` that does not list `t` (or `locale`)
 * in its deps therefore keeps the OLD language's text after a toggle: the
 * static coverage gate sees a `t('key')` call, the catalogs are complete,
 * `npm run test` is green, and the French page still prints
 * "Requires switching to the ULO plan and moving the load into 23:00–07:00."
 * — qa's runtime class, invisible to every gate that existed.
 *
 * This scanner is the missing half: it walks the AST and fails on any
 * `useMemo`/`useCallback` whose callback produces LOCALE-DEPENDENT output
 * without a locale dependency, so the defect is caught at authoring time
 * instead of by a French reader.
 *
 * What counts as locale-dependent output:
 *   - a call to `t(`;
 *   - a call to any `@/i18n` formatter (`fmtMoney`, `fmtNumber`, `fmtDate`,
 *     `fmtDay`, `fmtPercent`, `planLabel`, `periodLabel`, …);
 *   - a call to a local function that does either (transitive, fixpoint over
 *     the whole `src/` graph as long as the callee lives in the same file or
 *     is imported by name).
 *
 * Why a name-set and not a type-checker: the codebase's lib functions are
 * plain exports with no locale parameter (that is the whole point of the
 * module singleton), so the callee identity is enough to decide.
 *
 * A memo with NO dependency array recomputes every render and is therefore
 * safe — it is reported as `no-deps-array` only when it also runs on every
 * render… which it does, so it is not a violation. (Reported separately so a
 * reviewer can see the cheap fix was taken.)
 *
 * CLI:
 *   node scripts/i18n-locale-deps.mjs          # report; exit 1 on violations
 *   node scripts/i18n-locale-deps.mjs --json    # machine-readable
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const WEBAPP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(WEBAPP_ROOT, 'src');

/** The i18n surface whose output moves with the locale. */
export const LOCALE_DEPENDENT_EXPORTS = new Set([
  't',
  'fmtMoney',
  'fmtMoney0',
  'fmtSignedMoney',
  'fmtCents',
  'fmtCentsAuto',
  'fmtKwh',
  'fmtNumber',
  'fmtNumberAuto',
  'fmtPercent',
  'fmtDate',
  'fmtDateLong',
  'fmtWeekdayDate',
  'fmtDay',
  'fmtDayRange',
  'planLabel',
  'periodLabel',
]);

/** Hook names whose callback result is cached across renders. */
const HOOKS = new Set(['useMemo']);

export function listSourceFiles(dir = SRC_DIR, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !/\/(i18n)\//.test(p)) out.push(p);
  }
  return out;
}

const scriptKind = (p) => (p.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(file));
}

/** Every name this file uses for the i18n surface (handles `import { x as y }`). */
function i18nAliases(sf) {
  const aliases = new Map(); // local name -> canonical i18n name
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const from = stmt.moduleSpecifier.getText(sf).replace(/['"]/g, '');
    if (!from.endsWith('/i18n') && from !== '@/i18n' && from !== './index' && !from.endsWith('i18n/index')) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (LOCALE_DEPENDENT_EXPORTS.has(imported)) aliases.set(el.name.text, imported);
    }
  }
  return aliases;
}

const isHookCall = (node) =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOKS.has(node.expression.text);

/** Does a block declare a binding with this name? (shadowing check) */
function declaresIn(block, name) {
  if (!block || !block.statements) return false;
  for (const s of block.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return true;
      }
    } else if (ts.isFunctionDeclaration(s) && s.name?.text === name) return true;
  }
  return false;
}

/**
 * Is this identifier bound by a local declaration/parameter in an enclosing
 * scope? `const t = transitions(y)` inside `resolveZone` is NOT the i18n `t`,
 * and counting it would make every memo calling `resolveZone` look
 * locale-dependent.
 */
function isShadowed(id, name) {
  let n = id.parent;
  while (n) {
    if (ts.isFunctionLike(n)) {
      if (n.parameters?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return true;
      if (n.body && ts.isBlock(n.body) && declaresIn(n.body, name)) return true;
    }
    if (ts.isBlock(n) && declaresIn(n, name)) return true;
    n = n.parent;
  }
  return false;
}

/**
 * Does this subtree call anything locale-dependent, given the alias map for
 * the file and a predicate for "is this other local/imported name
 * locale-dependent"?
 */
function callsLocaleDependent(node, sf, aliases, isDependent) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (aliases.has(name) && !isShadowed(n.expression, name)) {
        found = true;
        return;
      }
      if (isDependent(name)) {
        found = true;
        return;
      }
    }
    // `t` can also be handed around as a value (`rows.map((r) => t(...))` is
    // covered above; `build(x, t)` is this case).
    if (ts.isIdentifier(n) && aliases.has(n.text) && !ts.isPropertyAccessExpression(n.parent)) {
      if (!isShadowed(n, n.text)) {
        found = true;
        return;
      }
    }
    n.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** Local function declarations/arrow consts in a file, with their bodies. */
function localFunctions(sf) {
  const out = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) out.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.set(node.name.text, init.body ?? init);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * Resolve a module specifier to a file in the source set (same rules as the
 * lib's own import style: `@/x`, `./x`, `../x`).
 */
function resolveImport(fromFile, spec, files) {
  const base = spec.startsWith('@/')
    ? join(SRC_DIR, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(fromFile), spec)
      : null;
  if (!base) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find((c) => files.includes(c)) ?? null;
}

/** Named imports of a file: local name -> { file, name } or { i18n: name }. */
function namedImports(sf, file, files, aliases) {
  const out = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier.getText(sf).replace(/['"]/g, '');
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const target = resolveImport(file, spec, files);
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (aliases.has(el.name.text)) continue; // the i18n surface itself
      if (target) out.set(el.name.text, { file: target, name: imported });
    }
  }
  return out;
}

/**
 * Fixpoint over the source graph: a function is locale-dependent if its body
 * calls the i18n surface (`t`, a formatter, `planLabel`, …) or calls another
 * locale-dependent function — resolved through the real import graph, not by
 * bare name, so two unrelated `format()` helpers cannot poison each other.
 */
export function analyseLocaleDependence(files = listSourceFiles()) {
  const fileList = [...files];
  const perFile = new Map(); // file -> { sf, aliases, locals, imports }
  for (const file of fileList) {
    const sf = parse(file);
    const aliases = i18nAliases(sf);
    perFile.set(file, {
      sf,
      aliases,
      locals: localFunctions(sf),
      imports: namedImports(sf, file, fileList, aliases),
    });
  }
  const key = (file, name) => `${file}::${name}`;
  const dependent = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, { sf, aliases, locals, imports }] of perFile) {
      const isDependent = (name) => {
        const imported = imports.get(name);
        if (imported) return dependent.has(key(imported.file, imported.name));
        return dependent.has(key(file, name));
      };
      for (const [name, body] of locals) {
        if (dependent.has(key(file, name))) continue;
        if (callsLocaleDependent(body, sf, aliases, isDependent)) {
          dependent.add(key(file, name));
          changed = true;
        }
      }
      // An imported name re-exported or used directly at module scope is
      // covered by the importer's own scan.
    }
  }
  return { dependent, perFile, key };
}

/** The gate itself: hooks that cache locale-dependent output without a locale dep. */
export function findMissingLocaleDeps(files = listSourceFiles()) {
  const { dependent, perFile, key } = analyseLocaleDependence(files);
  const violations = [];
  const withoutDepsArray = [];
  for (const [file, { sf, aliases, imports }] of perFile) {
    const isDependent = (name) => {
      const imported = imports.get(name);
      if (imported) return dependent.has(key(imported.file, imported.name));
      return dependent.has(key(file, name));
    };

    const visit = (node) => {
      if (isHookCall(node)) {
        const cb = node.arguments[0];
        const deps = node.arguments[1];
        const rel = relative(SRC_DIR, file).split(/[\\/]/).join('/');
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (cb && callsLocaleDependent(cb, sf, aliases, isDependent)) {
          if (!deps) {
            withoutDepsArray.push({ file: rel, line: line + 1, hook: node.expression.text });
          } else if (
            !/\bt\b/.test(deps.getText(sf)) &&
            !/\blocale\b/.test(deps.getText(sf))
          ) {
            violations.push({
              file: rel,
              line: line + 1,
              hook: node.expression.text,
              deps: deps.getText(sf),
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return { violations, withoutDepsArray };
}

function main(argv) {
  const { violations, withoutDepsArray } = findMissingLocaleDeps();
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ violations, withoutDepsArray }, null, 2));
    return violations.length === 0 ? 0 : 1;
  }
  console.log(
    `i18n locale-deps: ${violations.length} hook(s) cache locale-dependent output without ` +
      "`t`/`locale` in their deps; " +
      `${withoutDepsArray.length} recompute every render (safe).`,
  );
  for (const v of violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.error(`  ${v.file}:${v.line} ${v.hook}(…) deps=${v.deps}  -> add \`t\` to the deps array`);
  }
  console.log(violations.length === 0 ? 'i18n locale-deps gate: PASS' : 'i18n locale-deps gate: FAIL');
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
