/**
 * The MONEY-FORMAT contract — the scanner behind `src/i18n/money-contract.test.ts`.
 *
 * Wave U shipped 165 translated strings and a French money fix (7ee0375), and
 * the fr-CA build still printed `1 420,89 $$/AN` on all four plan-cost
 * headlines, `kWh kWh` three times on Plans, and `11.9¢` beside `3,9 ¢` on one
 * page. Every one of those is a NUMBER reaching the DOM without going through
 * `@/i18n`: nothing in the battery failed when a component hand-rolled
 * `$${n.toFixed(2)}`, and the catalog could carry a currency symbol into a
 * money value's own unit label with no gate in the way.
 *
 * This module is that gate. It walks `src/` with the TypeScript compiler (the
 * same machinery `scripts/i18n-coverage.mjs` uses for hardcoded strings) and
 * fails on five classes:
 *
 *   M1 raw-currency-concat — `$${n.toFixed(2)}`, `toFixed(1)}¢`, `¢${…}`.
 *      A hand-built money or cent string is en-CA by construction: `$1.5`,
 *      never `1,5 $`.
 *
 *   M2 hardcoded-locale-number — `n.toLocaleString('en-CA', …)`.
 *      The numeric locale is a function of the ACTIVE locale, so a literal
 *      one pins English formatting into the French build (the `kWh` helper
 *      and the Money usage table both did).
 *
 *   M3 raw-number — a hand-rolled `toFixed(`/`toPrecision(`/numeric
 *      `toLocaleString(` ANYWHERE outside `@/i18n`. `toFixed` always emits a
 *      `.` decimal separator, so every one of them is the `11.9¢` beside
 *      `3,9 ¢` class, and a pinned locale (`toLocaleString('en-CA', …)`) also
 *      skips the active locale's grouping. Exempt, because they are not text
 *      a person reads: `data-*` attribute initializers (machine-readable test
 *      hooks), a `Number(...)`/`parseFloat(...)` round-trip (that is rounding
 *      maths, not formatting — `lib/energy.ts`'s `round()`), and a
 *      `toLocaleString` that passes DATE options (`dateStyle`/`timeStyle`/
 *      `weekday`/`hour`), which belongs to the i18n string sweep.
 *
 *   M4 doubled-unit-token — `t('key', { token: fmtKwh(…) })` where the
 *      catalog already prints the unit after `{token}` (`{kwh} kWh`), or
 *      `{cents}¢` fed a `…toFixed(1)` (also M3). The template owns the unit, so the
 *      parameter must be a BARE number (`fmtNumber`/`fmtNumberAuto`); a
 *      formatter that carries its own symbol prints it twice. This is the
 *      `kWh kWh` class, and it is locale-independent on purpose.
 *
 *   M5 currency-symbol-order — a catalog that puts `$`/`¢` BEFORE a `{token}`
 *      in French (or AFTER one in English). fr-CA writes the symbol last
 *      (`0,40 $/kWh`); en-CA writes it first (`$0.40/kWh`). A translated
 *      sentence that keeps the English order prints `$0,0252/kWh` in French.
 *
 * CLI:
 *   node scripts/money-contract.mjs           report; exit 1 on any violation
 *   node scripts/money-contract.mjs --list    also print every money render
 *                                             site the sweep pins
 *   node scripts/money-contract.mjs --json    machine-readable report
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const WEBAPP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(WEBAPP_ROOT, 'src');

/** The module that OWNS number formatting: the only place `toFixed` is legal. */
const OWNER_FILE = join(SRC_DIR, 'i18n', 'index.ts');

/** Formatters that already carry a unit, so they may not feed a `{token}`
 *  the catalog suffixes with that same unit. */
const UNIT_BEARING_FORMATTERS = new Set([
  'fmtMoney',
  'fmtMoney0',
  'fmtSignedMoney',
  'fmtCents',
  'fmtCentsAuto',
  'fmtKwh',
  'fmtPercent',
]);

/** The bare-number formatters — always safe for a unit-bearing `{token}`. */
const BARE_NUMBER_FORMATTERS = new Set(['fmtNumber', 'fmtNumberAuto']);

export function listSourceFiles(dir = SRC_DIR, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip comments so prose ABOUT money never trips the sweep. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function calleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/**
 * A hand-rolled NUMERIC format anywhere in this subtree: `toFixed`,
 * `toPrecision`, or a `toLocaleString` that passes numeric options
 * (`FractionDigits` / `style`). A bare `Date.toLocaleString()` is a DATE
 * render, not a number one — that class belongs to the i18n string sweep,
 * not to the money contract, so it is deliberately not collected here.
 */
/** Is this call a hand-rolled numeric format (not a date render)? */
function rawNumberCallName(n) {
  const name = calleeName(n);
  if (name === 'toFixed' || name === 'toPrecision') return name;
  if (name === 'toLocaleString') {
    const args = n.getText();
    // Date options are a DATE render — the i18n string sweep owns those.
    if (/dateStyle|timeStyle|weekday|hour|minute|month\s*:|day\s*:/.test(args)) return null;
    if (/FractionDigits|style\s*:/.test(args)) return 'toLocaleString';
  }
  return null;
}

/** …anywhere in this subtree, minus the `Number(x.toFixed())` rounding idiom. */
function containsRawNumberCall(node) {
  let hit = null;
  const walk = (n) => {
    if (hit) return;
    const name = rawNumberCallName(n);
    if (name) {
      // `Number(v.toFixed(dp))` is rounding MATHS (lib/energy.ts's `round`),
      // not a string a person reads — the string never escapes the cast.
      const wrap = n.parent;
      const wrapped =
        wrap && ts.isCallExpression(wrap) && calleeName(wrap) === 'Number' &&
        wrap.arguments[0] === n;
      if (!wrapped) hit = name;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return hit;
}

/** Does this subtree call a formatter that carries its own unit? */
function unitBearingCallIn(node) {
  let hit = null;
  const walk = (n) => {
    if (hit) return;
    const name = calleeName(n);
    if (name && UNIT_BEARING_FORMATTERS.has(name)) hit = name;
    ts.forEachChild(n, walk);
  };
  walk(node);
  return hit;
}

/** The unit the catalog prints after `{token}`, or null when it prints none. */
export function tokenUnitAfter(template, token) {
  const needle = `{${token}}`;
  let i = template.indexOf(needle);
  while (i !== -1) {
    const after = template.slice(i + needle.length);
    if (/^\s*kWh/.test(after)) return 'kWh';
    if (/^\s*kW\b/.test(after)) return 'kW';
    if (/^\s*[¢$%]/.test(after)) return after.trimStart()[0];
    // NOTE: `{cents}/kWh` is NOT a bare-number slot — `fmtCents()` prints the
    // `¢` the template then suffixes with `/kWh` ("0.40¢/kWh" / "0,40 ¢/kWh").
    // Only a `$`/`¢`/`%`/kWh glyph owned by the template counts.
    i = template.indexOf(needle, i + 1);
  }
  return null;
}

function loadCatalogs() {
  return {
    en: JSON.parse(readFileSync(join(SRC_DIR, 'i18n', 'en.json'), 'utf8')),
    fr: JSON.parse(readFileSync(join(SRC_DIR, 'i18n', 'fr.json'), 'utf8')),
  };
}

/**
 * Rule M5 over the AREA files (the source of truth `i18n-merge.mjs` writes
 * the runtime catalogs from): a translated sentence must put the dollar sign
 * where its own locale puts it, so `charge.detail` cannot keep the English
 * `${perKwh}` order inside the French catalog.
 */
export function scanCatalogs() {
  const out = [];
  const areaDir = join(SRC_DIR, 'i18n', 'areas');
  const areaFiles = Object.fromEntries(
    readdirSync(areaDir).map((f) => [f, JSON.parse(readFileSync(join(areaDir, f), 'utf8'))]),
  );
  for (const [file, area] of Object.entries(areaFiles)) {
    for (const [loc, bad, why] of [
      ['fr', /\$\s*\{|\$\s*\d/, 'fr-CA writes the dollar sign AFTER the number ("0,40 $")'],
      ['en', /\{[a-z]\w*\}\s+\$|\d\s+\$/, 'en-CA writes the dollar sign BEFORE the number ("$0.40")'],
    ]) {
      for (const [key, value] of Object.entries(area[loc] ?? {})) {
        if (typeof value !== 'string') continue;
        const m = bad.exec(value);
        if (!m) continue;
        out.push({
          rule: 'M5',
          file: relative(WEBAPP_ROOT, join(areaDir, file)),
          line: 1,
          source: `${key} = ${JSON.stringify(value)}`,
          detail: `\`${m[0].trim()}\` — ${why}`,
        });
      }
    }
  }
  return out;
}

/**
 * Every money-format violation in ONE file. Exported so the vitest contract
 * can plant a scratch file and prove the rules still fire (the same
 * planted-failure probe the i18n coverage gate uses).
 */
export function scanFile(file, catalogs = loadCatalogs()) {
    const violations = [];
    const sites = [];
    const push = (rule, fileRel, line, source, detail) =>
      violations.push({ rule, file: fileRel, line, source, detail });
    const rel = relative(WEBAPP_ROOT, file);
    const text = readFileSync(file, 'utf8');
    const rawLines = text.split('\n');
    const isOwner = file === OWNER_FILE;
    const clean = isOwner ? null : stripComments(text);

    /* ---- M1 / M2: text-level sweeps over comment-free source ------------ */
    if (clean) {
      const M1 = [
        [/\$\$\{/, 'a hand-built `$${…}` money string'],
        [/toFixed\([^)]*\)\s*[`)}]*\s*[¢$]/, '`toFixed(…)` concatenated with a currency/cent symbol'],
        [/[¢$]\s*\$\{/, 'a currency/cent symbol directly before an interpolation'],
      ];
      clean.split('\n').forEach((line, idx) => {
        for (const [rx, why] of M1) {
          if (rx.test(line)) push('M1', rel, idx + 1, rawLines[idx].trim(), `${why} — format it with @/i18n`);
        }
        if (/toLocaleString\(\s*['"](en|fr)-CA['"]/.test(line)) {
          push('M2', rel, idx + 1, rawLines[idx].trim(),
            "hard-coded numeric locale — use `fmtNumber()`/`bcp47()` from @/i18n");
        }
      });
    }

    /* ---- AST sweeps: M3 (rendered raw number) and M4 (doubled token) ---- */
    const sf = ts.createSourceFile(
      file, text, ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const openI18n = new Set();
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const mod = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(mod) || mod.text !== '@/i18n') continue;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) openI18n.add((el.propertyName ?? el.name).text);
      }
    }

    const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const sourceOf = (node) => rawLines[lineOf(node) - 1]?.trim() ?? '';

    /**
     * Identifiers rendered as an `<input value={X}>` in THIS file. A form
     * control holds a DOM number string (`type="number"` rejects a fr-CA
     * `10,5` outright and blanks itself), so the value that feeds one is not
     * prose and keeps the `.` separator — the one deliberate exception.
     */
    const inputValueNames = new Set();
    (function collect(n) {
      if (ts.isJsxAttribute(n) && n.name.getText(sf) === 'value') {
        const el = n.parent?.parent;
        const tag = el && (ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el))
          ? el.tagName.getText(sf)
          : '';
        if (tag === 'input' && n.initializer && ts.isJsxExpression(n.initializer)) {
          const walk = (x) => {
            if (ts.isIdentifier(x)) inputValueNames.add(x.text);
            ts.forEachChild(x, walk);
          };
          if (n.initializer.expression) walk(n.initializer.expression);
        }
      }
      ts.forEachChild(n, collect);
    })(sf);

    /**
     * Not text a person reads: a `data-*` attribute initializer (a
     * machine-readable test hook), an `<input>` value, or a variable that
     * feeds one — plus a `Number(x.toFixed(dp))` rounding cast, which is
     * maths, not a string anybody sees.
     */
    const isMachineFacing = (node) => {
      let n = node.parent;
      const varNames = [];
      while (n) {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) varNames.push(n.name.text);
        if (ts.isJsxAttribute(n)) {
          if (/^data[-A-Za-z]*$/.test(n.name.getText(sf))) return true;
          const el = n.parent?.parent;
          const tag = el && (ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el))
            ? el.tagName.getText(sf)
            : '';
          return tag === 'input';
        }
        if (ts.isJsxElement(n) || ts.isJsxFragment(n)) return false;
        n = n.parent;
      }
      return varNames.some((v) => inputValueNames.has(v));
    };

    /** M3 — every hand-rolled numeric format in the file, reported in place. */
    const reportRawNumbers = (root) => {
      const walk = (n) => {
        const name = rawNumberCallName(n);
        if (name && !isMachineFacing(n)) {
          const wrap = n.parent;
          const wrapped =
            wrap && ts.isCallExpression(wrap) && calleeName(wrap) === 'Number' && wrap.arguments[0] === n;
          if (!wrapped) {
            push('M3', rel, lineOf(n), sourceOf(n),
              `\`${name}()\` formats a number by hand — every number a person reads goes ` +
              `through @/i18n (fmtNumber/fmtNumberAuto/fmtKwh/fmtCents/fmtPercent); a ` +
              `\`data-*\` attribute, an \`<input>\` value and a \`Number(…)\` rounding cast are exempt`);
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(root);
    };
    reportRawNumbers(sf);

    const visit = (node) => {
      // M4 — `t('key', { token: <unit-bearing formatter> })`.
      if (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' &&
        node.arguments.length >= 2 &&
        ts.isStringLiteralLike(node.arguments[0]) && ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        const baseKey = node.arguments[0].text;
        for (const prop of node.arguments[1].properties) {
          if (!ts.isPropertyAssignment(prop) || !prop.initializer) continue;
          const token = prop.name.getText(sf).replace(/['"]/g, '');
          let unitCtx = null;
          for (const loc of ['en', 'fr']) {
            for (const key of [baseKey, `${baseKey}_one`, `${baseKey}_other`]) {
              const template = catalogs[loc][key];
              if (typeof template !== 'string') continue;
              const unit = tokenUnitAfter(template, token);
              if (unit && !unitCtx) unitCtx = `${loc}:${key} → "{${token}}${unit}"`;
            }
          }
          if (!unitCtx) continue;
          const bare = calleeName(prop.initializer);
          if (bare && BARE_NUMBER_FORMATTERS.has(bare)) {
            sites.push({ file: rel, line: lineOf(prop.initializer), key: baseKey, token, unit: unitCtx });
            continue;
          }
          const raw = containsRawNumberCall(prop.initializer);
          const bearing = bare && UNIT_BEARING_FORMATTERS.has(bare) ? bare : unitBearingCallIn(prop.initializer);
          if (!raw && !bearing) continue;
          push('M4', rel, lineOf(prop.initializer), sourceOf(prop.initializer),
            `\`${bearing ?? raw}()\` feeds {${token}} of "${baseKey}", whose template already prints ` +
            `the unit (${unitCtx}) — pass \`fmtNumber()\`/\`fmtNumberAuto()\``);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { violations, sites };
}

/** The whole contract: the catalog sweep + every source file. */
export function scan() {
  const catalogs = loadCatalogs();
  const violations = [...scanCatalogs()];
  const sites = [];
  for (const file of listSourceFiles()) {
    const one = scanFile(file, catalogs);
    violations.push(...one.violations);
    sites.push(...one.sites);
  }

  const seen = new Set();
  const deduped = violations.filter((v) => {
    const k = `${v.rule}|${v.file}|${v.line}|${v.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { violations: deduped, sites };
}

/* ----------------------------------------------------------------- CLI ---- */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { violations, sites } = scan();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ violations, sites }, null, 2));
  } else {
    if (process.argv.includes('--list')) {
      console.log(`Money render sites pinned by the contract (${sites.length}):`);
      for (const s of sites) console.log(`  ${s.file}:${s.line}  ${s.key} {${s.token}}  ← ${s.unit}`);
      console.log('');
    }
    for (const v of violations) {
      console.log(`${v.rule}  ${v.file}:${v.line}\n    ${v.source}\n    ${v.detail}`);
    }
    console.log(
      violations.length === 0
        ? `money-contract: OK — 0 violations (${sites.length} unit-bearing tokens pinned)`
        : `money-contract: ${violations.length} violation(s)`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
