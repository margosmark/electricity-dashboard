// @vitest-environment node
/**
 * The module half of the build stamp's supply chain: `GIT_SHA` →
 * `scripts/bump-build-info.mjs` → `src/lib/buildInfo.generated.ts`.
 *
 * WHY THIS IS A REAL EXECUTION, NOT A GREP. The failure it guards is silent:
 * the script is the only thing that turns the deploy runbook's `git rev-parse
 * HEAD` into the constant `GET /api/version` answers, and a script that wrote
 * nothing (or wrote the wrong shape) would leave the deployed app saying
 * 'unknown' — which looks like "no stamp here", not like a defect. So the
 * script runs here against a COPY of the target (`BUILD_INFO_PATH`), exactly
 * as it runs during `npm run build`, and the bytes it produced are inspected.
 *
 * It also writes into a TypeScript SOURCE FILE, so the value is validated, not
 * interpolated: a `GIT_SHA` containing a quote or a newline must degrade to
 * 'unknown' rather than be pasted into the bundle as code.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEBAPP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(WEBAPP_ROOT, 'scripts', 'bump-build-info.mjs');
const COMMITTED = path.join(WEBAPP_ROOT, 'src', 'lib', 'buildInfo.generated.ts');

const REAL_SHA = 'deadbeefcafe0123456789deadbeefcafe012345';

const declarationOf = (source: string): string | null => {
  const m = source.match(/^export const BUILD_SHA = '([^']*)';$/m);
  return m ? m[1] : null;
};

/** A throwaway copy of the target the script may rewrite. */
function freshTarget(seed = '// seed\n'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'));
  const target = path.join(dir, 'buildInfo.generated.ts');
  fs.writeFileSync(target, seed);
  return target;
}

/**
 * Run the generator against `target` with a controlled environment: this
 * checkout's own `GIT_SHA`/`BUILD_INFO_PATH` must not leak in, or the test
 * would pass on one machine and prove nothing on another.
 */
function run(target: string, extra: Record<string, string> = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_SHA;
  delete env.BUILD_INFO_PATH;
  Object.assign(env, extra, { BUILD_INFO_PATH: target });
  execFileSync(process.execPath, [SCRIPT], { env });
  return fs.readFileSync(target, 'utf8');
}

describe('bump-build-info.mjs', () => {
  it('compiles the GIT_SHA it was given into the constant', () => {
    const out = run(freshTarget(), { GIT_SHA: REAL_SHA });

    expect(declarationOf(out)).toBe(REAL_SHA);
    // Exactly ONE declaration: a stray second constant would shadow it
    // depending on import order.
    expect(out.match(/export const BUILD_SHA/g)).toHaveLength(1);
  });

  it("writes 'unknown' when GIT_SHA is absent OR empty — never a plausible SHA", () => {
    // Absent: a bare `npm run build` / `npm run test`.
    expect(declarationOf(run(freshTarget()))).toBe('unknown');
    // Empty: what compose forwards when the runbook's export is missing
    // (`${GIT_SHA:-}` → `--build-arg GIT_SHA=`).
    expect(declarationOf(run(freshTarget(), { GIT_SHA: '' }))).toBe('unknown');
    // Whitespace-only is the same state, not a SHA.
    expect(declarationOf(run(freshTarget(), { GIT_SHA: '   \n' }))).toBe('unknown');
  });

  it('refuses a value that is not a commit SHA instead of pasting it into the source', () => {
    for (const bad of [
      `x'; process.exit(1); //`,
      'deadbeef\nsomething else',
      'HEAD',
      'a1b2c3', // too short (6)
      'not-a-sha-at-all',
    ]) {
      const out = run(freshTarget(), { GIT_SHA: bad });
      expect(declarationOf(out), `GIT_SHA=${JSON.stringify(bad)}`).toBe('unknown');
      // No fragment of the rejected value survives into the module.
      expect(out).not.toContain('process.exit');
      expect(out).not.toContain('not-a-sha-at-all');
    }
  });

  it('is byte-deterministic and idempotent — no clock, no cwd, no second run', () => {
    const first = run(freshTarget('// a different seed entirely\n'), { GIT_SHA: REAL_SHA });
    const second = run(freshTarget(), { GIT_SHA: REAL_SHA }); // different seed file
    expect(second).toBe(first);

    // Running again over its own output: identical bytes, so a local build
    // with no GIT_SHA leaves the tree clean.
    const stable = freshTarget(first);
    expect(run(stable, { GIT_SHA: REAL_SHA })).toBe(first);
  });

  it("leaves the committed placeholder alone — 'unknown' in, 'unknown' out", () => {
    const committed = fs.readFileSync(COMMITTED, 'utf8');
    expect(declarationOf(committed)).toBe('unknown');

    // The fresh-clone case: build with no GIT_SHA over the committed bytes.
    expect(run(freshTarget(committed))).toBe(committed);
  });
});
