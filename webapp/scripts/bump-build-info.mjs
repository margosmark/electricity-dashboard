#!/usr/bin/env node
/**
 * Compile the commit this build was made from INTO the bundle.
 *
 * Why not just read an environment variable (the previous mechanism, and the
 * one Next's `NEXT_PUBLIC_*` inlining does not give you on the server): on
 * Next 16.3.8 / Turbopack the emitted SERVER chunk keeps
 * `process.env.NEXT_PUBLIC_BUILD_SHA||"unknown"` verbatim, so `GET /api/version`
 * answered a value read from the CONTAINER'S ENVIRONMENT AT REQUEST TIME. That
 * means `docker run -e NEXT_PUBLIC_BUILD_SHA=deadbeef… <image>` — or a rebuild
 * with a different `--build-arg` — renames the process without touching a byte
 * of code. A stamp that can be relabelled at runtime is not evidence of what is
 * running.
 *
 * This rewrites exactly one tracked file from the `prebuild` npm lifecycle (so
 * `npm run build` — the path used by CI, the Dockerfile and the deploy runbook
 * — always stamps it), and the value becomes a plain exported constant, i.e. it
 * is baked into the emitted server AND client chunks:
 *
 *   src/lib/buildInfo.generated.ts:
 *     export const BUILD_SHA = 'unknown';          // the committed placeholder
 *     export const BUILD_SHA = 'a1b2c3…';          // a stamped build
 *
 * The value is VALIDATED before it is written, because it is written into a
 * TypeScript source file: `GIT_SHA` must be a real short/long commit SHA
 * ([0-9a-f], 7–40 chars). Anything else — a quote, a newline, a semicolon —
 * degrades to `'unknown'` with a warning instead of being pasted into the
 * bundle as code.
 *
 * `BUILD_INFO_PATH` lets the test run this against a copy of the target,
 * mirroring `SW_JS_PATH` in scripts/bump-sw-version.mjs.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEBAPP = join(SCRIPT_DIR, '..');
const target = process.env.BUILD_INFO_PATH ?? join(WEBAPP, 'src', 'lib', 'buildInfo.generated.ts');

/** A commit SHA as `git rev-parse` writes it: lowercase hex, 7 (short) to 40 chars. */
const COMMIT_SHA = /^[0-9a-fA-F]{7,40}$/;

const raw = (process.env.GIT_SHA ?? '').trim();
let sha = 'unknown';
if (raw) {
  if (COMMIT_SHA.test(raw)) {
    sha = raw;
  } else {
    // Never interpolate an unvalidated string into a source file.
    console.error(
      `bump-build-info: GIT_SHA is not a commit SHA (${raw.length} chars, ` +
        `${JSON.stringify(raw.slice(0, 40))}) — writing 'unknown'`,
    );
  }
}

const content = `// GENERATED FILE — do not edit by hand.
//
// Written by scripts/bump-build-info.mjs on the \`prebuild\` npm lifecycle
// (\`npm run build\`), from the \`GIT_SHA\` build arg the Dockerfile forwards to
// docker-compose.yml's \`build.args\`. The value committed to git is the
// 'unknown' placeholder, so a fresh clone and a local build name no commit.
//
// It is a PLAIN CONSTANT, never a \`process.env\` read: the SHA is compiled into
// the emitted server and client chunks, which is what makes
// \`docker run -e NEXT_PUBLIC_BUILD_SHA=…\` unable to rename a running
// container. Re-exported by src/lib/buildInfo.ts; served by
// GET /api/version.
export const BUILD_SHA = '${sha}';
`;

const label = relative(process.cwd(), target) || target;
if (existsSync(target) && readFileSync(target, 'utf8') === content) {
  // Same commit as the file already names — leave the bytes (and the git
  // status) alone. A local build with no GIT_SHA dirties nothing.
  console.log(`bump-build-info: ${label} already names '${sha}'`);
} else {
  writeFileSync(target, content);
  console.log(`bump-build-info: ${label} -> '${sha}'`);
}
