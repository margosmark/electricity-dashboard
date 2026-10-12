// @vitest-environment node
/**
 * The supply chain of the stamp `GET /api/version` answers: build arg →
 * Dockerfile ENV → the constant the route reads.
 *
 * WHY A STATIC PIN ON BUILD FILES. The failure it guards is silent and was
 * measured, not hypothesised: a `NEXT_PUBLIC_*` value is inlined into CLIENT
 * chunks but is read from the ENVIRONMENT in server code (Next 16.3.8 keeps
 * `process.env.NEXT_PUBLIC_BUILD_SHA||"unknown"` verbatim in the emitted route
 * chunk — see buildInfo.ts). So a `GIT_SHA` that reaches only the BUILDER stage
 * builds fine, deploys fine, and makes the container answer `'unknown'` — the
 * one answer that looks like "no stamp here" rather than like a defect. These
 * two tests are the whole difference between the builder-only Dockerfile (what
 * the feature card described) and a container that can name its commit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBAPP = join(HERE, '..', '..', '..', '..'); // src/app/api/version → webapp
const REPO = join(WEBAPP, '..');

const dockerfile = readFileSync(join(WEBAPP, 'Dockerfile'), 'utf8');
const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');

describe('the stamp reaches the image, not just the build', () => {
  it('declares the GIT_SHA build arg in BOTH stages', () => {
    const args = dockerfile.match(/^ARG GIT_SHA=""/gm) ?? [];
    expect(args.length).toBe(2);
  });

  it('exports the stamp in the builder BEFORE the build, and in the runner after it', () => {
    const stageTwo = dockerfile.indexOf('# Stage 2:');
    expect(stageTwo).toBeGreaterThan(-1);

    const builderHalf = dockerfile.slice(0, stageTwo);
    const runnerHalf = dockerfile.slice(stageTwo);

    // Builder: before `RUN npm run build` (client chunks are inlined from it).
    const buildRun = builderHalf.indexOf('RUN npm run build');
    const builderEnv = builderHalf.indexOf('ENV NEXT_PUBLIC_BUILD_SHA=$GIT_SHA');
    expect(builderEnv).toBeGreaterThan(-1);
    expect(builderEnv).toBeLessThan(buildRun);

    // Runner: this is the one the route handler reads at request time.
    expect(runnerHalf).toContain('ENV NEXT_PUBLIC_BUILD_SHA=$GIT_SHA');
  });

  it('forwards it from the environment in compose — and defaults to empty, never a SHA', () => {
    expect(compose).toMatch(/energy-dashboard:[\s\S]*?args:\s*\n\s*GIT_SHA: \$\{GIT_SHA:-\}/);
    // No literal SHA may be committed anywhere in these two files: the only
    // acceptable answers are the build arg and the empty default.
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
