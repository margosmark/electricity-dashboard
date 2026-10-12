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
 *   runbook's `git rev-parse HEAD` → the Dockerfile's `ARG GIT_SHA` +
 *   `ENV NEXT_PUBLIC_BUILD_SHA` in BOTH stages → this constant.
 *
 * Two readers, two mechanisms, one value:
 *   - CLIENT code: Next inlines `NEXT_PUBLIC_*` into the browser chunks at
 *     build time, so a bundle served to a browser cannot be relabelled by the
 *     container it came from.
 *   - SERVER code (this route): the emitted chunk keeps
 *     `process.env.NEXT_PUBLIC_BUILD_SHA||"unknown"` and reads it per request,
 *     so the runner stage sets it too (without that ENV the container answers
 *     'unknown' — the builder's ENV does not cross stages).
 *
 * The fallback is the literal string `'unknown'`, deliberately not a version
 * number and not a checked-in SHA: a local `npm run build` (and `npm run test`)
 * carries no commit, and a stamp that guesses is worse than one that admits it
 * does not know.
 *
 * This module is deliberately client-safe — a bare constant, no node builtins —
 * so a future "built from <sha>" line in the UI can import it without dragging
 * `node:fs` into the browser bundle. The server-only half (Next's build id,
 * read off disk) lives in the route.
 */
export const BUILD_SHA: string = process.env.NEXT_PUBLIC_BUILD_SHA || 'unknown';
