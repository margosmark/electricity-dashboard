// @vitest-environment node
/**
 * The reader-recovery contract for the surfaces OUTSIDE the Green Button
 * corpus funnel (security gate t_b6260ed7, finding F3; card t_423bfe20).
 *
 * WHAT IS BEING PINNED
 * For every site the gate listed as reader-reachable, the copy the reader
 * sees must be OURS — a catalog sentence or a fixed sentence written in
 * this repo — and never the caught exception's own message. A raw
 * `.message` interpolated into rendered copy is the "English parser text
 * inside the French sentence" bug family: unreadable to a French reader,
 * unactionable to an English one, and often leaks internals.
 *
 * The primary check is SOURCE-level because no corpus case reaches these
 * paths: the backup/example failures need a broken file or a dead network,
 * the account catches need a failing server — inputs the hostile-XML
 * funnel never produces (the same reason `greenbutton/recovery.test.ts`
 * scans its own surfaces). Lines are matched with comments stripped; the
 * allow-list names the deliberate channels by sentence, and a STALE entry
 * fails the test, so the list can only shrink with the code.
 *
 * Behavioural pins sit alongside: the catalog surfaces must render the
 * catalog value byte-for-byte in BOTH locales, the account mapper must
 * answer with copy even when handed the ugliest exceptions, and the
 * network/JSON-parse paths must not carry their raw text one step closer
 * to a reader.
 *
 * Run: `npx vitest run src/lib/rawExceptionRender.test.ts`
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGS, setLocale, type Locale } from '@/i18n';
import { parseBackup } from '@/lib/backup';
import { loadExampleReadings } from '@/lib/exampleData';
import { AccountApiError, requestRecovery } from '@/lib/account/client';
import { describeAccountError, describeAuthError } from '@/lib/account/errors';
import { readJsonCapped } from '@/lib/account/http';

/** The files whose catches feed rendered copy — the gate's listed sites. */
const SURFACES = [
  'src/lib/backup.ts', // → Dashboard issue box + BackupControls error line
  'src/lib/exampleData.ts', // → useDashboard's setParseIssue detail
  'src/components/AccountControls.tsx', // → account.notify("error", …)
  'src/components/classic/AccountControls.tsx', // → account.notify("error", …)
  'src/hooks/useAccount.ts', // → say(), the account drawer's message line
  'src/lib/account/http.ts', // → server detail → AccountApiError → say()/notify()
  'src/lib/account/client.ts', // → AccountApiError on every account call
  'src/components/AppErrorBoundary.tsx', // deliberate channel, allow-listed below
];

/**
 * The deliberate raw-message channels, named BY SENTENCE rather than by
 * line number or variable name — a stale entry fails the test below, so
 * this list can never quietly outlive the code it documents:
 *
 *  - `incidentIdFor(\`${error.name}:${error.message}\`)` hashes the message
 *    into `ERR-xxxxxx`; the reader sees the hash, never the text;
 *  - `new Error(event.message || …)` wraps a window error, and only the
 *    line below prints it —
 *  - `{error.name}: {error.message}` inside the collapsed `<details>`
 *    "technical detail" crash disclosure (testid `crash-detail`): the
 *    deliberate diagnostic channel the gate documented as NOT a defect.
 */
const DELIBERATE: Record<string, string[]> = {
  'src/components/AppErrorBoundary.tsx': [
    'incidentIdFor(`${error.name}:${error.message}`)',
    'new Error(event.message',
    '{error.name}: {error.message}',
  ],
};

/** `src/lib` → the webapp root these paths are relative to. */
const WEBAPP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  afterEach(() => setLocale('en'));

  it('keeps every raw exception message off the reader', () => {
    const offenders: string[] = [];
    const staleAllow: string[] = [];

    for (const rel of SURFACES) {
      const source = readFileSync(join(WEBAPP, rel), 'utf8');
      const lines = codeLines(source);
      const allowed = DELIBERATE[rel] ?? [];
      const seen = new Set<string>();

      for (const line of lines) {
        if (!FORMATS_RAW_MESSAGE.some((pattern) => pattern.test(line))) continue;
        const phrase = allowed.find((p) => line.includes(p));
        if (phrase) {
          seen.add(phrase);
          continue;
        }
        offenders.push(`${rel}: ${line.trim()}`);
      }

      // An allow-list entry with nothing left to allow is debt, not safety:
      // fail so the list shrinks with the code instead of outliving it.
      for (const phrase of allowed) {
        if (!seen.has(phrase)) staleAllow.push(`${rel}: ${phrase}`);
      }
    }

    expect(offenders, `raw exception text reaches the reader:\n${offenders.join('\n')}`).toEqual([]);
    expect(staleAllow, `deliberate-channel allow-list entries with no match left:\n${staleAllow.join('\n')}`).toEqual([]);
  });

  it('the backup parser renders the catalog sentence in both locales', () => {
    for (const locale of ['en', 'fr'] as Locale[]) {
      setLocale(locale);
      const res = parseBackup('{');
      expect(res.ok, `${locale}: malformed JSON must be rejected`).toBe(false);
      if (res.ok) continue;
      // Byte-for-byte the catalog value: no `{reason}` slot left to fill,
      // and nothing of JSON.parse's own English inside the French one.
      expect(res.error, locale).toBe(CATALOGS[locale]['backup.errBadJson']);
      expect(res.error, locale).not.toMatch(/\{reason\}|Unexpected|position \d+|SyntaxError/i);
    }
    expect(CATALOGS.fr['backup.errBadJson']).not.toBe(CATALOGS.en['backup.errBadJson']);
  });

  it('the example loader renders catalog copy, not the fetch/parser error', async () => {
    // A dead network and a parser that throws: the two catches the funnel
    // can never reach. Both raw texts are distinctive on purpose — the old
    // code interpolated them verbatim into {reason}.
    const deadNetwork = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const truncated = (async () => ({ ok: true, text: async () => '<feed' })) as unknown as typeof fetch;

    for (const locale of ['en', 'fr'] as Locale[]) {
      setLocale(locale);
      const dl = await loadExampleReadings(deadNetwork);
      expect(dl.ok, `${locale}: a failed download must be a failure`).toBe(false);
      if (!dl.ok) expect(dl.detail, locale).toBe(CATALOGS[locale]['example.downloadFail']);

      const pf = await loadExampleReadings(truncated);
      expect(pf.ok, `${locale}: an unreadable document must be a failure`).toBe(false);
      if (!pf.ok) expect(pf.detail, locale).toBe(CATALOGS[locale]['example.parseFail']);
    }
    expect(CATALOGS.fr['example.downloadFail']).not.toBe(CATALOGS.en['example.downloadFail']);
    expect(CATALOGS.fr['example.parseFail']).not.toBe(CATALOGS.en['example.parseFail']);
  });

  it('a dead network carries no message of its own into AccountApiError', async () => {
    vi.stubGlobal('fetch', () => {
      throw new TypeError('Failed to fetch');
    });
    try {
      const err = await requestRecovery('reader@example.com').then(
        () => {
          throw new Error('requestRecovery unexpectedly succeeded');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AccountApiError);
      const api = err as AccountApiError;
      expect(api.status).toBe(0);
      expect(api.code).toBe('network');
      expect(api.detail, 'the fetch message must not ride along').toBeUndefined();
      // describeAuthError("network") is what the reader gets instead.
      expect(describeAuthError(api.detail ?? api.code)).toBe('The account server is not reachable. Nothing was changed.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the server never echoes JSON.parse text back to the browser', async () => {
    const request = new Request('http://localhost/account/sync', { method: 'POST', body: '{"iv": ' });
    const out = await readJsonCapped(request, 1024);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('Request body is not valid JSON.');
    expect(out.error).not.toMatch(/Unexpected|position \d+|SyntaxError/i);
  });

  it('the account mapper answers with copy for every shape a catch can see', () => {
    // A browser exception (the ugliest kind): fixed copy, no `boom`.
    expect(describeAccountError(new TypeError('boom at line 3'))).toBe('Something went wrong. Please try again.');
    expect(describeAccountError(new TypeError('boom at line 3'))).not.toContain('boom');

    // Server answers keep their specific sentence — hand-written detail is
    // the channel reader-actionable lines (the 413 limit) ride on.
    expect(describeAccountError(new AccountApiError(0, 'network'))).toBe(
      'The account server is not reachable. Nothing was changed.',
    );
    expect(describeAccountError(new AccountApiError(400, 'bad_request', 'Request body is not valid JSON.'))).toBe(
      'Request body is not valid JSON.',
    );
    expect(
      describeAccountError(new AccountApiError(413, 'bad_request', 'That upload is larger than the 10 MB limit.')),
    ).toBe('That upload is larger than the 10 MB limit.');

    // A bare machine code is not a sentence — same rule the Green Button
    // toolbar's describeGbError default was held to.
    expect(describeAuthError('http_500')).not.toBe('http_500');
    expect(describeAuthError('http_500')).not.toContain('_');
    expect(describeAuthError('invalid_credentials')).toBe('That e-mail address and password do not match.');
  });
});
