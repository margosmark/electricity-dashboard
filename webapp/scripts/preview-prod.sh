#!/usr/bin/env bash
# Production-mode local preview that can PROVE which SHA it serves.
#
# A bare `npx next build && npx next start` preview stamps
# `src/lib/buildInfo.generated.ts` with 'unknown' (no GIT_SHA in the
# environment), so its `/api/version` answers `{"sha":"unknown"}` and any
# exact-SHA claim about the preview is unverifiable — QA hit exactly this
# on 2026-10-24. The deploy runbook exports GIT_SHA before building; this
# is the same stamp for a local preview.
#
# Usage:
#   PORT=3210 bash scripts/preview-prod.sh        # build, then serve
#   curl -s http://127.0.0.1:3210/api/version     # → {"sha":"<HEAD>",…}
#
# The stamp is compiled into the bundle (OPERATIONS.md, "Build stamp"), so
# the running server names its own commit without reading the environment.
# `next build` leaves src/lib/buildInfo.generated.ts stamped with your HEAD
# — restore it afterwards with `git checkout -- src/lib/buildInfo.generated.ts`
# if you are not about to commit that SHA (stage by name, never `git add -A`).

set -euo pipefail
cd "$(dirname "$0")/.."

export GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD)}"
PORT="${PORT:-3210}"

echo "preview: building production bundle with GIT_SHA=$GIT_SHA"
npm run build

echo "preview: serving on http://127.0.0.1:${PORT} (verify with GET /api/version)"
exec npx next start -p "$PORT"
