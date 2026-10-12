// GENERATED FILE — do not edit by hand.
//
// Written by scripts/bump-build-info.mjs on the `prebuild` npm lifecycle
// (`npm run build`), from the `GIT_SHA` build arg the Dockerfile forwards to
// docker-compose.yml's `build.args`. The value committed to git is the
// 'unknown' placeholder, so a fresh clone and a local build name no commit.
//
// It is a PLAIN CONSTANT, never a `process.env` read: the SHA is compiled into
// the emitted server and client chunks, which is what makes
// `docker run -e NEXT_PUBLIC_BUILD_SHA=…` unable to rename a running
// container. Re-exported by src/lib/buildInfo.ts; served by
// GET /api/version.
export const BUILD_SHA = 'unknown';
