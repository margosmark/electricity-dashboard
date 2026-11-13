// @vitest-environment node
/**
 * `GET /api/version` — the build stamp a deploy verification reads instead of
 * hashing built bytes (t_5b968b78, t_94b28843, t_613fc78b).
 *
 * WHAT IS PINNED HERE, and why each one is a real failure mode:
 *
 *  - the answer is the COMPILED constant (`BUILD_SHA`, baked into the bundle by
 *    scripts/bump-build-info.mjs), so it is the build's own input and NOT a
 *    runtime read;
 *  - **and the environment cannot change it.** With `NEXT_PUBLIC_BUILD_SHA`
 *    (the previous mechanism's variable) and `GIT_SHA` stubbed to a tempting
 *    fake SHA, the response is byte-identical. This is the property the
 *    compiled stamp exists for; the live half — a real container started with
 *    `-e NEXT_PUBLIC_BUILD_SHA=deadbeef…` still answering its built SHA — is an
 *    HTTP probe against a running image, not a jsdom assertion;
 *  - the committed constant is either `'unknown'` or a FULL 40-hex commit:
 *    never a truncated, mixed-case or invented value. `'unknown'` is the
 *    fresh-clone/local-build state and is deliberately not a plausible SHA;
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
import { BUILD_SHA } from '@/lib/buildInfo';

const FAKE_SHA = 'deadbeefcafe0123456789deadbeefcafe012345';
const FAKE_BUILD_ID = 'TESTBUILDID0000000000';

/** Temp dirs created per test, removed afterwards. */
const temps: string[] = [];

/** A fresh module graph for the route under test. */
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
  it('answers the stamp compiled into the bundle — and nothing else', async () => {
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(body.sha).toBe(BUILD_SHA);
    expect(Object.keys(body).sort()).toEqual(['buildId', 'sha']);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(String(res.headers.get('cache-control'))).not.toMatch(/immutable/);
  });

  it('cannot be relabelled by the environment it runs in', async () => {
    // Both the variable the previous mechanism read and the one the build
    // actually uses are stubbed to a fake SHA. The modules are re-imported
    // AFTER the stub, so a module that still read `process.env` at import time
    // would answer FAKE_SHA here — this is the assertion that discriminates
    // the compiled constant from the environment read it replaced.
    vi.stubEnv('NEXT_PUBLIC_BUILD_SHA', FAKE_SHA);
    vi.stubEnv('GIT_SHA', FAKE_SHA);
    vi.stubEnv('BUILD_SHA', FAKE_SHA);

    vi.resetModules();
    const fresh = (await import('@/lib/buildInfo')).BUILD_SHA;
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(fresh).not.toBe(FAKE_SHA);
    expect(body.sha).toBe(fresh);
    expect(body.sha).not.toBe(FAKE_SHA);
  });

  it("the shipped constant is 'unknown' or a full commit — never a partial or invented SHA", () => {
    // Widened to `string` on purpose: the generated constant is a LITERAL type,
    // so `BUILD_SHA !== 'unknown'` is TS2367 ("no overlap") in a build that HAS
    // a SHA — i.e. in the Docker build — and `next build` type-checks this file.
    const sha: string = BUILD_SHA;
    expect(sha).toMatch(/^(unknown|[0-9a-f]{40})$/);
    // A 7-40 char hex string that is not a full commit is what a truncated or
    // hand-edited stamp looks like.
    if (sha !== 'unknown') expect(sha).not.toMatch(/^[0-9a-f]{7,39}$/);
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
    vi.spyOn(process, 'cwd').mockReturnValue(tempCwd(true));
    const { GET } = await loadRoute();

    const body = await (await GET()).json();

    expect(body).toEqual({ sha: BUILD_SHA, buildId: FAKE_BUILD_ID });
  });
});
