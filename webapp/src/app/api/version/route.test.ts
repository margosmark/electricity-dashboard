// @vitest-environment node
/**
 * `GET /api/version` — the build stamp a deploy verification reads instead of
 * hashing built bytes (t_5b968b78, t_94b28843).
 *
 * WHAT IS PINNED HERE, and why each one is a real failure mode:
 *
 *  - the INLINED build arg is what comes back (`NEXT_PUBLIC_BUILD_SHA` →
 *    `sha`), so the value is the build's own input and not a runtime env read;
 *  - with NO stamp the answer is `'unknown'` — never a plausible-looking commit.
 *    That is the local-build default and the one state where a wrong value
 *    would be most believable;
 *  - `buildId` comes off the build's own `_next/BUILD_ID` (real file, real
 *    read, in a temp cwd) and degrades to `'unknown'` when it is missing;
 *  - the response is EXACTLY `{sha, buildId}` and is not cacheable.
 *
 * NO TEST HERE MAY DEPEND ON A REAL GIT SHA. The stamp below is obviously fake
 * on purpose: a test that read this checkout's HEAD would pass on one machine
 * and prove nothing about the code.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_SHA = 'test-only-sha-not-a-commit';
const FAKE_BUILD_ID = 'TESTBUILDID0000000000';

/** Temp dirs created per test, removed afterwards. */
const temps: string[] = [];

/** A fresh module graph, so `BUILD_SHA` re-reads the environment it was stubbed with. */
async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

/** A cwd that may or may not contain the build's `.next/BUILD_ID`. */
function tempCwd(withBuildId: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-route-'));
  temps.push(dir);
  if (withBuildId) {
    mkdirSync(join(dir, '.next'), { recursive: true });
    writeFileSync(join(dir, '.next', 'BUILD_ID'), `${FAKE_BUILD_ID}\n`);
  }
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  while (temps.length) rmSync(temps.pop() as string, { recursive: true, force: true });
});

describe('GET /api/version', () => {
  it("answers the stamp the build was given — and nothing else", async () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_SHA', FAKE_SHA);
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(body.sha).toBe(FAKE_SHA);
    expect(Object.keys(body).sort()).toEqual(['buildId', 'sha']);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(String(res.headers.get('cache-control'))).not.toMatch(/immutable/);
  });

  it("answers 'unknown' — never a stale or invented SHA — with no stamp", async () => {
    // Both shapes of "no stamp": the variable absent (a bare `npm run test` /
    // `npm run build`) and the variable set to empty (what compose passes when
    // GIT_SHA is unset, `${GIT_SHA:-}`).
    for (const unset of [undefined, '']) {
      if (unset === undefined) delete process.env.NEXT_PUBLIC_BUILD_SHA;
      else vi.stubEnv('NEXT_PUBLIC_BUILD_SHA', unset);

      const { GET } = await loadRoute();
      const body = await (await GET()).json();

      expect(body.sha, `NEXT_PUBLIC_BUILD_SHA=${String(unset)}`).toBe('unknown');
      // A 7-40 char hex string is what a leaked/checked-in SHA would look like.
      expect(body.sha).not.toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it("names the build's own BUILD_ID, read from _next/BUILD_ID", async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tempCwd(true));
    const { GET } = await loadRoute();

    const body = await (await GET()).json();

    expect(body.buildId).toBe(FAKE_BUILD_ID);
  });

  it("degrades buildId to 'unknown' when the build id file is missing", async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tempCwd(false));
    const { GET } = await loadRoute();

    const body = await (await GET()).json();

    expect(body.buildId).toBe('unknown');
  });

  it('reports the two fields independently: sha from the build, buildId from disk', async () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_SHA', FAKE_SHA);
    vi.spyOn(process, 'cwd').mockReturnValue(tempCwd(true));
    const { GET } = await loadRoute();

    const body = await (await GET()).json();

    expect(body).toEqual({ sha: FAKE_SHA, buildId: FAKE_BUILD_ID });
  });
});
