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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGS, getLocale, setLocale, type Locale } from '@/i18n';
import { parseGreenButtonFeed } from '@/lib/energy';
// main's gas-aware import gate: the funnel must judge a document the way
// `/import` does — usable rows (electric DataPoints + commodity-7 volume
// rows), not `g.readings` alone.
import { countUsableRows } from '@/hooks/useDashboard';
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
      // main's funnel, byte for byte: parse the WHOLE feed, gate on usable
      // rows. `recoveryMessage` with no `error` is the GATE branch — the
      // sentence `/import` shows when the document parsed and simply carried
      // nothing importable.
      const usable = countUsableRows(parseGreenButtonFeed(c.xml).groups);
      if (usable > 0) {
        outcome = 'import';
      } else {
        outcome = 'reject';
        message = recoveryMessage({ text: c.xml, readings: usable });
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
      readings = countUsableRows(parseGreenButtonFeed(hostile.xml).groups);
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

// --- The catches no corpus case can reach ---------------------------------
//
// Everything above runs DOCUMENTS through the parser. The catch sites the
// security gate flagged (useDashboard's sync pull, the upload modal's outer
// `.catch`) are reachable ONLY for non-document errors — fetch/status
// failures, storage/quota errors, runtime TypeErrors — so no corpus case
// ever exercises them and the funnel above cannot vouch for them. What can
// is the source itself: every surface that turns a caught exception into
// copy must take the words from the catalog, never from the exception.

/**
 * The surfaces that turn a caught exception — or, for the JSON half, a
 * server's answer — into copy the reader sees.
 *
 * The first three are the BROWSER half (a catch that formats `e.message`
 * into copy). The next four compose the JSON error body of
 * `/greenbutton/usage`, which `fetchGbUsage` reads into the SAME toolbar
 * line (`outcome.detail ?? describeGbError(code).detail`): two halves of
 * one rendered expression, so one list guards both. The last answers with
 * a REDIRECT instead (`/?gb=error:<code>`) but lands on the same
 * `describeGbError` reader in `useDashboard`.
 */
const SURFACES = [
  'src/app/import/page.tsx', // the /import error box
  'src/hooks/useDashboard.ts', // the upload modal's issue box + the sync toolbar
  'src/lib/greenbutton/client.ts', // fetchGbUsage — feeds the SAME toolbar line
  // Server half (F1 of gate t_b6260ed7): at 7d43192 these put an exception
  // message (`resource server unreachable: ${e.message}`), an OAuthError
  // message that could carry a token-store fs path, or 500 chars of a
  // custodian's 202 body into `FeedResult.detail`, which the usage route
  // sent as this body's `detail`.
  'src/lib/greenbutton/sync.ts', // readFeed → FeedResult.detail → jsonError
  'src/lib/greenbutton/espi.ts', // the fetch that produces upstream/202 detail
  'src/lib/greenbutton/oauth.ts', // OAuthError.message → oauthFailure detail
  'src/app/greenbutton/usage/route.ts', // the route that answers the browser
  // The fourth server half (finding of gate t_7b7e28e9): the OAuth
  // callback's failure arms used to put an OAuthError message, the IdP's
  // own `error` parameter, or (for a non-OAuth throw out of the
  // exchangeCode/store try block) a token-store fs path into a dead detail
  // redirect parameter with zero readers. No `.message` formatting left in
  // it — the exception now goes to the server log only.
  'src/app/greenbutton/callback/route.ts', // 302 to /?gb=error:<code> → describeGbError
];

/**
 * The storage notice row is a DIFFERENT, deliberate channel: storage.ts
 * composes those messages through its own `describeError()` helper (13
 * sites) and `StorageNoticeRow` prints the result as a secondary diagnostic
 * line under a catalog headline. They are named here by their sentence
 * rather than by line number or variable name, and a stale entry fails the
 * test below — so this list can only shrink, never quietly become a hole.
 */
const STORAGE_DIAGNOSTIC = ['is not serializable:', 'Storage read failed:'];

/** `src/lib/greenbutton` → the webapp root these paths are relative to. */
const WEBAPP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The lines that EXECUTE, comments removed: the contract governs what the
 * reader is shown, not what a comment says about it.
 */
function codeLines(source: string): string[] {
  const lines: string[] = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('/*');
    if (open !== -1) {
      const end = line.indexOf('*/', open + 2);
      if (end === -1) {
        inBlockComment = true;
        line = line.slice(0, open);
      } else {
        line = line.slice(0, open) + line.slice(end + 2);
      }
    }
    const comment = line.indexOf('//');
    if (comment !== -1) line = line.slice(0, comment);
    if (line.trim().length > 0) lines.push(line);
  }
  return lines;
}

/** Formats a caught exception into a string a surface can render. */
const FORMATS_RAW_MESSAGE = [/\.message\b/, /\bString\(\s*e(?:rr)?\s*\)/];

describe('no catch site formats an exception into rendered copy', () => {
  it('keeps every raw exception message off the reader', () => {
    const offenders: string[] = [];
    const staleAllow: string[] = [];

    for (const rel of SURFACES) {
      const source = readFileSync(join(WEBAPP, rel), 'utf8');
      const lines = codeLines(source);
      const seen = new Set<string>();

      for (const line of lines) {
        if (!FORMATS_RAW_MESSAGE.some((pattern) => pattern.test(line))) continue;
        const allowed = STORAGE_DIAGNOSTIC.find((phrase) => line.includes(phrase));
        if (allowed) {
          seen.add(allowed);
          continue;
        }
        offenders.push(`${rel}: ${line.trim()}`);
      }

      // An allow-list entry with nothing left to allow is debt, not safety:
      // fail so the list shrinks with the code instead of outliving it.
      for (const phrase of STORAGE_DIAGNOSTIC) {
        if (rel === 'src/hooks/useDashboard.ts' && !seen.has(phrase)) staleAllow.push(phrase);
      }
    }

    expect(offenders, `raw exception text reaches the reader:\n${offenders.join('\n')}`).toEqual([]);
    expect(staleAllow, `storage-diagnostic allow-list entries with no match left: ${staleAllow.join(', ')}`).toEqual([]);
  });

  it('the two flagged catches answer from the catalog, not from the exception', () => {
    const dash = readFileSync(join(WEBAPP, 'src/hooks/useDashboard.ts'), 'utf8');

    // Site 1 (the sync pull): no `detail` at all, so the toolbar renders
    // `outcome.detail ?? describeGbError(code).detail` — the catalog
    // sentence for `unreachable` — instead of the exception's own words.
    expect(dash, 'the sync catch must not attach a detail').not.toMatch(/code: "unreachable", detail:/);
    expect(describeGbError('unreachable').detail, 'the fallback must be copy, not a code word').not.toBe('unreachable');
    expect(describeGbError('unreachable').detail).toBe(CATALOGS.en['gb.unreachableDetail']);

    // Site 2 (the upload modal's outer .catch): the fallback's detail is a
    // catalog key in BOTH locales, translated differently in each.
    expect(dash, 'the modal fallback must render a catalog sentence').toContain("t('upload.processFailedDetail')");
    for (const locale of ['en', 'fr'] as Locale[]) {
      const value = CATALOGS[locale]['upload.processFailedDetail'];
      expect(value, `${locale}: upload.processFailedDetail is missing`).toBeTruthy();
      expect(value, `${locale}: a raw key would paint at the reader`).not.toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(value, `${locale}: an unfilled placeholder`).not.toMatch(/\{\w+\}/);
    }
    expect(CATALOGS.fr['upload.processFailedDetail']).not.toBe(CATALOGS.en['upload.processFailedDetail']);
  });

  it('every allow-listed storage line still exists (the list cannot rot forward)', () => {
    const dash = readFileSync(join(WEBAPP, 'src/hooks/useDashboard.ts'), 'utf8');
    for (const phrase of STORAGE_DIAGNOSTIC) {
      expect(dash, `"${phrase}" is no longer in the file — drop it from STORAGE_DIAGNOSTIC`).toContain(phrase);
    }
  });
});

// --- The other side of the same line: the JSON error body ----------------
//
// `/greenbutton/usage` answers a failed pull with `{ error: <code>,
// detail? }`, `fetchGbUsage` reads it, and `useDashboard` renders
// `outcome.detail ?? describeGbError(code).detail`. The SURFACES scan
// above proves no server file FORMATS an exception into a `detail`; the
// tests below prove that prose cannot CROSS the wire or be READ back into
// copy — and that every code which used to arrive carrying prose (the
// exception messages, the config sentence, the custodian's 202 body)
// answers with a catalog sentence in the reader's locale instead.

/** A response body read landing in a `detail` — third-party text. */
const BODY_INTO_DETAIL = /\bdetail\b[^;\n{}]*\.text\(\)|\.text\(\)[^;\n{}]*\bdetail\b/;

describe('the /greenbutton/usage error body is a code, never prose', () => {
  const linesOf = (rel: string): string[] => codeLines(readFileSync(join(WEBAPP, rel), 'utf8'));

  afterEach(() => setLocale('en'));

  it("the shim's jsonError has no detail channel to put prose in", () => {
    // tsc already rejects a third argument (the parameter is gone); this
    // pins the helper itself, so re-adding the channel fails the contract
    // test as well as the type check.
    const offenders = linesOf('src/lib/greenbutton/http.ts').filter((line) => /\bdetail\b/i.test(line));
    expect(offenders, `jsonError must answer { error } only:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no server file reads a response body into a detail', () => {
    const serverFiles = [
      'src/lib/greenbutton/sync.ts',
      'src/lib/greenbutton/espi.ts',
      'src/lib/greenbutton/oauth.ts',
      'src/app/greenbutton/usage/route.ts',
    ];
    const offenders: string[] = [];
    for (const rel of serverFiles) {
      for (const line of linesOf(rel)) {
        if (BODY_INTO_DETAIL.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders, `third-party text in a detail:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the client reads the code out of the body and nothing else', () => {
    const client = readFileSync(join(WEBAPP, 'src/lib/greenbutton/client.ts'), 'utf8');
    const clientLines = linesOf('src/lib/greenbutton/client.ts');
    const clientCode = clientLines.join('\n');

    const forwarders = clientLines.filter((line) => /body\.detail/.test(line));
    expect(forwarders, `fetchGbUsage must not forward the body's detail:\n${forwarders.join('\n')}`).toEqual([]);

    // The failure variant has no field to forward prose WITH: `detail` on
    // it is a type error, so the boundary holds even if a future edit
    // forgets the comment above it.
    const from = clientCode.indexOf('export type GbUsageResult');
    const to = clientCode.indexOf('const TIMEOUT_MS');
    expect(from, 'GbUsageResult must still exist').toBeGreaterThan(-1);
    expect(clientCode.slice(from, to), 'GbUsageResult must not offer a detail field').not.toContain('detail');
    expect(client, 'the source of that type must not offer one either').not.toMatch(
      /ok: false; code: string; detail/,
    );

    // The route must not name a detail in a jsonError call — including
    // the config sentence it used to send for `not_configured`.
    const route = linesOf('src/app/greenbutton/usage/route.ts').join('\n');
    expect(route, 'the usage route must not pass a detail to jsonError').not.toMatch(
      /jsonError\([^)]*(?:detail|unconfiguredReason)/,
    );

    // …and the hook must not re-attach one: the toolbar's first half of
    // `outcome.detail ?? describeGbError(code).detail` has to stay empty
    // for a server failure (the storage notice's own `res.detail` is a
    // different `res`, which is why this is keyed on the outcome shape).
    const dash = linesOf('src/hooks/useDashboard.ts').join('\n');
    expect(dash, 'useDashboard must not propagate res.detail into the outcome').not.toMatch(
      /code: res\.code, detail:/,
    );
  });

  it('every code that used to carry raw detail answers with catalog copy', () => {
    // These five arrived WITH a server-composed `detail` at 7d43192:
    // raw fetch/OAuth/fs messages (upstream, grant_revoked, client_auth),
    // the config sentence (not_configured), and up to 500 chars of the
    // custodian's own 202 body (data_pending).
    const codes = ['upstream', 'data_pending', 'grant_revoked', 'client_auth', 'not_configured'];

    setLocale('en');
    const enExact = new Set(Object.values(CATALOGS.en));
    const enPatterns = composedMatchers(CATALOGS.en);
    for (const code of codes) {
      const detail = describeGbError(code).detail;
      expect(detail, `${code}: the default branch would echo the code word at the reader`).not.toBe(code);
      expect(isComposed(detail, enExact, enPatterns), `${code}: not ours: ${JSON.stringify(detail)}`).toBe(true);
    }
    // The two decisions this card had to make explicitly.
    expect(describeGbError('data_pending').detail).toBe(CATALOGS.en['gb.dataPendingDetail']);
    expect(describeGbError('upstream').detail).toBe(CATALOGS.en['gb.upstreamDetail']);

    // ...and in the reader's other locale, differently.
    setLocale('fr');
    const frExact = new Set(Object.values(CATALOGS.fr));
    const frUpstream = describeGbError('upstream').detail;
    expect(frUpstream).toBe(CATALOGS.fr['gb.upstreamDetail']);
    expect(frUpstream, 'the French sentence must not be the English one').not.toBe(
      CATALOGS.en['gb.upstreamDetail'],
    );
    expect(isComposed(frUpstream, frExact, composedMatchers(CATALOGS.fr))).toBe(true);
  });
});

// --- The callback redirect: a code, never a message ------------------------
//
// `GET /greenbutton/callback` answers every failure with a 302 to
// `/?gb=error:<code>`, and `useDashboard` renders that code through the
// SAME reader as the JSON half above (`describeGbError` → the catalog).
// Until t_d2eb2b3e four arms also appended a dead detail query parameter:
// the custodian's own `error` parameter, an `OAuthError`'s message, a
// static phrase, and — for ANY non-OAuth throw out of the `try` block that
// wraps `exchangeCode` AND `store.load()`/`store.save()` — an exception
// message that can carry the token file's fs path (ENOENT/EACCES).
// That parameter had ZERO readers (src + scripts), so the text bought
// nothing functional while landing in the address bar, the browser
// history, and the access log of the follow-up GET. This is a pure
// deletion, pinned as a source scan in the style of the SURFACES above.

/** Every text file under `dir`, recursively. */
function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(p));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|md)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe('the /greenbutton/callback redirect carries a code, never a message', () => {
  const CALLBACK = 'src/app/greenbutton/callback/route.ts';
  const route = readFileSync(join(WEBAPP, CALLBACK), 'utf8');
  const routeCode = codeLines(route).join('\n');

  afterEach(() => setLocale('en'));

  it('every redirect of the callback is a bare `gb=` code', () => {
    // The token this contract forbids, named here by construction so the
    // scan below cannot match this test file itself.
    const FORBIDDEN = ['gb', 'detail'].join('_');

    // The acceptance is a whole-tree grep, not a spot check: no reader of
    // the parameter may exist anywhere for a reintroduction to hide in.
    const readers: string[] = [];
    for (const root of [join(WEBAPP, 'src'), join(WEBAPP, 'scripts')]) {
      if (!existsSync(root)) continue;
      for (const file of textFiles(root)) {
        if (file.endsWith(join('greenbutton', 'recovery.test.ts'))) continue; // this file names the token
        const source = readFileSync(file, 'utf8');
        if (source.includes(FORBIDDEN)) readers.push(file.slice(WEBAPP.length + 1));
      }
    }
    expect(readers, `${FORBIDDEN} must have zero readers/writers in the webapp:\n${readers.join('\n')}`).toEqual([]);

    expect(routeCode, `${FORBIDDEN} must not come back on any redirect`).not.toContain(FORBIDDEN);

    // Shape, not just token: every `redirectToApp` call must be a literal
    // the matcher understands, so a call it CANNOT parse fails the count
    // below instead of being silently skipped.
    const calls = routeCode.match(/redirectToApp\(/g)?.length ?? 0;
    const args = [...routeCode.matchAll(/redirectToApp\(\s*("[^"]*"|`[^`]*`)\s*\)/g)].map((m) => m[1]);
    expect(args.length, 'a redirectToApp call the scan could not parse — the contract would go blind').toBe(calls);
    const offenders = args.filter((a) => !/^"gb=(?:error:[a-z_]+|connected)"$/.test(a));
    expect(offenders, `a callback redirect carrying more than a code:\n${offenders.join('\n')}`).toEqual([]);
    // Ten arms: not_configured, state_mismatch, denied, no_code,
    // pkce_verifier_missing, connected, client_auth, grant_revoked, and
    // token_exchange twice (OAuthError vs any other exception).
    expect(calls, 'the redirect arms this contract pins are gone').toBe(10);
  });

  it("neither the IdP's raw `error` parameter nor e.message reaches the URL", () => {
    expect(routeCode, 'the denied arm must answer with the code alone').toContain(
      'redirectToApp("gb=error:denied")',
    );
    expect(routeCode, 'the IdP parameter is read only as a guard, never interpolated').not.toMatch(
      /encodeURIComponent\(/,
    );
    const formatted = routeCode.split('\n').filter((line) => FORMATS_RAW_MESSAGE.some((p) => p.test(line)));
    expect(formatted, `an exception message formatted into the redirect:\n${formatted.join('\n')}`).toEqual([]);
  });

  it('the diagnostics the redirect dropped still reach the server log', () => {
    // README: "the diagnostics go to the server log". Before this fix the
    // callback's diagnostics went to the URL instead — nowhere else.
    expect(routeCode, 'the catch must log its exception server-side').toContain(
      'console.warn("[greenbutton] callback failed"',
    );
  });

  it('every code the callback can emit still answers from the catalog', () => {
    const codes = [...new Set([...routeCode.matchAll(/gb=error:([a-z_]+)/g)].map((m) => m[1]))];
    expect(codes.sort(), 'the redirect arms changed — re-pin this list').toEqual([
      'client_auth',
      'denied',
      'grant_revoked',
      'no_code',
      'not_configured',
      'pkce_verifier_missing',
      'state_mismatch',
      'token_exchange',
    ]);

    const headlines: Record<string, string> = {};
    for (const locale of ['en', 'fr'] as Locale[]) {
      setLocale(locale);
      const exact = new Set(Object.values(CATALOGS[locale]));
      const patterns = composedMatchers(CATALOGS[locale]);
      for (const code of codes) {
        const copy = describeGbError(code);
        const label = `${locale}/${code}`;
        expect(isComposed(copy.headline, exact, patterns), `${label}: headline not ours: ${copy.headline}`).toBe(true);
        // describeGbError's default branch deliberately echoes the CODE as
        // its detail (pinned above); anything else must be catalog copy.
        if (copy.detail !== code) {
          expect(isComposed(copy.detail, exact, patterns), `${label}: detail not ours: ${copy.detail}`).toBe(true);
        }
        expect(copy.hints.length, `${label}: a failure must say what to do next`).toBeGreaterThan(0);
        for (const hint of copy.hints) {
          expect(isComposed(hint, exact, patterns), `${label}: hint not ours: ${hint}`).toBe(true);
        }
      }
      headlines[locale] = describeGbError('denied').headline;
    }
    // Locale actually applied: the French reader gets French copy.
    expect(headlines.fr).not.toBe(headlines.en);
  });

  it('the README claim about these routes matches the code', () => {
    const readme = readFileSync(join(WEBAPP, 'src/lib/greenbutton/README.md'), 'utf8');
    // The sentence sits directly under the route table that lists
    // `GET /greenbutton/callback`, so it must be true FOR the redirect.
    expect(readme, 'the route table must still list the callback').toContain('`GET /greenbutton/callback`');
    expect(readme, 'the claim under the route table').toContain('no `detail`, no exception text');
    expect(readme, 'the README must not document a parameter that does not exist').not.toContain(
      ['gb', 'detail'].join('_'),
    );
    // The other half of that sentence — "the diagnostics go to the server
    // log" — is its own test above; here it is only the claim that must
    // still be present for the route table it sits under.
  });
});

