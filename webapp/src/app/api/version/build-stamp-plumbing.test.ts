// @vitest-environment node
/**
 * The supply chain of the stamp `GET /api/version` answers, as a static pin on
 * the build files: deploy runbook `GIT_SHA` → docker-compose.yml build arg →
 * the Dockerfile BUILDER stage's build environment → scripts/bump-build-info.mjs
 * → the committed constant src/lib/buildInfo.generated.ts.
 *
 * WHY A STATIC PIN ON BUILD FILES. Both failure modes here are silent and were
 * measured, not hypothesised:
 *
 *  - `GIT_SHA` reaches only the build as an ARG the script cannot see, or the
 *    generator is not wired into `prebuild` at all: the image builds fine,
 *    deploys fine, and answers `'unknown'` — the one answer that looks like
 *    "no stamp here" rather than like a defect.
 *  - the stamp goes back to being an ENVIRONMENT READ (`NEXT_PUBLIC_BUILD_SHA`
 *    in the runner stage, the pre-t_9ce26184 mechanism): correct values are
 *    served, and `docker run -e NEXT_PUBLIC_BUILD_SHA=deadbeef… <image>` then
 *    renames the process without touching a byte of code. The runner stage
 *    asserting NOTHING about the stamp is therefore the point of this file,
 *    not an omission in it.
 *
 * Instructions only: comment lines are stripped before asserting, so the prose
 * explaining the mechanism can name the very variables the instructions must
 * not use.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBAPP = join(HERE, '..', '..', '..', '..'); // src/app/api/version → webapp
const REPO = join(WEBAPP, '..');

const dockerfile = readFileSync(join(WEBAPP, 'Dockerfile'), 'utf8');
const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
const generator = readFileSync(join(WEBAPP, 'scripts', 'bump-build-info.mjs'), 'utf8');
const generated = readFileSync(join(WEBAPP, 'src', 'lib', 'buildInfo.generated.ts'), 'utf8');
const reexport = readFileSync(join(WEBAPP, 'src', 'lib', 'buildInfo.ts'), 'utf8');
const route = readFileSync(join(HERE, 'route.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(WEBAPP, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * Instructions/code without the prose that explains them: Dockerfile `#` lines,
 * and `//`-style comment lines (every file pinned here is line-commented, so a
 * comment that deliberately NAMES a variable the code must not use — e.g. the
 * runtime override this mechanism exists to defeat — cannot fail its own pin).
 */
const bodyOf = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !line.startsWith('#') &&
        !line.startsWith('//') &&
        !line.startsWith('*') &&
        !line.startsWith('/*'),
    )
    .join('\n');

const docker = bodyOf(dockerfile);
const stageTwo = dockerfile.indexOf('# Stage 2:');
const builderInstructions = bodyOf(stageTwo > -1 ? dockerfile.slice(0, stageTwo) : dockerfile);
const runnerInstructions = bodyOf(stageTwo > -1 ? dockerfile.slice(stageTwo) : '');

describe('the stamp is compiled into the image, not read by the container', () => {
  it('takes GIT_SHA from compose as a build arg — defaulting to empty, never a SHA', () => {
    expect(compose).toMatch(/energy-dashboard:[\s\S]*?args:\s*\n\s*GIT_SHA: \$\{GIT_SHA:-\}/);
  });

  it('puts GIT_SHA in the BUILDER environment before the build — which is what the generator reads', () => {
    // Declared exactly once: the builder. A second ARG in the runner would be
    // the old mechanism creeping back (see the test below).
    expect(docker.match(/^ARG GIT_SHA=""/gm) ?? []).toHaveLength(1);

    const buildRun = builderInstructions.indexOf('RUN npm run build');
    const arg = builderInstructions.indexOf('ARG GIT_SHA=""');
    const env = builderInstructions.indexOf('ENV GIT_SHA=$GIT_SHA');

    expect(buildRun).toBeGreaterThan(-1);
    expect(arg).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(arg); // the ENV copies an ARG that exists
    expect(env).toBeLessThan(buildRun); // and precedes the build that reads it
    // `npm run build` runs `prebuild`, which is where the generator runs.
    expect(pkg.scripts.prebuild).toContain('node scripts/bump-build-info.mjs');
  });

  it('declares NOTHING about the stamp in the RUNNER stage', () => {
    expect(stageTwo, 'the Dockerfile must still have two stages').toBeGreaterThan(-1);
    expect(runnerInstructions).not.toMatch(/GIT_SHA/);
    expect(runnerInstructions).not.toMatch(/NEXT_PUBLIC_BUILD_SHA/);
  });

  it('uses no environment variable for the stamp anywhere in the image build', () => {
    expect(docker).not.toMatch(/NEXT_PUBLIC_BUILD_SHA/);
    expect(compose).not.toContain('NEXT_PUBLIC_BUILD_SHA');
  });

  it('serves the committed constant: generated file → re-export → route', () => {
    // The committed placeholder, or a real full commit a stamped build wrote.
    expect(generated).toMatch(/^export const BUILD_SHA = '(unknown|[0-9a-f]{40})';$/m);
    // A compiled constant, not an environment read.
    expect(bodyOf(generated)).not.toContain('process.env');

    expect(bodyOf(reexport)).toMatch(/export \{ BUILD_SHA \} from '\.\/buildInfo\.generated';/);
    expect(bodyOf(route)).toContain("import { BUILD_SHA } from '@/lib/buildInfo'");
    expect(bodyOf(route)).not.toContain('process.env');
  });

  it('writes that exact file from the generator, so the wiring above is real', () => {
    expect(generator).toContain("src', 'lib', 'buildInfo.generated.ts'");
    expect(generator).toContain('process.env.GIT_SHA');
  });

  it('commits the PLACEHOLDER, not a SHA', () => {
    // Read from the object store, not the working tree: a tree that has run a
    // stamped build holds the SHA locally, and this is about what a fresh
    // clone gets — no commit may inherit someone else's identity.
    const committed = execFileSync('git', ['show', 'HEAD:webapp/src/lib/buildInfo.generated.ts'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(committed).toMatch(/^export const BUILD_SHA = 'unknown';$/m);
    expect(committed).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  it('commits no literal 40-hex SHA in the build config', () => {
    // The only acceptable answers in the build config are the build arg and the
    // empty default; a checked-in SHA would be a stamp for the wrong commit.
    for (const [name, text] of [
      ['Dockerfile', dockerfile],
      ['docker-compose.yml', compose],
    ] as const) {
      expect(text, `${name} must not carry a hardcoded 40-hex commit`).not.toMatch(
        /\b[0-9a-f]{40}\b/,
      );
    }
  });
});
