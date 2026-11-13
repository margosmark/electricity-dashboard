// @vitest-environment node
/**
 * The SERVER half of the raw-exception contract (security gate t_a0a48336,
 * items 1–2; card t_f9c08ae4). The reader half is
 * `src/lib/rawExceptionRender.test.ts` — its sibling, deliberately not
 * edited here (nor `greenbutton/recovery.test.ts`), so the two contracts
 * can evolve on separate branches without colliding.
 *
 * WHAT IS PINNED
 *
 * 1. The JSON.parse failure log carries NO request-body text. On node the
 *    `Unexpected token` message embeds an excerpt of the input — measured on
 *    v22.23.4: `JSON.parse('{"email":"alice@example.com","password":LEAK…')`
 *    → ``Unexpected token 'L', ..."password":LEAK-ME-IF"... is not valid JSON``
 *    — so logging the caught error prints a fragment of a password-bearing
 *    body. `readJsonCapped` (whose 64 KB alias `readJsonSmall` serves
 *    login/register/sync) must log only SHAPE: byte count + error name.
 *    Behavioural: a malformed body with a distinctive marker goes through
 *    the reader and the LOG OUTPUT itself is asserted to hold no fragment
 *    of it. (The returned `error` string is already pinned by the sibling
 *    test — this file pins the channel the sibling cannot see: the console.)
 *
 * 2. Every string a server producer sends is hand-written.
 *    `describeAuthError`'s default renders a whitespace-bearing `detail`
 *    — or `error` code — VERBATIM, so anything composed into a producer
 *    reaches the reader. The invariant was audited by hand at 1389255
 *    (http.ts's JSON.parse echo was the one violation) and nothing
 *    enforced it; this does. Each production file under `src/lib/account/`
 *    + `src/app/account/` is parsed with the TypeScript compiler — the
 *    instrument `scripts/i18n-locale-deps.mjs` already walks `src/` with —
 *    and flagged when an exception's own text (`.message`, `["message"]`,
 *    `String(e)`, or a bare `${e}` coercion, which coerces exactly as
 *    `String(e)` does) sits inside a producer:
 *
 *      - any argument of `accountError(…)`, `accountJson(…)`, or
 *        `new AccountApiError(…)` (the client's detail constructor — the
 *        exact site gate F3 fixed at client.ts:84), or
 *      - the `error`/`detail` property of a `{ ok: false, … }` object
 *        (CappedRead and the auth validators — routes forward both into
 *        `accountError`),
 *
 *    either directly or through a variable composed in the same file.
 *    Comments are parser trivia, so a comment that DESCRIBES the defect
 *    cannot trip the gate — the card's "comments stripped", met
 *    structurally rather than by a regex over `//`. Offenders must be `[]`:
 *    there is no allow-list, because nothing in these directories reads an
 *    exception's own text today, and a deliberate channel would have to be
 *    argued into this file. Known boundary (a source scan's own edge):
 *    composition that leaves the directory before it reaches a producer —
 *    a helper in another module — is not visible here; review covers that.
 *
 * Run: `npx vitest run src/lib/account/serverRawException.test.ts`
 */

import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readJsonSmall } from '@/lib/account/http';

/** `webapp/`, derived from this file's own location. */
const WEBAPP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The server-side source the card names. */
const SCAN_DIRS = ['src/lib/account', 'src/app/account'];

/** Call shapes whose string arguments end up on a reader's screen. */
const PRODUCER_CALLEES = new Set(['accountError', 'accountJson', 'AccountApiError']);

/** Names a caught exception plausibly rides under in this codebase. */
const EXCEPTION_NAMES = new Set(['e', 'err', 'error', 'exception', 'ex', 'exc']);

/** Production sources only: tests assert on `.message` all the time. */
function productionFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const found = readdirSync(join(WEBAPP, dir), { recursive: true }) as string[];
    for (const rel of found) {
      if (!/\.tsx?$/.test(rel)) continue;
      if (/\.test\.tsx?$/.test(rel)) continue;
      files.push(`${dir}/${rel}`);
    }
  }
  return files.sort();
}

/** Unwrap `(e as Error)` / `(err)!` to the identifier underneath. */
function bareRef(expr: ts.Expression): ts.Expression {
  let node = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      node = node.expression;
    } else {
      return node;
    }
  }
}

/** The first node inside `root` that reads an exception's own text. */
function rawTextRead(root: ts.Node): ts.Node | null {
  let hit: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') {
      hit = node;
      return;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'message') {
      hit = node;
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String') {
      const ref = node.arguments[0] ? bareRef(node.arguments[0]) : null;
      if (ref && ts.isIdentifier(ref) && EXCEPTION_NAMES.has(ref.text)) {
        hit = node;
        return;
      }
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        const ref = bareRef(span.expression);
        if (ts.isIdentifier(ref) && EXCEPTION_NAMES.has(ref.text)) {
          hit = span.expression;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return hit;
}

/**
 * Every offender in one source: exception text reaching a producer,
 * inline or through a same-file variable. Offender lines name the line
 * the COMPOSITION sits on (that is the line a red control must report).
 */
function offendersIn(rel: string, source: string): string[] {
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind);
  const offenders: string[] = [];
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  // Same-file variable flow: `const detail = \`${e.message}\`` … later
  // `accountError(…, detail)`. The offender is reported at the composition.
  const composed = new Map<string, number>();
  const collectComposed = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const hit = rawTextRead(node.initializer);
      if (hit) composed.set(node.name.text, lineOf(hit));
    }
    ts.forEachChild(node, collectComposed);
  };
  collectComposed(sf);

  // Producer sites: where a string starts travelling to a reader.
  const sites: Array<{ label: string; node: ts.Node }> = [];
  const collectSites = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee: ts.Expression | undefined = node.expression;
      const name =
        callee && ts.isIdentifier(callee) ? callee.text : callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (PRODUCER_CALLEES.has(name)) {
        for (const arg of node.arguments ?? []) sites.push({ label: `${name}(…) argument`, node: arg });
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const isFailure = node.properties.some(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'ok' && p.initializer.kind === ts.SyntaxKind.FalseKeyword,
      );
      if (isFailure) {
        for (const p of node.properties) {
          if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
          const pname = p.name.getText(sf);
          if (pname !== 'error' && pname !== 'detail') continue;
          sites.push({ label: `{ok:false} ${pname}`, node: ts.isPropertyAssignment(p) ? p.initializer : p.name });
        }
      }
    }
    ts.forEachChild(node, collectSites);
  };
  collectSites(sf);

  const refs = new Set<string>();
  const collectRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) refs.add(node.text);
    ts.forEachChild(node, collectRefs);
  };

  for (const site of sites) {
    const hit = rawTextRead(site.node);
    if (hit) offenders.push(`${rel}:${lineOf(hit)} — ${site.label} reads \`${hit.getText(sf)}\``);
    refs.clear();
    collectRefs(site.node);
    for (const [name, line] of composed) {
      if (refs.has(name)) offenders.push(`${rel}:${line} — \`${name}\` composes exception text and feeds ${site.label}`);
    }
  }
  return offenders;
}

describe('account server detail producers', () => {
  it('never compose an exception text into a response string', () => {
    const files = productionFiles();
    // The walk must actually see the tree — an empty glob would report
    // "no offenders" vacuously.
    expect(files).toContain('src/lib/account/http.ts');
    expect(files).toContain('src/app/account/login/route.ts');
    expect(files.length).toBeGreaterThan(20);

    const offenders = files.flatMap((rel) => offendersIn(rel, readFileSync(join(WEBAPP, rel), 'utf8')));
    expect(offenders, `server producers must be hand-written, offenders:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('has signal: a planted composition is flagged at its own line', () => {
    // Every path the contract claims, planted on purpose — the real tree
    // being clean proves nothing about whether the scanner can see dirt.
    const planted = [
      'export function inline(e: unknown) {',
      '  return accountError(400, "bad_request", `boom ${(e as Error).message}`);', // line 2
      '}',
      'export function viaVar(e: unknown) {',
      '  const detail = `boom ${String(e)}`;', // line 5
      '  return accountError(400, "bad_request", detail);',
      '}',
      'export function capped(e: unknown) {',
      '  return { ok: false, error: `boom ${(e as Error).message}`, status: 400 };', // line 9
      '}',
      'export function viaClient(e: unknown) {',
      '  return new AccountApiError(0, "network", `${(e as Error).message}`);', // line 12
      '}',
    ].join('\n');

    const hits = offendersIn('planted.ts', planted);
    expect(hits.map((h) => h.split(' — ')[0]), hits.join('\n')).toEqual([
      'planted.ts:2',
      'planted.ts:5',
      'planted.ts:9',
      'planted.ts:12',
    ]);
    const report = hits.join('\n');
    expect(report).toContain('accountError(…) argument');
    expect(report).toContain('{ok:false} error');
    expect(report).toContain('AccountApiError(…) argument');
    expect(report).toContain('`detail` composes exception text');
  });

  it('cannot be tripped by a comment that describes the defect', () => {
    // "Comments stripped", structurally: the parser never hands trivia to
    // the walk, so documenting the rule in a comment is safe — which is
    // what lets this file (and every account source) explain itself.
    const clean = [
      '// e.message would be a defect here; String(e) too; ${e} also',
      'export function ok(e: unknown) {',
      '  const note = "see https://example.test/x"; // String(e)',
      '  return accountError(400, "bad_request", note);',
      '}',
    ].join('\n');
    expect(offendersIn('clean.ts', clean)).toEqual([]);
  });
});

describe('the JSON.parse failure log', () => {
  /** Malformed on purpose: V8's message embeds this input's tail. */
  const BODY = '{"email":"alice@example.com","password":LEAK-ME-IF-LOGGED';

  it('logs shape only — never a fragment of the request body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const request = new Request('http://localhost/account/login', { method: 'POST', body: BODY });
      const out = await readJsonSmall(request);
      expect(out).toEqual({ ok: false, error: 'Request body is not valid JSON.', status: 400 });

      expect(warn, 'the parse failure must still be logged').toHaveBeenCalledTimes(1);
      const [tag, payload] = warn.mock.calls[0];
      expect(tag).toBe('[account] request body is not valid JSON');

      // What actually reaches the console: strings verbatim, Errors as
      // name+message — JSON.stringify(Error) is `{}` and would hide the
      // very leak this test exists to catch.
      const rendered = warn.mock.calls
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? `${arg.name}: ${arg.message}` : JSON.stringify(arg)))
        .join(' ');
      expect(rendered, 'the body must not appear in the log').not.toContain('LEAK-ME-IF');
      expect(rendered).not.toContain('password');
      expect(rendered).not.toContain('Unexpected token');

      // The sanitized shape: byte count + error NAME, never message text.
      expect(payload).toEqual({ bytes: BODY.length, name: 'SyntaxError' });
    } finally {
      warn.mockRestore();
    }
  });
});
