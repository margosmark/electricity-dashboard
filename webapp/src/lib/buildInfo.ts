/**
 * The build's own identity — the ONE place the app names the commit it was
 * built from.
 *
 * WHY THIS EXISTS: before it, nothing in the tree carried a git SHA (0
 * references to GIT_SHA/BUILD_SHA/buildSha anywhere in source or build config;
 * the only per-build artefact was the service worker's `oeo-v1-<base36 ms>`
 * clock and Next's random `_next/BUILD_ID`). A deploy verification then had to
 * reconstruct identity from built bytes — sha256 of every emitted JS chunk
 * against a fresh local build of the candidate SHA — which is minutes of
 * inference to answer a question the build can answer by itself.
 *
 * HOW THE VALUE IS SET, exactly (measured on Next 16.3.8, 2026-10-12):
 *   docker-compose.yml `build.args.GIT_SHA` ← `${GIT_SHA}` ← the deploy
 *   runbook's `git rev-parse HEAD` → the Dockerfile's `ARG GIT_SHA` →
 *   `scripts/bump-build-info.mjs` (the `prebuild` npm lifecycle, i.e. the same
 *   mechanism as the service-worker version) COMPILES it into
 *   src/lib/buildInfo.generated.ts → this re-export.
 *
 * It is deliberately NOT `process.env.NEXT_PUBLIC_BUILD_SHA` any more, and that
 * distinction is the whole point of the generated file. MEASURED (Next
 * 16.3.8/Turbopack): the emitted SERVER route chunk kept
 * `process.env.NEXT_PUBLIC_BUILD_SHA||"unknown"` verbatim — a `NEXT_PUBLIC_*`
 * value is inlined into CLIENT chunks but READ FROM THE ENVIRONMENT in server
 * code — so `GET /api/version` answered whatever the container's environment
 * said at request time, and `docker run -e NEXT_PUBLIC_BUILD_SHA=deadbeef…`
 * renamed the process without touching a byte of code. A compiled constant
 * cannot be relabelled by anything at runtime: the answer is a literal in the
 * bundle.
 *
 * This module stays client-safe — a bare constant, no node builtins — so a
 * future "built from <sha>" line in the UI can import it without dragging
 * `node:fs` into the browser bundle. The server-only half (Next's build id,
 * read off disk) lives in the route.
 */
export { BUILD_SHA } from './buildInfo.generated';
